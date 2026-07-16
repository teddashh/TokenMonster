import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, sep } from "node:path";

import { extractAll, getRawHeader } from "@electron/asar";
import yauzl from "yauzl";

import { rootDirectory } from "./repository-files.mjs";

const arguments_ = process.argv.slice(2);
const modeIndex = arguments_.indexOf("--mode");
const mode = modeIndex === -1 ? undefined : arguments_[modeIndex + 1];
const requireMaker = arguments_.includes("--require-maker");
if (mode !== "internal" && mode !== "signed") {
  throw new Error(
    "Usage: verify-companion-package.mjs --mode internal|signed [--require-maker]"
  );
}

const companionDirectory = join(rootDirectory, "apps", "companion");
const outDirectory = join(companionDirectory, "out");
const manifestPath = join(
  companionDirectory,
  "packaging",
  "runtime-bundle-manifest.json"
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const blockedExtensions = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".m4a",
  ".map",
  ".mp3",
  ".mp4",
  ".ogg",
  ".png",
  ".svg",
  ".tif",
  ".tiff",
  ".wav",
  ".webm",
  ".webp"
]);
const sourceExtensions = new Set([".cts", ".mts", ".ts", ".tsx"]);
const allowedBareImports = ["electron", "node:*"];
const expectedFuseStates = [false, true, false, false, true, true, true, false, true];
const fuseSentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX", "ascii");
const secretPatterns = [
  /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\b(?:CLOUDFLARE|CF)_API_TOKEN\s*[:=]\s*["']?[A-Za-z0-9_-]{20,}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/u,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/u,
  /\bAIza[0-9A-Za-z_-]{35}\b/u,
  /\bGOCSPX-[0-9A-Za-z_-]{20,}\b/u,
  /\beyJ[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{16,}\b/u,
  /\bnpm_[A-Za-z0-9]{36}\b/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u
];

function portablePath(path) {
  return path.split(sep).join("/");
}

async function walkFiles(directory, options = {}) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    const path = join(directory, entry.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      if (options.rejectLinks === true) {
        throw new Error(`Packaged ASAR contains a symbolic link: ${entry.name}`);
      }
      continue;
    }
    if (metadata.isDirectory()) {
      files.push(...(await walkFiles(path, options)));
    } else if (metadata.isFile()) {
      files.push(path);
    } else if (options.rejectLinks === true) {
      throw new Error(`Packaged ASAR contains a non-regular entry: ${entry.name}`);
    }
  }
  return files;
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function hashFile(path) {
  return sha256(await readFile(path));
}

function linuxLibcSuffix() {
  const report = process.report?.getReport();
  return typeof report?.header?.glibcVersionRuntime === "string"
    ? "gnu"
    : "musl";
}

function collectorTargetKey() {
  if (
    process.platform === "darwin" &&
    (process.arch === "x64" || process.arch === "arm64")
  ) {
    return `${process.platform}-${process.arch}`;
  }
  if (
    process.platform === "linux" &&
    (process.arch === "x64" || process.arch === "arm64")
  ) {
    return `${process.platform}-${process.arch}-${linuxLibcSuffix()}`;
  }
  if (
    process.platform === "win32" &&
    (process.arch === "x64" || process.arch === "arm64")
  ) {
    return `${process.platform}-${process.arch}-msvc`;
  }
  throw new Error(
    `No audited collector verification target exists for ${process.platform}-${process.arch}.`
  );
}

function selectedCollectorTarget() {
  const key = collectorTargetKey();
  const target = manifest.collector?.targets?.[key];
  if (
    target === null ||
    typeof target !== "object" ||
    target.runtimeEnabled !== true ||
    typeof target.package !== "string" ||
    target.packageVersion !== manifest.collector.sourceVersion ||
    typeof target.lockIntegrity !== "string" ||
    !Array.isArray(target.files) ||
    target.files.length < 1 ||
    target.files.length > 2
  ) {
    throw new Error(`Collector verification target ${key} is not enabled.`);
  }
  return { key, target };
}

async function verifyCollectorExtraResource(asarPath) {
  const disabledKey = collectorTargetKey();
  const disabledTarget = manifest.collector?.targets?.[disabledKey];
  if (
    disabledTarget !== null &&
    typeof disabledTarget === "object" &&
    disabledTarget.runtimeEnabled === false &&
    typeof disabledTarget.blockedReason === "string"
  ) {
    // The packager skips bundling on explicitly-disabled targets (no audited
    // no-egress sandbox); the package must then contain no collector at all.
    const absentDirectory = join(
      dirname(asarPath),
      ...manifest.collector.extraResourceTarget.split("/")
    );
    let extraResourcePresent = true;
    try {
      await lstat(absentDirectory);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      extraResourcePresent = false;
    }
    if (extraResourcePresent) {
      throw new Error(
        `Collector target ${disabledKey} is disabled but the extraResource was packaged.`
      );
    }
    return {
      status: manifest.collector.status,
      target: disabledKey,
      package: null,
      packageVersion: null,
      packageLockIntegrity: null,
      expectedVersionOutput: null,
      versionEvidence: "explicitly-disabled-target",
      binaryExecutedDuringVerification: false,
      extraResourcePresent: false,
      files: [],
      releaseBlocker: disabledTarget.blockedReason
    };
  }
  const { key, target } = selectedCollectorTarget();
  const targetDirectory = join(
    dirname(asarPath),
    ...manifest.collector.extraResourceTarget.split("/")
  );
  const rootMetadata = await lstat(targetDirectory);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("Collector extraResource root is not a regular directory.");
  }
  const files = await walkFiles(targetDirectory, { rejectLinks: true });
  const expectedNames = target.files
    .map(({ target: name }) => name)
    .sort();
  const actualNames = files
    .map((path) => portablePath(relative(targetDirectory, path)))
    .sort();
  if (
    new Set(expectedNames).size !== expectedNames.length ||
    JSON.stringify(actualNames) !== JSON.stringify(expectedNames)
  ) {
    throw new Error(
      `Collector extraResource inventory mismatch: ${JSON.stringify(actualNames)}.`
    );
  }

  const inventory = [];
  for (const specification of target.files) {
    if (
      typeof specification.target !== "string" ||
      !/^[A-Za-z0-9._-]+$/u.test(specification.target) ||
      typeof specification.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(specification.sha256) ||
      (specification.mode !== "0755" && specification.mode !== "0644") ||
      typeof specification.executable !== "boolean"
    ) {
      throw new Error("Collector manifest file evidence is malformed.");
    }
    const path = join(targetDirectory, specification.target);
    const metadata = await lstat(path);
    const digest = await hashFile(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o777) !== Number.parseInt(specification.mode, 8) ||
      digest !== specification.sha256 ||
      metadata.size < 1 ||
      metadata.size > 32 * 1024 * 1024
    ) {
      throw new Error(
        `Collector evidence failed for ${specification.target}.`
      );
    }
    inventory.push({
      path: portablePath(relative(rootDirectory, path)),
      bytes: metadata.size,
      sha256: digest,
      mode: specification.mode,
      executable: specification.executable
    });
  }

  if (target.files.filter(({ executable }) => executable).length !== 1) {
    throw new Error("Collector target must contain exactly one executable.");
  }
  return {
    status: manifest.collector.status,
    target: key,
    package: target.package,
    packageVersion: target.packageVersion,
    packageLockIntegrity: target.lockIntegrity,
    expectedVersionOutput: manifest.collector.versionOutput,
    versionEvidence: "package-lock+package-manifest+audited-file-sha256",
    binaryExecutedDuringVerification: false,
    extraResourcePresent: true,
    files: inventory,
    releaseBlocker: null
  };
}

