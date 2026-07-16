import type { Writable } from "node:stream";

import type {
  CompanionGateway,
  CompanionGatewayOptions
} from "@tokenmonster/companion-gateway";
import type {
  TokenTrackerAdapter,
  TokenTrackerAdapterOptions
} from "@tokenmonster/token-tracker-adapter";
import type {
  ManagedTokenTracker,
  ManagedTokenTrackerExit,
  StartManagedTokenTrackerOptions
} from "@tokenmonster/token-tracker-runtime";

export interface TokenMonsterOutput {
  write(chunk: string): boolean;
}

export type TokenMonsterTerminationReason =
  | Readonly<{ kind: "signal"; signal: "SIGINT" | "SIGTERM" }>
  | Readonly<{ kind: "runtime-exit"; exit: ManagedTokenTrackerExit }>;

export type TokenMonsterWaitForTermination = (
  runtimeClosed: Promise<ManagedTokenTrackerExit>
) => Promise<TokenMonsterTerminationReason>;

export interface TokenMonsterCliDependencies {
  readonly startRuntime: (
    options: StartManagedTokenTrackerOptions
  ) => Promise<ManagedTokenTracker>;
  readonly createAdapter: (
    options: TokenTrackerAdapterOptions
  ) => TokenTrackerAdapter;
  readonly createGateway: (
    options: CompanionGatewayOptions
  ) => CompanionGateway;
  readonly getAssetDirectory: () => string;
  readonly openBrowser: (url: string) => Promise<boolean>;
  readonly waitForTermination: TokenMonsterWaitForTermination;
}

export interface RunTokenMonsterOptions {
  readonly argv?: readonly string[];
  readonly stdout?: TokenMonsterOutput | Pick<Writable, "write">;
  readonly stderr?: TokenMonsterOutput | Pick<Writable, "write">;
  readonly dependencies?: Partial<TokenMonsterCliDependencies>;
}
