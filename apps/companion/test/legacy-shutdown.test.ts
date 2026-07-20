import { describe, expect, it, vi } from "vitest"

import {
  FATAL_EXIT_CODE,
  createFatalQuitController
} from "../src/main/graceful-fatal-quit.js"
import {
  closeLegacyOwnedServices,
  createLegacyStartupFence,
  createLegacyShutdownCoordinator,
  disposeLegacyOwnedServices,
  startLegacyRuntimeWithOwnedLease
} from "../src/main/legacy-shutdown.js"

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

describe("legacy Electron shutdown", () => {
  it("retains a lease that resolves after shutdown until startup joins", async () => {
    const events: string[] = []
    const fence = createLegacyStartupFence()
    const acquired = deferred<Readonly<{ release(): Promise<void> }>>()
    let ownedLease: Readonly<{ release(): Promise<void> }> | null = null
    const startup = (async () => {
      const lease = await acquired.promise
      await startLegacyRuntimeWithOwnedLease(
        lease,
        (owned) => {
          events.push("lease-retained")
          ownedLease = owned
        },
        async () => {
          fence.assertRunning()
          events.push("late-owner-created")
        }
      )
    })()
    fence.track(startup)
    const coordinator = createLegacyShutdownCoordinator({
      closeOwnedServices: async () => {
        fence.requestShutdown()
        await fence.join()
        events.push("owners-closed")
      },
      releaseLease: async () => {
        const lease = ownedLease
        ownedLease = null
        await lease?.release()
      },
      quit: () => events.push("app-quit")
    })

    coordinator.handleBeforeQuit({ preventDefault: vi.fn() })
    expect(events).toEqual([])

    acquired.resolve(
      Object.freeze({
        release: async () => {
          events.push("lease-release")
        }
      })
    )
    await coordinator.completion()

    expect(events).toEqual([
      "lease-retained",
      "owners-closed",
      "lease-release",
      "app-quit"
    ])
    expect(events).not.toContain("late-owner-created")
  })

  it("closes a store that opens after shutdown without creating later owners", async () => {
    const events: string[] = []
    const fence = createLegacyStartupFence()
    const opened = deferred<Readonly<{ close(): void }>>()
    let store: Readonly<{ close(): void }> | null = null
    const startup = (async () => {
      store = await opened.promise
      events.push("store-retained")
      fence.assertRunning()
      events.push("late-service-created")
    })()
    fence.track(startup)
    const coordinator = createLegacyShutdownCoordinator({
      closeOwnedServices: async () => {
        fence.requestShutdown()
        await fence.join()
        const capturedStore = store
        store = null
        await closeLegacyOwnedServices({
          detachScheduler: null,
          scheduler: null,
          byok: null,
          contribution: null,
          collector: null,
          store: capturedStore
        })
      },
      releaseLease: async () => {
        events.push("lease-release")
      },
      quit: () => events.push("app-quit")
    })

    coordinator.handleBeforeQuit({ preventDefault: vi.fn() })
    opened.resolve(Object.freeze({ close: () => events.push("store-close") }))
    await coordinator.completion()

    expect(events).toEqual([
      "store-retained",
      "store-close",
      "lease-release",
      "app-quit"
    ])
    expect(events).not.toContain("late-service-created")
  })

  it("aborts an owned pending init, joins its raw worker, then exits fatally", async () => {
    const events: string[] = []
    const fence = createLegacyStartupFence()
    const boundedInitialize = deferred()
    const rawInitialize = deferred()
    let disposed = false
    const byok = Object.freeze({
      initialize: async () => {
        events.push("byok-initialize-start")
        void rawInitialize.promise
        await boundedInitialize.promise
        events.push("byok-initialize-return")
      },
      dispose: () => {
        if (disposed) return
        disposed = true
        events.push("byok-dispose")
      },
      quiesce: async () => {
        events.push("byok-quiesce-start")
        await rawInitialize.promise
        events.push("byok-raw-initialize-end")
      }
    })
    let ownedByok: typeof byok | null = null
    const store = Object.freeze({ close: () => events.push("store-close") })
    const startup = (async () => {
      ownedByok = byok
      await byok.initialize()
      fence.assertRunning()
      events.push("late-contribution-created")
    })()
    fence.track(startup)
    const fatalQuit = createFatalQuitController({
      quit: () => events.push("app-quit-request"),
      exit: (code) => events.push(`app-exit:${code}`)
    })
    const coordinator = createLegacyShutdownCoordinator({
      closeOwnedServices: async () => {
        fence.requestShutdown()
        disposeLegacyOwnedServices({
          detachScheduler: null,
          scheduler: null,
          byok: ownedByok,
          contribution: null,
          collector: null,
          store
        })
        await fence.join()
        const capturedByok = ownedByok
        ownedByok = null
        await closeLegacyOwnedServices({
          detachScheduler: null,
          scheduler: null,
          byok: capturedByok,
          contribution: null,
          collector: null,
          store
        })
      },
      releaseLease: async () => {
        events.push("lease-release")
      },
      quit: fatalQuit.completeLegacyShutdown
    })

    fatalQuit.requestLegacyFatalQuit()
    coordinator.handleBeforeQuit({ preventDefault: vi.fn() })
    await vi.waitFor(() => expect(events).toContain("byok-dispose"))
    expect(events).not.toContain("store-close")
    expect(events).not.toContain("lease-release")
    expect(events).not.toContain(`app-exit:${FATAL_EXIT_CODE}`)

    boundedInitialize.resolve(undefined)
    await vi.waitFor(() => expect(events).toContain("byok-quiesce-start"))
    expect(events).not.toContain("late-contribution-created")
    expect(events).not.toContain("store-close")
    expect(events).not.toContain("lease-release")

    rawInitialize.resolve(undefined)
    await coordinator.completion()
    expect(events).toEqual([
      "byok-initialize-start",
      "app-quit-request",
      "byok-dispose",
      "byok-initialize-return",
      "byok-quiesce-start",
      "byok-raw-initialize-end",
      "store-close",
      "lease-release",
      `app-exit:${FATAL_EXIT_CODE}`
    ])
  })

  it.each(["initial startup", "activation"])(
    "preserves fatal %s intent when window-all-closed precedes rejection handling",
    async (failureStage) => {
      const events: string[] = []
      const drain = deferred()
      const fence = createLegacyStartupFence()
      let coordinator!: ReturnType<typeof createLegacyShutdownCoordinator>
      const appQuit = vi.fn(() => {
        events.push("app-quit-request")
        coordinator.handleBeforeQuit({ preventDefault: vi.fn() })
      })
      const fatalQuit = createFatalQuitController({
        quit: appQuit,
        exit: (code) => events.push(`app-exit:${code}`)
      })
      coordinator = createLegacyShutdownCoordinator({
        closeOwnedServices: async () => {
          fence.requestShutdown()
          events.push("coordinator-drain-start")
          await drain.promise
          events.push("owners-closed")
        },
        releaseLease: async () => {
          events.push("lease-release")
        },
        quit: fatalQuit.completeLegacyShutdown
      })

      events.push(`${failureStage}-renderer-failed`)
      fatalQuit.markLegacyFatalIntent()
      events.push("window-destroy")
      appQuit()
      if (fence.shutdownRequested()) {
        events.push("startup-rejection-suppressed")
      } else {
        fatalQuit.requestLegacyFatalQuit()
      }

      expect(events).toEqual([
        `${failureStage}-renderer-failed`,
        "window-destroy",
        "app-quit-request",
        "coordinator-drain-start",
        "startup-rejection-suppressed"
      ])
      expect(events).not.toContain(`app-exit:${FATAL_EXIT_CODE}`)

      drain.resolve(undefined)
      await coordinator.completion()
      expect(events).toEqual([
        `${failureStage}-renderer-failed`,
        "window-destroy",
        "app-quit-request",
        "coordinator-drain-start",
        "startup-rejection-suppressed",
        "owners-closed",
        "lease-release",
        `app-exit:${FATAL_EXIT_CODE}`
      ])
      expect(appQuit).toHaveBeenCalledOnce()
    }
  )

  it("keeps a user-requested window teardown non-fatal", async () => {
    const events: string[] = []
    const drain = deferred()
    const fence = createLegacyStartupFence()
    const appQuit = vi.fn(() => events.push("app-quit"))
    const appExit = vi.fn((code?: number) =>
      events.push(`app-exit:${code}`)
    )
    const fatalQuit = createFatalQuitController({
      quit: appQuit,
      exit: appExit
    })
    const coordinator = createLegacyShutdownCoordinator({
      closeOwnedServices: async () => {
        fence.requestShutdown()
        events.push("window-destroy")
        if (!fence.shutdownRequested()) fatalQuit.markLegacyFatalIntent()
        events.push("renderer-load-rejected")
        await drain.promise
        events.push("owners-closed")
      },
      releaseLease: async () => {
        events.push("lease-release")
      },
      quit: fatalQuit.completeLegacyShutdown
    })

    coordinator.handleBeforeQuit({ preventDefault: vi.fn() })
    expect(events).toEqual(["window-destroy", "renderer-load-rejected"])
    expect(appQuit).not.toHaveBeenCalled()
    expect(appExit).not.toHaveBeenCalled()

    drain.resolve(undefined)
    await coordinator.completion()
    expect(events).toEqual([
      "window-destroy",
      "renderer-load-rejected",
      "owners-closed",
      "lease-release",
      "app-quit"
    ])
    expect(appQuit).toHaveBeenCalledOnce()
    expect(appExit).not.toHaveBeenCalled()
  })

  it("keeps a window close during renderer loading non-fatal", async () => {
    const events: string[] = []
    const drain = deferred()
    const fence = createLegacyStartupFence()
    let closeRequested = false
    const appQuit = vi.fn(() => events.push("app-quit"))
    const appExit = vi.fn((code?: number) =>
      events.push(`app-exit:${code}`)
    )
    const fatalQuit = createFatalQuitController({
      quit: appQuit,
      exit: appExit
    })
    const coordinator = createLegacyShutdownCoordinator({
      closeOwnedServices: async () => {
        fence.requestShutdown()
        events.push("coordinator-drain-start")
        await drain.promise
        events.push("owners-closed")
      },
      releaseLease: async () => {
        events.push("lease-release")
      },
      quit: fatalQuit.completeLegacyShutdown
    })

    events.push("window-close")
    closeRequested = true
    events.push("renderer-load-rejected")
    if (closeRequested) {
      events.push("create-window-cancelled")
    } else if (!fence.shutdownRequested()) {
      fatalQuit.markLegacyFatalIntent()
    }
    events.push("window-all-closed")
    coordinator.handleBeforeQuit({ preventDefault: vi.fn() })

    expect(events).toEqual([
      "window-close",
      "renderer-load-rejected",
      "create-window-cancelled",
      "window-all-closed",
      "coordinator-drain-start"
    ])
    expect(appExit).not.toHaveBeenCalled()

    drain.resolve(undefined)
    await coordinator.completion()
    expect(events).toEqual([
      "window-close",
      "renderer-load-rejected",
      "create-window-cancelled",
      "window-all-closed",
      "coordinator-drain-start",
      "owners-closed",
      "lease-release",
      "app-quit"
    ])
    expect(appQuit).toHaveBeenCalledOnce()
    expect(appExit).not.toHaveBeenCalled()
  })

  it("normalizes a macOS close during renderer loading without shutdown or fatal intent", () => {
    const fence = createLegacyStartupFence()
    const appQuit = vi.fn()
    const appExit = vi.fn()
    const fatalQuit = createFatalQuitController({
      quit: appQuit,
      exit: appExit
    })
    const closeRequested = true
    const handleRendererLoadRejection = (): "closed" | "failed" => {
      if (closeRequested) return "closed"
      if (!fence.shutdownRequested()) fatalQuit.markLegacyFatalIntent()
      return "failed"
    }

    expect(handleRendererLoadRejection()).toBe("closed")
    expect(fence.shutdownRequested()).toBe(false)
    expect(appQuit).not.toHaveBeenCalled()
    expect(appExit).not.toHaveBeenCalled()
  })

  it("defers repeated quit events until contribution quiesces and releases once", async () => {
    const events: string[] = []
    let releaseByokQuiesce!: () => void
    const byokQuiesceBarrier = new Promise<void>((resolve) => {
      releaseByokQuiesce = resolve
    })
    let releaseQuiesce!: () => void
    const quiesceBarrier = new Promise<void>((resolve) => {
      releaseQuiesce = resolve
    })
    let releaseCollectorQuiesce!: () => void
    const collectorQuiesceBarrier = new Promise<void>((resolve) => {
      releaseCollectorQuiesce = resolve
    })
    const closeOwnedServices = () =>
      closeLegacyOwnedServices({
        detachScheduler: () => events.push("scheduler-detach"),
        scheduler: Object.freeze({
          dispose: () => events.push("scheduler-dispose")
        }),
        byok: Object.freeze({
          dispose: () => events.push("byok-dispose"),
          quiesce: async () => {
            events.push("byok-quiesce-start")
            await byokQuiesceBarrier
            events.push("byok-late-write-clear-end")
          }
        }),
        contribution: Object.freeze({
          dispose: () => events.push("contribution-dispose"),
          quiesce: async () => {
            events.push("contribution-quiesce-start")
            await quiesceBarrier
            events.push("contribution-quiesce-end")
          }
        }),
        collector: Object.freeze({
          dispose: () => events.push("collector-dispose"),
          quiesce: async () => {
            events.push("collector-quiesce-start")
            await collectorQuiesceBarrier
            events.push("collector-quiesce-end")
          }
        }),
        store: Object.freeze({
          close: () => events.push("store-close")
        })
      })
    const coordinator = createLegacyShutdownCoordinator({
      closeOwnedServices,
      releaseLease: async () => {
        events.push("lease-release")
      },
      quit: () => events.push("app-quit")
    })
    const firstPreventDefault = vi.fn()
    const repeatedPreventDefault = vi.fn()

    coordinator.handleBeforeQuit({ preventDefault: firstPreventDefault })
    coordinator.handleBeforeQuit({ preventDefault: repeatedPreventDefault })

    expect(firstPreventDefault).toHaveBeenCalledOnce()
    expect(repeatedPreventDefault).toHaveBeenCalledOnce()
    await vi.waitFor(() =>
      expect(events).toEqual([
        "scheduler-detach",
        "scheduler-dispose",
        "byok-dispose",
        "contribution-dispose",
        "collector-dispose",
        "byok-quiesce-start"
      ])
    )

    releaseByokQuiesce()
    await vi.waitFor(() =>
      expect(events).toEqual([
        "scheduler-detach",
        "scheduler-dispose",
        "byok-dispose",
        "contribution-dispose",
        "collector-dispose",
        "byok-quiesce-start",
        "byok-late-write-clear-end",
        "contribution-quiesce-start"
      ])
    )

    releaseQuiesce()
    await vi.waitFor(() =>
      expect(events).toEqual([
        "scheduler-detach",
        "scheduler-dispose",
        "byok-dispose",
        "contribution-dispose",
        "collector-dispose",
        "byok-quiesce-start",
        "byok-late-write-clear-end",
        "contribution-quiesce-start",
        "contribution-quiesce-end",
        "collector-quiesce-start"
      ])
    )

    releaseCollectorQuiesce()
    await coordinator.completion()
    expect(events).toEqual([
      "scheduler-detach",
      "scheduler-dispose",
      "byok-dispose",
      "contribution-dispose",
      "collector-dispose",
      "byok-quiesce-start",
      "byok-late-write-clear-end",
      "contribution-quiesce-start",
      "contribution-quiesce-end",
      "collector-quiesce-start",
      "collector-quiesce-end",
      "store-close",
      "lease-release",
      "app-quit"
    ])

    const allowedPreventDefault = vi.fn()
    coordinator.handleBeforeQuit({ preventDefault: allowedPreventDefault })
    expect(allowedPreventDefault).not.toHaveBeenCalled()
    expect(events.filter((event) => event === "app-quit")).toHaveLength(1)
  })

  it("continues closing local owners when BYOK quiesce rejects", async () => {
    const events: string[] = []

    await closeLegacyOwnedServices({
      detachScheduler: () => events.push("scheduler-detach"),
      scheduler: Object.freeze({
        dispose: () => events.push("scheduler-dispose")
      }),
      byok: Object.freeze({
        dispose: () => events.push("byok-dispose"),
        quiesce: async () => {
          events.push("byok-quiesce")
          throw new Error("quiesce failed")
        }
      }),
      contribution: Object.freeze({
        dispose: () => events.push("contribution-dispose"),
        quiesce: async () => {
          events.push("contribution-quiesce")
        }
      }),
      collector: Object.freeze({
        dispose: () => events.push("collector-dispose"),
        quiesce: async () => {
          events.push("collector-quiesce")
        }
      }),
      store: Object.freeze({
        close: () => events.push("store-close")
      })
    })

    expect(events).toEqual([
      "scheduler-detach",
      "scheduler-dispose",
      "byok-dispose",
      "contribution-dispose",
      "collector-dispose",
      "byok-quiesce",
      "contribution-quiesce",
      "collector-quiesce",
      "store-close"
    ])
  })

  it("retains a fatal-startup lease until BYOK cleanup and store close", async () => {
    const events: string[] = []
    let ownedLease: Readonly<{ release(): Promise<void> }> | null = null
    const release = vi.fn(async () => {
      events.push("lease-release")
    })
    const lease = Object.freeze({ release })
    await expect(
      startLegacyRuntimeWithOwnedLease(
        lease,
        (owned) => {
          ownedLease = owned
        },
        async () => {
          events.push("startup-failed")
          throw new Error("startup failed")
        }
      )
    ).rejects.toThrow("startup failed")
    expect(ownedLease).toBe(lease)
    expect(release).not.toHaveBeenCalled()

    let releaseByokQuiesce!: () => void
    const byokQuiesceBarrier = new Promise<void>((resolve) => {
      releaseByokQuiesce = resolve
    })
    const requestQuit = vi.fn(() => events.push("app-quit-request"))
    const terminalExit = vi.fn((code?: number) =>
      events.push(`app-exit:${code}`)
    )
    const fatalQuit = createFatalQuitController({
      quit: requestQuit,
      exit: terminalExit
    })
    const coordinator = createLegacyShutdownCoordinator({
      closeOwnedServices: () =>
        closeLegacyOwnedServices({
          detachScheduler: null,
          scheduler: null,
          byok: Object.freeze({
            dispose: () => events.push("byok-dispose"),
            quiesce: async () => {
              events.push("byok-quiesce-start")
              await byokQuiesceBarrier
              events.push("byok-late-clear-end")
            }
          }),
          contribution: Object.freeze({
            dispose: () => events.push("contribution-dispose"),
            quiesce: async () => {
              events.push("contribution-quiesce")
            }
          }),
          collector: Object.freeze({
            dispose: () => events.push("collector-dispose"),
            quiesce: async () => {
              events.push("collector-quiesce")
            }
          }),
          store: Object.freeze({
            close: () => events.push("store-close")
          })
        }),
      releaseLease: async () => {
        const current = ownedLease
        ownedLease = null
        await current?.release()
      },
      quit: fatalQuit.completeLegacyShutdown
    })

    fatalQuit.requestLegacyFatalQuit()
    coordinator.handleBeforeQuit({ preventDefault: vi.fn() })
    await vi.waitFor(() =>
      expect(events).toEqual([
        "startup-failed",
        "app-quit-request",
        "byok-dispose",
        "contribution-dispose",
        "collector-dispose",
        "byok-quiesce-start"
      ])
    )
    expect(release).not.toHaveBeenCalled()
    expect(events).not.toContain("store-close")
    expect(terminalExit).not.toHaveBeenCalled()

    releaseByokQuiesce()
    await coordinator.completion()
    expect(events).toEqual([
      "startup-failed",
      "app-quit-request",
      "byok-dispose",
      "contribution-dispose",
      "collector-dispose",
      "byok-quiesce-start",
      "byok-late-clear-end",
      "contribution-quiesce",
      "collector-quiesce",
      "store-close",
      "lease-release",
      `app-exit:${FATAL_EXIT_CODE}`
    ])
    expect(requestQuit).toHaveBeenCalledOnce()
    expect(terminalExit).toHaveBeenCalledOnce()
    expect(terminalExit).toHaveBeenCalledWith(FATAL_EXIT_CODE)
    expect(release).toHaveBeenCalledOnce()
    expect(ownedLease).toBeNull()
  })
})
