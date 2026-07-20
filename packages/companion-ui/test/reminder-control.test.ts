import { describe, expect, it, vi } from "vitest";

import {
  parseReminderStatus,
  readReminderStatus,
  reminderBridge,
  reminderStatusText,
  saveReminderSettings,
  sendReminderTest,
  type ReminderStatus,
} from "../src/public/reminder-control.js";
import type { TokenMonsterCompanionBridge } from "../src/public/share-card.js";

function status(
  overrides: Partial<ReminderStatus> = {},
): ReminderStatus {
  return {
    contractVersion: 1,
    revision: "0",
    storage: "ready",
    notificationSupported: true,
    enabled: false,
    dailySummaryTime: "18:00",
    quietHours: { start: "22:00", end: "08:00" },
    scheduled: false,
    nextCheckAt: null,
    lastHandledLocalDate: null,
    ...overrides,
  };
}

function bridge(overrides: Partial<TokenMonsterCompanionBridge> = {}) {
  return {
    savePng: vi.fn(),
    getReminderStatus: vi.fn(async () => status()),
    updateReminderSettings: vi.fn(async () => ({ ok: true, status: status() })),
    testReminder: vi.fn(async () => ({ outcome: "shown", status: status() })),
    ...overrides,
  } satisfies TokenMonsterCompanionBridge;
}

describe("Electron reminder control", () => {
  it("appears only when the complete reminder bridge is present", () => {
    expect(reminderBridge(undefined)).toBeNull();
    expect(
      reminderBridge({ savePng: vi.fn() } as TokenMonsterCompanionBridge),
    ).toBeNull();

    const candidate = bridge();
    expect(reminderBridge(candidate)).toMatchObject({
      getReminderStatus: candidate.getReminderStatus,
      updateReminderSettings: candidate.updateReminderSettings,
      testReminder: candidate.testReminder,
    });
  });

  it("strictly validates status and response DTOs before rendering them", async () => {
    const parsed = parseReminderStatus(
      status({
        enabled: true,
        scheduled: true,
        nextCheckAt: "2026-07-18T18:01:00.000Z",
        lastHandledLocalDate: "2026-07-17",
      }),
    );
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.quietHours)).toBe(true);

    expect(() => parseReminderStatus({ ...status(), extra: true })).toThrow(
      "Invalid reminder status",
    );
    expect(() =>
      parseReminderStatus({
        ...status(),
        lastHandledLocalDate: "2026-02-31",
      }),
    ).toThrow("Invalid reminder status");
    expect(() =>
      parseReminderStatus({
        ...status(),
        nextCheckAt: "2026-07-18T18:01:00.000Z",
      }),
    ).toThrow("Invalid reminder status");

    const malformed = bridge({
      getReminderStatus: vi.fn(async () => ({ ...status(), extra: true })),
    });
    const reminder = reminderBridge(malformed);
    if (reminder === null) throw new Error("missing reminder bridge");
    await expect(readReminderStatus(reminder)).rejects.toThrow(
      "Invalid reminder status",
    );
  });

  it("saves exact local settings and rejects invalid times before IPC", async () => {
    const update = vi.fn(async () => ({
      ok: true as const,
      status: status({
        enabled: true,
        scheduled: true,
        nextCheckAt: "2026-07-18T18:01:00.000Z",
      }),
    }));
    const reminder = reminderBridge(
      bridge({ updateReminderSettings: update }),
    );
    if (reminder === null) throw new Error("missing reminder bridge");

    await expect(
      saveReminderSettings(reminder, {
        expectedRevision: "0",
        enabled: true,
        dailySummaryTime: "18:00",
        quietHours: { start: "22:00", end: "08:00" },
      }),
    ).resolves.toMatchObject({ ok: true, status: { enabled: true } });
    expect(update).toHaveBeenCalledWith({
      expectedRevision: "0",
      enabled: true,
      dailySummaryTime: "18:00",
      quietHours: { start: "22:00", end: "08:00" },
    });

    await expect(
      saveReminderSettings(reminder, {
        expectedRevision: "0",
        enabled: true,
        dailySummaryTime: "24:00",
        quietHours: { start: "22:00", end: "08:00" },
      }),
    ).rejects.toThrow("Invalid reminder settings");
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("accepts a conflict only with the authoritative revisioned status", async () => {
    const update = vi.fn(async () => ({
      ok: false as const,
      error: "conflict" as const,
      status: status({ revision: "2", dailySummaryTime: "17:00" }),
    }));
    const reminder = reminderBridge(
      bridge({ updateReminderSettings: update }),
    );
    if (reminder === null) throw new Error("missing reminder bridge");

    await expect(
      saveReminderSettings(reminder, {
        expectedRevision: "1",
        enabled: true,
        dailySummaryTime: "18:00",
        quietHours: { start: "22:00", end: "08:00" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "conflict",
      status: { revision: "2", dailySummaryTime: "17:00" },
    });
  });

  it("parses test outcomes and explains disabled, scheduled, and unavailable states", async () => {
    const reminder = reminderBridge(bridge());
    if (reminder === null) throw new Error("missing reminder bridge");
    await expect(sendReminderTest(reminder)).resolves.toMatchObject({
      outcome: "shown",
    });

    expect(reminderStatusText(status())).toContain("每日提醒目前關閉");
    expect(
      reminderStatusText(
        status({
          enabled: true,
          scheduled: true,
          nextCheckAt: "2026-07-18T18:01:00.000Z",
        }),
        "提醒設定已儲存。",
      ),
    ).toBe(
      "提醒設定已儲存。 每天 18:00 檢查本機摘要；安靜時段 22:00–08:00。",
    );
    expect(
      reminderStatusText(
        status({
          storage: "unavailable",
          notificationSupported: false,
        }),
      ),
    ).toContain("每日提醒保持關閉");
  });
});
