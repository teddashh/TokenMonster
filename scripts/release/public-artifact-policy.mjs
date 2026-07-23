import { createHash } from "node:crypto";
import { extname } from "node:path";

import { inspectZstdPrebuildArchive } from "./audit-zstd-native-prebuild.mjs";
import {
  validateZstdNativePolicy,
  ZSTD_NATIVE_POLICY,
} from "./zstd-native-verifier.mjs";

export const PUBLIC_ASSET_AUTHORITY_ARCHIVE_ENTRY =
  "package/node_modules/@tokenmonster/characters/dist/approved-release-v2.json";
export const PUBLIC_ASSET_PACK_DESCRIPTOR_ARCHIVE_ENTRY =
  "package/node_modules/@tokenmonster/characters/dist/approved-asset-pack-descriptor-v1.json";
export const PUBLIC_ASSET_PACK_ALLOWLIST_ARCHIVE_ENTRY =
  "package/node_modules/@tokenmonster/characters/dist/approved-asset-pack-allowlist-v1.json";
export const PUBLIC_ASSET_AUTHORITY_ARCHIVE_ENTRIES = Object.freeze([
  PUBLIC_ASSET_PACK_ALLOWLIST_ARCHIVE_ENTRY,
  PUBLIC_ASSET_PACK_DESCRIPTOR_ARCHIVE_ENTRY,
  PUBLIC_ASSET_AUTHORITY_ARCHIVE_ENTRY,
]);
export const APPROVED_PUBLIC_ASSET_RELEASE = Object.freeze({
  releaseId: "ai-sister-media-11-voice55-2026.07.23",
  slotSha256: Object.freeze({
    releaseManifest:
      "67bbd62e82654d04c85caaec3c50171a1931e341fb83af3d86f6acd6c79cdf7e",
    descriptor:
      "7af3ba0a18bb12b8ef7652671954ec1e10778dbf542d74feece9b386c3d9b401",
    allowlist:
      "98732b1e975d7821c37d9ab5b96221a77df8494bb59d5ec6e9c9f39b51c580a8",
  }),
});
export const PUBLIC_EMBEDDED_STARTER_SOURCE_PACK = Object.freeze({
  url: "https://cdn.ted-h.com/tokenmonster/characters/v1/bootstrap/ai-sister-images-11-2026.07.21/99301d903406a5c800a0e6a258fc83ed48af522b3014e09fa1ff100fa6a6269b.zip",
  bytes: 417_332,
  sha256: "99301d903406a5c800a0e6a258fc83ed48af522b3014e09fa1ff100fa6a6269b",
});
const EMBEDDED_STARTER_ARCHIVE_PREFIX =
  "package/node_modules/@tokenmonster/characters/dist/embedded-starter-assets/";
