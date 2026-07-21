import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";

import {
  AssetReleaseManifestV2Schema,
  parseAssetManifest,
  projectAssetReleaseManifestV2ToRuntimeManifest,
  type ApprovedAssetPackConfiguration,
  type AssetManifest,
  type AssetReleaseManifestV2,
} from "@tokenmonster/characters";
import {
  AssetPackAllowlistV1Schema,
  AssetPackDescriptorV1Schema,
  AssetPackError,
  installFixedAssetPack,
  planFixedAssetPack,
  recoverFixedAssetPackCache,
  type AssetPackAllowlistV1,
  type AssetPackDescriptorV1,
  type InstallFixedAssetPackInput,
  type RecoverFixedAssetPackCacheInput,
} from "@tokenmonster/characters/asset-pack";

import type {
  CompanionAssetPackError,
  CompanionAssetPackPhase,
  CompanionAssetPackStatusResponse,
} from "./types.js";

export const ASSET_PACK_CONSENT_FILE = "asset-pack-consent-v1.json";

const CONSENT_SCHEMA_VERSION = "1" as const;
const CONFIGURATION_KEYS = Object.freeze([
  "releaseManifest",
  "descriptor",
  "allowlist",
] as const);

interface NormalizedAssetPackConfiguration {
  readonly releaseManifest: AssetReleaseManifestV2;
  readonly descriptor: AssetPackDescriptorV1;
  readonly allowlist: AssetPackAllowlistV1;
  readonly runtimeManifest: AssetManifest;
  readonly releaseId: string;
  readonly downloadBytes: number;
}

interface ConsentState {
  readonly schemaVersion: typeof CONSENT_SCHEMA_VERSION;
  readonly releaseId: string;
  readonly consented: boolean;
}

export interface AssetPackService {
  initialize(): Promise<CompanionAssetPackStatusResponse>;
  getStatus(): CompanionAssetPackStatusResponse;
  setEnabled(enabled: boolean): Promise<CompanionAssetPackStatusResponse>;
  close(): Promise<void>;
}

interface AssetPackServiceOptions {
  readonly configuration: ApprovedAssetPackConfiguration | null;
  readonly cacheDirectory: string;
  readonly progressionStorePath: string;
  readonly setActiveManifest: (manifest: AssetManifest | null) => void;
}

interface AssetPackServiceDependencies {
  readonly recoverCache: (
    input: RecoverFixedAssetPackCacheInput,
  ) => ReturnType<typeof recoverFixedAssetPackCache>;
  readonly install: (
    input: InstallFixedAssetPackInput,
  ) => ReturnType<typeof installFixedAssetPack>;
  readonly cacheIsComplete: (
    configuration: NormalizedAssetPackConfiguration,
    cacheDirectory: string,
  ) => Promise<boolean>;
  readonly removeCache: (
    configuration: NormalizedAssetPackConfiguration,
    cacheDirectory: string,
  ) => Promise<void>;
}

function isPlainRecord(value: unknown): value is Record<PropertyKey, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<PropertyKey, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => keys.includes(key))
  );
}

