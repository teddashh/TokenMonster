import { describe, expect, it, vi } from "vitest"

import type {
  ContributionActionResult,
  ContributionDeletionResult
} from "@tokenmonster/contribution-runtime"

import {
  deleteContributionWithSchedulerPaused,
  stopContributionWithSchedulerPaused
} from "../src/main/contribution-scheduler-boundary.js"

const stillEnabledResult = Object.freeze({
  ok: false,
  code: "secure-storage-error",
  status: Object.freeze({ enabled: true })
})

describe("legacy Electron contribution scheduler boundaries", () => {
  it("keeps Stop paused when secure-storage failure leaves status enabled", async () => {
    const pause = vi.fn()
    const wake = vi.fn()
    const stop = vi.fn(async () =>
      stillEnabledResult as unknown as ContributionActionResult
    )
    const scheduler = { pause, wake }

    await expect(
      stopContributionWithSchedulerPaused(
        { stop },
        scheduler
      )
    ).resolves.toBe(stillEnabledResult)

    expect(pause).toHaveBeenCalledOnce()
    expect(pause.mock.invocationCallOrder[0]).toBeLessThan(
      stop.mock.invocationCallOrder[0]!
    )
    expect(wake).not.toHaveBeenCalled()
  })

  it("pauses before Delete and stays paused on result or rejection", async () => {
    const pause = vi.fn()
    const wake = vi.fn()
    const requestDeletion = vi
      .fn<() => Promise<ContributionDeletionResult>>()
      .mockResolvedValueOnce(
        stillEnabledResult as unknown as ContributionDeletionResult
      )
      .mockRejectedValueOnce(new Error("SECURE_STORAGE_FAILED"))
    const contribution = { requestDeletion }
    const scheduler = { pause, wake }

    await expect(
      deleteContributionWithSchedulerPaused(contribution, scheduler)
    ).resolves.toBe(stillEnabledResult)
    await expect(
      deleteContributionWithSchedulerPaused(contribution, scheduler)
    ).rejects.toThrow("SECURE_STORAGE_FAILED")

    expect(pause).toHaveBeenCalledTimes(2)
    expect(pause.mock.invocationCallOrder[0]).toBeLessThan(
      requestDeletion.mock.invocationCallOrder[0]!
    )
    expect(pause.mock.invocationCallOrder[1]).toBeLessThan(
      requestDeletion.mock.invocationCallOrder[1]!
    )
    expect(wake).not.toHaveBeenCalled()
  })
})
