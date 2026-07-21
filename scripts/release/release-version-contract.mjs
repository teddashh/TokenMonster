// Browser- and Node-compatible authority for every public Windows release
// version. Keep this module free of Node built-ins: the desktop packager, CLI
// assembler, Cloudflare Worker, and browser-facing release parser all import
// these exact predicates.

const MAX_WINDOWS_VERSION_COMPONENT = 65_535n;
const WINDOWS_RELEASE_VERSION_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([A-Za-z][0-9A-Za-z-]*)(?:\.(0|[1-9][0-9]*))?)?$/u;

export function requireWindowsReleaseVersion(value, label = "release version") {
  const match =
    typeof value === "string"
      ? WINDOWS_RELEASE_VERSION_PATTERN.exec(value)
      : null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 64 ||
    value.includes("+") ||
    match === null ||
    /\d$/u.test(match[4] ?? "") ||
    [match[1], match[2], match[3], match[5]]
      .filter((part) => part !== undefined)
      .some((part) => BigInt(part) > MAX_WINDOWS_VERSION_COMPONENT)
  ) {
    throw new TypeError(
      `${label} must be strict Windows-compatible SemVer without build metadata`,
    );
  }
  return value;
}

export function requireReleaseVersionForSource(
  sourceVersion,
  releaseVersion,
  label = "release version",
) {
  const source = requireWindowsReleaseVersion(sourceVersion, "source version");
  if (source.includes("-")) {
    throw new TypeError("source version must be a stable SemVer base");
  }
  const release = requireWindowsReleaseVersion(releaseVersion, label);
  if (release !== source && !release.startsWith(`${source}-`)) {
    throw new TypeError(`${label} must use source base ${source}`);
  }
  return release;
}

export function ciWindowsReleaseVersionForRunId(sourceVersion, runId) {
  const source = requireReleaseVersionForSource(
    sourceVersion,
    sourceVersion,
    "source version",
  );
  if (
    typeof runId !== "string" ||
    runId.length > 20 ||
    !/^[1-9][0-9]*$/u.test(runId)
  ) {
    throw new TypeError("GITHUB_RUN_ID must be a positive decimal integer");
  }
  return requireReleaseVersionForSource(
    source,
    // Keep the stable source base intact. The terminal `x` makes the entire
    // run-id projection a non-numeric SemVer identifier, so Windows' 65535
    // numeric component ceiling never truncates a real GitHub run ID.
    `${source}-ci${runId}x`,
    "CI release version",
  );
}

function parsedWindowsReleaseVersion(value, label) {
  const version = requireWindowsReleaseVersion(value, label);
  const match = WINDOWS_RELEASE_VERSION_PATTERN.exec(version);
  if (match === null) {
    throw new TypeError(`${label} is not a release version`);
  }
  return Object.freeze({
    core: Object.freeze([BigInt(match[1]), BigInt(match[2]), BigInt(match[3])]),
    prereleaseLabel: match[4] ?? null,
    prereleaseNumber: match[5] === undefined ? null : BigInt(match[5]),
  });
}

function compareBigInts(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareWindowsReleaseVersions(left, right) {
  const leftVersion = parsedWindowsReleaseVersion(left, "left release version");
  const rightVersion = parsedWindowsReleaseVersion(
    right,
    "right release version",
  );
  for (let index = 0; index < leftVersion.core.length; index += 1) {
    const comparison = compareBigInts(
      leftVersion.core[index],
      rightVersion.core[index],
    );
    if (comparison !== 0) {
      return comparison;
    }
  }

  if (leftVersion.prereleaseLabel === null) {
    return rightVersion.prereleaseLabel === null ? 0 : 1;
  }
  if (rightVersion.prereleaseLabel === null) {
    return -1;
  }
  if (leftVersion.prereleaseLabel !== rightVersion.prereleaseLabel) {
    return leftVersion.prereleaseLabel < rightVersion.prereleaseLabel ? -1 : 1;
  }
  if (leftVersion.prereleaseNumber === null) {
    return rightVersion.prereleaseNumber === null ? 0 : -1;
  }
  if (rightVersion.prereleaseNumber === null) {
    return 1;
  }
  return compareBigInts(
    leftVersion.prereleaseNumber,
    rightVersion.prereleaseNumber,
  );
}

export function npmDistTagForReleaseVersion(value) {
  const version = requireWindowsReleaseVersion(value);
  return version.includes("-") ? "next" : "latest";
}

function requireIdentity(value, label) {
  if (typeof value !== "string" || value.length < 1) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

export function decideMonotonicReleaseTransition({
  currentVersion,
  candidateVersion,
  currentIdentity,
  candidateIdentity,
}) {
  const candidate = requireWindowsReleaseVersion(
    candidateVersion,
    "candidate release version",
  );
  const candidateBytes = requireIdentity(
    candidateIdentity,
    "candidate identity",
  );
  if (currentVersion === null) {
    if (currentIdentity !== null) {
      throw new TypeError("missing current version cannot have an identity");
    }
    return "advance";
  }

  const current = requireWindowsReleaseVersion(
    currentVersion,
    "current release version",
  );
  const currentBytes = requireIdentity(currentIdentity, "current identity");
  const comparison = compareWindowsReleaseVersions(candidate, current);
  if (comparison < 0) {
    throw new Error(
      `release downgrade is forbidden: ${candidate} is older than ${current}`,
    );
  }
  if (comparison > 0) {
    return "advance";
  }
  if (candidateBytes !== currentBytes) {
    throw new Error(`release ${candidate} already exists with different bytes`);
  }
  return "idempotent";
}
