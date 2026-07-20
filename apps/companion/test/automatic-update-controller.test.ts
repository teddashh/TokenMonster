import { describe, expect, it, vi } from "vitest";

import {
  AUTOMATIC_UPDATE_SCHEDULE,
  AUTOMATIC_UPDATE_TIMEOUTS,
  createAutomaticUpdateController,
  type AutomaticUpdateTimerPort,
  type WindowsSquirrelUpdaterEventName,
  type WindowsSquirrelUpdaterListener,
  type WindowsSquirrelUpdaterPort,
} from "../src/main/automatic-update-controller.js";
import {
  isAutomaticUpdateVersion,
  parseAutomaticUpdateDto,
  windowsSquirrelFeedUrl,
} from "../src/shared/automatic-updates.js";

class FakeUpdater implements WindowsSquirrelUpdaterPort {
  public readonly listeners = new Map<
    WindowsSquirrelUpdaterEventName,
    Set<WindowsSquirrelUpdaterListener>
  >();
  public readonly setFeedURL = vi.fn();
  public readonly checkForUpdates = vi.fn();
  public readonly quitAndInstall = vi.fn();

  public on(
    event: WindowsSquirrelUpdaterEventName,
    listener: WindowsSquirrelUpdaterListener,
  ): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  public removeListener(
    event: WindowsSquirrelUpdaterEventName,
    listener: WindowsSquirrelUpdaterListener,
  ): void {
    this.listeners.get(event)?.delete(listener);
  }