function isAllowedBareImport(specifier) {
  return specifier === "electron" || specifier.startsWith("node:");
}

function importedSpecifiers(text) {
  const patterns = [
    /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu
  ];
  const specifiers = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1] !== undefined) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function isBareSpecifier(specifier) {
  return !(
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("/")
  );
}

async function expectedAsarFiles() {
  const files = [];
  for (const staticFile of manifest.asar.staticFiles) {
    files.push(join(companionDirectory, staticFile));
  }
  files.push(
    ...(await walkFiles(join(companionDirectory, manifest.asar.generatedRoot)))
  );
  return files.sort();
}

function assertManifestPolicy() {
  if (
    manifest.schemaVersion !== 1 ||
    manifest.application?.productName !== "TokenMonster" ||
    manifest.application?.bundleId !== "com.tokenmonster.companion" ||
    manifest.application?.main !== "dist/main/main/main.js" ||
    manifest.application?.preload !== "dist/main/preload/index.cjs" ||
    manifest.application?.renderer !== "dist/renderer/index.html" ||
    manifest.asar?.enabled !== true ||
    manifest.asar?.allowUnpackedFiles !== false ||
    manifest.collector?.status !== "ready" ||
    typeof manifest.collector?.signedReleaseStatus !== "string" ||
    manifest.collector?.name !== "tokscale" ||
    manifest.collector?.sourceVersion !== "4.5.2" ||
    manifest.collector?.versionOutput !== "tokscale 4.5.2" ||
    manifest.collector?.license !== "MIT" ||
    manifest.collector?.licenseFile !== "packaging/TOKSCALE_LICENSE.txt" ||
    manifest.collector?.licenseSha256 !==
      "24a794f325f7625b5f124945dedb6dcec8188f88e76bf4b99557b52d6cc77be9" ||
    !manifest.asar.staticFiles.includes(manifest.collector.licenseFile) ||
    manifest.collector?.extraResourceTarget !== "collector/tokscale" ||
    manifest.collector?.runtimeBase !== "process.resourcesPath" ||
    JSON.stringify(manifest.application?.runtimeExternals) !==
      JSON.stringify(allowedBareImports)
  ) {
    throw new Error("Runtime bundle manifest does not match release policy.");
  }
}

