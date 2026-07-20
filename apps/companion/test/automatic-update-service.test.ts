import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAutomaticUpdateController,
  type AutomaticUpdateController,
  type WindowsSquirrelUpdaterPort,
} from "../src/main/automatic-update-controller.js";
import { createAutomaticUpdateService } from "../src/main/automatic-update-service.js";
import type {
  AutomaticUpdateCommandResult,
  AutomaticUpdateDto,
} from "../src/shared/automatic-updates.js";

const roots: string[] = [];

async function preferencePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tokenmonster-auto-update-"));
  roots.push(root);
  return join(root, "private", "automatic-updates-v1.json");
}

function updateDto(): AutomaticUpdateDto {
  return Object.freeze({
    contractVersion: 1,
    currentVersion: "0.1.0",
    channel: "latest",
    status: "idle",
    lastCheckedAt: null,
    availableVersion: null,
    errorCode: null,
  });
}

function fakeController() {
  const setAutomaticChecksEnabled = vi.fn();
  const checkNow = vi.fn(
    (): AutomaticUpdateCommandResult =>
      Object.freeze({
        ok: true,
        code: "check-started",
        update: updateDto(),
      }),
  );
  const quitAndInstall = vi.fn(
    (): AutomaticUpdateCommandResult =>
      Object.freeze({ ok: false, code: "not-ready", update: updateDto() }),
  );
  const dispose = vi.fn();
  const controller = Object.freeze({
    status: updateDto,
    setAutomaticChecksEnabled,
    checkNow,
    quitAndInstall,
    dispose,
  }) satisfies AutomaticUpdateController;
  return {
    controller,
    setAutomaticChecksEnabled,
    checkNow,
    quitAndInstall,
    dispose,
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })),
  );
});

