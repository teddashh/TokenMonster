import type { TokenTrackerAdapter } from "@tokenmonster/token-tracker-adapter";
import type { StarterCharacterSelection } from "@tokenmonster/characters";

export type CompanionGatewayClock = () => Date;

export interface CompanionUiAssets {
  readonly html: string | Uint8Array;
  readonly css: string | Uint8Array;
  readonly javascript: string | Uint8Array;
}

interface CompanionGatewayBaseOptions {
  readonly adapter: TokenTrackerAdapter;
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

export type CompanionGatewayErrorCode =
  | "invalid-configuration"
  | "already-started"
  | "closed";