function asarHeaderFile(header, relativePath) {
  let directory = header;
  const segments = relativePath.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    const entry = directory?.files?.[segments[index]];
    if (entry === undefined) return undefined;
    if (index === segments.length - 1) return entry;
    directory = entry;
  }
  return undefined;
}

async function findAppAsars() {
  try {
    return (await walkFiles(outDirectory)).filter(
      (path) => basename(path) === "app.asar"
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Companion package output is missing.");
    }
    throw error;
  }
}

function packageRootForAsar(asarPath) {
  let current = dirname(asarPath);
  while (current !== dirname(current)) {
    if (basename(current).endsWith(".app")) return current;
    current = dirname(current);
  }
  return dirname(dirname(asarPath));
}

async function verifyPackagePermissionTree(directory, depth = 0, counter = { value: 0 }) {
  // Runaway guard, not a tight count: macOS .app bundles carry an order of
  // magnitude more entries than the Linux/Windows layouts.
  if (depth > 16 || counter.value > 4096) {
    throw new Error("Packaged permission inventory exceeded its bound.");
  }
  counter.value += 1;
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink()) {
    if (process.platform !== "darwin") {
      throw new Error("Packaged application contains an unexpected symbolic link.");
    }
    return;
  }
  if (!metadata.isDirectory() && !metadata.isFile()) {
    throw new Error("Packaged application contains a non-regular entry.");
  }
  // POSIX mode bits are synthetic on Windows (node reports 0o666; ACLs are
  // the real permission model there), so the bit check only runs on unix.
  if (process.platform !== "win32" && (metadata.mode & 0o7022) !== 0) {
    throw new Error("Packaged application contains an unsafe file mode.");
  }
  if (metadata.isDirectory()) {
    for (const entry of await readdir(directory)) {
      await verifyPackagePermissionTree(join(directory, entry), depth + 1, counter);
    }
  }
}

async function verifyPackagePathsAndSnapshots(asarPath) {
  const packageRoot = packageRootForAsar(asarPath);
  await verifyPackagePermissionTree(packageRoot);
  const files = await walkFiles(packageRoot);
  for (const path of files) {
    const relativePath = portablePath(relative(packageRoot, path));
    const lowerPath = relativePath.toLowerCase();
    const extension = extname(lowerPath);
    const segments = lowerPath.split("/");
    if (
      blockedExtensions.has(extension) ||
      sourceExtensions.has(extension) ||
      segments.includes("node_modules") ||
      segments.some((segment) => segment === ".env" || segment.startsWith(".env."))
    ) {
      throw new Error(`Forbidden packaged application path: ${relativePath}`);
    }
  }

  const sharedSnapshots = files.filter((path) =>
    // macOS names the shared snapshot per-arch (v8_context_snapshot.arm64.bin).
    /^v8_context_snapshot(?:\.(?:arm64|x86_64))?\.bin$/u.test(basename(path))
  );
  const browserSnapshots = files.filter(
    (path) => basename(path) === "browser_v8_context_snapshot.bin"
  );
  if (
    sharedSnapshots.length < 1 ||
    sharedSnapshots.length > 2 ||
    browserSnapshots.length !== sharedSnapshots.length
  ) {
    throw new Error(
      `Electron browser snapshot inventory mismatch: shared=${sharedSnapshots.length}, browser=${browserSnapshots.length}.`
    );
  }

  const evidence = [];
  for (const sharedPath of sharedSnapshots.sort()) {
    const browserPath = join(dirname(sharedPath), "browser_v8_context_snapshot.bin");
    if (!browserSnapshots.includes(browserPath)) {
      throw new Error("Electron browser snapshot is not beside its shared snapshot.");
    }
    const shared = await readFile(sharedPath);
    const browser = await readFile(browserPath);
    if (!shared.equals(browser)) {
      throw new Error("Electron browser and shared snapshots are not byte-identical.");
    }
    evidence.push({
      sharedPath: portablePath(relative(rootDirectory, sharedPath)),
      browserPath: portablePath(relative(rootDirectory, browserPath)),
      bytes: shared.byteLength,
      sha256: sha256(shared)
    });
  }
  return evidence;
}

