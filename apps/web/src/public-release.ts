import { requireWindowsReleaseVersion } from "../../../scripts/release/release-version-contract.mjs";

export const PUBLIC_RELEASE_ENDPOINT = "/v1/releases/current";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MIN_INSTALLER_BYTES = 1 * 1_024 * 1_024;
const MAX_INSTALLER_BYTES = 512 * 1_024 * 1_024;

export interface PublicReleaseSnapshot {
  readonly contractVersion: 1;
  readonly platform: "windows-x64";
  readonly version: string;
  readonly downloadUrl: string;
  readonly sha256: string;
  readonly bytes: number;
}

export type PublicReleaseState =
  | Readonly<{ readonly status: "loading" }>
  | Readonly<{ readonly status: "unavailable" }>
  | Readonly<{
      readonly status: "available";
      readonly snapshot: PublicReleaseSnapshot;
    }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    [...expected].sort().every((key, index) => actual[index] === key)
  );
}

function validVersion(value: unknown): value is string {
  try {
    requireWindowsReleaseVersion(value, "public release version");
    return true;
  } catch {
    return false;
  }
}

function validDownloadUrl(value: unknown, version: string): value is string {
  if (typeof value !== "string" || value.length > 512) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "cdn.ted-h.com" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.pathname ===
        `/tokenmonster/releases/windows/v${version}/TokenMonsterSetup.exe`
    );
  } catch {
    return false;
  }
}

export function parsePublicReleaseSnapshot(
  value: unknown,
): PublicReleaseSnapshot {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "contractVersion",
      "platform",
      "version",
      "downloadUrl",
      "sha256",
      "bytes",
    ]) ||
    value["contractVersion"] !== 1 ||
    value["platform"] !== "windows-x64" ||
    !validVersion(value["version"]) ||
    !validDownloadUrl(value["downloadUrl"], value["version"]) ||
    typeof value["sha256"] !== "string" ||
    !SHA256_PATTERN.test(value["sha256"]) ||
    typeof value["bytes"] !== "number" ||
    !Number.isSafeInteger(value["bytes"]) ||
    value["bytes"] < MIN_INSTALLER_BYTES ||
    value["bytes"] > MAX_INSTALLER_BYTES
  ) {
    throw new TypeError("Invalid public release snapshot");
  }
  return Object.freeze({
    contractVersion: 1,
    platform: "windows-x64",
    version: value["version"],
    downloadUrl: value["downloadUrl"],
    sha256: value["sha256"],
    bytes: value["bytes"],
  });
}

export function publicReleaseFromEnvironment(
  environment: unknown,
): PublicReleaseSnapshot {
  if (!isRecord(environment)) {
    throw new TypeError("Invalid public release environment");
  }
  const raw = environment["TOKENMONSTER_PUBLIC_RELEASE_JSON"];
  if (typeof raw !== "string" || raw.length < 2 || raw.length > 1_024) {
    throw new TypeError("Invalid public release environment");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new TypeError("Invalid public release environment");
  }
  const snapshot = parsePublicReleaseSnapshot(parsed);
  if (JSON.stringify(snapshot) !== raw) {
    throw new TypeError("Public release JSON must use canonical encoding");
  }
  return snapshot;
}

export async function fetchPublicRelease(
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<PublicReleaseSnapshot> {
  const response = await fetcher(PUBLIC_RELEASE_ENDPOINT, {
    method: "GET",
    credentials: "same-origin",
    redirect: "error",
    headers: { Accept: "application/json" },
    ...(signal === undefined ? {} : { signal }),
  });
  if (
    response.status !== 200 ||
    response.headers.get("content-type")?.split(";", 1)[0]?.trim() !==
      "application/json"
  ) {
    throw new TypeError("Public release is unavailable");
  }
  return parsePublicReleaseSnapshot(await response.json());
}
