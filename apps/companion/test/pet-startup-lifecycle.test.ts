import { readFile } from "node:fs/promises"

import { describe, expect, it, vi } from "vitest"

import {
  adoptPetStartupOwner,
  createPetStartupLifecycle,
  drainPetStartupAttemptFailure,
  drainPetStartupLifecycle,
  runPetStartupAttempt
} from "../src/main/pet/startup-lifecycle.js"

function deferred<T = void>(): Readonly<{
  promise: Promise<T>
  resolve(value: T): void
}> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return Object.freeze({ promise, resolve })
}

describe("pet startup shutdown lifecycle", () => {
  it.each(["initial-load", "initial-stop"] as const)(
    "treats normal quit during %s as clean cancellation",
    async (stage) => {
      const events: string[] = []
      const lifecycle = createPetStartupLifecycle()
      const stageGate = deferred()
      const startup = runPetStartupAttempt(
        lifecycle,
        async () => {
          events.push(`${stage}-start`)
          await stageGate.promise
          lifecycle.assertRunning()
          events.push("late-startup-continuation")
        },
        async () => {
          events.push("fatal-startup-handler")
        }
      )
      lifecycle.trackStartup(startup)
      const shutdown = drainPetStartupLifecycle(lifecycle, async () => {
        events.push("active-owners-stop")
        if (stage === "initial-stop") await stageGate.promise
      }).then(() => events.push("lease-release"))

      await vi.waitFor(() => expect(lifecycle.signal.aborted).toBe(true))
      expect(events).not.toContain("fatal-startup-handler")
      expect(events).not.toContain("lease-release")

      stageGate.resolve(undefined)
      await shutdown
      expect(events).not.toContain("fatal-startup-handler")
      expect(events).not.toContain("late-startup-continuation")
      expect(events.at(-1)).toBe("lease-release")
    }
  )

  it("aborts pending credential startup and joins its raw worker before lease release", async () => {
    const events: string[] = []
    const lifecycle = createPetStartupLifecycle()
    const boundedResult = deferred()
    const rawCredentialWorker = deferred()
    lifecycle.signal.addEventListener(
      "abort",
      () => boundedResult.resolve(undefined),
      { once: true }
    )
    const startup = (async () => {
      lifecycle.trackCredentialWorker(rawCredentialWorker.promise)
      await boundedResult.promise
      lifecycle.assertRunning()
      events.push("late-services-started")
    })()
    lifecycle.trackStartup(startup)
    const stopActiveOwners = vi.fn(async () => {
      events.push("active-owners-stop")
    })
    const shutdown = drainPetStartupLifecycle(lifecycle, stopActiveOwners).then(
      () => events.push("lease-release")
    )

    await vi.waitFor(() => expect(lifecycle.signal.aborted).toBe(true))
    expect(events).toEqual(["active-owners-stop"])
    expect(events).not.toContain("late-services-started")
    expect(events).not.toContain("lease-release")

    rawCredentialWorker.resolve(undefined)
    await shutdown
    expect(events).toEqual([
      "active-owners-stop",
      "active-owners-stop",
      "lease-release"
    ])
  })

  it("drains raw credential work when the failure page also fails", async () => {
    const events: string[] = []
    const lifecycle = createPetStartupLifecycle()
    const rawCredentialWorker = deferred()
    lifecycle.trackCredentialWorker(rawCredentialWorker.promise)
    const startup = runPetStartupAttempt(
      lifecycle,
      async () => {
        throw new Error("startup failed")
      },
      async () => {
        events.push("failure-page-failed")
        await drainPetStartupAttemptFailure(lifecycle, async () => {
          events.push("active-owners-stop")
        })
        throw new Error("failure page failed")
      }
    )
    lifecycle.trackStartup(startup)
    const terminal = startup
      .catch(() => undefined)
      .then(() => events.push("lease-release"))

    await vi.waitFor(() => expect(events).toContain("failure-page-failed"))
    expect(events).not.toContain("lease-release")

    rawCredentialWorker.resolve(undefined)
    await terminal
    expect(events).toEqual([
      "failure-page-failed",
      "active-owners-stop",
      "active-owners-stop",
      "lease-release"
    ])
  })

  it("closes startPetServices that returns after quit instead of adopting it", async () => {
    const events: string[] = []
    const lifecycle = createPetStartupLifecycle()
    const started = deferred<Readonly<{ id: string }>>()
    const allowClose = deferred()
    let adopted: Readonly<{ id: string }> | null = null
    const startup = (async () => {
      const owner = await started.promise
      await adoptPetStartupOwner(
        lifecycle,
        owner,
        (accepted) => {
          adopted = accepted
          events.push("late-services-adopted")
        },
        async () => {
          events.push("late-services-close-start")
          await allowClose.promise
          events.push("late-services-close-end")
        }
      )
    })()
    lifecycle.trackStartup(startup)
    const shutdown = drainPetStartupLifecycle(lifecycle, async () => {
      events.push("active-owners-stop")
    }).then(() => events.push("lease-release"))

    started.resolve(Object.freeze({ id: "late" }))
    await vi.waitFor(() =>
      expect(events).toContain("late-services-close-start")
    )
    expect(adopted).toBeNull()
    expect(events).not.toContain("lease-release")

    allowClose.resolve(undefined)
    await shutdown
    expect(events).toEqual([
      "active-owners-stop",
      "late-services-close-start",
      "late-services-close-end",
      "active-owners-stop",
      "lease-release"
    ])
  })

  it("allows fire-and-forget smoke wind-down to join its current startup", async () => {
    const events: string[] = []
    const lifecycle = createPetStartupLifecycle()
    const reachSmokeReport = deferred()
    let windDown: Promise<void> | null = null
    const startup = runPetStartupAttempt(
      lifecycle,
      async () => {
        await reachSmokeReport.promise
        events.push("smoke-report")
        windDown = drainPetStartupLifecycle(lifecycle, async () => {
          events.push("active-owners-stop")
        }).then(() => {
          events.push("lease-release")
        })
        events.push("startup-return")
      },
      async () => {
        events.push("unexpected-failure")
      }
    )
    lifecycle.trackStartup(startup)

    reachSmokeReport.resolve(undefined)
    await startup
    await windDown

    expect(events).toEqual([
      "smoke-report",
      "active-owners-stop",
      "startup-return",
      "active-owners-stop",
      "lease-release"
    ])
  })

  it("wires raw vault quiescence and late service adoption into pet shutdown", async () => {
    const source = await readFile(
      new URL("../src/main/pet/pet.ts", import.meta.url),
      "utf8"
    )

    expect(source).toMatch(
      /startPetByokSecretSlot\([\s\S]*signal: startupLifecycle\.signal[\s\S]*byokStartup\.quiesce\(\)[\s\S]*startupLifecycle\.trackCredentialWorker/u
    )
    expect(source).toMatch(
      /runPetStartupAttempt\(\s*startupLifecycle,[\s\S]*await loadShell\(\)\s+startupLifecycle\.assertRunning\(\)\s+await stopActiveServices\(\)\s+startupLifecycle\.assertRunning\(\)/u
    )
    expect(source).toMatch(
      /const started = await startPetServices\([\s\S]*await adoptPetStartupOwner\([\s\S]*closePetServices/u
    )
    expect(
      source.match(
        /drainPetStartupLifecycle\(startupLifecycle, stopActiveServices\)/gu
      )
    ).toHaveLength(2)
    expect(source).toMatch(
      /startupLifecycle\.requestShutdown\(\)\s+shutdownOperation/u
    )
    expect(source).toContain("WINDOWS_SMOKE_EXIT_CODES")
    expect(source).toContain("ok: 86")
    expect(source).toContain(
      'outcome === "sidecar"\n        ? WINDOWS_SIDECAR_SMOKE_EXIT_CODES[sidecarCode]\n        : WINDOWS_SMOKE_EXIT_CODES[outcome]'
    )
    expect(source).toMatch(
      /if \(process\.platform !== "win32"\) \{\s+process\.stdout\.write/u
    )
  })
})
