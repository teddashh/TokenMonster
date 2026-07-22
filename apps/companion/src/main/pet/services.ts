import { homedir } from "node:os";
import { join } from "node:path";

import {
  createCompanionGateway,
  type CompanionCharacterOptions,
  type CompanionGateway,
  type CompanionGatewayOptions
} from "@tokenmonster/companion-gateway";
import { getCompanionUiAssetDirectory } from "@tokenmonster/companion-ui";
import type { EncryptedSecretSlot } from "@tokenmonster/secret-vault";
import {
  SUPPORTED_TOKEN_TRACKER_VERSION,
  createTokenTrackerAdapter,
  type TokenTrackerAdapter,
  type TokenTrackerAggregateRange
} from "@tokenmonster/token-tracker-adapter";
import {
  PINNED_TOKEN_TRACKER_VERSION,
  TokenTrackerRuntimeError,
  startManagedTokenTracker,
  type ManagedTokenTracker,
  type TokenTrackerRuntimeErrorCode
} from "@tokenmonster/token-tracker-runtime";

import { resolveSidecarExecutable, utilityProcessSpawn } from "./sidecar.js";

// The retired Electron entry point remains cache-only. Fixed-pack acquisition
// belongs to the permanent CLI/loopback UI composition, not this legacy shell.
export const PET_CHARACTER_CDN_BASE_URL = null;

export const PET_STARTUP_MESSAGES = Object.freeze({
  gateway:
    "TokenMonster 本機介面無法啟動。請關閉其他執行中的 TokenMonster 後再試。",
  sidecar:
    "TokenTracker sidecar 無法啟動。請重新啟動 TokenMonster;若持續發生,請回報問題。"
});

const DATA_PROBE_TRAILING_DAYS = 365;

function trailingUtcRange(): TokenTrackerAggregateRange {
  const now = new Date();
  return Object.freeze({
    fromUtcDate: new Date(
      now.getTime() - DATA_PROBE_TRAILING_DAYS * 86_400_000
    )
      .toISOString()
      .slice(0, 10),
    toUtcDate: now.toISOString().slice(0, 10)
  });
}

export class PetStartupError extends Error {
  public override readonly name = "PetStartupError";
  public readonly kind: "gateway" | "sidecar";
  public readonly sidecarCode: TokenTrackerRuntimeErrorCode | "unknown" | null;

  public constructor(kind: "gateway" | "sidecar", options?: ErrorOptions) {
    super(PET_STARTUP_MESSAGES[kind], options);
    this.kind = kind;
    this.sidecarCode =
      kind !== "sidecar"
        ? null
        : options?.cause instanceof TokenTrackerRuntimeError
          ? options.cause.code
          : "unknown";
  }
}

export interface PetServices {
  readonly runtime: ManagedTokenTracker;
  readonly gateway: CompanionGateway;
  readonly origin: string;
  readonly bootstrapUrl: string;
}

export function createPetCharacterOptions(
  homeDirectory: string
): CompanionCharacterOptions {
  return Object.freeze({
    manifest: null,
    assetPack: null,
    cacheDirectory: join(homeDirectory, ".tokenmonster", "asset-cache"),
    cdnBaseUrl: PET_CHARACTER_CDN_BASE_URL,
    progressionStorePath: join(
      homeDirectory,
      ".tokenmonster",
      "progression-v1.json"
    )
  });
}

export function createPetGatewayOptions(
  adapter: TokenTrackerAdapter,
  runtime: ManagedTokenTracker,
  byok: EncryptedSecretSlot | null,
  homeDirectory: string,
  assetDirectory = getCompanionUiAssetDirectory()
): CompanionGatewayOptions {
  return Object.freeze({
    adapter,
    collector: runtime,
    byok,
    assetDirectory,
    characters: createPetCharacterOptions(homeDirectory)
  });
}

async function stopServices(
  gateway: CompanionGateway | null,
  runtime: ManagedTokenTracker | null
): Promise<void> {
  if (gateway !== null) {
    try {
      await gateway.close();
    } catch {
      // Continue to the managed child: gateway then runtime is the CLI order.
    }
  }
  if (runtime !== null) {
    try {
      await runtime.stop();
    } catch {
      // The generic startup page is the only failure detail shown to users.
    }
  }
}

export async function startPetServices(
  byok: EncryptedSecretSlot | null = null
): Promise<PetServices> {
  if (PINNED_TOKEN_TRACKER_VERSION !== SUPPORTED_TOKEN_TRACKER_VERSION) {
    throw new PetStartupError("sidecar");
  }

  let runtime: ManagedTokenTracker | null = null;
  let adapter: TokenTrackerAdapter | null = null;

  try {
    runtime = await startManagedTokenTracker({
      readinessProbe: async (baseUrl, signal): Promise<void> => {
        if (signal.aborted) throw new Error("aborted");
        const candidate = createTokenTrackerAdapter({ baseUrl });
        await candidate.probe();
        if (signal.aborted) throw new Error("aborted");
        adapter = candidate;
      },
      dataAvailabilityProbe: async (baseUrl): Promise<boolean> => {
        const candidate = adapter ?? createTokenTrackerAdapter({ baseUrl });
        const summary = await candidate.getSummary(trailingUtcRange());
        return summary.tokens.totalTokens > 0;
      },
      resolveExecutable: resolveSidecarExecutable,
      spawn: utilityProcessSpawn
    });
  } catch (error: unknown) {
    await stopServices(null, runtime);
    throw new PetStartupError("sidecar", { cause: error });
  }

  if (adapter === null) {
    await stopServices(null, runtime);
    throw new PetStartupError("sidecar");
  }

  let gateway: CompanionGateway | null = null;
  try {
    const environment = process.env;
    const homeDirectory = environment["HOME"] ?? homedir();
    gateway = createCompanionGateway(
      createPetGatewayOptions(adapter, runtime, byok, homeDirectory)
    );
    const address = await gateway.start();
    return Object.freeze({
      runtime,
      gateway,
      origin: address.origin,
      bootstrapUrl: address.bootstrapUrl
    });
  } catch (error: unknown) {
    await stopServices(gateway, runtime);
    throw new PetStartupError("gateway", { cause: error });
  }
}

export async function closePetServices(
  services: PetServices | null
): Promise<void> {
  if (services === null) return;
  await stopServices(services.gateway, services.runtime);
}