  public emit(event: WindowsSquirrelUpdaterEventName, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

class FakeTimer implements AutomaticUpdateTimerPort {
  public readonly pending = new Map<number, () => void>();
  public readonly setCalls: number[] = [];
  public readonly cleared: number[] = [];
  private nextHandle = 1;

  public set(delayMs: number, callback: () => void): unknown {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.setCalls.push(delayMs);
    this.pending.set(handle, callback);
    return handle;
  }

  public clear(handle: unknown): void {
    if (typeof handle !== "number") throw new TypeError("invalid handle");
    this.cleared.push(handle);
    this.pending.delete(handle);
  }

  public fireNext(): void {
    const next = this.pending.entries().next().value as
      | readonly [number, () => void]
      | undefined;
    if (next === undefined) throw new Error("no pending timer");
    this.pending.delete(next[0]);
    next[1]();
  }

  public fireLatest(): void {
    const entries = [...this.pending.entries()];
    const next = entries.at(-1);
    if (next === undefined) throw new Error("no pending timer");
    this.pending.delete(next[0]);
    next[1]();
  }
}

function harness(
  overrides: Readonly<{
    platform?: NodeJS.Platform;
    version?: string;
    now?: Date;
    automaticChecksEnabled?: boolean;
  }> = {},
) {
  const updater = new FakeUpdater();
  const timer = new FakeTimer();
  const beforeQuitForUpdate = vi.fn();
  const now = overrides.now ?? new Date("2026-07-18T12:34:56.000Z");
  const controller = createAutomaticUpdateController({
    updater,
    timer,
    clock: { now: () => new Date(now) },
    platform: { current: () => overrides.platform ?? "win32" },
    currentVersion: { current: () => overrides.version ?? "0.1.0" },
    automaticChecksEnabled: overrides.automaticChecksEnabled ?? true,
    beforeQuitForUpdate,
  });
  return { controller, updater, timer, beforeQuitForUpdate };
}

describe("automatic update controller", () => {
  it("selects a fixed feed and schedules the first Windows check", () => {
    const { controller, updater, timer } = harness();
    expect(controller.status()).toEqual({
      contractVersion: 1,
      currentVersion: "0.1.0",
      channel: "latest",
      status: "idle",
      lastCheckedAt: null,
      availableVersion: null,
      errorCode: null,
    });
    expect(updater.setFeedURL).not.toHaveBeenCalled();
    expect(timer.setCalls).toEqual([
      AUTOMATIC_UPDATE_SCHEDULE.initialDelayMs,
    ]);
    timer.fireNext();
    expect(updater.setFeedURL).toHaveBeenCalledWith({
      url: windowsSquirrelFeedUrl("latest"),
    });
    expect([...updater.listeners.keys()]).not.toContain("download-progress");
    expect(updater.listeners.has("before-quit-for-update")).toBe(true);
  });

  it("uses the prerelease channel for prerelease builds", () => {
    const { controller, updater } = harness({ version: "0.1.0-rc.11" });
    expect(controller.status().channel).toBe("next");
    expect(updater.setFeedURL).not.toHaveBeenCalled();
    controller.checkNow();
    expect(updater.setFeedURL).toHaveBeenCalledWith({
      url: windowsSquirrelFeedUrl("next"),
    });
  });

  it("keeps startup and follow-up checks manual unless locally enabled", () => {
    const { controller, updater, timer } = harness({
      automaticChecksEnabled: false,
    });
    expect(timer.pending.size).toBe(0);
    expect(updater.setFeedURL).not.toHaveBeenCalled();
    expect(controller.checkNow().code).toBe("check-started");
    expect(updater.setFeedURL).toHaveBeenCalledTimes(1);
    updater.emit("update-not-available");
    expect(controller.status().status).toBe("idle");
    expect(timer.pending.size).toBe(0);
  });

  it("applies a persisted preference without recreating an active controller", () => {
    const { controller, updater, timer } = harness({
      automaticChecksEnabled: false,
    });
    controller.setAutomaticChecksEnabled(true);
    expect(timer.setCalls).toEqual([
      AUTOMATIC_UPDATE_SCHEDULE.initialDelayMs,
    ]);
    expect(updater.setFeedURL).not.toHaveBeenCalled();
    controller.setAutomaticChecksEnabled(false);
    expect(timer.pending.size).toBe(0);

    controller.checkNow();
    controller.setAutomaticChecksEnabled(true);
    controller.setAutomaticChecksEnabled(false);
    updater.emit("update-not-available");
    expect(timer.pending.size).toBe(0);
  });

  it("does not initialize the updater on unsupported platforms", () => {
    const { controller, updater, timer } = harness({ platform: "linux" });
    expect(controller.status().status).toBe("unsupported");
    expect(controller.checkNow().code).toBe("unsupported");
    expect(updater.setFeedURL).not.toHaveBeenCalled();
    expect(timer.pending.size).toBe(0);
  });

  it("runs one check at a time and records a canonical check instant", () => {
    const { controller, updater } = harness();
    expect(controller.checkNow()).toMatchObject({
      ok: true,
      code: "check-started",
    });
    expect(controller.status()).toMatchObject({
      status: "checking",
      lastCheckedAt: "2026-07-18T12:34:56.000Z",
    });
    expect(controller.checkNow().code).toBe("check-busy");
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("moves through download and installation only for a newer version", () => {
    const { controller, updater, timer, beforeQuitForUpdate } = harness();
    controller.checkNow();
    updater.emit("update-available", { version: "0.2.0" });
    expect(controller.status()).toMatchObject({
      status: "downloading",
      availableVersion: "0.2.0",
    });
    updater.emit("update-downloaded", { version: "0.2.0" });
    expect(controller.status().status).toBe("ready");
    expect(timer.pending.size).toBe(0);
    updater.quitAndInstall.mockImplementation(() => {
      updater.emit("before-quit-for-update");
      updater.emit("before-quit-for-update");
    });
    expect(controller.quitAndInstall()).toMatchObject({
      ok: true,
      code: "install-started",
    });
    expect(beforeQuitForUpdate).toHaveBeenCalledTimes(1);
    expect(controller.quitAndInstall().code).toBe("install-busy");
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("fails closed when update-quit lifecycle preparation throws", () => {
    const { controller, updater, beforeQuitForUpdate } = harness();
    controller.checkNow();
    updater.emit("update-downloaded", { version: "0.2.0" });
    beforeQuitForUpdate.mockImplementation(() => {
      throw new Error("PRIVATE_UPDATE_QUIT_CANARY");
    });
    updater.quitAndInstall.mockImplementation(() => {
      updater.emit("before-quit-for-update");
    });

    expect(controller.quitAndInstall()).toMatchObject({
      ok: false,
      code: "failed",
      update: { status: "error", errorCode: "install-failed" },
    });
    expect(JSON.stringify(controller.status())).not.toContain(
      "PRIVATE_UPDATE_QUIT_CANARY",
    );
  });

  it.each(["0.1.0", "0.0.9", "not-a-version"])(
    "rejects invalid or non-newer update version %s",
    (version) => {
      const { controller, updater } = harness();
      controller.checkNow();
      updater.emit("update-available", { version });
      expect(controller.status()).toMatchObject({
        status: "error",
        errorCode: "invalid-update",
      });
    },
  );

  it("orders the largest Windows-compatible numeric components exactly", () => {
    const { controller, updater } = harness({
      version: "65534.0.0",
    });
    controller.checkNow();
    updater.emit("update-available", {
      version: "65535.0.0",
    });
    expect(controller.status()).toMatchObject({
      status: "downloading",
      availableVersion: "65535.0.0",
    });
  });

  it.each([
    ["1.2.3-rc-hotfix.1", "1.2.3-rc-hotfix.2"],
    ["1.2.3-alpha-beta.1", "1.2.3-alpha-beta-z.1"],
  ])(
    "keeps every hyphen in prerelease identifiers when ordering %s before %s",
    (currentVersion, availableVersion) => {
      const { controller, updater } = harness({ version: currentVersion });
      controller.checkNow();
      updater.emit("update-available");
      updater.emit("update-downloaded", {}, "release notes", availableVersion);
      expect(controller.status()).toMatchObject({
        status: "ready",
        availableVersion,
        errorCode: null,
      });
    },
  );

  it.each(["1.2.3-rc-hotfix.1", "1.2.3-rc-hotfix.01"])(
    "rejects downgraded or invalid multi-hyphen prerelease %s",
    (availableVersion) => {
      const { controller, updater } = harness({
        version: "1.2.3-rc-hotfix.2",
      });
      controller.checkNow();
      updater.emit("update-available");
      updater.emit("update-downloaded", {}, "release notes", availableVersion);
      expect(controller.status()).toMatchObject({
        status: "error",
        errorCode: "invalid-update",
        availableVersion: null,
      });
    },
  );

  it("accepts Electron's releaseName event position", () => {
    const { controller, updater } = harness({ version: "0.1.0-rc.10" });
    controller.checkNow();
    updater.emit("update-available");
    updater.emit(
      "update-downloaded",
      {},
      "release notes",
      "0.1.0-rc.11",
    );
    expect(controller.status()).toMatchObject({
      status: "ready",
      availableVersion: "0.1.0-rc.11",
    });
  });

  it("restores Squirrel's collapsed prerelease before downgrade checks", () => {
    const downgrade = harness({ version: "0.1.0-rc.11" });
    downgrade.controller.checkNow();
    downgrade.updater.emit(
      "update-downloaded",
      {},
      "release notes",
      "0.1.0-rc8",
    );
    expect(downgrade.controller.status()).toMatchObject({
      status: "error",
      errorCode: "invalid-update",
    });

    const upgrade = harness({ version: "0.1.0-rc.11" });
    upgrade.controller.checkNow();
    upgrade.updater.emit(
      "update-downloaded",
      {},
      "release notes",
      "0.1.0-rc12",
    );
    expect(upgrade.controller.status()).toMatchObject({
      status: "ready",
      availableVersion: "0.1.0-rc.12",
    });
  });

  it("rejects prerelease candidates from the stable feed", () => {
    const { controller, updater } = harness({ version: "0.1.0" });
    controller.checkNow();
    updater.emit("update-downloaded", {}, "release notes", "0.2.0-rc1");
    expect(controller.status()).toMatchObject({
      status: "error",
      errorCode: "invalid-update",
    });
  });

  it("returns to idle and schedules the periodic check when current", () => {
    const { controller, updater, timer } = harness();
    controller.checkNow();
    updater.emit("update-not-available");
    expect(controller.status()).toMatchObject({
      status: "idle",
      availableVersion: null,
      errorCode: null,
    });
    expect(timer.setCalls.at(-1)).toBe(
      AUTOMATIC_UPDATE_SCHEDULE.periodicIntervalMs,
    );
  });

  it("bounds checks and downloads that never settle", () => {
    const check = harness();
    check.controller.checkNow();
    expect(check.timer.setCalls.at(-1)).toBe(
      AUTOMATIC_UPDATE_TIMEOUTS.checkMs,
    );
    check.timer.fireLatest();
    expect(check.controller.status()).toMatchObject({
      status: "error",
      errorCode: "check-failed",
    });
    expect(check.controller.checkNow().code).toBe("check-busy");
    expect(check.updater.checkForUpdates).toHaveBeenCalledTimes(1);
    check.updater.emit("update-not-available");
    expect(check.controller.status().status).toBe("idle");
    expect(check.controller.checkNow().code).toBe("check-started");
    expect(check.updater.checkForUpdates).toHaveBeenCalledTimes(2);

    const download = harness();
    download.controller.checkNow();
    download.updater.emit("update-available", { version: "0.2.0" });
    expect(download.timer.setCalls.at(-1)).toBe(
      AUTOMATIC_UPDATE_TIMEOUTS.downloadMs,
    );
    download.timer.fireLatest();
    expect(download.controller.status()).toMatchObject({
      status: "error",
      errorCode: "download-failed",
      availableVersion: "0.2.0",
    });
    expect(download.controller.checkNow().code).toBe("check-busy");
  });

  it("classifies check and download failures without leaking error details", () => {
    const first = harness();
    first.controller.checkNow();
    first.updater.emit("error", new Error("PRIVATE_PATH_CANARY"));
    expect(first.controller.status()).toMatchObject({
      status: "error",
      errorCode: "check-failed",
    });
    expect(JSON.stringify(first.controller.status())).not.toContain(
      "PRIVATE_PATH_CANARY",
    );

    const second = harness();
    second.controller.checkNow();
    second.updater.emit("update-available", { version: "0.2.0" });
    second.updater.emit("error", new Error("PRIVATE_PATH_CANARY"));
    expect(second.controller.status()).toMatchObject({
      status: "error",
      errorCode: "download-failed",
      availableVersion: "0.2.0",
    });
  });

  it("handles synchronous updater and installer failures", () => {
    const check = harness();
    check.updater.checkForUpdates.mockImplementation(() => {
      throw new Error("check failed");
    });
    expect(check.controller.checkNow()).toMatchObject({
      ok: false,
      code: "failed",
    });
    expect(check.controller.status().errorCode).toBe("check-failed");

    const install = harness();
    install.controller.checkNow();
    install.updater.emit("update-downloaded", { version: "0.2.0" });
    install.updater.quitAndInstall.mockImplementation(() => {
      throw new Error("install failed");
    });
    expect(install.controller.quitAndInstall()).toMatchObject({
      ok: false,
      code: "failed",
    });
    expect(install.controller.status().errorCode).toBe("install-failed");
  });

  it("disposes timers and event listeners idempotently", () => {
    const { controller, updater, timer } = harness();
    controller.dispose();
    controller.dispose();
    expect(controller.checkNow().code).toBe("disposed");
    expect(controller.quitAndInstall().code).toBe("disposed");
    expect(timer.pending.size).toBe(0);
    expect(
      [...updater.listeners.values()].every((listeners) => listeners.size === 0),
    ).toBe(true);
    updater.emit("update-available", { version: "0.2.0" });
    expect(controller.status().status).toBe("idle");
  });

  it("ignores updater events that do not belong to an active check", () => {
    const { controller, updater } = harness();
    updater.emit("update-available", { version: "0.2.0" });
    updater.emit("update-downloaded", { version: "0.2.0" });
    updater.emit("update-not-available");
    updater.emit("error", new Error("late"));
    expect(controller.status()).toMatchObject({
      status: "idle",
      availableVersion: null,
      errorCode: null,
    });

    controller.checkNow();
    updater.emit("error", new Error("timeout"));
    updater.emit("update-downloaded", { version: "0.2.0" });
    expect(controller.status()).toMatchObject({
      status: "error",
      errorCode: "check-failed",
      availableVersion: null,
    });
  });
});

describe("automatic update DTO", () => {
  it("accepts strict multi-hyphen prereleases but rejects invalid numeric identifiers and build metadata", () => {
    expect(isAutomaticUpdateVersion("1.2.3-rc-hotfix.1")).toBe(true);
    expect(isAutomaticUpdateVersion("1.2.3-alpha-beta-z.9")).toBe(true);
    expect(isAutomaticUpdateVersion("1.2.3-rc-hotfix.01")).toBe(false);
    expect(isAutomaticUpdateVersion("1.2.3-rc-hotfix.1+build.2")).toBe(false);
    expect(isAutomaticUpdateVersion("1.2.3-beta2")).toBe(false);
    expect(isAutomaticUpdateVersion("1.2.3-beta.1.2")).toBe(false);
    expect(isAutomaticUpdateVersion("65536.0.0")).toBe(false);
    expect(isAutomaticUpdateVersion("1.2.3-beta.65536")).toBe(false);
  });

  it("rejects extra keys and impossible error states", () => {
    const valid = {
      contractVersion: 1,
      currentVersion: "0.1.0",
      channel: "latest",
      status: "idle",
      lastCheckedAt: null,
      availableVersion: null,
      errorCode: null,
    };
    expect(parseAutomaticUpdateDto(valid)).toEqual(valid);
    expect(() =>
      parseAutomaticUpdateDto({ ...valid, unexpected: true }),
    ).toThrow("INVALID_AUTOMATIC_UPDATE_DTO");
    expect(() =>
      parseAutomaticUpdateDto({
        ...valid,
        status: "error",
        errorCode: null,
      }),
    ).toThrow("INVALID_AUTOMATIC_UPDATE_DTO");
  });
});
