import { readFile } from "node:fs/promises"

import { describe, expect, it, vi } from "vitest"

import {
  FATAL_EXIT_CODE,
  createFatalQuitController,
  createPetStartupQuitBridge,
  handleModeAwareBeforeQuit,
  runPetStartupWithOwnedLease
} from "../src/main/graceful-fatal-quit.js"

describe("fatal Electron quit boundary", () => {
  it("hands an early pet quit to its drain only after startup settles", async () => {
    let finishStartup!: () => void
    const startup = new Promise<void>((resolve) => {
      finishStartup = resolve
    })
    const quit = vi.fn()
    const bridge = createPetStartupQuitBridge(quit)
    bridge.track(startup)
    const first = Object.freeze({ preventDefault: vi.fn() })
    const repeated = Object.freeze({ preventDefault: vi.fn() })

    expect(bridge.handleBeforeQuit(first)).toBe(true)
    expect(bridge.handleBeforeQuit(repeated)).toBe(true)
    expect(first.preventDefault).toHaveBeenCalledOnce()
    expect(repeated.preventDefault).toHaveBeenCalledOnce()
    expect(quit).not.toHaveBeenCalled()

    finishStartup()
    await startup
    await Promise.resolve()
    expect(quit).toHaveBeenCalledOnce()

    const handedOff = Object.freeze({ preventDefault: vi.fn() })
    expect(bridge.handleBeforeQuit(handedOff)).toBe(false)
    expect(handedOff.preventDefault).not.toHaveBeenCalled()
  })

  it.each(["startup", "activate"])(
    "defers a fatal legacy %s exit until shutdown completion",
    () => {
      const quit = vi.fn()
      const exit = vi.fn()
      const controller = createFatalQuitController({ quit, exit })

      controller.requestLegacyFatalQuit()

      expect(quit).toHaveBeenCalledOnce()
      expect(exit).not.toHaveBeenCalled()

      controller.completeLegacyShutdown()
      expect(exit).toHaveBeenCalledOnce()
      expect(exit).toHaveBeenCalledWith(FATAL_EXIT_CODE)
    }
  )

  it("exits pet fatally only after its startup lease cleanup", async () => {
    const events: string[] = []
    const lease = Object.freeze({
      release: async () => {
        events.push("lease-release")
      }
    })
    const exit = vi.fn((code?: number) => events.push(`app-exit:${code}`))
    const controller = createFatalQuitController({ quit: vi.fn(), exit })

    await expect(
      runPetStartupWithOwnedLease(lease, async () => {
        events.push("pet-start-failed")
        throw new Error("pet startup failed")
      })
    ).rejects.toThrow("pet startup failed")
    expect(events).toEqual(["pet-start-failed", "lease-release"])
    expect(exit).not.toHaveBeenCalled()

    controller.exitPetFatalAfterDrain()
    expect(events).toEqual([
      "pet-start-failed",
      "lease-release",
      `app-exit:${FATAL_EXIT_CODE}`
    ])
  })

  it("does not route pet-mode before-quit through the legacy coordinator", () => {
    const handleBeforeQuit = vi.fn()
    const coordinator = Object.freeze({
      handleBeforeQuit,
      completion: () => null
    })
    const event = Object.freeze({ preventDefault: vi.fn() })

    handleModeAwareBeforeQuit(true, coordinator, event)
    expect(handleBeforeQuit).not.toHaveBeenCalled()

    handleModeAwareBeforeQuit(false, coordinator, event)
    expect(handleBeforeQuit).toHaveBeenCalledOnce()
    expect(handleBeforeQuit).toHaveBeenCalledWith(event)
  })

  it("routes startup and activate failures through the fatal controller", async () => {
    const mainSource = await readFile(
      new URL("../src/main/main.ts", import.meta.url),
      "utf8"
    )

    expect(
      mainSource.match(/fatalQuit\.requestLegacyFatalQuit\(\)/gu)
    ).toHaveLength(2)
    expect(mainSource).toMatch(
      /let closeRequested = false\s+window\.once\("close", \(\) => \{\s+closeRequested = true\s+\}\)/u
    )
    expect(mainSource).toMatch(
      /catch \{\s+if \(closeRequested\) return window\s+if \(!legacyStartup\.shutdownRequested\(\)\) \{\s+fatalQuit\.markLegacyFatalIntent\(\)\s+\}\s+if \(!window\.isDestroyed\(\)\) window\.destroy\(\)/u
    )
    expect(mainSource).toContain("fatalQuit.exitPetFatalAfterDrain()")
    const fatalStartupBoundary = mainSource.slice(
      mainSource.indexOf("async function createWindow"),
      mainSource.indexOf('app.on("before-quit"')
    )
    expect(fatalStartupBoundary).not.toContain("process.exitCode")
    expect(fatalStartupBoundary).not.toMatch(/app\.exit\(1\)/u)
    expect(mainSource).toMatch(
      /byokService = service\s+await service\.initialize\(\)\s+legacyStartup\.assertRunning\(\)/u
    )
    expect(mainSource).toMatch(
      /contributionService = contribution\s+await contribution\.initialize\(\)\s+legacyStartup\.assertRunning\(\)/u
    )
    expect(mainSource).toContain("legacyStartup.track(startupOperation)")
    expect(mainSource).toContain("petStartupQuit.track(startupOperation)")
    expect(mainSource).toMatch(
      /if \(petMode && petStartupQuit\.handleBeforeQuit\(event\)\) return/u
    )
    expect(mainSource).toMatch(
      /legacyStartup\.requestShutdown\(\)[\s\S]*disposeLegacyOwnedServices\([\s\S]*await legacyStartup\.join\(\)[\s\S]*await closeLegacyOwnedServices/u
    )
  })
})
