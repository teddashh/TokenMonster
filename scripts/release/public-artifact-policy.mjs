import { createHash } from "node:crypto";
import { extname } from "node:path";

import { inspectZstdPrebuildArchive } from "./audit-zstd-native-prebuild.mjs";
import {
  validateZstdNativePolicy,
  ZSTD_NATIVE_POLICY,
} from "./zstd-native-verifier.mjs";

export const PUBLIC_ASSET_AUTHORITY_ARCHIVE_ENTRY =
  "package/node_modules/@tokenmonster/characters/dist/approved-release-v2.json";
export const PUBLIC_ZSTD_PREINSTALL_ARCHIVE_ENTRY =
  "package/preinstall-zstd.cjs";
export const PUBLIC_ZSTD_PREINSTALL_COMMAND = "node preinstall-zstd.cjs";
// This executable runs during a consumer's npm install. Any change requires a
// fresh review and an intentional update to both of these byte authorities.
export const PUBLIC_ZSTD_PREINSTALL_BYTES = 34_332;
export const PUBLIC_ZSTD_PREINSTALL_SHA256 =
  "f4e82d7dd2b2fe9f38c484fa1824e376c194cfef6ae5bcf5f281df187009df03";

const PUBLIC_ZSTD_PACKAGE_PREFIX = "package/node_modules/@mongodb-js/zstd/";
const PUBLIC_ZSTD_PREBUILD_PREFIX = `${PUBLIC_ZSTD_PACKAGE_PREFIX}prebuilds/`;

export const PUBLIC_ZSTD_PREBUILD_ARCHIVE_ENTRIES = Object.freeze(
  Object.values(ZSTD_NATIVE_POLICY.platforms)
    .map((platform) => `${PUBLIC_ZSTD_PREBUILD_PREFIX}${platform.archiveName}`)
    .sort(),
);
const PUBLIC_ZSTD_PREBUILD_ARCHIVE_ENTRY_SET = new Set(
  PUBLIC_ZSTD_PREBUILD_ARCHIVE_ENTRIES,
);

const CHARACTERS_DIST_JSON_PREFIX =
  "package/node_modules/@tokenmonster/characters/dist/";

const FORBIDDEN_PUBLIC_EXTENSIONS = new Set([
  ".7z",
  ".avif",
  ".bmp",
  ".bz2",
  ".cur",
  ".dll",
  ".dmg",
  ".dylib",
  ".exe",
  ".flac",
  ".gif",
  ".gz",
  ".heic",
  ".heif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".m4a",
  ".map",
  ".mkv",
  ".mov",
  ".mp3",
  ".mp4",
  ".node",
  ".nupkg",
  ".ogg",
  ".otf",
  ".pdf",
  ".png",
  ".rar",
  ".so",
  ".svg",
  ".tar",
  ".tif",
  ".tiff",
  ".ttf",
  ".wasm",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".xz",
  ".zip",
]);
// Public release tarballs must extract to the same inventory on every
// supported filesystem. Keep this deliberately narrower than Unicode: npm's
// current package inventory needs ASCII letters/digits, scoped directories,
// and the separators commonly used by generated JavaScript and declaration
// files. A leading dot or hyphen is not present in the public inventory and is
// intentionally not accepted.
const PORTABLE_PUBLIC_TAR_COMPONENT =
  /^(?:@[A-Za-z0-9][A-Za-z0-9._+~-]*|[A-Za-z0-9_][A-Za-z0-9._+~-]*)$/u;
const MAX_PORTABLE_COMPONENT_LENGTH = 255;
const WINDOWS_RESERVED_BASENAME =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/;

function asciiLowercase(value) {
  return value.replace(/[A-Z]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 0x20),
  );
}

export function portablePublicTarEntryKey(entry) {
  requirePublicTarEntry(entry);
  const path = entry.endsWith("/") ? entry.slice(0, -1) : entry;
  // requirePublicTarEntry has already rejected every non-ASCII component.
  // Fold only ASCII A-Z so this collision key never pretends JavaScript's
  // Unicode lowercase operation is a filesystem case-folding authority.
  return asciiLowercase(path);
}