describe("automatic update local preference service", () => {
  it("performs zero updater network setup on a fresh default-off startup", async () => {
    const path = await preferencePath();
    const setFeedURL = vi.fn();
    const checkForUpdates = vi.fn();
    const updater = Object.freeze({
      setFeedURL,
      checkForUpdates,
      quitAndInstall: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    }) satisfies WindowsSquirrelUpdaterPort;
    const timerSet = vi.fn(() => 1);
    const service = await createAutomaticUpdateService({
      path,
      createController: (automaticChecksEnabled) =>
        createAutomaticUpdateController({
          updater,
          timer: { set: timerSet, clear: vi.fn() },
          clock: { now: () => new Date("2026-07-18T12:34:56.000Z") },
          platform: { current: () => "win32" },
          currentVersion: { current: () => "0.1.0" },
          automaticChecksEnabled,
          beforeQuitForUpdate: vi.fn(),
        }),
    });

    expect(service.status().automaticChecksEnabled).toBe(false);
    expect(setFeedURL).not.toHaveBeenCalled();
    expect(checkForUpdates).not.toHaveBeenCalled();
    expect(timerSet).not.toHaveBeenCalled();

    expect(service.checkNow()).toMatchObject({
      ok: true,
      code: "check-started",
    });
    expect(setFeedURL).toHaveBeenCalledTimes(1);
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it("creates a private default-off store and applies an explicit persisted opt-in", async () => {
    const path = await preferencePath();
    const fake = fakeController();
    const createController = vi.fn(() => fake.controller);
    const service = await createAutomaticUpdateService({
      path,
      createController,
    });

    expect(createController).toHaveBeenCalledWith(false);
    expect(service.status()).toMatchObject({
      revision: "0",
      preferenceStorage: "ready",
      automaticChecksEnabled: false,
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      schemaVersion: "1",
      revision: "0",
      automaticChecksEnabled: false,
    });
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    }

    await expect(
      service.updatePreference({
        expectedRevision: "0",
        automaticChecksEnabled: true,
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: { revision: "1", automaticChecksEnabled: true },
    });
    expect(fake.setAutomaticChecksEnabled).toHaveBeenCalledWith(true);

    service.dispose();
    const restarted = fakeController();
    const restartedFactory = vi.fn(() => restarted.controller);
    const nextService = await createAutomaticUpdateService({
      path,
      createController: restartedFactory,
    });
    expect(restartedFactory).toHaveBeenCalledWith(true);
    expect(nextService.status()).toMatchObject({
      revision: "1",
      automaticChecksEnabled: true,
    });
    nextService.dispose();
  });

  it("keeps identical writes idempotent and rejects stale cross-window revisions", async () => {
    const path = await preferencePath();
    const fake = fakeController();
    const service = await createAutomaticUpdateService({
      path,
      createController: () => fake.controller,
    });

    await expect(
      service.updatePreference({
        expectedRevision: "0",
        automaticChecksEnabled: false,
      }),
    ).resolves.toMatchObject({ ok: true, status: { revision: "0" } });
    expect(fake.setAutomaticChecksEnabled).not.toHaveBeenCalled();

    await service.updatePreference({
      expectedRevision: "0",
      automaticChecksEnabled: true,
    });
    await expect(
      service.updatePreference({
        expectedRevision: "0",
        automaticChecksEnabled: false,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "conflict",
      status: { revision: "1", automaticChecksEnabled: true },
    });
    expect(fake.setAutomaticChecksEnabled).toHaveBeenCalledTimes(1);
  });

  it("keeps corrupt or unsafe storage fail-closed without overwriting it", async () => {
    const path = await preferencePath();
    await mkdir(dirname(path), { mode: 0o700 });
    await writeFile(path, "PRIVATE_CORRUPT_CANARY\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    const fake = fakeController();
    const service = await createAutomaticUpdateService({
      path,
      createController: () => fake.controller,
    });

    expect(service.status()).toMatchObject({
      preferenceStorage: "unavailable",
      automaticChecksEnabled: false,
    });
    expect(await readFile(path, "utf8")).toBe("PRIVATE_CORRUPT_CANARY\n");
    await expect(
      service.updatePreference({
        expectedRevision: "0",
        automaticChecksEnabled: true,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "storage-unavailable",
    });
    expect(fake.setAutomaticChecksEnabled).not.toHaveBeenCalled();
  });

  it("rejects non-canonical JSON and duplicate opt-in keys before startup egress", async () => {
    const path = await preferencePath();
    await mkdir(dirname(path), { mode: 0o700 });
    const duplicateOptIn =
      '{"schemaVersion":"1","revision":"0","automaticChecksEnabled":false,"automaticChecksEnabled":true}\n';
    await writeFile(path, duplicateOptIn, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    const fake = fakeController();
    const createController = vi.fn(() => fake.controller);
    const service = await createAutomaticUpdateService({
      path,
      createController,
    });

    expect(createController).toHaveBeenCalledWith(false);
    expect(service.status()).toMatchObject({
      preferenceStorage: "unavailable",
      automaticChecksEnabled: false,
    });
    expect(await readFile(path, "utf8")).toBe(duplicateOptIn);
  });

  it("normalizes invalid requests, composes manual commands, and disposes once", async () => {
    const path = await preferencePath();
    const fake = fakeController();
    const service = await createAutomaticUpdateService({
      path,
      createController: () => fake.controller,
    });

    await expect(
      service.updatePreference({
        expectedRevision: "0",
        automaticChecksEnabled: true,
        feedUrl: "https://attacker.invalid/",
      }),
    ).resolves.toMatchObject({ ok: false, error: "invalid-request" });
    expect(service.checkNow()).toMatchObject({
      ok: true,
      code: "check-started",
      status: { automaticChecksEnabled: false },
    });
    expect(fake.checkNow).toHaveBeenCalledTimes(1);
    expect(service.quitAndInstall()).toMatchObject({
      ok: false,
      code: "not-ready",
    });

    service.dispose();
    service.dispose();
    expect(fake.dispose).toHaveBeenCalledTimes(1);
    expect(service.checkNow().code).toBe("disposed");
    await expect(
      service.updatePreference({
        expectedRevision: "0",
        automaticChecksEnabled: true,
      }),
    ).resolves.toMatchObject({ ok: false, error: "disposed" });
  });
});
