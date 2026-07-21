import type { Writable } from "node:stream"

import type {
  CompanionGateway,
  CompanionGatewayOptions
} from "@tokenmonster/companion-gateway"
import type {
  TokenTrackerAdapter,
  TokenTrackerAdapterOptions
} from "@tokenmonster/token-tracker-adapter"
import type {
  AcquireTokenMonsterRuntimeLeaseOptions,
  ManagedTokenTracker,
  ManagedTokenTrackerExit,
  StartManagedTokenTrackerOptions,
  TokenMonsterRuntimeLease
} from "@tokenmonster/token-tracker-runtime"
import type { ContributionCredentialHost } from "@tokenmonster/contribution-runtime"

import type {
  CliContributionRuntime,
  CliContributionRuntimeOptions
} from "./contribution-host.js"

export interface TokenMonsterOutput {
  write(chunk: string): boolean
}

export type TokenMonsterTerminationReason =
  | Readonly<{ kind: "signal"; signal: "SIGINT" | "SIGTERM" }>
  | Readonly<{ kind: "runtime-exit"; exit: ManagedTokenTrackerExit }>

export type TokenMonsterWaitForTermination = (
  runtimeClosed: Promise<ManagedTokenTrackerExit>
) => Promise<TokenMonsterTerminationReason>

export interface TokenMonsterCliDependencies {
  readonly acquireRuntimeLease: (
    options: AcquireTokenMonsterRuntimeLeaseOptions
  ) => Promise<TokenMonsterRuntimeLease>
  readonly startRuntime: (
    options: StartManagedTokenTrackerOptions
  ) => Promise<ManagedTokenTracker>
  readonly createAdapter: (
    options: TokenTrackerAdapterOptions
  ) => TokenTrackerAdapter
  readonly createGateway: (options: CompanionGatewayOptions) => CompanionGateway
  readonly getApprovedAssetPackConfiguration: () => NonNullable<
    CompanionGatewayOptions["characters"]["assetPack"]
  > | null
  readonly getAssetDirectory: () => string
  /** Pure Node defaults to null until an audited native host injects this. */
  readonly getContributionCredentialHost: () => ContributionCredentialHost | null
  readonly createContributionRuntime: (
    options: CliContributionRuntimeOptions
  ) => Promise<CliContributionRuntime>
  readonly openBrowser: (url: string) => Promise<boolean>
  readonly waitForTermination: TokenMonsterWaitForTermination
}

export interface RunTokenMonsterOptions {
  readonly argv?: readonly string[]
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly homeDirectory?: string
  readonly stdout?: TokenMonsterOutput | Pick<Writable, "write">
  readonly stderr?: TokenMonsterOutput | Pick<Writable, "write">
  readonly dependencies?: Partial<TokenMonsterCliDependencies>
}
