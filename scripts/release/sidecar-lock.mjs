const LOCKFILE_VERSION = 3;
const SIDECAR_PACKAGE = "tokentracker-cli";
const REGISTRY_PREFIX = "https://registry.npmjs.org/";
const SHA512_INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;
const EXACT_PACKAGE_VERSION_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function isPlainRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value, label) {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedRecord(value) {
  return Object.fromEntries(
    Object.entries(requireRecord(value, "dependency map")).sort(
      ([left], [right]) => compareText(left, right),
    ),
  );
}

function dependencyMapIdentity(entry, field, label) {
  const rawValue = entry[field];
  if (rawValue === undefined) return null;
  const value = requireRecord(rawValue, `${label}.${field}`);
  const normalized = {};
  for (const [name, specifier] of Object.entries(value)) {
    validatePackageName(name, `${label}.${field} package name`);
    normalized[name] = requireString(
      specifier,
      `${label}.${field}.${name}`,
    );
  }
  return sortedRecord(normalized);
}

function dependencyIdentity(entry, label) {
  return {
    dependencies: dependencyMapIdentity(entry, "dependencies", label),
    optionalDependencies: dependencyMapIdentity(
      entry,
      "optionalDependencies",
      label,
    ),
  };
}

function validatePackageName(packageName, label) {
  requireString(packageName, label);
  const segments = packageName.split("/");
  const scoped = packageName.startsWith("@");
  const validSegment = (segment) =>
    /^[a-z0-9][a-z0-9._~-]*$/u.test(segment);
  if (
    (scoped &&
      (segments.length !== 2 ||
        !validSegment(segments[0]?.slice(1) ?? "") ||
        !validSegment(segments[1] ?? ""))) ||
    (!scoped &&
      (segments.length !== 1 || !validSegment(segments[0] ?? "")))
  ) {
    throw new Error(`${label} is not a safe npm package name`);
  }
  return packageName;
}

function packageNameFromLockPath(lockPath) {
  requireString(lockPath, "package-lock path");
  const segments = lockPath.split("/");
  const names = [];
  let index = 0;
  while (index < segments.length) {
    if (segments[index] !== "node_modules") {
      throw new Error(`Invalid package-lock path: ${lockPath}`);
    }
    index += 1;
    const first = segments[index];
    if (first === undefined || first.length === 0 || first === "." || first === "..") {
      throw new Error(`Invalid package-lock path: ${lockPath}`);
    }
    index += 1;
    if (first.startsWith("@")) {
      const second = segments[index];
      if (
        first.length === 1 ||
        second === undefined ||
        second.length === 0 ||
        second === "." ||
        second === ".."
      ) {
        throw new Error(`Invalid package-lock path: ${lockPath}`);
      }
      index += 1;
      names.push(
        validatePackageName(`${first}/${second}`, "package-lock package name"),
      );
    } else {
      names.push(validatePackageName(first, "package-lock package name"));
    }
  }
  const packageName = names.at(-1);
  if (packageName === undefined) {
    throw new Error(`Invalid package-lock path: ${lockPath}`);
  }
  return packageName;
}

function packageNameFromRegistryCandidatePath(lockPath) {
  if (lockPath === "") return null;
  requireString(lockPath, "package-lock registry path");
  const marker = "node_modules/";
  const index = lockPath.lastIndexOf(marker);
  if (index < 0) return null;
  const suffix = lockPath.slice(index + marker.length);
  return validatePackageName(suffix, "package-lock registry package name");
}

function parentPackagePath(lockPath) {
  const marker = "/node_modules/";
  const index = lockPath.lastIndexOf(marker);
  return index < 0 ? "" : lockPath.slice(0, index);
}

function resolveLockedDependency(packages, parentPath, dependencyName) {
  validatePackageName(dependencyName, "locked dependency name");
  let current = parentPath;
  for (;;) {
    const candidate =
      current.length === 0
        ? `node_modules/${dependencyName}`
        : `${current}/node_modules/${dependencyName}`;
    if (Object.hasOwn(packages, candidate)) return candidate;
    if (current.length === 0) return null;
    current = parentPackagePath(current);
  }
}

function dependencyNames(entry, lockPath) {
  const names = new Set();
  for (const field of ["dependencies", "optionalDependencies"]) {
    const value = entry[field];
    if (value === undefined) continue;
    const dependencies = requireRecord(value, `${lockPath}.${field}`);
    for (const [name, specifier] of Object.entries(dependencies)) {
      requireString(name, `${lockPath}.${field} package name`);
      requireString(specifier, `${lockPath}.${field}.${name}`);
      names.add(name);
    }
  }
  const peerDependencies = entry["peerDependencies"];
  if (
    peerDependencies !== undefined &&
    Object.keys(requireRecord(peerDependencies, `${lockPath}.peerDependencies`))
      .length > 0
  ) {
    throw new Error(
      `${lockPath} has peer dependencies; review the release-lock resolver before updating the sidecar pin`,
    );
  }
  return [...names].sort(compareText);
}

function validateRegistryProvenance(lockPath, rawEntry, packageName) {
  const entry = requireRecord(rawEntry, lockPath);
  const name = validatePackageName(packageName, `${lockPath} package name`);
  const version = requireString(entry["version"], `${lockPath}.version`);
  const resolved = requireString(entry["resolved"], `${lockPath}.resolved`);
  const integrity = requireString(entry["integrity"], `${lockPath}.integrity`);
  if (!resolved.startsWith(REGISTRY_PREFIX)) {
    throw new Error(`${lockPath} is not locked to the public npm registry`);
  }
  if (!SHA512_INTEGRITY_PATTERN.test(integrity)) {
    throw new Error(`${lockPath} must use a sha512 integrity`);
  }
  if (entry["link"] === true || entry["dev"] === true) {
    throw new Error(`${lockPath} is not a production registry package`);
  }
  return Object.freeze({
    path: lockPath,
    name,
    version,
    resolved,
    integrity,
    entry,
  });
}

function validateRegistryEntry(lockPath, rawEntry) {
  return validateRegistryProvenance(
    lockPath,
    rawEntry,
    packageNameFromLockPath(lockPath),
  );
}

function registryProvenanceFingerprint(identity) {
  return {
    name: identity.name,
    version: identity.version,
    resolved: identity.resolved,
    integrity: identity.integrity,
    ...dependencyIdentity(identity.entry, identity.path),
  };
}

function findBundledRegistryIdentity(packages, manifest, lockPath) {
  const name = manifest["name"];
  const version = manifest["version"];
  const rootEntry = packages[lockPath];
  if (isPlainRecord(rootEntry) && rootEntry["link"] === true) {
    const workspacePath = requireString(
      rootEntry["resolved"],
      `${lockPath}.resolved`,
    );
    const workspaceEntry = requireRecord(
      packages[workspacePath],
      `${workspacePath} workspace package`,
    );
    if (
      workspaceEntry["name"] !== name ||
      workspaceEntry["version"] !== version ||
      JSON.stringify(dependencyIdentity(workspaceEntry, workspacePath)) !==
        JSON.stringify(dependencyIdentity(manifest, `bundled manifest ${name}`))
    ) {
      throw new Error(`${lockPath} does not match its bundled workspace manifest`);
    }
    return null;
  }

  const manifestDependencies = JSON.stringify(
    dependencyIdentity(manifest, `bundled manifest ${name}`),
  );
  const candidates = [];
  for (const [candidatePath, rawEntry] of Object.entries(packages)) {
    const candidateName = packageNameFromRegistryCandidatePath(candidatePath);
    if (candidateName !== name || !isPlainRecord(rawEntry)) continue;
    if (rawEntry["version"] !== version || rawEntry["dev"] === true) continue;
    const candidate = validateRegistryProvenance(
      candidatePath,
      rawEntry,
      candidateName,
    );
    if (
      JSON.stringify(dependencyIdentity(candidate.entry, candidatePath)) !==
      manifestDependencies
    ) {
      continue;
    }
    candidates.push(candidate);
  }
  if (candidates.length === 0) {
    throw new Error(
      `${name}@${version} has no exact production registry provenance in the repository lock`,
    );
  }

  const byFingerprint = new Map();
  for (const candidate of candidates) {
    const key = JSON.stringify(registryProvenanceFingerprint(candidate));
    if (!byFingerprint.has(key)) byFingerprint.set(key, candidate);
  }
  if (byFingerprint.size !== 1) {
    throw new Error(
      `${name}@${version} resolves to multiple registry identities in the repository lock`,
    );
  }
  return byFingerprint.values().next().value;
}

export function mergeSharedRegistryLockEntry({
  bundledPath,
  bundledEntry,
  sidecarPath,
  sidecarEntry,
}) {
  const bundle = requireRecord(bundledEntry, `${bundledPath} bundled entry`);
  if (sidecarPath !== bundledPath) {
    throw new Error(
      `Sidecar registry path ${sidecarPath} does not match bundled path ${bundledPath}`,
    );
  }
  if (bundle["inBundle"] !== true) {
    throw new Error(`${bundledPath} is not marked as a bundled package`);
  }
  const bundledIdentity = validateRegistryEntry(bundledPath, bundle);
  const sidecarIdentity = validateRegistryEntry(sidecarPath, sidecarEntry);
  if (
    JSON.stringify(registryProvenanceFingerprint(bundledIdentity)) !==
    JSON.stringify(registryProvenanceFingerprint(sidecarIdentity))
  ) {
    throw new Error(
      `Sidecar registry identity differs from bundled package ${bundledPath}`,
    );
  }
  return {
    ...clone(sidecarIdentity.entry),
    ...clone(bundle),
    inBundle: true,
  };
}

function requireLockPackages(lock, label) {
  const manifest = requireRecord(lock, label);
  if (manifest["lockfileVersion"] !== LOCKFILE_VERSION) {
    throw new Error(`${label} must use lockfileVersion ${LOCKFILE_VERSION}`);
  }
  return requireRecord(manifest["packages"], `${label}.packages`);
}

export function collectSidecarClosure(lock, sidecarPin, parentPath = "") {
  requireString(sidecarPin, "sidecar pin");
  const packages = requireLockPackages(lock, "package lock");
  if (parentPath.length > 0) packageNameFromLockPath(parentPath);
  const sidecarPath = resolveLockedDependency(
    packages,
    parentPath,
    SIDECAR_PACKAGE,
  );
  if (sidecarPath === null) {
    throw new Error(`Could not resolve ${SIDECAR_PACKAGE} from ${parentPath || "."}`);
  }

  const closure = [];
  const pending = [sidecarPath];
  const seen = new Set();
  while (pending.length > 0) {
    const lockPath = pending.shift();
    if (lockPath === undefined || seen.has(lockPath)) continue;
    seen.add(lockPath);
    const identity = validateRegistryEntry(lockPath, packages[lockPath]);
    closure.push(identity);
    for (const dependencyName of dependencyNames(identity.entry, lockPath)) {
      const dependencyPath = resolveLockedDependency(
        packages,
        lockPath,
        dependencyName,
      );
      if (dependencyPath === null) {
        throw new Error(
          `${lockPath} dependency ${dependencyName} is missing from the lockfile`,
        );
      }
      pending.push(dependencyPath);
    }
  }

  const sidecar = closure.find(({ path }) => path === sidecarPath);
  if (
    sidecar === undefined ||
    sidecar.name !== SIDECAR_PACKAGE ||
    sidecar.version !== sidecarPin
  ) {
    throw new Error(
      `${SIDECAR_PACKAGE} lock identity does not match exact pin ${sidecarPin}`,
    );
  }
  return Object.freeze(
    closure
      .sort((left, right) => compareText(left.path, right.path))
      .map((identity) => Object.freeze(identity)),
  );
}

export function exactSidecarDependencyPins(lock, sidecarPin) {
  const pins = new Map();
  for (const identity of collectSidecarClosure(lock, sidecarPin)) {
    if (!EXACT_PACKAGE_VERSION_PATTERN.test(identity.version)) {
      throw new Error(
        `Sidecar closure version for ${identity.name} is not an exact package version`,
      );
    }
    if (pins.has(identity.name)) {
      throw new Error(
        `Sidecar closure contains more than one install path for ${identity.name}; exact direct pins cannot represent it`,
      );
    }
    pins.set(identity.name, identity.version);
  }
  return Object.freeze(
    Object.fromEntries(
      [...pins].sort(([left], [right]) => compareText(left, right)),
    ),
  );
}

function releaseRootLockEntry(releaseManifest) {
  const manifest = requireRecord(releaseManifest, "release manifest");
  const dependencies = requireRecord(
    manifest["dependencies"],
    "release manifest dependencies",
  );
  const bundleDependencies = manifest["bundleDependencies"];
  if (!Array.isArray(bundleDependencies)) {
    throw new Error("release manifest bundleDependencies must be an array");
  }
  return {
    name: requireString(manifest["name"], "release manifest name"),
    version: requireString(manifest["version"], "release manifest version"),
    bundleDependencies: bundleDependencies.map((name) =>
      validatePackageName(name, "release bundled package name"),
    ),
    dependencies: clone(dependencies),
    ...(manifest["bin"] === undefined ? {} : { bin: clone(manifest["bin"]) }),
    ...(manifest["engines"] === undefined
      ? {}
      : { engines: clone(manifest["engines"]) }),
  };
}

export function createReleaseShrinkwrap({
  rootLock,
  releaseManifest,
  bundledManifests,
}) {
  const rootPackages = requireLockPackages(rootLock, "repository lock");
  const rootEntry = releaseRootLockEntry(releaseManifest);
  const sidecarPin = requireString(
    rootEntry.dependencies[SIDECAR_PACKAGE],
    `release dependency ${SIDECAR_PACKAGE}`,
  );
  const bundleSet = new Set(rootEntry.bundleDependencies);
  if (bundleSet.size !== rootEntry.bundleDependencies.length) {
    throw new Error("release manifest has duplicate bundleDependencies");
  }
  if (!Array.isArray(bundledManifests)) {
    throw new Error("bundled manifests must be an array");
  }

  const entries = new Map();
  entries.set("", rootEntry);
  for (const rawManifest of bundledManifests) {
    const manifest = requireRecord(rawManifest, "bundled manifest");
    const name = validatePackageName(
      manifest["name"],
      "bundled manifest name",
    );
    const version = requireString(
      manifest["version"],
      `bundled manifest ${name} version`,
    );
    if (!bundleSet.delete(name)) {
      throw new Error(`${name} is not declared exactly once in bundleDependencies`);
    }
    if (rootEntry.dependencies[name] !== version) {
      throw new Error(`${name}@${version} does not match the release dependency pin`);
    }
    const lockPath = `node_modules/${name}`;
    const registryIdentity = findBundledRegistryIdentity(
      rootPackages,
      manifest,
      lockPath,
    );
    entries.set(lockPath, {
      version,
      inBundle: true,
      ...(registryIdentity === null
        ? {}
        : {
            resolved: registryIdentity.resolved,
            integrity: registryIdentity.integrity,
          }),
      ...(manifest["dependencies"] === undefined
        ? {}
        : { dependencies: clone(manifest["dependencies"]) }),
      ...(manifest["optionalDependencies"] === undefined
        ? {}
        : { optionalDependencies: clone(manifest["optionalDependencies"]) }),
      ...(manifest["engines"] === undefined
        ? {}
        : { engines: clone(manifest["engines"]) }),
      ...(manifest["bin"] === undefined ? {} : { bin: clone(manifest["bin"]) }),
    });
  }
  if (bundleSet.size > 0) {
    throw new Error(
      `Missing bundled manifests: ${[...bundleSet].sort(compareText).join(", ")}`,
    );
  }

  for (const identity of collectSidecarClosure(rootLock, sidecarPin)) {
    const bundledEntry = entries.get(identity.path);
    if (bundledEntry !== undefined) {
      entries.set(
        identity.path,
        mergeSharedRegistryLockEntry({
          bundledPath: identity.path,
          bundledEntry,
          sidecarPath: identity.path,
          sidecarEntry: identity.entry,
        }),
      );
      continue;
    }
    entries.set(identity.path, clone(identity.entry));
  }

  return {
    name: rootEntry.name,
    version: rootEntry.version,
    lockfileVersion: LOCKFILE_VERSION,
    requires: true,
    packages: Object.fromEntries(
      [...entries].sort(([left], [right]) => compareText(left, right)),
    ),
  };
}

function closureFingerprint(closure) {
  return closure
    .map(({ name, version, resolved, integrity, entry }) => ({
      name,
      version,
      resolved,
      integrity,
      dependencies:
        entry["dependencies"] === undefined
          ? null
          : sortedRecord(entry["dependencies"]),
      optionalDependencies:
        entry["optionalDependencies"] === undefined
          ? null
          : sortedRecord(entry["optionalDependencies"]),
    }))
    .sort((left, right) =>
      compareText(JSON.stringify(left), JSON.stringify(right)),
    );
}

export function assertSidecarClosuresMatch({
  expectedLock,
  expectedParentPath = "",
  actualLock,
  actualParentPath,
  sidecarPin,
}) {
  const expected = collectSidecarClosure(
    expectedLock,
    sidecarPin,
    expectedParentPath,
  );
  const actual = collectSidecarClosure(actualLock, sidecarPin, actualParentPath);
  if (
    JSON.stringify(closureFingerprint(actual)) !==
    JSON.stringify(closureFingerprint(expected))
  ) {
    throw new Error("Installed sidecar dependency closure differs from shrinkwrap");
  }
  return actual;
}

export { packageNameFromLockPath };