async function assertAsarInventory(asarPath, extractedDirectory) {
  const unpackedPath = `${asarPath}.unpacked`;
  try {
    await stat(unpackedPath);
    throw new Error("app.asar.unpacked is forbidden for the companion bundle.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  extractAll(asarPath, extractedDirectory);
  const extractedFiles = await walkFiles(extractedDirectory, {
    rejectLinks: true
  });
  const rawHeader = getRawHeader(asarPath).header;
  const expectedFiles = await expectedAsarFiles();
  const extractedNames = extractedFiles
    .map((path) => portablePath(relative(extractedDirectory, path)))
    .sort();
  const expectedNames = expectedFiles
    .map((path) => portablePath(relative(companionDirectory, path)))
    .sort();
  if (JSON.stringify(extractedNames) !== JSON.stringify(expectedNames)) {
    const unexpected = extractedNames.filter(
      (path) => !expectedNames.includes(path)
    );
    const missing = expectedNames.filter(
      (path) => !extractedNames.includes(path)
    );
    throw new Error(
      `ASAR inventory mismatch; unexpected=${JSON.stringify(unexpected)}, missing=${JSON.stringify(missing)}`
    );
  }
  if (extractedFiles.length > 64) {
    throw new Error("ASAR inventory exceeds the 64-file release bound.");
  }

  const inventory = [];
  let totalBytes = 0;
  for (let index = 0; index < extractedFiles.length; index += 1) {
    const extractedPath = extractedFiles[index];
    const expectedPath = expectedFiles.find(
      (path) =>
        portablePath(relative(companionDirectory, path)) ===
        portablePath(relative(extractedDirectory, extractedPath))
    );
    if (expectedPath === undefined) {
      throw new Error("ASAR inventory comparison lost an expected path.");
    }
    const relativePath = portablePath(relative(extractedDirectory, extractedPath));
    const contents = await readFile(extractedPath);
    const expectedContents = await readFile(expectedPath);
    totalBytes += contents.byteLength;
    if (contents.byteLength > 8 * 1024 * 1024) {
      throw new Error(`ASAR file exceeds the 8 MiB bound: ${relativePath}`);
    }
    if (!contents.equals(expectedContents)) {
      const bound = Math.min(contents.byteLength, expectedContents.byteLength);
      let difference = 0;
      while (
        difference < bound &&
        contents[difference] === expectedContents[difference]
      ) {
        difference += 1;
      }
      throw new Error(
        `Packaged file differs from built input: ${relativePath} ` +
          `(packaged ${contents.byteLength}B vs built ${expectedContents.byteLength}B; ` +
          `first difference at byte ${difference}: ` +
          `${contents.subarray(difference, difference + 8).toString("hex")} vs ` +
          `${expectedContents.subarray(difference, difference + 8).toString("hex")})`
      );
    }

    const lowerPath = relativePath.toLowerCase();
    const extension = extname(lowerPath);
    const segments = lowerPath.split("/");
    if (
      segments.includes("node_modules") ||
      segments.includes("src") ||
      segments.includes("test") ||
      segments.includes("tests") ||
      sourceExtensions.has(extension) ||
      blockedExtensions.has(extension) ||
      segments.some((segment) => segment === ".env" || segment.startsWith(".env."))
    ) {
      throw new Error(`Forbidden packaged path: ${relativePath}`);
    }
    if (contents.includes(0)) {
      throw new Error(`Unknown binary content in ASAR: ${relativePath}`);
    }
    const text = contents.toString("utf8");
    if (text.includes("data:image/")) {
      throw new Error(`Embedded image data is forbidden: ${relativePath}`);
    }
    for (const pattern of secretPatterns) {
      if (pattern.test(text)) {
        throw new Error(`Possible secret in ASAR: ${relativePath}`);
      }
    }
    if (new Set([".cjs", ".js", ".mjs"]).has(extension)) {
      for (const specifier of importedSpecifiers(text)) {
        if (isBareSpecifier(specifier) && !isAllowedBareImport(specifier)) {
          throw new Error(
            `Forbidden runtime bare import ${JSON.stringify(specifier)} in ${relativePath}`
          );
        }
      }
    }
    const headerFile = asarHeaderFile(rawHeader, relativePath);
    const integrity = headerFile?.integrity;
    if (
      headerFile?.size !== contents.byteLength ||
      integrity?.algorithm !== "SHA256" ||
      integrity.hash !== sha256(contents) ||
      !Number.isSafeInteger(integrity.blockSize) ||
      integrity.blockSize < 1 ||
      integrity.blockSize > 4 * 1024 * 1024 ||
      !Array.isArray(integrity.blocks)
    ) {
      throw new Error(`ASAR header integrity metadata is invalid: ${relativePath}`);
    }
    const expectedBlocks = [];
    for (let offset = 0; offset < contents.byteLength; offset += integrity.blockSize) {
      expectedBlocks.push(
        sha256(contents.subarray(offset, offset + integrity.blockSize))
      );
    }
    if (JSON.stringify(integrity.blocks) !== JSON.stringify(expectedBlocks)) {
      throw new Error(`ASAR block integrity mismatch: ${relativePath}`);
    }
    inventory.push({
      path: relativePath,
      bytes: contents.byteLength,
      sha256: sha256(contents)
    });
  }
  if (totalBytes > 20 * 1024 * 1024) {
    throw new Error("ASAR inventory exceeds the 20 MiB release bound.");
  }

  const packagedManifest = JSON.parse(
    await readFile(
      join(extractedDirectory, "packaging", "runtime-bundle-manifest.json"),
      "utf8"
    )
  );
  if (JSON.stringify(packagedManifest) !== JSON.stringify(manifest)) {
    throw new Error("Packaged runtime manifest differs from source policy.");
  }
  const collectorLicense = await readFile(
    join(extractedDirectory, manifest.collector.licenseFile)
  );
  if (sha256(collectorLicense) !== manifest.collector.licenseSha256) {
    throw new Error("Packaged collector license differs from the pinned notice.");
  }
  const packageManifest = JSON.parse(
    await readFile(join(extractedDirectory, "package.json"), "utf8")
  );
  if (
    packageManifest.main !== manifest.application.main ||
    packageManifest.productName !== manifest.application.productName
  ) {
    throw new Error("Packaged package.json has an unexpected entry point.");
  }
  for (const entry of [
    manifest.application.main,
    manifest.application.preload,
    manifest.application.renderer
  ]) {
    if (!extractedNames.includes(entry)) {
      throw new Error(`Declared runtime entry is absent from ASAR: ${entry}`);
    }
  }
  return inventory;
}

function fuseBinaryPath(asarPath) {
  const resourcesDirectory = dirname(asarPath);
  if (portablePath(resourcesDirectory).includes(".app/Contents/Resources")) {
    const contentsDirectory = dirname(resourcesDirectory);
    return join(
      contentsDirectory,
      "Frameworks",
      "Electron Framework.framework",
      "Electron Framework"
    );
  }
  const packageDirectory = dirname(resourcesDirectory);
  return process.platform === "win32"
    ? join(packageDirectory, "TokenMonster.exe")
    : join(packageDirectory, "TokenMonster");
}

async function verifyRawFuseWires(binaryPath) {
  const executable = await readFile(binaryPath);
  const wires = [];
  let offset = 0;
  while (offset < executable.byteLength) {
    const sentinelIndex = executable.indexOf(fuseSentinel, offset);
    if (sentinelIndex === -1) break;
    const wirePosition = sentinelIndex + fuseSentinel.byteLength;
    const version = executable[wirePosition];
    const length = executable[wirePosition + 1];
    if (version !== 1 || length !== expectedFuseStates.length) {
      throw new Error(
        `Unexpected Electron fuse wire version/length: ${version}/${length}`
      );
    }
    const rawStates = [...executable.subarray(wirePosition + 2, wirePosition + 2 + length)];
    const expectedRawStates = expectedFuseStates.map((enabled) =>
      enabled ? "1".charCodeAt(0) : "0".charCodeAt(0)
    );
    if (JSON.stringify(rawStates) !== JSON.stringify(expectedRawStates)) {
      throw new Error(
        `Electron fuse wire mismatch: ${JSON.stringify(rawStates)}`
      );
    }
    wires.push(rawStates.map((state) => state === "1".charCodeAt(0)));
    offset = wirePosition + 2 + length;
  }
  if (wires.length === 0 || wires.length > 2) {
    throw new Error(`Expected one or two Electron fuse wires, found ${wires.length}.`);
  }
  return wires;
}

function openZip(path, options = {}) {
  // PowerShell 5.1 Compress-Archive (cross-zip's win32 backend) writes
  // non-conformant backslash separators. Lenient mode lets yauzl normalize
  // them to "/" before its own traversal/absolute-path validation and before
  // safeZipEntryName re-checks the normalized name.
  const allowBackslashSeparators = options.allowBackslashSeparators === true;
  return new Promise((resolvePromise, reject) => {
    yauzl.open(
      path,
      {
        autoClose: false,
        decodeStrings: true,
        lazyEntries: true,
        strictFileNames: !allowBackslashSeparators,
        validateEntrySizes: true
      },
      (error, zip) => {
        if (error !== null) {
          reject(error);
          return;
        }
        if (zip === undefined) {
          reject(new Error("ZIP reader returned no archive."));
          return;
        }
        resolvePromise(zip);
      }
    );
  });
}

function safeZipEntryName(input) {
  if (
    typeof input !== "string" ||
    input.length < 1 ||
    Buffer.byteLength(input, "utf8") > 4_096 ||
    input.includes("\0") ||
    input.includes("\\") ||
    input.startsWith("/") ||
    /^[A-Za-z]:/u.test(input)
  ) {
    return false;
  }
  const directory = input.endsWith("/");
  const segments = input.split("/");
  if (directory) segments.pop();
  return (
    segments.length >= 1 &&
    segments.every(
      (segment) => segment.length >= 1 && segment !== "." && segment !== ".."
    )
  );
}

// The darwin/win32 zip toolchains cannot round-trip POSIX modes (PowerShell
// zips carry DOS attributes; .app zips carry framework symlinks), so foreign
// platforms verify entry safety and sizes without unix type/mode assertions.
function lenientZipEntryKind(entry) {
  if (!safeZipEntryName(entry.fileName)) {
    throw new Error("Maker ZIP contains an unsafe entry path.");
  }
  if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
    throw new Error("Encrypted maker ZIP entries are forbidden.");
  }
  const isDirectory = entry.fileName.endsWith("/");
  if (
    !isDirectory &&
    (!Number.isSafeInteger(entry.uncompressedSize) ||
      entry.uncompressedSize < 0 ||
      entry.uncompressedSize > 256 * 1024 * 1024)
  ) {
    throw new Error("Maker ZIP file size is outside the release bound.");
  }
  return { kind: isDirectory ? "directory" : "file", mode: null };
}

function zipEntryKindAndMode(entry) {
  if (!safeZipEntryName(entry.fileName)) {
    throw new Error("Maker ZIP contains an unsafe entry path.");
  }
  if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
    throw new Error("Encrypted maker ZIP entries are forbidden.");
  }
  if ((entry.versionMadeBy >>> 8) !== 3) {
    throw new Error("Maker ZIP entries must preserve Unix file types and modes.");
  }
  const unixMode = entry.externalFileAttributes >>> 16;
  const fileType = unixMode & 0o170000;
  const isDirectory = entry.fileName.endsWith("/");
  if ((unixMode & 0o7022) !== 0) {
    throw new Error("Maker ZIP contains an unsafe file mode.");
  }
  if (isDirectory) {
    if (fileType !== 0o040000 || entry.uncompressedSize !== 0) {
      throw new Error("Maker ZIP directory metadata is invalid.");
    }
    return { kind: "directory", mode: unixMode & 0o777 };
  }
  if (fileType !== 0o100000) {
    throw new Error("Maker ZIP contains a link or non-regular entry.");
  }
  if (
    !Number.isSafeInteger(entry.uncompressedSize) ||
    entry.uncompressedSize < 1 ||
    entry.uncompressedSize > 256 * 1024 * 1024
  ) {
    throw new Error("Maker ZIP file size is outside the release bound.");
  }
  return { kind: "file", mode: unixMode & 0o777 };
}

