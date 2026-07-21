import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  parse as parsePath,
} from "node:path";
import type { Readable } from "node:stream";

import { open as openZipArchive, type Entry, type ZipFile } from "yauzl";
import { z } from "zod";

import {
  AssetReleaseManifestV2Schema,
  computeAssetReleaseManifestV2Sha256,
  type AssetReleaseManifestV2,
} from "./asset-release.js";

export const ASSET_PACK_DESCRIPTOR_SCHEMA_VERSION = "1" as const;
export const ASSET_PACK_ALLOWLIST_SCHEMA_VERSION = "1" as const;

/** Caps cover the planned 860-association release without allowing an open-ended archive. */
export const MAX_ASSET_PACK_TRANSFER_BYTES = 256 * 1_024 * 1_024;
export const MAX_ASSET_PACK_EXTRACTED_BYTES = 256 * 1_024 * 1_024;
export const MAX_ASSET_PACK_ENTRIES = 1_024;
export const DEFAULT_ASSET_PACK_TIMEOUT_MS = 120_000;
export const MAX_ASSET_PACK_TIMEOUT_MS = 300_000;

const MAX_TRANSFER_CHUNKS = 262_144;
const MAX_ENTRY_CHUNKS = 65_536;
const CACHE_PUBLICATION_LOCK_FILE = ".asset-pack-install.lock";
const CACHE_PUBLICATION_LOCK_RETRY_MS = 25;
const MAX_CACHE_PUBLICATION_LOCK_BYTES = 512;
const INSTALL_RESIDUE_SCHEMA_VERSION = "1" as const;
const INSTALL_LOCK_SOURCE_FILE = ".asset-pack-lock-owner-v1.json";
const INSTALL_STAGE_MARKER_FILE = ".asset-pack-stage-owner-v1.json";
const INSTALL_STAGE_NAME_PREFIX = ".asset-pack-stage-v1-";
const MAX_INSTALL_STAGE_MARKER_BYTES = 512;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INSTALL_STAGE_NAME_PATTERN =
  /^\.asset-pack-stage-v1-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const RELEASE_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const PACK_PATH_PATTERN =
  /^\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*\/packs\/[a-z0-9]+(?:[._-][a-z0-9]+)*\/[0-9a-f]{64}\.zip$/u;
const ZIP_EOCD_BYTES = 22;
const ZIP_LOCAL_HEADER_BYTES = 30;
const ZIP_LOCAL_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008;
const ZIP_ENCRYPTED_FLAG = 0x0001;
const ZIP_STRONG_ENCRYPTION_FLAG = 0x0040;
const ZIP_UNIX_PLATFORM = 3;
const ZIP_DOS_PLATFORM = 0;
const ZIP_UNIX_FILE_TYPE_MASK = 0o170000;
const ZIP_UNIX_REGULAR_FILE = 0o100000;
const ZIP_DOS_DIRECTORY_ATTRIBUTE = 0x10;
const ABORTED = Symbol("asset-pack-aborted");

const Sha256Schema = z.string().regex(SHA256_PATTERN);
const ReleaseIdSchema = z.string().min(1).max(120).regex(RELEASE_ID_PATTERN);
const InstallOwnerIdSchema = z.string().regex(UUID_PATTERN);
const InstallStageNameSchema = z.string().regex(INSTALL_STAGE_NAME_PATTERN);
const InstallStageMarkerSchema = z
  .object({
    schemaVersion: z.literal(INSTALL_RESIDUE_SCHEMA_VERSION),
    kind: z.literal("fixed-asset-pack-stage"),
    ownerId: InstallOwnerIdSchema,
    stageName: InstallStageNameSchema,
    releaseId: ReleaseIdSchema,
    packSha256: Sha256Schema,
  })
  .strict()
  .superRefine((marker, context) => {
    if (marker.stageName !== `${INSTALL_STAGE_NAME_PREFIX}${marker.ownerId}`) {
      context.addIssue({
        code: "custom",
        path: ["stageName"],
        message: "stage name must bind the owner ID",
      });
    }
  });
const InstallLockMarkerSchema = z
  .object({
    schemaVersion: z.literal(INSTALL_RESIDUE_SCHEMA_VERSION),
    kind: z.literal("fixed-asset-pack-lock"),
    ownerId: InstallOwnerIdSchema,
    stageName: InstallStageNameSchema,
    releaseId: ReleaseIdSchema,
    packSha256: Sha256Schema,
  })
  .strict()
  .superRefine((marker, context) => {
    if (marker.stageName !== `${INSTALL_STAGE_NAME_PREFIX}${marker.ownerId}`) {
      context.addIssue({
        code: "custom",
        path: ["stageName"],
        message: "stage name must bind the owner ID",
      });
    }
  });
type InstallStageMarker = Readonly<z.infer<typeof InstallStageMarkerSchema>>;
type InstallLockMarker = Readonly<z.infer<typeof InstallLockMarkerSchema>>;

// Production has one OS-backed runtime lease. This registry additionally
// protects concurrent calls inside that one process from treating each
// other's strictly marked stage/lock as crash residue.
const ACTIVE_INSTALL_OWNER_IDS = new Set<string>();

type ProcessLocalCacheMutex = {
  tail: Promise<void>;
  users: number;
};

// The OS-backed runtime lease excludes another live TokenMonster process.
// This keyed queue closes the remaining same-process pathname race without
// making independent cache roots wait for one another.
const PROCESS_LOCAL_CACHE_MUTEXES = new Map<
  string,
  ProcessLocalCacheMutex
>();

const HttpsOriginSchema = z.string().superRefine((value, context) => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    context.addIssue({ code: "custom", message: "origin must be a URL" });
    return;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.origin !== value
  ) {
    context.addIssue({
      code: "custom",
      message: "origin must be one canonical credential-free HTTPS origin",
    });
  }
});

export const AssetPackDescriptorV1Schema = z
  .object({
    schemaVersion: z.literal(ASSET_PACK_DESCRIPTOR_SCHEMA_VERSION),
    releaseId: ReleaseIdSchema,
    releaseManifestSha256: Sha256Schema,
    pack: z
      .object({
        path: z.string().max(512).regex(PACK_PATH_PATTERN),
        mediaType: z.literal("application/zip"),
        bytes: z
          .number()
          .int()
          .min(ZIP_EOCD_BYTES)
          .max(MAX_ASSET_PACK_TRANSFER_BYTES),
        sha256: Sha256Schema,
        entryCount: z.number().int().min(1).max(MAX_ASSET_PACK_ENTRIES),
        extractedBytes: z
          .number()
          .int()
          .min(1)
          .max(MAX_ASSET_PACK_EXTRACTED_BYTES),
      })
      .strict(),
  })
  .strict()
  .superRefine((descriptor, context) => {
    const expectedSuffix = `/packs/${descriptor.releaseId}/${descriptor.pack.sha256}.zip`;
    if (!descriptor.pack.path.endsWith(expectedSuffix)) {
      context.addIssue({
        code: "custom",
        path: ["pack", "path"],
        message:
          "pack path must bind an allowlisted namespace, release ID, and complete pack hash",
      });
    }
  });
export type AssetPackDescriptorV1 = Readonly<
  z.infer<typeof AssetPackDescriptorV1Schema>
>;

export const AssetPackAllowlistV1Schema = z
  .object({
    schemaVersion: z.literal(ASSET_PACK_ALLOWLIST_SCHEMA_VERSION),
    origin: HttpsOriginSchema,
    path: z.string().max(512).regex(PACK_PATH_PATTERN),
  })
  .strict();
