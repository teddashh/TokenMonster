import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import {
  TokenMonsterRuntimeLeaseError,
  type TokenMonsterRuntimeLease
} from "@tokenmonster/token-tracker-runtime"

import {
  acquireCompanionRuntimeLease,
  closeCompanionRuntimeLeaseAfter
} from "../src/main/runtime-lease.js"

const PRIVATE_HOME = "/private/USER_PATH_CANARY"

describe("Electron shared runtime lease", () => {
  it("uses the same ~/.tokenmonster scope as the CLI", async () => {
    const lease: TokenMonsterRuntimeLease = Object.freeze({
      release: vi.fn(async (): Promise<void> => undefined)
    })
    const acquire = vi.fn(async () => lease)

    await expect(
      acquireCompanionRuntimeLease({ homeDirectory: PRIVATE_HOME, acquire })
    ).resolves.toEqual({ kind: "acquired", lease })
    expect(acquire).toHaveBeenCalledWith({
      scopeDirectory: join(PRIVATE_HOME, ".tokenmonster")
    })
  })

  it("maps cross-CLI contention to sanitized already-running UX state", async () => {
    const result = await acquireCompanionRuntimeLease({
      homeDirectory: PRIVATE_HOME,
      acquire: async () => {
        throw new TokenMonsterRuntimeLeaseError("already-running")
      }
    })

    expect(result).toEqual({ kind: "already-running" })
    expect(JSON.stringify(result)).not.toContain(PRIVATE_HOME)
  })

  it("maps unexpected local IPC failures without returning their details", async () => {
    const canary = "LOCAL_IPC_ERROR_CANARY"
    const result = await acquireCompanionRuntimeLease({
      homeDirectory: PRIVATE_HOME,
      acquire: async () => {
        throw new Error(canary)
      }
    })

    expect(result).toEqual({ kind: "unavailable" })
    expect(JSON.stringify(result)).not.toContain(canary)
    expect(JSON.stringify(result)).not.toContain(PRIVATE_HOME)
  })

  it("releases only after owned services close and still releases on failure", async () => {
    const events: string[] = []
    const lease: TokenMonsterRuntimeLease = Object.freeze({
      release: vi.fn(async () => {
        events.push("lease-release")
      })
    })

    await closeCompanionRuntimeLeaseAfter(async () => {
      events.push("services-close")
    }, lease)
    expect(events).toEqual(["services-close", "lease-release"])

    events.length = 0
    await expect(
      closeCompanionRuntimeLeaseAfter(async () => {
        events.push("services-close-failed")
        throw new Error("close failed")
      }, lease)
    ).rejects.toThrow("close failed")
    expect(events).toEqual(["services-close-failed", "lease-release"])
  })
})