export function normalizeAssetPackConfiguration(
  value: unknown,
): NormalizedAssetPackConfiguration | null {
  if (value === null || value === undefined) return null;
  if (!isPlainRecord(value) || !hasExactKeys(value, CONFIGURATION_KEYS)) {
    throw new Error("invalid asset pack configuration");
  }
  const release = AssetReleaseManifestV2Schema.safeParse(
    value["releaseManifest"],
  );
  const descriptor = AssetPackDescriptorV1Schema.safeParse(value["descriptor"]);
  const allowlist = AssetPackAllowlistV1Schema.safeParse(value["allowlist"]);
  if (!release.success || !descriptor.success || !allowlist.success) {
    throw new Error("invalid asset pack configuration");
  }
  try {
    const plan = planFixedAssetPack({
      releaseManifest: release.data,
      descriptor: descriptor.data,
      allowlist: allowlist.data,
    });
    const runtimeManifest = parseAssetManifest(
      projectAssetReleaseManifestV2ToRuntimeManifest(release.data),
    );
    return Object.freeze({
      releaseManifest: release.data,
      descriptor: descriptor.data,
      allowlist: allowlist.data,
      runtimeManifest,
      releaseId: plan.releaseId,
      downloadBytes: plan.packBytes,
    });
  } catch {
    throw new Error("invalid asset pack configuration");
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function mediaSignatureMatches(
  mediaType: "image/webp" | "image/png" | "audio/wav",
  bytes: Uint8Array,
): boolean {
  if (mediaType === "image/png") {
    return Buffer.from(bytes.subarray(0, 8)).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  }
  if (mediaType === "image/webp") {
    return (
      Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
      Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
    );
  }
  return (
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WAVE"
  );
}

function uniqueOutputs(configuration: NormalizedAssetPackConfiguration) {
  return new Map(
    configuration.releaseManifest.assets.map((asset) => [
      asset.output.path,
      asset.output,
    ]),
  );
}

async function verifiedCacheIsComplete(
  configuration: NormalizedAssetPackConfiguration,
  cacheDirectory: string,
): Promise<boolean> {
  for (const output of uniqueOutputs(configuration).values()) {
    const path = join(cacheDirectory, basename(output.path));
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.size !== output.bytes
    ) {
      return false;
    }
    const bytes = await readFile(path);
    if (
      createHash("sha256").update(bytes).digest("hex") !== output.sha256 ||
      !mediaSignatureMatches(output.media.mediaType, bytes.subarray(0, 12))
    ) {
      return false;
    }
  }
  return true;
}

async function removeExactCache(
  configuration: NormalizedAssetPackConfiguration,
  cacheDirectory: string,
): Promise<void> {
  for (const output of uniqueOutputs(configuration).values()) {
    const path = join(cacheDirectory, basename(output.path));
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() && !metadata.isSymbolicLink()) {
        throw new Error("asset cache entry is not removable");
      }
      await unlink(path);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

const DEFAULT_DEPENDENCIES: AssetPackServiceDependencies = Object.freeze({
  recoverCache: recoverFixedAssetPackCache,
  install: installFixedAssetPack,
  cacheIsComplete: verifiedCacheIsComplete,
  removeCache: removeExactCache,
});

function consentPath(progressionStorePath: string): string {
  return join(dirname(progressionStorePath), ASSET_PACK_CONSENT_FILE);
}

function parseConsentState(
  input: unknown,
  releaseId: string,
): ConsentState {
  if (
    !isPlainRecord(input) ||
    !hasExactKeys(input, ["schemaVersion", "releaseId", "consented"]) ||
    input["schemaVersion"] !== CONSENT_SCHEMA_VERSION ||
    input["releaseId"] !== releaseId ||
    typeof input["consented"] !== "boolean"
  ) {
    throw new Error("invalid asset pack consent state");
  }
  return Object.freeze({
    schemaVersion: CONSENT_SCHEMA_VERSION,
    releaseId,
    consented: input["consented"],
  });
}

async function loadConsentState(
  path: string,
  releaseId: string,
): Promise<ConsentState> {
  try {
    const metadata = await lstat(path);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.size < 1 ||
      metadata.size > 512
    ) {
      throw new Error("invalid asset pack consent state");
    }
    return parseConsentState(
      JSON.parse(await readFile(path, "utf8")) as unknown,
      releaseId,
    );
  } catch (error) {
    if (isMissing(error)) {
      return Object.freeze({
        schemaVersion: CONSENT_SCHEMA_VERSION,
        releaseId,
        consented: false,
      });
    }
    throw error;
  }
}

async function saveConsentState(
  path: string,
  state: ConsentState,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function unavailableStatus(): CompanionAssetPackStatusResponse {
  return Object.freeze({
    status: "ok",
    phase: "unavailable",
    consented: false,
    enabled: false,
    releaseId: null,
    downloadBytes: null,
    lastError: null,
  });
}

function configuredStatus(
  configuration: NormalizedAssetPackConfiguration,
  phase: Exclude<CompanionAssetPackPhase, "unavailable">,
  consented: boolean,
  enabled: boolean,
  lastError: CompanionAssetPackError | null,
): CompanionAssetPackStatusResponse {
  return Object.freeze({
    status: "ok",
    phase,
    consented,
    enabled,
    releaseId: configuration.releaseId,
    downloadBytes: configuration.downloadBytes,
    lastError,
  });
}

function validateServiceOptions(options: AssetPackServiceOptions): void {
  if (
    typeof options.setActiveManifest !== "function" ||
    typeof options.cacheDirectory !== "string" ||
    !isAbsolute(options.cacheDirectory) ||
    normalize(options.cacheDirectory) !== options.cacheDirectory ||
    (options.configuration !== null &&
      basename(options.cacheDirectory) !== "asset-cache") ||
    typeof options.progressionStorePath !== "string" ||
    !isAbsolute(options.progressionStorePath)
  ) {
    throw new Error("invalid asset pack service options");
  }
}

export function createAssetPackService(
  options: AssetPackServiceOptions,
  dependencies: AssetPackServiceDependencies = DEFAULT_DEPENDENCIES,
): AssetPackService {
  validateServiceOptions(options);
  const configuration = normalizeAssetPackConfiguration(options.configuration);
  const stateFile = consentPath(options.progressionStorePath);
  let initialized = false;
  let closed = false;
  let consented = false;
  let activeInstall: AbortController | null = null;
  let status = unavailableStatus();
  let mutation = Promise.resolve();

  const serialize = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = mutation;
    let release!: () => void;
    mutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const initializeInternal = async (): Promise<void> => {
    if (initialized) return;
    initialized = true;
    if (configuration === null) {
      status = unavailableStatus();
      return;
    }
    options.setActiveManifest(null);
    let localStateAvailable = true;
    try {
      consented = (await loadConsentState(stateFile, configuration.releaseId))
        .consented;
    } catch {
      consented = false;
      localStateAvailable = false;
    }
    try {
      await dependencies.recoverCache({
        cacheDirectory: options.cacheDirectory,
      });
    } catch {
      status = configuredStatus(
        configuration,
        "repair-needed",
        consented,
        false,
        "cache-unavailable",
      );
      return;
    }
    if (!localStateAvailable) {
      status = configuredStatus(
        configuration,
        "available",
        false,
        false,
        "local-state-unavailable",
      );
      return;
    }
    if (!consented) {
      // A previous revoke may have persisted before one or more cache files
      // could be removed (for example while an antivirus scanner held a file
      // open on Windows).  Reconcile those exact release objects on every
      // non-consented startup so the player always has an in-product recovery
      // path and a transient delete failure is not forgotten after restart.
      try {
        await dependencies.removeCache(
          configuration,
          options.cacheDirectory,
        );
        status = configuredStatus(
          configuration,
          "available",
          false,
          false,
          null,
        );
      } catch {
        status = configuredStatus(
          configuration,
          "repair-needed",
          false,
          false,
          "cache-unavailable",
        );
      }
      return;
    }
    try {
      if (
        await dependencies.cacheIsComplete(
          configuration,
          options.cacheDirectory,
        )
      ) {
        options.setActiveManifest(configuration.runtimeManifest);
        status = configuredStatus(
          configuration,
          "installed",
          true,
          true,
          null,
        );
      } else {
        status = configuredStatus(
          configuration,
          "repair-needed",
          true,
          false,
          null,
        );
      }
    } catch {
      status = configuredStatus(
        configuration,
        "repair-needed",
        true,
        false,
        "cache-unavailable",
      );
    }
  };

  return Object.freeze({
    async initialize(): Promise<CompanionAssetPackStatusResponse> {
      await serialize(initializeInternal);
      return status;
    },

    getStatus(): CompanionAssetPackStatusResponse {
      return status;
    },

    async setEnabled(enabled: boolean): Promise<CompanionAssetPackStatusResponse> {
      if (!enabled && configuration !== null) {
        activeInstall?.abort();
        options.setActiveManifest(null);
      }
      await serialize(async () => {
        await initializeInternal();
        if (closed || configuration === null) return;
        if (!enabled) {
          const previouslyConsented = consented;
          let lastError: CompanionAssetPackError | null = null;
          try {
            await saveConsentState(stateFile, {
              schemaVersion: CONSENT_SCHEMA_VERSION,
              releaseId: configuration.releaseId,
              consented: false,
            });
            consented = false;
          } catch {
            consented = previouslyConsented;
            lastError = "local-state-unavailable";
          }
          try {
            await dependencies.removeCache(
              configuration,
              options.cacheDirectory,
            );
          } catch {
            lastError ??= "cache-unavailable";
          }
          status = configuredStatus(
            configuration,
            consented || lastError === "cache-unavailable"
              ? "repair-needed"
              : "available",
            consented,
            false,
            lastError,
          );
          return;
        }
        if (status.enabled) return;

        const controller = new AbortController();
        activeInstall = controller;
        status = configuredStatus(
          configuration,
          "installing",
          consented,
          false,
          null,
        );
        try {
          let complete = await dependencies.cacheIsComplete(
            configuration,
            options.cacheDirectory,
          );
          if (!complete) {
            await dependencies.install({
              releaseManifest: configuration.releaseManifest,
              descriptor: configuration.descriptor,
              allowlist: configuration.allowlist,
              cacheDirectory: options.cacheDirectory,
              signal: controller.signal,
            });
            complete = await dependencies.cacheIsComplete(
              configuration,
              options.cacheDirectory,
            );
          }
          if (!complete || controller.signal.aborted) {
            throw new AssetPackError(
              controller.signal.aborted
                ? "request-aborted"
                : "cache-write-failed",
            );
          }
          await saveConsentState(stateFile, {
            schemaVersion: CONSENT_SCHEMA_VERSION,
            releaseId: configuration.releaseId,
            consented: true,
          });
          if (controller.signal.aborted) {
            throw new AssetPackError("request-aborted");
          }
          consented = true;
          options.setActiveManifest(configuration.runtimeManifest);
          status = configuredStatus(
            configuration,
            "installed",
            true,
            true,
            null,
          );
        } catch (error) {
          options.setActiveManifest(null);
          const interrupted =
            controller.signal.aborted ||
            (error instanceof AssetPackError &&
              error.code === "request-aborted");
          status = configuredStatus(
            configuration,
            consented ? "repair-needed" : "available",
            consented,
            false,
            interrupted ? null : "download-failed",
          );
        } finally {
          if (activeInstall === controller) activeInstall = null;
        }
      });
      return status;
    },

    async close(): Promise<void> {
      closed = true;
      activeInstall?.abort();
      await mutation.catch(() => undefined);
    },
  });
}