export type AssetPackAllowlistV1 = Readonly<
  z.infer<typeof AssetPackAllowlistV1Schema>
>;

export type AssetPackErrorCode =
  | "invalid-configuration"
  | "release-binding-failed"
  | "request-aborted"
  | "request-timeout"
  | "network-error"
  | "redirect-rejected"
  | "response-rejected"
  | "transfer-limit-exceeded"
  | "pack-integrity-failed"
  | "archive-rejected"
  | "cache-write-failed";

const ERROR_MESSAGES: Readonly<Record<AssetPackErrorCode, string>> =
  Object.freeze({
    "invalid-configuration": "Invalid fixed asset pack configuration.",
    "release-binding-failed":
      "The fixed asset pack is not bound to the embedded release manifest.",
    "request-aborted": "The fixed asset pack request was aborted.",
    "request-timeout": "The fixed asset pack operation timed out.",
    "network-error": "The fixed asset pack request failed.",
    "redirect-rejected": "The fixed asset pack response attempted a redirect.",
    "response-rejected": "The fixed asset pack response was rejected.",
    "transfer-limit-exceeded":
      "The fixed asset pack exceeded its transfer limit.",
    "pack-integrity-failed":
      "The fixed asset pack did not match its immutable digest.",
    "archive-rejected": "The fixed asset pack archive was rejected.",
    "cache-write-failed": "The verified asset cache could not be updated.",
  });

/** Public errors are deliberately path-, URL-, and provider-response-free. */
export class AssetPackError extends Error {
  public readonly code: AssetPackErrorCode;

  public constructor(code: AssetPackErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "AssetPackError";
    this.code = code;
  }
}

export interface AssetPackFetchHeaders {
  get(name: string): string | null;
}

export interface AssetPackStreamReadResult {
  readonly done: boolean;
  readonly value?: Uint8Array;
}

export interface AssetPackStreamReader {
  read(): Promise<AssetPackStreamReadResult>;
  cancel?(reason?: unknown): Promise<void>;
}

export interface AssetPackResponseBody {
  getReader(): AssetPackStreamReader;
}

export interface AssetPackFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly redirected: boolean;
  readonly url: string;
  readonly headers: AssetPackFetchHeaders;
  readonly body: AssetPackResponseBody | null;
}

export interface AssetPackFetchRequestInit {
  readonly method: "GET";
  readonly redirect: "error";
  readonly credentials: "omit";
  readonly referrer: "";
  readonly referrerPolicy: "no-referrer";
  readonly cache: "no-store";
  readonly headers: Readonly<{
    Accept: "application/zip";
    "Accept-Encoding": "identity";
  }>;
  readonly signal: AbortSignal;
}

export type AssetPackFetch = (
  endpoint: string,
  init: AssetPackFetchRequestInit,
) => Promise<AssetPackFetchResponse>;

export interface InstallFixedAssetPackInput {
  readonly releaseManifest: unknown;
  readonly descriptor: unknown;
  readonly allowlist: unknown;
  readonly cacheDirectory: string;
  readonly fetch?: AssetPackFetch;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface RecoverFixedAssetPackCacheInput {
  readonly cacheDirectory: string;
}

export interface FixedAssetPackPlan {
  readonly releaseId: string;
  readonly url: string;
  readonly packPath: string;
  readonly packSha256: string;
  readonly packBytes: number;
  readonly entryPaths: ReadonlyArray<string>;
  readonly extractedBytes: number;
}

export interface InstalledFixedAssetPack {
  readonly releaseId: string;
  readonly packSha256: string;
  readonly entryPaths: ReadonlyArray<string>;
  readonly extractedBytes: number;
}

type ExpectedPackEntry = Readonly<{
  path: string;
  cacheFileName: string;
  bytes: number;
  sha256: string;
  mediaType: "image/webp" | "image/png" | "audio/wav";
}>;

type InternalPackPlan = Readonly<{
  publicPlan: FixedAssetPackPlan;
  descriptor: AssetPackDescriptorV1;
  entries: ReadonlyArray<ExpectedPackEntry>;
}>;

type NormalizedInstallInput = Readonly<{
  releaseManifest: unknown;
  descriptor: unknown;
  allowlist: unknown;
  cacheDirectory: string;
  fetch: AssetPackFetch;
  timeoutMs: number;
  signal: AbortSignal | undefined;
}>;

type ZipLayout = Readonly<{
  centralDirectoryOffset: number;
  endOfCentralDirectoryOffset: number;
}>;

type StagedEntry = Readonly<{
  expected: ExpectedPackEntry;
  path: string;
}>;

type CreatedCacheEntry = Readonly<{
  path: string;
  device: number;
  inode: number;
}>;

type CachePublicationLock = Readonly<{
  release: () => Promise<void>;
}>;

const INSTALL_INPUT_KEYS = new Set<PropertyKey>([
  "releaseManifest",
  "descriptor",
  "allowlist",
  "cacheDirectory",
  "fetch",
  "timeoutMs",
  "signal",
]);
const RECOVER_INPUT_KEYS = new Set<PropertyKey>(["cacheDirectory"]);

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPlainRecord(value: unknown): value is Record<PropertyKey, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function ownDataValue(
  object: Record<PropertyKey, unknown>,
  key: PropertyKey,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) {
    throw new AssetPackError("invalid-configuration");
  }
  return descriptor.value;
}

const nativeFetch: AssetPackFetch = async (endpoint, init) =>
  fetch(endpoint, {
    method: init.method,
    redirect: init.redirect,
    credentials: init.credentials,
    referrer: init.referrer,
    referrerPolicy: init.referrerPolicy,
    cache: init.cache,
    headers: init.headers,
    signal: init.signal,
  });

function isValidCacheDirectory(value: unknown): value is string {
  return (
    typeof value === "string" &&
    isAbsolute(value) &&
    normalize(value) === value &&
    basename(value) === "asset-cache" &&
    dirname(value) !== parsePath(value).root &&
    !value.includes("\0")
  );
}

function normalizeInstallInput(input: unknown): NormalizedInstallInput {
  if (
    !isPlainRecord(input) ||
    Reflect.ownKeys(input).some((key) => !INSTALL_INPUT_KEYS.has(key))
  ) {
    throw new AssetPackError("invalid-configuration");
  }
  for (const key of [
    "releaseManifest",
    "descriptor",
    "allowlist",
    "cacheDirectory",
  ] as const) {
    if (!Reflect.ownKeys(input).includes(key)) {
      throw new AssetPackError("invalid-configuration");
    }
  }
  const cacheDirectory = ownDataValue(input, "cacheDirectory");
  const fetchOption = ownDataValue(input, "fetch");
  const timeoutOption = ownDataValue(input, "timeoutMs");
  const signalOption = ownDataValue(input, "signal");
  if (
    !isValidCacheDirectory(cacheDirectory) ||
    (fetchOption !== undefined && typeof fetchOption !== "function") ||
    (timeoutOption !== undefined &&
      (typeof timeoutOption !== "number" ||
        !Number.isInteger(timeoutOption) ||
        timeoutOption < 1 ||
        timeoutOption > MAX_ASSET_PACK_TIMEOUT_MS)) ||
    (signalOption !== undefined && !(signalOption instanceof AbortSignal))
  ) {
    throw new AssetPackError("invalid-configuration");
  }
  return Object.freeze({
    releaseManifest: ownDataValue(input, "releaseManifest"),
    descriptor: ownDataValue(input, "descriptor"),
    allowlist: ownDataValue(input, "allowlist"),
    cacheDirectory,
    fetch: (fetchOption as AssetPackFetch | undefined) ?? nativeFetch,
    timeoutMs:
      (timeoutOption as number | undefined) ?? DEFAULT_ASSET_PACK_TIMEOUT_MS,
    signal: signalOption as AbortSignal | undefined,
  });
}

