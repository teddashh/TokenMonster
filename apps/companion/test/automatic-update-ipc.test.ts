import type { IpcMainInvokeEvent } from "electron";

import { describe, expect, it, vi } from "vitest";

import {
  registerAutomaticUpdateIpcHandlers,
  type AutomaticUpdateIpcOptions,
} from "../src/main/automatic-update-ipc.js";
import type { AutomaticUpdateService } from "../src/main/automatic-update-service.js";
import {
  AUTOMATIC_UPDATE_IPC_CHANNELS,
  type AutomaticUpdateServiceStatus,
} from "../src/shared/automatic-updates.js";

type Handler = (event: IpcMainInvokeEvent, input?: unknown) => unknown;

function status(): AutomaticUpdateServiceStatus {
  return Object.freeze({
    contractVersion: 1,
    revision: "0",
    preferenceStorage: "ready",
    automaticChecksEnabled: false,
    update: Object.freeze({
      contractVersion: 1,
      currentVersion: "0.1.0",
      channel: "latest",
      status: "idle",
      lastCheckedAt: null,
      availableVersion: null,
      errorCode: null,
    }),
  });
}

describe("automatic update IPC registration", () => {
  it("registers only fixed operations, validates senders, and removes every handler", async () => {
    const handlers = new Map<string, Handler>();
    const removeHandler = vi.fn((channel: string) => handlers.delete(channel));
    const ipc = {
      handle(channel: string, handler: Handler): void {
        handlers.set(channel, handler);
      },
      removeHandler,
    } as unknown as AutomaticUpdateIpcOptions["ipc"];
    const updatePreference = vi.fn(async () => ({
      ok: true as const,
      status: status(),
    }));
    const checkNow = vi.fn(() => ({
      ok: true as const,
      code: "check-started" as const,
      status: status(),
    }));
    const quitAndInstall = vi.fn(() => ({
      ok: false as const,
      code: "not-ready" as const,
      status: status(),
    }));
    const service = {
      status,
      updatePreference,
      checkNow,
      quitAndInstall,
      dispose: vi.fn(),
    } satisfies AutomaticUpdateService;
    const trustedEvent = { trusted: true } as unknown as IpcMainInvokeEvent;
    const rejectedEvent = { trusted: false } as unknown as IpcMainInvokeEvent;
    const remove = registerAutomaticUpdateIpcHandlers({
      ipc,
      service,
      trustedSender: (event) => event === trustedEvent,
    });

    expect([...handlers.keys()].sort()).toEqual(
      Object.values(AUTOMATIC_UPDATE_IPC_CHANNELS).sort(),
    );
    expect(removeHandler).toHaveBeenCalledTimes(4);
    for (const handler of handlers.values()) {
      expect(() => handler(rejectedEvent)).toThrow("IPC_REQUEST_REJECTED");
    }
    expect(updatePreference).not.toHaveBeenCalled();
    expect(checkNow).not.toHaveBeenCalled();
    expect(quitAndInstall).not.toHaveBeenCalled();

    expect(
      handlers.get(AUTOMATIC_UPDATE_IPC_CHANNELS.status)?.(trustedEvent),
    ).toEqual(status());
    const request = Object.freeze({
      expectedRevision: "0",
      automaticChecksEnabled: true,
    });
    await expect(
      handlers.get(AUTOMATIC_UPDATE_IPC_CHANNELS.preference)?.(
        trustedEvent,
        request,
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(updatePreference).toHaveBeenCalledWith(request);
    expect(
      handlers.get(AUTOMATIC_UPDATE_IPC_CHANNELS.check)?.(trustedEvent),
    ).toMatchObject({ code: "check-started" });
    expect(
      handlers.get(AUTOMATIC_UPDATE_IPC_CHANNELS.install)?.(trustedEvent),
    ).toMatchObject({ code: "not-ready" });

    checkNow.mockImplementationOnce(() => {
      throw new Error("PRIVATE_UPDATER_CANARY");
    });
    expect(() =>
      handlers.get(AUTOMATIC_UPDATE_IPC_CHANNELS.check)?.(trustedEvent),
    ).toThrow("IPC_REQUEST_REJECTED");
    updatePreference.mockRejectedValueOnce(
      new Error("PRIVATE_PREFERENCE_PATH_CANARY") as never,
    );
    await expect(
      handlers.get(AUTOMATIC_UPDATE_IPC_CHANNELS.preference)?.(
        trustedEvent,
        request,
      ),
    ).rejects.toThrow("IPC_REQUEST_REJECTED");

    remove();
    expect(handlers.size).toBe(0);
    expect(removeHandler).toHaveBeenCalledTimes(8);
  });
});
