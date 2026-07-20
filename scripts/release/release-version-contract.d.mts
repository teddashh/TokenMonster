export function requireWindowsReleaseVersion(
  value: unknown,
  label?: string,
): string;

export function requireReleaseVersionForSource(
  sourceVersion: unknown,
  releaseVersion: unknown,
  label?: string,
): string;

export function ciWindowsReleaseVersionForRunId(
  sourceVersion: unknown,
  runId: unknown,
): string;

export function compareWindowsReleaseVersions(
  left: unknown,
  right: unknown,
): -1 | 0 | 1;

export function npmDistTagForReleaseVersion(value: unknown): "latest" | "next";

export function decideMonotonicReleaseTransition(
  options: Readonly<{
    currentVersion: string | null;
    candidateVersion: unknown;
    currentIdentity: string | null;
    candidateIdentity: unknown;
  }>,
): "advance" | "idempotent";
