import { describe, expect, it, vi } from "vitest"

import {
  closeLegacyAppWhenWindowless,
  suspendLegacyWindowByok
} from "../src/main/legacy-window-lifecycle.js"

describe("legacy Electron window lifecycle", () => {
  it("suspends BYOK on window close without permanently disposing it", () => {
    const suspend = vi.fn()

    suspendLegacyWindowByok(Object.freeze({ suspend }))

    expect(suspend).toHaveBeenCalledOnce()
  })

  it("keeps the process alive for macOS activate window recreation", () => {
    const quit = vi.fn()

    closeLegacyAppWhenWindowless("darwin", quit)
    expect(quit).not.toHaveBeenCalled()

    closeLegacyAppWhenWindowless("linux", quit)
    expect(quit).toHaveBeenCalledOnce()
  })
})
