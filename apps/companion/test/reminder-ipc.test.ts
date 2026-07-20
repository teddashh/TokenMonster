import type { IpcMainInvokeEvent } from "electron";

import { describe, expect, it, vi } from "vitest";

import {
  registerReminderIpcHandlers,
  type ReminderIpcOptions,
} from "../src/main/reminder-ipc.js";
import type { ReminderService } from "../src/main/reminder-service.js";
import {
  DEFAULT_REMINDER_SETTINGS,
  REMINDER_IPC_CHANNELS,
  type ReminderServiceStatus,
} from "../src/shared/reminders.js";

type Handler = (event: IpcMainInvokeEvent, input?: unknown) => unknown;

function status(): ReminderServiceStatus {
  return Object.freeze({
    contractVersion: 1,
    revision: "0",
    storage: "ready",
    notificationSupported: true,
    enabled: false,
    dailySummaryTime: DEFAULT_REMINDER_SETTINGS.dailySummaryTime,
    quietHours: DEFAULT_REMINDER_SETTINGS.quietHours,
    scheduled: false,
    nextCheckAt: null,
    lastHandledLocalDate: null,
  });
}

describe("reminder IPC registration", () => {
  it("registers only fixed channels, rejects untrusted senders, and cleans up", async () => {
    const handlers = new Map<string, Handler>();
    const removeHandler = vi.fn((channel: string) => handlers.delete(channel));
    const ipc = {
      handle(channel: string, handler: Handler): void {
        handlers.set(channel, handler);
      },
      removeHandler,
    } as unknown as ReminderIpcOptions["ipc"];
    const updateSettings = vi.fn(async () => ({ ok: true as const, status: status() }));
    const testNotification = vi.fn(async () => ({
      outcome: "shown" as const,
      status: status(),
    }));
    const service = {
      status,
      updateSettings,
      testNotification,
      tick: vi.fn(),
      resume: vi.fn(),
      dispose: vi.fn(),
    } satisfies ReminderService;
    const trustedEvent = { trusted: true } as unknown as IpcMainInvokeEvent;
    const rejectedEvent = { trusted: false } as unknown as IpcMainInvokeEvent;
    const remove = registerReminderIpcHandlers({
      ipc,
      service,
      trustedSender: (event) => event === trustedEvent,
    });

    expect([...handlers.keys()].sort()).toEqual(
      Object.values(REMINDER_IPC_CHANNELS).sort(),
    );
    expect(removeHandler).toHaveBeenCalledTimes(3);

    for (const handler of handlers.values()) {
      expect(() => handler(rejectedEvent)).toThrow("IPC_REQUEST_REJECTED");
    }
    expect(updateSettings).not.toHaveBeenCalled();
    expect(testNotification).not.toHaveBeenCalled();

    expect(
      handlers.get(REMINDER_IPC_CHANNELS.status)?.(trustedEvent),
    ).toEqual(status());
    const input = Object.freeze({
      expectedRevision: "0",
      enabled: true,
      dailySummaryTime: "18:00",
      quietHours: Object.freeze({ start: "22:00", end: "08:00" }),
    });
    await expect(
      handlers.get(REMINDER_IPC_CHANNELS.update)?.(trustedEvent, input),
    ).resolves.toMatchObject({ ok: true });
    expect(updateSettings).toHaveBeenCalledWith(input);
    await expect(
      handlers.get(REMINDER_IPC_CHANNELS.test)?.(trustedEvent),
    ).resolves.toMatchObject({ outcome: "shown" });

    remove();
    expect(handlers.size).toBe(0);
    expect(removeHandler).toHaveBeenCalledTimes(6);
  });
});