export function requirePublicTarEntry(entry) {
  if (
    typeof entry !== "string" ||
    entry.length < 1 ||
    entry.length > 4_096 ||
    /[\0-\x1f\x7f\\]/u.test(entry) ||
    entry.startsWith("/")
  ) {
    throw new Error("Release tarball contains an unsafe entry name.");
  }
  const directory = entry.endsWith("/");
  const path = directory ? entry.slice(0, -1) : entry;
  const segments = path.split("/");
  if (
    segments[0] !== "package" ||
    segments.some(
      (segment) =>
        segment.length < 1 ||
        segment.length > MAX_PORTABLE_COMPONENT_LENGTH ||
        segment === "." ||
        segment === ".." ||
        !PORTABLE_PUBLIC_TAR_COMPONENT.test(segment) ||
        /[ .]$/u.test(segment) ||
        WINDOWS_RESERVED_BASENAME.test(asciiLowercase(segment)),
    )
  ) {
    throw new Error(
      "Release tarball entries must use portable names below package/.",
    );
  }
  if (
    !directory &&
    FORBIDDEN_PUBLIC_EXTENSIONS.has(asciiLowercase(extname(path))) &&
    !PUBLIC_ZSTD_PREBUILD_ARCHIVE_ENTRY_SET.has(entry)
  ) {
    throw new Error(
      `Release tarball contains a forbidden binary asset: ${entry}`,
    );
  }
  if (
    !directory &&
    segments.length === 2 &&
    asciiLowercase(extname(path)) === ".cjs" &&
    entry !== PUBLIC_ZSTD_PREINSTALL_ARCHIVE_ENTRY
  ) {
    throw new Error(
      `Release tarball contains an unreviewed root script: ${entry}`,
    );
  }
  if (
    !directory &&
    path.startsWith(CHARACTERS_DIST_JSON_PREFIX) &&
    asciiLowercase(extname(path)) === ".json" &&
    path !== PUBLIC_ASSET_AUTHORITY_ARCHIVE_ENTRY
  ) {
    throw new Error(
      `Release tarball contains a non-authority character JSON: ${entry}`,
    );
  }
  return entry;
}

export function requirePublicStagedFile(
  entry,
  contents,
  policy = ZSTD_NATIVE_POLICY,
) {
  requirePublicTarEntry(entry);
  if (!(contents instanceof Uint8Array)) {
    throw new Error(
      `Release staging contains an unknown binary file: ${entry}`,
    );
  }
  if (PUBLIC_ZSTD_PREBUILD_ARCHIVE_ENTRY_SET.has(entry)) {
    requirePublicZstdPrebuildArchive(entry, contents, policy);
    return entry;
  }
  if (entry === PUBLIC_ZSTD_PREINSTALL_ARCHIVE_ENTRY) {
    requirePublicZstdPreinstallBootstrap(entry, contents);
    return entry;
  }
  if (contents.includes(0)) {
    throw new Error(
      `Release staging contains an unknown binary file: ${entry}`,
    );
  }
  return entry;
}

export function requirePublicZstdPreinstallBootstrap(entry, contents) {
  requirePublicTarEntry(entry);
  if (entry !== PUBLIC_ZSTD_PREINSTALL_ARCHIVE_ENTRY) {
    throw new Error("Release zstd preinstall must use its one fixed path.");
  }
  if (!(contents instanceof Uint8Array)) {
    throw new Error("Release zstd preinstall must contain script bytes.");
  }
  if (contents.byteLength !== PUBLIC_ZSTD_PREINSTALL_BYTES) {
    throw new Error("Release zstd preinstall byte length differs from policy.");
  }
  const bootstrapSha256 = createHash("sha256").update(contents).digest("hex");
  if (bootstrapSha256 !== PUBLIC_ZSTD_PREINSTALL_SHA256) {
    throw new Error("Release zstd preinstall SHA-256 differs from policy.");
  }
  return entry;
}

export function requirePublicZstdPrebuildArchive(
  entry,
  contents,
  policy = ZSTD_NATIVE_POLICY,
) {
  requirePublicTarEntry(entry);
  if (!PUBLIC_ZSTD_PREBUILD_ARCHIVE_ENTRY_SET.has(entry)) {
    throw new Error("Release zstd prebuild must use one fixed policy path.");
  }
  if (!(contents instanceof Uint8Array)) {
    throw new Error("Release zstd prebuild must contain archive bytes.");
  }
  const validatedPolicy = validateZstdNativePolicy(policy);
  const platform = Object.values(validatedPolicy.platforms).find(
    (candidate) =>
      `${PUBLIC_ZSTD_PREBUILD_PREFIX}${candidate.archiveName}` === entry,
  );
  if (platform === undefined) {
    throw new Error("Release zstd prebuild path differs from its policy.");
  }
  if (contents.byteLength !== platform.archiveBytes) {
    throw new Error("Release zstd prebuild byte length differs from policy.");
  }
  const archiveSha256 = createHash("sha256").update(contents).digest("hex");
  if (archiveSha256 !== platform.archiveSha256) {
    throw new Error("Release zstd prebuild SHA-256 differs from policy.");
  }
  inspectZstdPrebuildArchive(contents, platform);
  return entry;
}

export function requirePublicAssetAuthority(
  entry,
  contents,
  validateReleaseV2,
) {
  requirePublicStagedFile(entry, contents);
  if (entry !== PUBLIC_ASSET_AUTHORITY_ARCHIVE_ENTRY) {
    throw new Error("Release asset authority must use its one fixed path.");
  }
  if (contents.byteLength > 32 * 1024 * 1024) {
    throw new Error("Release asset authority exceeds its size bound.");
  }

  let authority;
  try {
    authority = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(contents),
    );
  } catch {
    throw new Error("Release asset authority must be valid UTF-8 JSON.");
  }
  if (authority === null) return null;
  if (
    typeof authority !== "object" ||
    Array.isArray(authority) ||
    authority.schemaVersion !== "2"
  ) {
    throw new Error("Release asset authority must be null or schema-v2.");
  }
  if (typeof validateReleaseV2 !== "function") {
    throw new Error("Release asset authority requires strict v2 validation.");
  }
  return validateReleaseV2(authority);
}
