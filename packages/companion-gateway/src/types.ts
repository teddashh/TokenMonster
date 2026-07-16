import type { TokenTrackerAdapter } from "@tokenmonster/token-tracker-adapter";
import type {
  TokenMonsterUsageFamily,
  TokenMonsterUsageFamilyTotals
} from "@tokenmonster/token-tracker-adapter";
import type {
  AssetManifest,
  StarterCharacterSelection
} from "@tokenmonster/characters";

export type CompanionGatewayClock = () => Date;

export interface CompanionUiAssets {
  readonly html: string | Uint8Array;
  readonly css: string | Uint8Array;
  readonly scripts: Readonly<Record<string, string | Uint8Array>>;
}

export interface CompanionCharacterFetchInit {
  readonly method: "GET";
  readonly redirect: "error";
  readonly signal: AbortSignal;
}

export interface CompanionCharacterFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: Readonly<{ get(name: string): string | null }>;
  readonly body: ReadableStream<Uint8Array> | null;
}

export type CompanionCharacterFetch = (
  url: string,
  init: CompanionCharacterFetchInit
) => Promise<CompanionCharacterFetchResponse>;

export interface CompanionCharacterOptions {
  readonly manifest: AssetManifest | null;
  readonly cacheDirectory: string;
  readonly cdnBaseUrl: string | null;
  readonly progressionStorePath: string;
  readonly fetch?: CompanionCharacterFetch;
}

export type CompanionCharacterId =
  | "chatgpt"
  | "claude"
  | "gemini"
  | "grok"
  | "deepseek"
  | "qwen"
  | "mistral"
  | "venice"
  | "sakana"
  | "perplexity"
  | "glm";

export interface CompanionCharacterProgress {
  readonly value: number;
  readonly explain: string;
}

export interface CompanionCharacterLetterVisual {
  readonly mode: "letter";
  readonly glyph: string;
  readonly background: string;
  readonly foreground: string;
  readonly accent: string;
}

export interface CompanionCharacterThemeVisual {
  readonly themeId: string;
  readonly unlocked: boolean;
  readonly outfitPath: string;
  readonly posePaths: Readonly<{
    supported: string | null;
    challenged: string | null;
    victory: string | null;
  }>;
}

export interface CompanionCharacterDollVisual {
  readonly mode: "doll";
  readonly avatarPath: string;
  readonly themes: readonly CompanionCharacterThemeVisual[];
}

export interface CompanionCharacterVoiceLine {
  readonly id: string;
  readonly trigger: "greeting" | "unlock" | "quiet" | "active" | "error";
  readonly path: string;
  readonly durationMs: number;
}

export interface CompanionCharacter {
  readonly characterId: CompanionCharacterId;
  readonly displayName: string;
  readonly kind: "sister" | "friend";
  readonly unlocked: boolean;
  readonly unlockedAt: string | null;
  readonly isStarter: boolean;
  readonly activeThemeId: string | null;
  readonly visual: CompanionCharacterLetterVisual | CompanionCharacterDollVisual;
  readonly progress: CompanionCharacterProgress | null;
  readonly voiceLines: readonly CompanionCharacterVoiceLine[];
}

export interface CompanionCharactersResponse {
  readonly status: "ok";
  readonly generatedAt: string;
  readonly selection: Readonly<{
    characterId: CompanionCharacterId | null;
    selectedBy: "manual" | "auto-starter" | null;
  }>;
  readonly voiceEnabled: true;
  readonly characters: readonly CompanionCharacter[];
}

interface CompanionGatewayBaseOptions {
  readonly adapter: TokenTrackerAdapter;
  readonly collector: CompanionCollectorController;
  readonly characters: CompanionCharacterOptions;
  readonly clock?: CompanionGatewayClock;
  readonly apiTimeoutMs?: number;
}

export type CompanionGatewayOptions = CompanionGatewayBaseOptions &
  (
    | {
        readonly assets: CompanionUiAssets;
        readonly assetDirectory?: never;
      }
    | {
        readonly assets?: never;
        readonly assetDirectory: string;
      }
  );

export interface CompanionGatewayAddress {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly origin: string;
  readonly bootstrapUrl: string;
}

export interface CompanionGateway {
  start(port?: number): Promise<CompanionGatewayAddress>;
  close(): Promise<void>;
}

export type CompanionCollectorPhase =
  | "starting"
  | "syncing"
  | "ready"
  | "ready-no-data"
  | "refresh-failed"
  | "stale";

export interface CompanionCollectorStatus {
  readonly phase: CompanionCollectorPhase;
  readonly lastSuccessAt: string | null;
  readonly consecutiveFailures: number;
  readonly canRetry: boolean;
}

export interface CompanionCollectorController {
  getStatus(): CompanionCollectorStatus;
  requestRefresh(): Promise<CompanionCollectorStatus>;
}

export interface CompanionDailyTotal {
  readonly utcDate: string;
  readonly totalTokens: number;
}

export interface CompanionPeriodTotals {
  readonly today: number;
  readonly last7Days: number;
  readonly last28Days: number;
}

export interface CompanionApiHealthyResponse {
  readonly status: "healthy";
  readonly generatedAt: string;
  readonly starter: StarterCharacterSelection;
  readonly totals: CompanionPeriodTotals;
  readonly daily: readonly CompanionDailyTotal[];
}

export type CompanionApiErrorCode =
  | "sidecar-unavailable"
  | "sidecar-incompatible";

export interface CompanionApiErrorResponse {
  readonly status: "error";
  readonly error: CompanionApiErrorCode;
}

export type CompanionApiResponse =
  | CompanionApiHealthyResponse
  | CompanionApiErrorResponse;

export type CompanionUsageWindow = 7 | 28 | 90;

export interface CompanionUsageFamilyDay {
  readonly utcDate: string;
  readonly families: TokenMonsterUsageFamilyTotals;
}

export interface CompanionUsageFamiliesResponse {
  readonly window: CompanionUsageWindow;
  readonly days: readonly CompanionUsageFamilyDay[];
}

export interface CompanionUsageModel {
  readonly model: string;
  readonly family: TokenMonsterUsageFamily;
  readonly totalTokens: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface CompanionUsageModelsResponse {
  readonly window: CompanionUsageWindow;
  readonly models: readonly CompanionUsageModel[];
}

export type CompanionGatewayErrorCode =
  | "invalid-configuration"
  | "already-started"
  | "closed";
