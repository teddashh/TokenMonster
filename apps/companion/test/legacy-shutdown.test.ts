import { describe, expect, it, vi } from "vitest"

import {
  closeLegacyOwnedServices,
  createLegacyShutdownCoordinator
} from "../src/main/legacy-shutdown.js"

describe("legacy Electron shutdown", () => {
  it("defers repeated quit events until contribution quiesces and releases once", async () => {
    const events: string[] = []
    let releaseQuiesce!: () => void
    const quiesceBarrier = new Promise<void>((resolve) => {
      releaseQuiesce = resolve
    })
    const closeOwnedServices = () =>
      closeLegacyOwnedServices({
        detachScheduler: () => events.push("scheduler-detach"),
        scheduler: Object.freeze({
          dispose: () => events.push("scheduler-dispose")
        }),
        byok: Object.freeze({
          dispose: () => events.push("byok-dispose")
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
          dispose: () => events.push("collector-dispose")
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
        "contribution-quiesce-start"
      ])
    )

    releaseQuiesce()
    await coordinator.completion()
    expect(events).toEqual([
      "scheduler-detach",
      "scheduler-dispose",
      "byok-dispose",
      "contribution-dispose",
      "collector-dispose",
      "contribution-quiesce-start",
      "contribution-quiesce-end",
      "store-close",
      "lease-release",
      "app-quit"
    ])

    const allowedPreventDefault = vi.fn()
    coordinator.handleBeforeQuit({ preventDefault: allowedPreventDefault })
    expect(allowedPreventDefault).not.toHaveBeenCalled()
    expect(events.filter((event) => event === "app-quit")).toHaveLength(1)
  })
})
