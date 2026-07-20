export function requireCanonicalCliVersion(
  value: unknown,
  label?: string,
): string;

export function resolveCliReleaseVersion(
  sourceVersion: unknown,
  options?: Readonly<{
    exactVersion?: string | null;
    versionSuffix?: string | null;
  }>,
): string;