function normalizeRecoverInput(input: unknown): string {
  if (
    !isPlainRecord(input) ||
    Reflect.ownKeys(input).length !== RECOVER_INPUT_KEYS.size ||
    Reflect.ownKeys(input).some((key) => !RECOVER_INPUT_KEYS.has(key))
  ) {
    throw new AssetPackError("invalid-configuration");
  }
  const cacheDirectory = ownDataValue(input, "cacheDirectory");
  if (!isValidCacheDirectory(cacheDirectory)) {
    throw new AssetPackError("invalid-configuration");
  }
  return cacheDirectory;
}

function expectedEntriesFromManifest(
  manifest: AssetReleaseManifestV2,
): ReadonlyArray<ExpectedPackEntry> {
  const byPath = new Map<string, ExpectedPackEntry>();
  for (const asset of manifest.assets) {
    const output = asset.output;
    const entry = Object.freeze({
      path: output.path,
      cacheFileName: basename(output.path),
      bytes: output.bytes,
      sha256: output.sha256,
      mediaType: output.media.mediaType,
    });
    const existing = byPath.get(output.path);
    if (existing === undefined) {
      byPath.set(output.path, entry);
      continue;
    }
    if (
      existing.bytes !== entry.bytes ||
      existing.sha256 !== entry.sha256 ||
      existing.mediaType !== entry.mediaType ||
      existing.cacheFileName !== entry.cacheFileName
    ) {
      throw new AssetPackError("release-binding-failed");
    }
  }
  return Object.freeze(
    [...byPath.values()].sort((left, right) =>
      compareCodePoints(left.path, right.path),
    ),
  );
}

function buildInternalPackPlan(
  releaseManifestInput: unknown,
  descriptorInput: unknown,
  allowlistInput: unknown,
): InternalPackPlan {
  let manifest: AssetReleaseManifestV2;
  let descriptor: AssetPackDescriptorV1;
  let allowlist: AssetPackAllowlistV1;
  try {
    manifest = AssetReleaseManifestV2Schema.parse(releaseManifestInput);
    descriptor = AssetPackDescriptorV1Schema.parse(descriptorInput);
    allowlist = AssetPackAllowlistV1Schema.parse(allowlistInput);
  } catch {
    throw new AssetPackError("invalid-configuration");
  }

  const entries = expectedEntriesFromManifest(manifest);
  const extractedBytes = entries.reduce(
    (total, entry) => total + entry.bytes,
    0,
  );
  if (
    manifest.releaseId !== descriptor.releaseId ||
    computeAssetReleaseManifestV2Sha256(manifest) !==
      descriptor.releaseManifestSha256 ||
    allowlist.path !== descriptor.pack.path ||
    entries.length !== descriptor.pack.entryCount ||
    extractedBytes !== descriptor.pack.extractedBytes ||
    entries.length === 0 ||
    entries.length > MAX_ASSET_PACK_ENTRIES ||
    extractedBytes > MAX_ASSET_PACK_EXTRACTED_BYTES
  ) {
    throw new AssetPackError("release-binding-failed");
  }

  const url = new URL(allowlist.path, `${allowlist.origin}/`);
  if (
    url.origin !== allowlist.origin ||
    url.pathname !== allowlist.path ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new AssetPackError("release-binding-failed");
  }
  const publicPlan = Object.freeze({
    releaseId: descriptor.releaseId,
    url: url.href,
    packPath: descriptor.pack.path,
    packSha256: descriptor.pack.sha256,
    packBytes: descriptor.pack.bytes,
    entryPaths: Object.freeze(entries.map((entry) => entry.path)),
    extractedBytes,
  });
  return Object.freeze({ publicPlan, descriptor, entries });
}

/**
 * Build the only legal request and deterministic entry order. No character,
 * unlock, theme, pose, trigger, or usage state is accepted by this API.
 */
export function planFixedAssetPack(input: {
  readonly releaseManifest: unknown;
  readonly descriptor: unknown;
  readonly allowlist: unknown;
}): FixedAssetPackPlan {
  if (!isPlainRecord(input)) {
    throw new AssetPackError("invalid-configuration");
  }
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== 3 ||
    !keys.includes("releaseManifest") ||
    !keys.includes("descriptor") ||
    !keys.includes("allowlist")
  ) {
    throw new AssetPackError("invalid-configuration");
  }
  return buildInternalPackPlan(
    ownDataValue(input, "releaseManifest"),
    ownDataValue(input, "descriptor"),
    ownDataValue(input, "allowlist"),
  ).publicPlan;
}

function cancelReader(reader: AssetPackStreamReader): void {
  if (reader.cancel === undefined) return;
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // Connection release is best-effort; the public error remains sanitized.
  }
}