export const PUBLIC_EMBEDDED_STARTER_ASSETS = Object.freeze(
  [
    {
      characterId: "chatgpt",
      kind: "outfit",
      themeId: "tech",
      objectPath:
        "objects/0a725ec07f71ddd4366aaae352532dbd7978c5673119a1826628f8c2c5f70314.webp",
      bytes: 63_198,
      sha256:
        "0a725ec07f71ddd4366aaae352532dbd7978c5673119a1826628f8c2c5f70314",
    },
    {
      characterId: "chatgpt",
      kind: "avatar",
      objectPath:
        "objects/2966f68a3e702c47a29d11c19b901a4d850a8914ec2b78252b617d757c04fca3.webp",
      bytes: 17_722,
      sha256:
        "2966f68a3e702c47a29d11c19b901a4d850a8914ec2b78252b617d757c04fca3",
    },
    {
      characterId: "grok",
      kind: "avatar",
      objectPath:
        "objects/41377cc281b8f5685628da087f82055cbf7806949b33dcc19c8814240c3d4995.webp",
      bytes: 15_012,
      sha256:
        "41377cc281b8f5685628da087f82055cbf7806949b33dcc19c8814240c3d4995",
    },
    {
      characterId: "gemini",
      kind: "outfit",
      themeId: "tech",
      objectPath:
        "objects/539f8fb9d004e8047ab80e0d66ce5b97d733613e7d189d0fca95bb2c8c518012.webp",
      bytes: 97_304,
      sha256:
        "539f8fb9d004e8047ab80e0d66ce5b97d733613e7d189d0fca95bb2c8c518012",
    },
    {
      characterId: "grok",
      kind: "outfit",
      themeId: "tech",
      objectPath:
        "objects/6ac1e5a8dfd219cb1119ff06b723e9babdff64bd042e033d452d590ce2ed071b.webp",
      bytes: 74_946,
      sha256:
        "6ac1e5a8dfd219cb1119ff06b723e9babdff64bd042e033d452d590ce2ed071b",
    },
    {
      characterId: "gemini",
      kind: "avatar",
      objectPath:
        "objects/c4fa29dbd7142705b3ef35477c86aa5372d6c66cc9ef6c5a3f7c55b2bac926ef.webp",
      bytes: 19_898,
      sha256:
        "c4fa29dbd7142705b3ef35477c86aa5372d6c66cc9ef6c5a3f7c55b2bac926ef",
    },
    {
      characterId: "claude",
      kind: "avatar",
      objectPath:
        "objects/f4b50a1ffa8f717a2717bd14551c84a2258b4985e3e8b7f4b18d6008a660f2ae.webp",
      bytes: 19_088,
      sha256:
        "f4b50a1ffa8f717a2717bd14551c84a2258b4985e3e8b7f4b18d6008a660f2ae",
    },
    {
      characterId: "claude",
      kind: "outfit",
      themeId: "tech",
      objectPath:
        "objects/fa39c624f4b1263b90a665230491f238f5a24d6fc91e39de0f169c8351345c73.webp",
      bytes: 108_302,
      sha256:
        "fa39c624f4b1263b90a665230491f238f5a24d6fc91e39de0f169c8351345c73",
    },
  ]
    .map((asset) =>
      Object.freeze({
        ...asset,
        archiveEntry: `${EMBEDDED_STARTER_ARCHIVE_PREFIX}${asset.objectPath}`,
      }),
    )
    .sort((left, right) =>
      left.archiveEntry < right.archiveEntry
        ? -1
        : left.archiveEntry > right.archiveEntry
          ? 1
          : 0,
    ),
);
export const PUBLIC_EMBEDDED_STARTER_ARCHIVE_ENTRIES = Object.freeze(
  PUBLIC_EMBEDDED_STARTER_ASSETS.map(({ archiveEntry }) => archiveEntry),
);
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
const PUBLIC_EMBEDDED_STARTER_ASSET_BY_ENTRY = new Map(
  PUBLIC_EMBEDDED_STARTER_ASSETS.map((asset) => [asset.archiveEntry, asset]),
);

const CHARACTERS_DIST_JSON_PREFIX =
  "package/node_modules/@tokenmonster/characters/dist/";
const PUBLIC_ASSET_AUTHORITY_ARCHIVE_ENTRY_SET = new Set(
  PUBLIC_ASSET_AUTHORITY_ARCHIVE_ENTRIES,
);

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
    !PUBLIC_ZSTD_PREBUILD_ARCHIVE_ENTRY_SET.has(entry) &&
    !PUBLIC_EMBEDDED_STARTER_ASSET_BY_ENTRY.has(entry)
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
    !PUBLIC_ASSET_AUTHORITY_ARCHIVE_ENTRY_SET.has(path)
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
  if (PUBLIC_EMBEDDED_STARTER_ASSET_BY_ENTRY.has(entry)) {
    requirePublicEmbeddedStarterAsset(entry, contents);
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

export function requirePublicEmbeddedStarterAsset(entry, contents) {
  requirePublicTarEntry(entry);
  const expected = PUBLIC_EMBEDDED_STARTER_ASSET_BY_ENTRY.get(entry);
  if (expected === undefined || !(contents instanceof Uint8Array)) {
    throw new Error("Release embedded starter asset is outside policy.");
  }
  if (contents.byteLength !== expected.bytes) {
    throw new Error("Release embedded starter asset size differs from policy.");
  }
  const bytes = Buffer.from(contents);
  if (
    bytes.subarray(0, 4).toString("ascii") !== "RIFF" ||
    bytes.subarray(8, 12).toString("ascii") !== "WEBP" ||
    createHash("sha256").update(bytes).digest("hex") !== expected.sha256
  ) {
    throw new Error("Release embedded starter asset bytes differ from policy.");
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

function requirePublicAssetPackSlot(
  entry,
  contents,
  expectedEntry,
  label,
  validateV1,
) {
  requirePublicStagedFile(entry, contents);
  if (entry !== expectedEntry) {
    throw new Error(`Release asset ${label} must use its one fixed path.`);
  }
  if (contents.byteLength > 64 * 1024) {
    throw new Error(`Release asset ${label} exceeds its size bound.`);
  }

  let value;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(contents),
    );
  } catch {
    throw new Error(`Release asset ${label} must be valid UTF-8 JSON.`);
  }
  if (value === null) return null;
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== "1"
  ) {
    throw new Error(`Release asset ${label} must be null or schema-v1.`);
  }
  if (typeof validateV1 !== "function") {
    throw new Error(`Release asset ${label} requires strict v1 validation.`);
  }
  return validateV1(value);
}

