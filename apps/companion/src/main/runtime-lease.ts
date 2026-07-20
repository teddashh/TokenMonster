import { homedir } from "node:os"
import { join } from "node:path"

import {
  TokenMonsterRuntimeLeaseError,
  acquireTokenMonsterRuntimeLease,
  type AcquireTokenMonsterRuntimeLeaseOptions,
  type TokenMonsterRuntimeLease
} from "@tokenmonster/token-tracker-runtime"

export type CompanionRuntimeLeaseResult =
  | Readonly<{
      kind: "acquired"
      lease: TokenMonsterRuntimeLease
    }>
  | Readonly<{
      kind: "already-running" | "unavailable"
    }>

interface CompanionRuntimeLeaseOptions {
  readonly homeDirectory?: string
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly acquire?: (
    options: AcquireTokenMonsterRuntimeLeaseOptions
  ) => Promise<TokenMonsterRuntimeLease>
}

/** Maps every implementation failure to a path-free result for Electron UX. */
export async function acquireCompanionRuntimeLease(
  options: CompanionRuntimeLeaseOptions = {}
): Promise<CompanionRuntimeLeaseResult> {
  const environment = options.environment ?? process.env
  const homeDirectory =
    options.homeDirectory ?? environment["HOME"] ?? homedir()
  const acquire = options.acquire ?? acquireTokenMonsterRuntimeLease
  try {
    const lease = await acquire({
      scopeDirectory: join(homeDirectory, ".tokenmonster")
    })
    return Object.freeze({ kind: "acquired" as const, lease })
  } catch (error) {
    return Object.freeze({
      kind:
        error instanceof TokenMonsterRuntimeLeaseError &&
        error.code === "already-running"
          ? ("already-running" as const)
          : ("unavailable" as const)
    })
  }
}

/** Keeps the lease until every cache/gateway owner has had its close turn. */
export async function closeCompanionRuntimeLeaseAfter(
  closeOwnedServices: () => void | Promise<void>,
  lease: TokenMonsterRuntimeLease
): Promise<void> {
  try {
    await closeOwnedServices()
  } finally {
    await lease.release()
  }
}