function discardResponseBody(response: AssetPackFetchResponse): void {
  try {
    if (response.body !== null) cancelReader(response.body.getReader());
  } catch {
    // Connection release is best-effort; the public error remains sanitized.
  }
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(ABORTED);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function validateFetchResponse(
  response: AssetPackFetchResponse,
  plan: InternalPackPlan,
): void {
  if (
    typeof response !== "object" ||
    response === null ||
    typeof response.ok !== "boolean" ||
    typeof response.status !== "number" ||
    !Number.isInteger(response.status) ||
    response.status < 100 ||
    response.status > 599 ||
    response.ok !== (response.status >= 200 && response.status <= 299) ||
    typeof response.redirected !== "boolean" ||
    typeof response.url !== "string" ||
    typeof response.headers?.get !== "function" ||
    (response.body !== null && typeof response.body.getReader !== "function")
  ) {
    throw new AssetPackError("network-error");
  }
  if (
    response.redirected ||
    (response.status >= 300 && response.status <= 399) ||
    response.url !== plan.publicPlan.url
  ) {
    discardResponseBody(response);
    throw new AssetPackError("redirect-rejected");
  }
  if (response.status !== 200 || !response.ok || response.body === null) {
    discardResponseBody(response);
    throw new AssetPackError("response-rejected");
  }

  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  const contentEncoding = response.headers.get("content-encoding");
  const rawLength = response.headers.get("content-length");
  if (
    contentType !== plan.descriptor.pack.mediaType ||
    (contentEncoding !== null && contentEncoding.toLowerCase() !== "identity")
  ) {
    discardResponseBody(response);
    throw new AssetPackError("response-rejected");
  }
  if (rawLength !== null) {
    if (!/^\d+$/u.test(rawLength)) {
      discardResponseBody(response);
      throw new AssetPackError("response-rejected");
    }
    const declaredLength = Number(rawLength);
    if (!Number.isSafeInteger(declaredLength)) {
      discardResponseBody(response);
      throw new AssetPackError("transfer-limit-exceeded");
    }
    if (declaredLength > MAX_ASSET_PACK_TRANSFER_BYTES) {
      discardResponseBody(response);
      throw new AssetPackError("transfer-limit-exceeded");
    }
    if (declaredLength !== plan.descriptor.pack.bytes) {
      discardResponseBody(response);
      throw new AssetPackError("response-rejected");
    }
  }
}

async function downloadAndVerifyPack(
  response: AssetPackFetchResponse,
  archivePath: string,
  plan: InternalPackPlan,
  signal: AbortSignal,
): Promise<void> {
  const body = response.body;
  if (body === null) throw new AssetPackError("response-rejected");
  let reader: AssetPackStreamReader;
  try {
    reader = body.getReader();
  } catch {
    throw new AssetPackError("network-error");
  }
  if (
    typeof reader !== "object" ||
    reader === null ||
    typeof reader.read !== "function" ||
    (reader.cancel !== undefined && typeof reader.cancel !== "function")
  ) {
    throw new AssetPackError("network-error");
  }
  const hash = createHash("sha256");
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let totalBytes = 0;
  let chunks = 0;
  try {
    try {
      handle = await open(archivePath, "wx", 0o600);
    } catch {
      throw new AssetPackError("cache-write-failed");
    }
    while (true) {
      let result: AssetPackStreamReadResult;
      try {
        result = await abortable(reader.read(), signal);
      } catch (error) {
        if (error === ABORTED) throw error;
        throw new AssetPackError("network-error");
      }
      if (result.done) break;
      if (
        !(result.value instanceof Uint8Array) ||
        result.value.byteLength === 0
      ) {
        throw new AssetPackError("network-error");
      }
      chunks += 1;
      totalBytes += result.value.byteLength;
      if (
        chunks > MAX_TRANSFER_CHUNKS ||
        totalBytes > MAX_ASSET_PACK_TRANSFER_BYTES ||
        totalBytes > plan.descriptor.pack.bytes
      ) {
        throw new AssetPackError("transfer-limit-exceeded");
      }
      const bytes = Buffer.from(result.value);
      hash.update(bytes);
      try {
        await handle.writeFile(bytes);
      } catch {
        throw new AssetPackError("cache-write-failed");
      }
    }
    if (
      totalBytes !== plan.descriptor.pack.bytes ||
      hash.digest("hex") !== plan.descriptor.pack.sha256
    ) {
      throw new AssetPackError("pack-integrity-failed");
    }
    try {
      await handle.sync();
      await handle.close();
      handle = null;
      await chmod(archivePath, 0o600);
    } catch {
      throw new AssetPackError("cache-write-failed");
    }
  } catch (error) {
    cancelReader(reader);
    throw error;
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
  }
}

async function readExactly(
  handle: Awaited<ReturnType<typeof open>>,
  length: number,
  position: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let totalRead = 0;
  while (totalRead < length) {
    const { bytesRead } = await handle.read(
      buffer,
      totalRead,
      length - totalRead,
      position + totalRead,
    );
    if (bytesRead === 0) throw new AssetPackError("archive-rejected");
    totalRead += bytesRead;
  }
  return buffer;
}

async function validateClassicZipLayout(
  archivePath: string,
  plan: InternalPackPlan,
): Promise<ZipLayout> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(archivePath, "r");
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size !== plan.descriptor.pack.bytes ||
      metadata.size < ZIP_EOCD_BYTES
    ) {
      throw new AssetPackError("archive-rejected");
    }
    const firstSignature = await readExactly(handle, 4, 0);
    if (firstSignature.readUInt32LE(0) !== ZIP_LOCAL_HEADER_SIGNATURE) {
      throw new AssetPackError("archive-rejected");
    }
    const eocdOffset = metadata.size - ZIP_EOCD_BYTES;
    const eocd = await readExactly(handle, ZIP_EOCD_BYTES, eocdOffset);
    if (
      eocd.readUInt32LE(0) !== ZIP_EOCD_SIGNATURE ||
      eocd.readUInt16LE(4) !== 0 ||
      eocd.readUInt16LE(6) !== 0 ||
      eocd.readUInt16LE(8) !== eocd.readUInt16LE(10) ||
      eocd.readUInt16LE(10) === 0xffff ||
      eocd.readUInt16LE(20) !== 0 ||
      eocd.readUInt32LE(12) === 0xffffffff ||
      eocd.readUInt32LE(16) === 0xffffffff ||
      eocd.readUInt16LE(10) !== plan.entries.length
    ) {
      throw new AssetPackError("archive-rejected");
    }
    if (eocdOffset >= 20) {
      const possibleZip64Locator = await readExactly(
        handle,
        4,
        eocdOffset - 20,
      );
      if (possibleZip64Locator.readUInt32LE(0) === ZIP64_LOCATOR_SIGNATURE) {
        throw new AssetPackError("archive-rejected");
      }
    }
    const centralDirectorySize = eocd.readUInt32LE(12);
    const centralDirectoryOffset = eocd.readUInt32LE(16);
    if (
      centralDirectorySize === 0 ||
      centralDirectoryOffset === 0 ||
      centralDirectoryOffset + centralDirectorySize !== eocdOffset
    ) {
      throw new AssetPackError("archive-rejected");
    }
    const centralSignature = await readExactly(
      handle,
      4,
      centralDirectoryOffset,
    );
    if (centralSignature.readUInt32LE(0) !== ZIP_CENTRAL_HEADER_SIGNATURE) {
      throw new AssetPackError("archive-rejected");
    }
    return Object.freeze({
      centralDirectoryOffset,
      endOfCentralDirectoryOffset: eocdOffset,
    });
  } catch (error) {
    if (error instanceof AssetPackError) throw error;
    throw new AssetPackError("archive-rejected");
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
  }
}

function openZip(path: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    openZipArchive(
      path,
      {
        autoClose: false,
        lazyEntries: true,
        decodeStrings: true,
        validateEntrySizes: true,
        strictFileNames: true,
      },
      (error, zip) => {
        if (error !== null) {
          reject(new AssetPackError("archive-rejected"));
          return;
        }
        resolve(zip);
      },
    );
  });
}

function nextZipEntry(zip: ZipFile): Promise<Entry | null> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      zip.removeListener("entry", onEntry);
      zip.removeListener("end", onEnd);
      zip.removeListener("error", onError);
    };
    const onEntry = (entry: Entry): void => {
      cleanup();
      resolve(entry);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(null);
    };
    const onError = (): void => {
      cleanup();
      reject(new AssetPackError("archive-rejected"));
    };
    zip.once("entry", onEntry);
    zip.once("end", onEnd);
    zip.once("error", onError);
    try {
      zip.readEntry();
    } catch {
      cleanup();
      reject(new AssetPackError("archive-rejected"));
    }
  });
}

function openZipEntryStream(zip: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error !== null) {
        reject(new AssetPackError("archive-rejected"));
        return;
      }
      resolve(stream);
    });
  });
}

function closeZip(zip: ZipFile): Promise<void> {
  if (!zip.isOpen) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      zip.removeListener("close", onClose);
      zip.removeListener("error", onError);
    };
    const onClose = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new AssetPackError("archive-rejected"));
    };
    zip.once("close", onClose);
    zip.once("error", onError);
    try {
      zip.close();
    } catch {
      cleanup();
      reject(new AssetPackError("archive-rejected"));
    }
  });
}