export function requirePublicAssetPackDescriptor(
  entry,
  contents,
  validateDescriptorV1,
) {
  return requirePublicAssetPackSlot(
    entry,
    contents,
    PUBLIC_ASSET_PACK_DESCRIPTOR_ARCHIVE_ENTRY,
    "pack descriptor",
    validateDescriptorV1,
  );
}

export function requirePublicAssetPackAllowlist(
  entry,
  contents,
  validateAllowlistV1,
) {
  return requirePublicAssetPackSlot(
    entry,
    contents,
    PUBLIC_ASSET_PACK_ALLOWLIST_ARCHIVE_ENTRY,
    "pack allowlist",
    validateAllowlistV1,
  );
}

/**
 * Validate the complete generated release slot set. A release may ship with
 * all three slots null, or with all three strictly validated and bound. A
 * partial configuration is a packaging error even though runtime resolution
 * would independently fail closed.
 */
export function requirePublicAssetReleaseSlots(contents, validators) {
  const releaseManifest = requirePublicAssetAuthority(
    PUBLIC_ASSET_AUTHORITY_ARCHIVE_ENTRY,
    contents.releaseManifest,
    validators.validateReleaseV2,
  );
  const descriptor = requirePublicAssetPackDescriptor(
    PUBLIC_ASSET_PACK_DESCRIPTOR_ARCHIVE_ENTRY,
    contents.descriptor,
    validators.validateDescriptorV1,
  );
  const allowlist = requirePublicAssetPackAllowlist(
    PUBLIC_ASSET_PACK_ALLOWLIST_ARCHIVE_ENTRY,
    contents.allowlist,
    validators.validateAllowlistV1,
  );
  const configuredCount = [releaseManifest, descriptor, allowlist].filter(
    (value) => value !== null,
  ).length;
  if (configuredCount === 0) return null;
  if (configuredCount !== 3) {
    throw new Error(
      "Release asset authority, pack descriptor, and pack allowlist must be all null or all configured.",
    );
  }
  if (typeof validators.validateBinding !== "function") {
    throw new Error("Release asset slots require strict cross-binding validation.");
  }
  validators.validateBinding({ releaseManifest, descriptor, allowlist });
  return Object.freeze({ releaseManifest, descriptor, allowlist });
}

/**
 * Bind a production CLI artifact to one deliberately reviewed, non-null
 * release slot set. Runtime parsing may remain fail-closed for all-null local
 * builds, but a public production artifact must never silently regress to it.
 */
export function requireApprovedPublicAssetRelease(contents) {
  const slots = [
    ["release manifest", contents.releaseManifest, "releaseManifest"],
    ["pack descriptor", contents.descriptor, "descriptor"],
    ["pack allowlist", contents.allowlist, "allowlist"],
  ];
  for (const [label, bytes, key] of slots) {
    if (!(bytes instanceof Uint8Array)) {
      throw new Error(`Approved public asset ${label} must contain bytes.`);
    }
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    if (actualSha256 !== APPROVED_PUBLIC_ASSET_RELEASE.slotSha256[key]) {
      throw new Error(
        `Approved public asset ${label} differs from the reviewed release policy.`,
      );
    }
  }
  return APPROVED_PUBLIC_ASSET_RELEASE;
}