function hashZipEntry(zip, entry) {
  return new Promise((resolvePromise, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error !== null) {
        reject(error);
        return;
      }
      if (stream === undefined) {
        reject(new Error("ZIP reader returned no entry stream."));
        return;
      }
      const hash = createHash("sha256");
      let bytes = 0;
      stream.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > entry.uncompressedSize || bytes > 256 * 1024 * 1024) {
          stream.destroy(new Error("Maker ZIP entry exceeded its size bound."));
          return;
        }
        hash.update(chunk);
      });
      stream.once("error", reject);
      stream.once("end", () => {
        if (bytes !== entry.uncompressedSize) {
          reject(new Error("Maker ZIP entry size changed while reading."));
          return;
        }
        resolvePromise({ bytes, sha256: hash.digest("hex") });
      });
    });
  });
}

async function zipInventory(path, options = {}) {
  const lenientModes = options.lenientModes === true;
  const entryBound = lenientModes ? 8192 : 512;
  const byteBound = (lenientModes ? 2 : 1) * 1_024 * 1_024 * 1_024;
  const zip = await openZip(path, { allowBackslashSeparators: lenientModes });
  try {
    return await new Promise((resolvePromise, reject) => {
      const files = new Map();
      const directories = new Map();
      const names = new Set();
      const caseFoldedNames = new Set();
      let entries = 0;
      let totalBytes = 0;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      zip.once("error", fail);
      zip.once("end", () => {
        if (settled) return;
        settled = true;
        resolvePromise({ files, directories, entries, totalBytes });
      });
      zip.on("entry", (entry) => {
        void (async () => {
          entries += 1;
          if (entries > entryBound) {
            throw new Error(
              `Maker ZIP exceeds the ${entryBound}-entry release bound.`
            );
          }
          const folded = entry.fileName.toLocaleLowerCase("en-US");
          if (names.has(entry.fileName) || caseFoldedNames.has(folded)) {
            throw new Error("Maker ZIP contains duplicate or case-colliding paths.");
          }
          names.add(entry.fileName);
          caseFoldedNames.add(folded);
          const metadata = lenientModes
            ? lenientZipEntryKind(entry)
            : zipEntryKindAndMode(entry);
          if (metadata.kind === "directory") {
            directories.set(entry.fileName.slice(0, -1), metadata.mode);
          } else {
            totalBytes += entry.uncompressedSize;
            if (totalBytes > byteBound) {
              throw new Error("Maker ZIP exceeds the uncompressed byte bound.");
            }
            files.set(entry.fileName, {
              ...(await hashZipEntry(zip, entry)),
              mode: metadata.mode
            });
          }
          if (!settled) zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}

async function stagedPackageInventory(asarPath) {
  const packageRoot = packageRootForAsar(asarPath);
  const inventory = new Map();
  const directories = new Map();
  async function visit(path, depth = 0) {
    if (depth > 16 || inventory.size + directories.size > 512) {
      throw new Error("Staged maker inventory exceeded its bound.");
    }
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new Error(
        "Maker ZIP verification does not yet support macOS framework symlinks."
      );
    }
    const relativePath = portablePath(relative(packageRoot, path));
    if (metadata.isDirectory()) {
      directories.set(relativePath, metadata.mode & 0o777);
      for (const entry of await readdir(path)) {
        await visit(join(path, entry), depth + 1);
      }
      return;
    }
    if (!metadata.isFile()) {
      throw new Error("Staged maker inventory contains a non-regular entry.");
    }
    inventory.set(relativePath, {
      bytes: metadata.size,
      sha256: await hashFile(path),
      mode: metadata.mode & 0o777
    });
  }
  await visit(packageRoot);
  return { packageRoot, inventory, directories };
}

function sameInventory(left, right) {
  return (
    left.bytes === right.bytes &&
    left.sha256 === right.sha256 &&
    left.mode === right.mode
  );
}

// Foreign-platform zips cannot support the linux byte/mode inventory diff
// (PowerShell zips drop unix modes; .app staging trees contain framework
// symlinks), so they get bounded structural checks plus proof that the
// packaged executable is present.
async function verifyForeignPlatformZip(path) {
  const zip = await zipInventory(path, { lenientModes: true });
  const executableSuffix =
    process.platform === "win32"
      ? "TokenMonster.exe"
      : "Contents/MacOS/TokenMonster";
  const containsExecutable = [...zip.files.keys()].some((name) =>
    name.endsWith(executableSuffix)
  );
  if (!containsExecutable) {
    throw new Error("Maker ZIP does not contain the packaged executable.");
  }
  return {
    verification: "entry-safety-and-executable-presence",
    fileCount: zip.files.size,
    entryCount: zip.entries,
    uncompressedBytes: zip.totalBytes
  };
}

async function verifyZipMakerArtifact(path, asarPath) {
  if (process.platform !== "linux") {
    return verifyForeignPlatformZip(path);
  }
  const staged = await stagedPackageInventory(asarPath);
  const zip = await zipInventory(path);
  const prefixes = ["", `${basename(staged.packageRoot)}/`];
  const prefix = prefixes.find((candidate) => {
    const expectedNames = [...staged.inventory.keys()]
      .map((name) => `${candidate}${name}`)
      .sort();
    return JSON.stringify([...zip.files.keys()].sort()) === JSON.stringify(expectedNames);
  });
  if (prefix === undefined) {
    throw new Error("Maker ZIP file inventory differs from the verified package.");
  }
  for (const [name, expected] of staged.inventory) {
    const actual = zip.files.get(`${prefix}${name}`);
    if (actual === undefined || !sameInventory(actual, expected)) {
      throw new Error(`Maker ZIP content differs from the verified package: ${name}`);
    }
  }
  const expectedDirectories = new Map(
    [...staged.directories].map(([name, mode]) => [
      name === "" ? prefix.slice(0, -1) : `${prefix}${name}`,
      mode
    ])
  );
  if (
    expectedDirectories.size !== zip.directories.size ||
    [...expectedDirectories].some(
      ([name, mode]) => zip.directories.get(name) !== mode
    )
  ) {
    throw new Error("Maker ZIP directory inventory or mode differs from staging.");
  }
  for (const directory of zip.directories.keys()) {
    if (!expectedDirectories.has(directory)) {
      throw new Error("Maker ZIP contains an unrelated directory.");
    }
  }
  const canonical = [...zip.files]
    .map(([name, value]) => [name.slice(prefix.length), value])
    .sort(([left], [right]) => left.localeCompare(right));
  return {
    verification: "full-byte-mode-inventory",
    fileCount: zip.files.size,
    entryCount: zip.entries,
    uncompressedBytes: zip.totalBytes,
    contentInventorySha256: sha256(
      Buffer.from(JSON.stringify(canonical), "utf8")
    )
  };
}

async function makerEvidence(asarPath) {
  const makeDirectory = join(outDirectory, "make");
  let files;
  try {
    files = await walkFiles(makeDirectory);
  } catch (error) {
    if (error?.code === "ENOENT" && !requireMaker) return [];
    if (error?.code === "ENOENT") {
      throw new Error("Forge maker output is required but missing.");
    }
    throw error;
  }
  const artifacts = files.filter((path) =>
    new Set([".dmg", ".zip"]).has(extname(path).toLowerCase())
  );
  if (requireMaker && artifacts.length === 0) {
    throw new Error("Forge maker produced no ZIP or DMG artifact.");
  }
  if (
    mode === "signed" &&
    !artifacts.some((path) => extname(path).toLowerCase() === ".dmg")
  ) {
    throw new Error("Signed macOS release requires a DMG artifact.");
  }
  const evidence = [];
  for (const path of artifacts.sort()) {
    const extension = extname(path).toLowerCase();
    const contentVerification =
      extension === ".zip"
        ? await verifyZipMakerArtifact(path, asarPath)
        : { verification: "signed-dmg-native-verification-required" };
    if (extension === ".dmg") {
      throw new Error(
        "DMG release verification is blocked until native mount, nested app identity, and stapled-ticket verification are implemented."
      );
    }
    evidence.push({
      path: portablePath(relative(rootDirectory, path)),
      bytes: (await stat(path)).size,
      sha256: await hashFile(path),
      ...contentVerification
    });
  }
  return evidence;
}

function verifySignedMacApplication(asarPath) {
  if (mode !== "signed") return;
  const appPath = packageRootForAsar(asarPath);
  if (process.platform !== "darwin" || !basename(appPath).endsWith(".app")) {
    throw new Error("Signed verification requires a packaged macOS app.");
  }
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], {
    stdio: "inherit"
  });
  execFileSync("spctl", ["--assess", "--type", "execute", appPath], {
    stdio: "inherit"
  });
}

assertManifestPolicy();
if (
  mode === "signed" &&
  manifest.collector.signedReleaseStatus !== "ready"
) {
  throw new Error(
    `Signed release blocked by collector state: ${manifest.collector.signedReleaseStatus}.`
  );
}
const appAsars = await findAppAsars();
if (appAsars.length !== 1) {
  throw new Error(`Expected exactly one packaged app.asar, found ${appAsars.length}.`);
}
const asarPath = appAsars[0];
const runtimeSnapshots = await verifyPackagePathsAndSnapshots(asarPath);
const collectorEvidence = await verifyCollectorExtraResource(asarPath);

const extractionDirectory = await mkdtemp(
  join(tmpdir(), "tokenmonster-package-verification-")
);
let inventory;
try {
  inventory = await assertAsarInventory(asarPath, extractionDirectory);
} finally {
  await rm(extractionDirectory, { force: true, recursive: true });
}
const binaryPath = fuseBinaryPath(asarPath);
const fuseWires = await verifyRawFuseWires(binaryPath);
verifySignedMacApplication(asarPath);
const makerArtifacts = await makerEvidence(asarPath);

const evidenceDirectory = join(rootDirectory, "release-evidence");
await mkdir(evidenceDirectory, { recursive: true });
const evidence = {
  schemaVersion: 1,
  mode,
  declaredSigned: mode === "signed",
  appAsar: {
    path: portablePath(relative(rootDirectory, asarPath)),
    bytes: (await stat(asarPath)).size,
    sha256: await hashFile(asarPath)
  },
  runtimeInventory: inventory,
  asarHeaderIntegrityVerified: true,
  runtimeExternalAllowlist: allowedBareImports,
  fuseWires,
  runtimeSnapshots,
  makerArtifacts,
  collector: collectorEvidence
};
await writeFile(
  join(evidenceDirectory, "companion-package.json"),
  `${JSON.stringify(evidence, null, 2)}\n`,
  { mode: 0o600 }
);

process.stdout.write(
  `Verified ${inventory.length} ASAR files, ${fuseWires.length} fuse wire(s), and ${makerArtifacts.length} maker artifact(s).\n`
);
process.stdout.write(
  `Verified ${collectorEvidence.target} collector ${collectorEvidence.packageVersion} with ${collectorEvidence.files.length} file(s) without executing it.\n`
);