function validateEntryMetadata(
  entry: Entry,
  expected: ExpectedPackEntry,
): void {
  const platform = entry.versionMadeBy >>> 8;
  const unixMode = entry.externalFileAttributes >>> 16;
  if (
    entry.fileName !== expected.path ||
    entry.fileName.includes("\\") ||
    entry.fileName.startsWith("/") ||
    /^[A-Za-z]:/u.test(entry.fileName) ||
    entry.fileName
      .split("/")
      .some((part) => part === "" || part === "." || part === "..") ||
    entry.fileName.endsWith("/") ||
    entry.isEncrypted() ||
    (entry.generalPurposeBitFlag &
      (ZIP_ENCRYPTED_FLAG |
        ZIP_DATA_DESCRIPTOR_FLAG |
        ZIP_STRONG_ENCRYPTION_FLAG)) !==
      0 ||
    (entry.generalPurposeBitFlag & ~ZIP_UTF8_FLAG) !== 0 ||
    entry.versionNeededToExtract > 20 ||
    ![0, 8].includes(entry.compressionMethod) ||
    entry.extraFieldLength !== 0 ||
    entry.extraFields.length !== 0 ||
    entry.fileCommentLength !== 0 ||
    entry.comment !== "" ||
    entry.uncompressedSize !== expected.bytes ||
    entry.compressedSize > MAX_ASSET_PACK_TRANSFER_BYTES ||
    ![ZIP_DOS_PLATFORM, ZIP_UNIX_PLATFORM].includes(platform) ||
    (platform === ZIP_UNIX_PLATFORM &&
      (unixMode & ZIP_UNIX_FILE_TYPE_MASK) !== ZIP_UNIX_REGULAR_FILE) ||
    (platform === ZIP_DOS_PLATFORM &&
      (entry.externalFileAttributes & ZIP_DOS_DIRECTORY_ATTRIBUTE) !== 0) ||
    entry.extraFields.some((field) => field.id === 0x0001)
  ) {
    throw new AssetPackError("archive-rejected");
  }
}

async function validateLocalHeader(
  handle: Awaited<ReturnType<typeof open>>,
  entry: Entry,
  expected: ExpectedPackEntry,
  expectedOffset: number,
  centralDirectoryOffset: number,
): Promise<number> {
  if (entry.relativeOffsetOfLocalHeader !== expectedOffset) {
    throw new AssetPackError("archive-rejected");
  }
  const header = await readExactly(
    handle,
    ZIP_LOCAL_HEADER_BYTES,
    entry.relativeOffsetOfLocalHeader,
  );
  const fileNameLength = header.readUInt16LE(26);
  const extraFieldLength = header.readUInt16LE(28);
  const encodedExpectedPath = Buffer.from(expected.path, "utf8");
  if (
    header.readUInt32LE(0) !== ZIP_LOCAL_HEADER_SIGNATURE ||
    header.readUInt16LE(4) > 20 ||
    header.readUInt16LE(6) !== entry.generalPurposeBitFlag ||
    header.readUInt16LE(8) !== entry.compressionMethod ||
    header.readUInt32LE(14) !== entry.crc32 ||
    header.readUInt32LE(18) !== entry.compressedSize ||
    header.readUInt32LE(22) !== entry.uncompressedSize ||
    fileNameLength !== encodedExpectedPath.byteLength ||
    extraFieldLength !== 0
  ) {
    throw new AssetPackError("archive-rejected");
  }
  const localFileName = await readExactly(
    handle,
    fileNameLength,
    entry.relativeOffsetOfLocalHeader + ZIP_LOCAL_HEADER_BYTES,
  );
  if (!localFileName.equals(encodedExpectedPath)) {
    throw new AssetPackError("archive-rejected");
  }
  const dataEnd =
    entry.relativeOffsetOfLocalHeader +
    ZIP_LOCAL_HEADER_BYTES +
    fileNameLength +
    entry.compressedSize;
  if (dataEnd > centralDirectoryOffset) {
    throw new AssetPackError("archive-rejected");
  }
  return dataEnd;
}

function mediaSignatureMatches(
  mediaType: ExpectedPackEntry["mediaType"],
  header: Buffer,
): boolean {
  if (mediaType === "image/png") {
    return (
      header.length >= 8 &&
      header
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    );
  }
  if (mediaType === "image/webp") {
    return (
      header.length >= 12 &&
      header.subarray(0, 4).toString("ascii") === "RIFF" &&
      header.subarray(8, 12).toString("ascii") === "WEBP"
    );
  }
  return (
    header.length >= 12 &&
    header.subarray(0, 4).toString("ascii") === "RIFF" &&
    header.subarray(8, 12).toString("ascii") === "WAVE"
  );
}

async function extractEntry(
  zip: ZipFile,
  entry: Entry,
  expected: ExpectedPackEntry,
  stageDirectory: string,
  signal: AbortSignal,
): Promise<StagedEntry> {
  let stream: Readable;
  try {
    stream = await openZipEntryStream(zip, entry);
  } catch {
    throw new AssetPackError("archive-rejected");
  }
  const stagedPath = join(stageDirectory, expected.cacheFileName);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let bytesRead = 0;
  let chunksRead = 0;
  const headerChunks: Buffer[] = [];
  let headerBytes = 0;
  const hash = createHash("sha256");
  const onAbort = (): void => {
    stream.destroy(new Error("aborted"));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    handle = await open(stagedPath, "wx", 0o600);
    for await (const value of stream) {
      if (signal.aborted) throw ABORTED;
      if (!(value instanceof Uint8Array) || value.byteLength === 0) {
        throw new AssetPackError("archive-rejected");
      }
      chunksRead += 1;
      bytesRead += value.byteLength;
      if (
        chunksRead > MAX_ENTRY_CHUNKS ||
        bytesRead > expected.bytes ||
        bytesRead > MAX_ASSET_PACK_EXTRACTED_BYTES
      ) {
        throw new AssetPackError("archive-rejected");
      }
      const bytes = Buffer.from(value);
      if (headerBytes < 12) {
        const part = bytes.subarray(
          0,
          Math.min(bytes.length, 12 - headerBytes),
        );
        headerChunks.push(part);
        headerBytes += part.length;
      }
      hash.update(bytes);
      await handle.writeFile(bytes);
    }
    if (signal.aborted) throw ABORTED;
    if (
      bytesRead !== expected.bytes ||
      hash.digest("hex") !== expected.sha256 ||
      !mediaSignatureMatches(
        expected.mediaType,
        Buffer.concat(headerChunks, headerBytes),
      )
    ) {
      throw new AssetPackError("archive-rejected");
    }
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(stagedPath, 0o600);
    return Object.freeze({ expected, path: stagedPath });
  } catch (error) {
    stream.destroy();
    await rm(stagedPath, { force: true }).catch(() => undefined);
    if (error === ABORTED) throw error;
    if (error instanceof AssetPackError) throw error;
    throw new AssetPackError("archive-rejected");
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (handle !== null) await handle.close().catch(() => undefined);
  }
}

