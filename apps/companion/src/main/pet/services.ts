import { homedir } from "node:os";
import { join } from "node:path";

import {
  createCompanionGateway,
  getApprovedAssetManifest,
  type CompanionGateway
} from "@tokenmonster/companion-gateway";
import { getCompanionUiAssetDirectory } from "@tokenmonster/companion-ui";
import {
  SUPPORTED_TOKEN_TRACKER_VERSION,
  createTokenTrackerAdapter,
  type TokenTrackerAdapter,
  type TokenTrackerAggregateRange
} from "@tokenmonster/token-tracker-adapter";
import {
  PINNED_TOKEN_TRACKER_VERSION,
  startManagedTokenTracker,
  type ManagedTokenTracker
} from "@tokenmonster/token-tracker-runtime";

export const PET_CHARACTER_CDN_BASE_URL =
  "https://cdn.ted-h.com/tokenmonster/characters/v1" as const;

export const PET_STARTUP_MESSAGES = Object.freeze({
  gateway:
    "TokenMonster 本機介面無法啟動。請關閉其他執行中的 TokenMonster 後再試。",
  sidecar:
    "TokenTracker sidecar 無法啟動。請確認 Node.js 版本後重新執行 TokenMonster。"
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

  public constructor(kind: "gateway" | "sidecar") {
    super(PET_STARTUP_MESSAGES[kind]);
    this.kind = kind;
  }
}

export interface PetServices {
  readonly runtime: ManagedTokenTracker;
  readonly gateway: CompanionGateway;
  readonly origin: string;
  readonly bootstrapUrl: string;
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

export async function startPetServices(): Promise<PetServices> {
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
      }
    });
  } catch {
    await stopServices(null, runtime);
    throw new PetStartupError("sidecar");
  }

  if (adapter === null) {
    await stopServices(null, runtime);
    throw new PetStartupError("sidecar");
  }

  let gateway: CompanionGateway | null = null;
  try {
    const environment = process.env;
    const homeDirectory = environment["HOME"] ?? homedir();
    gateway = createCompanionGateway({
      adapter,
      collector: runtime,
      assetDirectory: getCompanionUiAssetDirectory(),
      characters: {
        manifest: getApprovedAssetManifest(),
        cacheDirectory: join(homeDirectory, ".tokenmonster", "asset-cache"),
        cdnBaseUrl:
          environment["TOKENMONSTER_CHARACTER_CDN"] ??
          PET_CHARACTER_CDN_BASE_URL,
        progressionStorePath: join(
          homeDirectory,
          ".tokenmonster",
          "progression-v1.json"
        )
      }
    });
    const address = await gateway.start();
    return Object.freeze({
      runtime,
      gateway,
      origin: address.origin,
      bootstrapUrl: address.bootstrapUrl
    });
  } catch {
    await stopServices(gateway, runtime);
    throw new PetStartupError("gateway");
  }
}

export async function closePetServices(
  services: PetServices | null
): Promise<void> {
  if (services === null) return;
  await stopServices(services.gateway, services.runtime);
}
