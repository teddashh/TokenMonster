import {
  requireReleaseVersionForSource,
  requireWindowsReleaseVersion,
} from "./release-version-contract.mjs";

export function requireCanonicalCliVersion(
  value,
  label = "CLI release version",
) {
  return requireWindowsReleaseVersion(value, label);
}

export function resolveCliReleaseVersion(
  sourceVersion,
  { exactVersion = null, versionSuffix = null } = {},
) {
  const source = requireCanonicalCliVersion(
    sourceVersion,
    "CLI source version",
  );
  if (source.includes("-")) {
    throw new Error("CLI source version must be a stable SemVer base");
  }
  if (exactVersion !== null && versionSuffix !== null) {
    throw new Error("--version and --version-suffix are mutually exclusive");
  }

  const candidate =
    exactVersion ??
    (versionSuffix === null ? source : `${source}-${versionSuffix}`);
  return requireReleaseVersionForSource(
    source,
    candidate,
    "CLI release version",
  );
}