async function extractAndValidateArchive(
  archivePath: string,
  stageDirectory: string,
  plan: InternalPackPlan,
  layout: ZipLayout,
  signal: AbortSignal,
): Promise<ReadonlyArray<StagedEntry>> {
  let zip: ZipFile | null = null;
  let localHeaderHandle: Awaited<ReturnType<typeof open>> | null = null;
  const staged: StagedEntry[] = [];
  let centralDirectoryBytes = 0;
  let expectedLocalOffset = 0;
  let zipError = false;
  const recordZipError = (): void => {
    zipError = true;
  };
  try {
    zip = await openZip(archivePath);
    zip.on("error", recordZipError);
    localHeaderHandle = await open(archivePath, "r");
    if (
      zip.entryCount !== plan.entries.length ||
      zip.entryCount > MAX_ASSET_PACK_ENTRIES ||
      zip.comment !== ""
    ) {
      throw new AssetPackError("archive-rejected");
    }

    for (const expected of plan.entries) {
      if (signal.aborted) throw ABORTED;
      const entry = await nextZipEntry(zip);
      if (entry === null) throw new AssetPackError("archive-rejected");
      validateEntryMetadata(entry, expected);
      expectedLocalOffset = await validateLocalHeader(
        localHeaderHandle,
        entry,
        expected,
        expectedLocalOffset,
        layout.centralDirectoryOffset,
      );
      centralDirectoryBytes +=
        46 +
        entry.fileNameLength +
        entry.extraFieldLength +
        entry.fileCommentLength;
      staged.push(
        await extractEntry(zip, entry, expected, stageDirectory, signal),
      );
      if (zipError) throw new AssetPackError("archive-rejected");
    }
    const extra = await nextZipEntry(zip);
    if (
      extra !== null ||
      expectedLocalOffset !== layout.centralDirectoryOffset ||
      layout.centralDirectoryOffset + centralDirectoryBytes !==
        layout.endOfCentralDirectoryOffset ||
      staged.reduce((total, item) => total + item.expected.bytes, 0) !==
        plan.descriptor.pack.extractedBytes
    ) {
      throw new AssetPackError("archive-rejected");
    }
    return Object.freeze(staged);
  } catch (error) {
    if (error === ABORTED || error instanceof AssetPackError) throw error;
    throw new AssetPackError("archive-rejected");
  } finally {
    if (localHeaderHandle !== null) {
      await localHeaderHandle.close().catch(() => undefined);
    }
    if (zip !== null) {
      try {
        await closeZip(zip);
      } finally {
        zip.removeListener("error", recordZipError);
      }
    }
  }
}

async function verifyExistingCacheEntry(
  path: string,
  expected: ExpectedPackEntry,
): Promise<boolean> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new AssetPackError("cache-write-failed");
  }
  if (metadata.size !== expected.bytes) return false;
  const bytes = await readFile(path);
  return (
    createHash("sha256").update(bytes).digest("hex") === expected.sha256 &&
    mediaSignatureMatches(expected.mediaType, bytes.subarray(0, 12))
  );
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

async function canonicalExistingCacheDirectory(
  cacheDirectory: string,
): Promise<string | null> {
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(cacheDirectory);
  } catch (error) {
    if (isMissing(error)) return null;
    throw new AssetPackError("cache-write-failed");
  }
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new AssetPackError("cache-write-failed");
  }

  try {
    const canonicalPath = await realpath(cacheDirectory);
    const [after, canonical] = await Promise.all([
      lstat(cacheDirectory),
      lstat(canonicalPath),
    ]);
    if (
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      canonical.isSymbolicLink() ||
      !canonical.isDirectory() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      canonical.dev !== before.dev ||
      canonical.ino !== before.ino
    ) {
      throw new AssetPackError("cache-write-failed");
    }
    return canonicalPath;
  } catch (error) {
    if (error instanceof AssetPackError) throw error;
    throw new AssetPackError("cache-write-failed");
  }
}

async function canonicalCacheDirectoryForInstall(
  cacheDirectory: string,
): Promise<string> {
  try {
    await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
    const canonicalPath = await canonicalExistingCacheDirectory(cacheDirectory);
    if (canonicalPath === null) {
      throw new AssetPackError("cache-write-failed");
    }
    await chmod(canonicalPath, 0o700);
    return canonicalPath;
  } catch (error) {
    if (error instanceof AssetPackError) throw error;
    throw new AssetPackError("cache-write-failed");
  }
}

async function runWithProcessLocalCacheMutex<T>(
  canonicalCacheDirectory: string,
  operation: () => Promise<T>,
): Promise<T> {
  let mutex = PROCESS_LOCAL_CACHE_MUTEXES.get(canonicalCacheDirectory);
  if (mutex === undefined) {
    mutex = { tail: Promise.resolve(), users: 0 };
    PROCESS_LOCAL_CACHE_MUTEXES.set(canonicalCacheDirectory, mutex);
  }
  mutex.users += 1;
  const previous = mutex.tail;
  let release!: () => void;
  mutex.tail = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await operation();
  } finally {
    release();
    mutex.users -= 1;
    if (
      mutex.users === 0 &&
      PROCESS_LOCAL_CACHE_MUTEXES.get(canonicalCacheDirectory) === mutex
    ) {
      PROCESS_LOCAL_CACHE_MUTEXES.delete(canonicalCacheDirectory);
    }
  }
}

async function assertStableCanonicalCacheDirectory(
  requestedCacheDirectory: string,
  expectedCanonicalDirectory: string,
): Promise<void> {
  const current = await canonicalExistingCacheDirectory(
    requestedCacheDirectory,
  );
  if (current !== expectedCanonicalDirectory) {
    throw new AssetPackError("cache-write-failed");
  }
}

async function delayWithAbort(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw ABORTED;
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(ABORTED);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function stageMarkerForPlan(
  plan: InternalPackPlan,
  ownerId: string,
): InstallStageMarker {
  return Object.freeze({
    schemaVersion: INSTALL_RESIDUE_SCHEMA_VERSION,
    kind: "fixed-asset-pack-stage" as const,
    ownerId,
    stageName: `${INSTALL_STAGE_NAME_PREFIX}${ownerId}`,
    releaseId: plan.publicPlan.releaseId,
    packSha256: plan.publicPlan.packSha256,
  });
}

function lockMarkerForStage(marker: InstallStageMarker): InstallLockMarker {
  return Object.freeze({
    schemaVersion: INSTALL_RESIDUE_SCHEMA_VERSION,
    kind: "fixed-asset-pack-lock" as const,
    ownerId: marker.ownerId,
    stageName: marker.stageName,
    releaseId: marker.releaseId,
    packSha256: marker.packSha256,
  });
}

function serializedMarker(
  marker: InstallStageMarker | InstallLockMarker,
): string {
  return `${JSON.stringify(marker)}\n`;
}

async function parseStageMarker(
  path: string,
): Promise<InstallStageMarker | null> {
  try {
    const metadata = await lstat(path);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.size < 1 ||
      metadata.size > MAX_INSTALL_STAGE_MARKER_BYTES
    ) {
      return null;
    }
    const parsed = InstallStageMarkerSchema.safeParse(
      JSON.parse(await readFile(path, "utf8")) as unknown,
    );
    return parsed.success ? Object.freeze(parsed.data) : null;
  } catch {
    return null;
  }
}

async function recoverOwnedStage(
  cacheDirectory: string,
  stageName: string,
): Promise<void> {
  if (!INSTALL_STAGE_NAME_PATTERN.test(stageName)) return;
  const stagePath = join(cacheDirectory, stageName);
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(stagePath);
  } catch {
    return;
  }
  if (before.isSymbolicLink() || !before.isDirectory()) return;
  const marker = await parseStageMarker(
    join(stagePath, INSTALL_STAGE_MARKER_FILE),
  );
  if (
    marker === null ||
    marker.stageName !== stageName ||
    ACTIVE_INSTALL_OWNER_IDS.has(marker.ownerId)
  ) {
    return;
  }
  try {
    const after = await lstat(stagePath);
    if (
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      throw new AssetPackError("cache-write-failed");
    }
    // Only a directory with our exact owned-name shape and strict owner
    // marker reaches this recursive removal. Symlinks inside are unlinked, not
    // followed; unrelated cache-root entries are never selected.
    await rm(stagePath, { recursive: true, force: false });
  } catch (error) {
    if (error instanceof AssetPackError) throw error;
    throw new AssetPackError("cache-write-failed");
  }
}

async function recoverOwnedPublicationLock(lockPath: string): Promise<boolean> {
  let before: Awaited<ReturnType<typeof lstat>>;
  let raw: string;
  try {
    before = await lstat(lockPath);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.size < 1 ||
      before.size > MAX_CACHE_PUBLICATION_LOCK_BYTES
    ) {
      return false;
    }
    raw = await readFile(lockPath, "utf8");
  } catch (error) {
    if (isMissing(error)) return false;
    return false;
  }
  let input: unknown;
  try {
    input = JSON.parse(raw) as unknown;
  } catch {
    return false;
  }
  const parsed = InstallLockMarkerSchema.safeParse(input);
  if (!parsed.success || ACTIVE_INSTALL_OWNER_IDS.has(parsed.data.ownerId)) {
    return false;
  }
  try {
    const after = await lstat(lockPath);
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      (await readFile(lockPath, "utf8")) !== raw
    ) {
      return false;
    }
    await unlink(lockPath);
    return true;
  } catch (error) {
    if (isMissing(error)) return true;
    throw new AssetPackError("cache-write-failed");
  }
}

async function recoverOwnedInstallResidue(
  cacheDirectory: string,
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(cacheDirectory);
  } catch (error) {
    if (isMissing(error)) return;
    throw new AssetPackError("cache-write-failed");
  }
  for (const name of names.sort(compareCodePoints)) {
    await recoverOwnedStage(cacheDirectory, name);
  }
  await recoverOwnedPublicationLock(
    join(cacheDirectory, CACHE_PUBLICATION_LOCK_FILE),
  );
}

/**
 * Remove only strictly marked fixed-pack crash residue from an existing local
 * cache. This startup primitive performs no request and never creates a cache.
 */
export async function recoverFixedAssetPackCache(
  input: RecoverFixedAssetPackCacheInput,
): Promise<void> {
  const requestedCacheDirectory = normalizeRecoverInput(input);
  const canonicalCacheDirectory = await canonicalExistingCacheDirectory(
    requestedCacheDirectory,
  );
  if (canonicalCacheDirectory === null) return;

  await runWithProcessLocalCacheMutex(
    canonicalCacheDirectory,
    async (): Promise<void> => {
      await assertStableCanonicalCacheDirectory(
        requestedCacheDirectory,
        canonicalCacheDirectory,
      );
      await recoverOwnedInstallResidue(canonicalCacheDirectory);
    },
  );
}

async function acquireCachePublicationLock(
  cacheDirectory: string,
  signal: AbortSignal,
  marker: InstallLockMarker,
  stageDirectory: string,
): Promise<CachePublicationLock> {
  const lockPath = join(cacheDirectory, CACHE_PUBLICATION_LOCK_FILE);
  const owner = serializedMarker(marker);
  const lockSourcePath = join(stageDirectory, INSTALL_LOCK_SOURCE_FILE);
  let sourceHandle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    sourceHandle = await open(lockSourcePath, "wx", 0o600);
    const sourceMetadata = await sourceHandle.stat();
    if (!sourceMetadata.isFile()) {
      throw new AssetPackError("cache-write-failed");
    }
    await sourceHandle.writeFile(owner, "utf8");
    await sourceHandle.sync();
    await sourceHandle.close();
    sourceHandle = null;
    await chmod(lockSourcePath, 0o600);
  } catch (error) {
    if (sourceHandle !== null) {
      await sourceHandle.close().catch(() => undefined);
    }
    if (error instanceof AssetPackError) throw error;
    throw new AssetPackError("cache-write-failed");
  }
  while (true) {
    if (signal.aborted) throw ABORTED;
    let identity: Readonly<{ device: number; inode: number }> | null = null;
    try {
      // The lock pathname is linked only after the source marker is fully
      // written and fsynced. A crash can therefore leave either no lock or a
      // complete recoverable marker, never an empty/partial 120-second trap.
      await link(lockSourcePath, lockPath);
      const metadata = await lstat(lockPath);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new AssetPackError("cache-write-failed");
      }
      identity = Object.freeze({ device: metadata.dev, inode: metadata.ino });
      await chmod(lockPath, 0o600);
      if ((await readFile(lockPath, "utf8")) !== owner) {
        throw new AssetPackError("cache-write-failed");
      }
      if (signal.aborted) throw ABORTED;
      const acquiredIdentity = identity;
      return Object.freeze({
        release: async () => {
          try {
            const metadataAfter = await lstat(lockPath);
            if (
              metadataAfter.isSymbolicLink() ||
              !metadataAfter.isFile() ||
              metadataAfter.dev !== acquiredIdentity.device ||
              metadataAfter.ino !== acquiredIdentity.inode ||
              metadataAfter.size > MAX_CACHE_PUBLICATION_LOCK_BYTES ||
              (await readFile(lockPath, "utf8")) !== owner
            ) {
              throw new AssetPackError("cache-write-failed");
            }
            await unlink(lockPath);
          } catch (error) {
            if (isMissing(error)) {
              throw new AssetPackError("cache-write-failed");
            }
            if (error instanceof AssetPackError) throw error;
            throw new AssetPackError("cache-write-failed");
          }
        },
      });
    } catch (error) {
      if (identity !== null) {
        try {
          const metadataAfter = await lstat(lockPath);
          if (
            metadataAfter.dev === identity.device &&
            metadataAfter.ino === identity.inode
          ) {
            await unlink(lockPath);
          }
        } catch {
          // A failed exclusive creation is already surfaced below.
        }
      }
      if (error === ABORTED || error instanceof AssetPackError) throw error;
      if (!hasCode(error, "EEXIST")) {
        throw new AssetPackError("cache-write-failed");
      }
      // The process-wide owner registry protects an active same-runtime
      // publisher. The OS runtime lease excludes another live process, so an
      // exact inactive v1 marker is necessarily owned crash residue.
      if (await recoverOwnedPublicationLock(lockPath)) continue;
      await delayWithAbort(CACHE_PUBLICATION_LOCK_RETRY_MS, signal);
    }
  }
}

async function publishStagedEntries(
  staged: ReadonlyArray<StagedEntry>,
  cacheDirectory: string,
  signal: AbortSignal,
): Promise<ReadonlyArray<CreatedCacheEntry>> {
  const created: CreatedCacheEntry[] = [];
  try {
    for (const item of staged) {
      if (signal.aborted) throw ABORTED;
      const destination = join(cacheDirectory, item.expected.cacheFileName);
      let shouldPublish = true;
      try {
        if (await verifyExistingCacheEntry(destination, item.expected)) {
          await chmod(destination, 0o600);
          shouldPublish = false;
        } else {
          await unlink(destination);
        }
      } catch (error) {
        if (error instanceof AssetPackError) throw error;
        if (!isMissing(error)) throw error;
      }
      if (!shouldPublish) continue;

      try {
        await link(item.path, destination);
      } catch (error) {
        if (hasCode(error, "EEXIST")) {
          if (await verifyExistingCacheEntry(destination, item.expected)) {
            await chmod(destination, 0o600);
            continue;
          }
        }
        throw error;
      }
      const metadata = await lstat(destination);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new AssetPackError("cache-write-failed");
      }
      created.push({
        path: destination,
        device: metadata.dev,
        inode: metadata.ino,
      });
      if (signal.aborted) throw ABORTED;
    }
    try {
      const directoryHandle = await open(cacheDirectory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      if (!isUnsupportedDirectorySync(error)) throw error;
    }
    if (signal.aborted) throw ABORTED;
    return Object.freeze([...created]);
  } catch (error) {
    await rollbackCreatedCacheEntries(created);
    if (error === ABORTED) throw error;
    throw new AssetPackError("cache-write-failed");
  }
}

async function rollbackCreatedCacheEntries(
  entries: ReadonlyArray<CreatedCacheEntry>,
): Promise<void> {
  for (const item of [...entries].reverse()) {
    try {
      const metadata = await lstat(item.path);
      if (metadata.dev === item.device && metadata.ino === item.inode) {
        await unlink(item.path);
      }
    } catch {
      // Rollback is best-effort and never follows a replacement symlink.
    }
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  return ["EACCES", "EISDIR", "EINVAL", "ENOTSUP", "EPERM"].some((code) =>
    hasCode(error, code),
  );
}

async function writeStageMarker(
  stageDirectory: string,
  marker: InstallStageMarker,
): Promise<void> {
  const markerPath = join(stageDirectory, INSTALL_STAGE_MARKER_FILE);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(markerPath, "wx", 0o600);
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new AssetPackError("cache-write-failed");
    await handle.writeFile(serializedMarker(marker), "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(markerPath, 0o600);
  } catch (error) {
    if (handle !== null) await handle.close().catch(() => undefined);
    if (error instanceof AssetPackError) throw error;
    throw new AssetPackError("cache-write-failed");
  }
}

async function preparePrivateStage(
  cacheDirectory: string,
  marker: InstallStageMarker,
): Promise<string> {
  let stage: string | null = null;
  try {
    await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(cacheDirectory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new AssetPackError("cache-write-failed");
    }
    await chmod(cacheDirectory, 0o700);
    await recoverOwnedInstallResidue(cacheDirectory);
    stage = join(cacheDirectory, marker.stageName);
    await mkdir(stage, { mode: 0o700 });
    const stageMetadata = await lstat(stage);
    if (stageMetadata.isSymbolicLink() || !stageMetadata.isDirectory()) {
      throw new AssetPackError("cache-write-failed");
    }
    await chmod(stage, 0o700);
    await writeStageMarker(stage, marker);
    return stage;
  } catch (error) {
    if (stage !== null) {
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    }
    if (error instanceof AssetPackError) throw error;
    throw new AssetPackError("cache-write-failed");
  }
}

function requestInit(signal: AbortSignal): AssetPackFetchRequestInit {
  return Object.freeze({
    method: "GET",
    redirect: "error",
    credentials: "omit",
    referrer: "",
    referrerPolicy: "no-referrer",
    cache: "no-store",
    headers: Object.freeze({
      Accept: "application/zip",
      "Accept-Encoding": "identity",
    }),
    signal,
  });
}

async function installFixedAssetPackWithinCacheScope(
  normalized: NormalizedInstallInput,
  plan: InternalPackPlan,
  cacheDirectory: string,
): Promise<InstalledFixedAssetPack> {
  const ownerId = randomUUID();
  const stageMarker = stageMarkerForPlan(plan, ownerId);
  ACTIVE_INSTALL_OWNER_IDS.add(ownerId);
  let stageDirectory: string;
  try {
    stageDirectory = await preparePrivateStage(cacheDirectory, stageMarker);
  } catch (error) {
    ACTIVE_INSTALL_OWNER_IDS.delete(ownerId);
    throw error;
  }
  const archivePath = join(stageDirectory, `pack-${randomUUID()}.zip`);
  const controller = new AbortController();
  let timedOut = false;
  let callerAborted = false;
  const onCallerAbort = (): void => {
    callerAborted = true;
    controller.abort();
  };
  normalized.signal?.addEventListener("abort", onCallerAbort, { once: true });
  if ((normalized.signal as AbortSignal | undefined)?.aborted === true) {
    onCallerAbort();
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, normalized.timeoutMs);
  timer.unref();
  let publishedEntries: ReadonlyArray<CreatedCacheEntry> = Object.freeze([]);
  let publicationLock: CachePublicationLock | null = null;

  try {
    let response: AssetPackFetchResponse;
    try {
      response = await abortable(
        normalized.fetch(plan.publicPlan.url, requestInit(controller.signal)),
        controller.signal,
      );
    } catch (error) {
      if (timedOut) throw new AssetPackError("request-timeout");
      if (callerAborted || error === ABORTED) {
        throw new AssetPackError("request-aborted");
      }
      if (error instanceof AssetPackError) throw error;
      throw new AssetPackError("network-error");
    }
    try {
      validateFetchResponse(response, plan);
    } catch (error) {
      if (error instanceof AssetPackError) throw error;
      throw new AssetPackError("network-error");
    }
    await downloadAndVerifyPack(response, archivePath, plan, controller.signal);
    const layout = await validateClassicZipLayout(archivePath, plan);
    const staged = await extractAndValidateArchive(
      archivePath,
      stageDirectory,
      plan,
      layout,
      controller.signal,
    );
    if (controller.signal.aborted) throw ABORTED;
    publicationLock = await acquireCachePublicationLock(
      cacheDirectory,
      controller.signal,
      lockMarkerForStage(stageMarker),
      stageDirectory,
    );
    publishedEntries = await publishStagedEntries(
      staged,
      cacheDirectory,
      controller.signal,
    );
    if (controller.signal.aborted) throw ABORTED;
    return Object.freeze({
      releaseId: plan.publicPlan.releaseId,
      packSha256: plan.publicPlan.packSha256,
      entryPaths: plan.publicPlan.entryPaths,
      extractedBytes: plan.publicPlan.extractedBytes,
    });
  } catch (error) {
    await rollbackCreatedCacheEntries(publishedEntries);
    publishedEntries = Object.freeze([]);
    if (timedOut) throw new AssetPackError("request-timeout");
    if (callerAborted || error === ABORTED) {
      throw new AssetPackError("request-aborted");
    }
    if (error instanceof AssetPackError) throw error;
    throw new AssetPackError("archive-rejected");
  } finally {
    clearTimeout(timer);
    normalized.signal?.removeEventListener("abort", onCallerAbort);
    let finalizationFailed = false;
    try {
      await rm(stageDirectory, { recursive: true, force: true });
    } catch {
      await rollbackCreatedCacheEntries(publishedEntries);
      publishedEntries = Object.freeze([]);
      finalizationFailed = true;
    }
    if (publicationLock !== null) {
      try {
        await publicationLock.release();
      } catch {
        finalizationFailed = true;
      }
    }
    ACTIVE_INSTALL_OWNER_IDS.delete(ownerId);
    if (finalizationFailed) {
      throw new AssetPackError("cache-write-failed");
    }
  }
}

/**
 * Download and install one complete immutable pack. Consent remains outside
 * this primitive; the gateway-owned lifecycle is its only runtime caller.
 */
export async function installFixedAssetPack(
  input: InstallFixedAssetPackInput,
): Promise<InstalledFixedAssetPack> {
  const normalized = normalizeInstallInput(input);
  const plan = buildInternalPackPlan(
    normalized.releaseManifest,
    normalized.descriptor,
    normalized.allowlist,
  );
  if (normalized.signal?.aborted === true) {
    throw new AssetPackError("request-aborted");
  }

  const canonicalCacheDirectory = await canonicalCacheDirectoryForInstall(
    normalized.cacheDirectory,
  );
  return runWithProcessLocalCacheMutex(
    canonicalCacheDirectory,
    async (): Promise<InstalledFixedAssetPack> => {
      if (normalized.signal?.aborted === true) {
        throw new AssetPackError("request-aborted");
      }
      await assertStableCanonicalCacheDirectory(
        normalized.cacheDirectory,
        canonicalCacheDirectory,
      );
      return installFixedAssetPackWithinCacheScope(
        normalized,
        plan,
        canonicalCacheDirectory,
      );
    },
  );
}
