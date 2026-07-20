import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createReminderService,
  type ReminderClockPort,
  type ReminderLocalDateTime,
  type ReminderNotificationPort,
  type ReminderService,
  type ReminderTimerPort,
} from "../src/main/reminder-service.js";
import {
  DEFAULT_REMINDER_SETTINGS,
  isWithinReminderQuietHours,
  parseReminderSettings,
  type ReminderNotification,
  type ReminderSettingsRequest,
  type ReminderSettingsV1,
} from "../src/shared/reminders.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

class FakeClock implements ReminderClockPort {
  private instant: Date;

  constructor(instant = "2026-07-18T17:59:00.000Z") {
    this.instant = new Date(instant);
  }

  set(instant: string): void {
    this.instant = new Date(instant);
  }

  now(): Date {
    return new Date(this.instant);
  }

  localDateTime(instant: Date): ReminderLocalDateTime {
    return Object.freeze({
      localDate: instant.toISOString().slice(0, 10),
      hour: instant.getUTCHours(),
      minute: instant.getUTCMinutes(),
    });
  }
}

interface ScheduledCallback {
  readonly handle: number;
  readonly delayMs: number;
  readonly callback: () => void;
  cancelled: boolean;
}

class FakeTimer implements ReminderTimerPort {
  readonly callbacks: ScheduledCallback[] = [];
  readonly cleared: unknown[] = [];
  private nextHandle = 1;

  set(delayMs: number, callback: () => void): unknown {
    const item: ScheduledCallback = {
      handle: this.nextHandle,
      delayMs,
      callback,
      cancelled: false,
    };
    this.nextHandle += 1;
    this.callbacks.push(item);
    return item.handle;
  }

  clear(handle: unknown): void {
    this.cleared.push(handle);
    const match = this.callbacks.find((item) => item.handle === handle);
    if (match !== undefined) match.cancelled = true;
  }
}

interface Harness {
  readonly root: string;
  readonly path: string;
  readonly clock: FakeClock;
  readonly timer: FakeTimer;
  readonly notification: ReminderNotificationPort & {
    show: ReturnType<
      typeof vi.fn<(value: ReminderNotification) => Promise<void>>
    >;
  };
  readonly service: ReminderService;
  setSupported(value: boolean): void;
}

async function harness(options?: {
  readonly instant?: string;
  readonly path?: string;
  readonly show?: (value: ReminderNotification) => Promise<void>;
  readonly locale?: "zh-TW" | "en";
}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "tokenmonster-reminders-"));
  roots.push(root);
  const path = options?.path ?? join(root, "private", "reminders-v1.json");
  const clock = new FakeClock(options?.instant);
  const timer = new FakeTimer();
  let supported = true;
  const show = vi.fn(
    options?.show ??
      (async (_value: ReminderNotification): Promise<void> => undefined),
  );
  const notification = Object.freeze({
    isSupported: () => supported,
    show,
  });
  const service = await createReminderService({
    path,
    clock,
    timer,
    notification,
    locale: () => options?.locale ?? "zh-TW",
  });
  return {
    root,
    path,
    clock,
    timer,
    notification,
    service,
    setSupported(value: boolean): void {
      supported = value;
    },
  };
}

function settings(
  overrides: Partial<ReminderSettingsRequest> = {},
): ReminderSettingsRequest {
  return {
    expectedRevision: "0",
    enabled: true,
    dailySummaryTime: "18:00",
    quietHours: { start: "22:00", end: "08:00" },
    ...overrides,
  };
}

async function readStore(path: string): Promise<{
  readonly schemaVersion: string;
  readonly revision: string;
  readonly settings: ReminderSettingsV1;
  readonly ledger: readonly Record<string, unknown>[];
}> {
  return JSON.parse(await readFile(path, "utf8")) as {
    readonly schemaVersion: string;
    readonly revision: string;
    readonly settings: ReminderSettingsV1;
    readonly ledger: readonly Record<string, unknown>[];
  };
}

describe("reminder settings contract", () => {
  it("accepts only exact versioned settings and treats equal quiet endpoints as off", () => {
    expect(parseReminderSettings(DEFAULT_REMINDER_SETTINGS)).toEqual(
      DEFAULT_REMINDER_SETTINGS,
    );
    expect(() =>
      parseReminderSettings({ ...DEFAULT_REMINDER_SETTINGS, extra: true }),
    ).toThrow("INVALID_REMINDER_SETTINGS");
    expect(() =>
      parseReminderSettings({
        ...DEFAULT_REMINDER_SETTINGS,
        dailySummaryTime: "24:00",
      }),
    ).toThrow("INVALID_REMINDER_SETTINGS");
    expect(() =>
      parseReminderSettings({
        ...DEFAULT_REMINDER_SETTINGS,
        quietHours: { start: "22:00", end: "08:00", extra: true },
      }),
    ).toThrow("INVALID_REMINDER_SETTINGS");

    expect(
      isWithinReminderQuietHours(23 * 60, {
        start: "22:00",
        end: "08:00",
      }),
    ).toBe(true);
    expect(
      isWithinReminderQuietHours(8 * 60, {
        start: "22:00",
        end: "08:00",
      }),
    ).toBe(false);
    expect(
      isWithinReminderQuietHours(12 * 60, {
        start: "08:00",
        end: "08:00",
      }),
    ).toBe(false);
  });
});

describe("local reminder service", () => {
  it("creates a private, default-off strict JSON store", async () => {
    const instance = await harness();

    expect(instance.service.status()).toMatchObject({
      contractVersion: 1,
      revision: "0",
      storage: "ready",
      notificationSupported: true,
      enabled: false,
      scheduled: false,
      nextCheckAt: null,
      lastHandledLocalDate: null,
    });
    expect(await readStore(instance.path)).toEqual({
      schemaVersion: "2",
      revision: "0",
      settings: DEFAULT_REMINDER_SETTINGS,
      ledger: [],
    });
    expect((await lstat(dirname(instance.path))).mode & 0o777).toBe(0o700);
    expect((await lstat(instance.path)).mode & 0o777).toBe(0o600);

    const before = await readFile(instance.path, "utf8");
    await expect(
      instance.service.updateSettings({ ...settings(), surprise: "no" }),
    ).resolves.toMatchObject({ ok: false, error: "invalid-request" });
    expect(await readFile(instance.path, "utf8")).toBe(before);
  });

  it("persists a monotonic settings revision and rejects stale compare-and-swap writes", async () => {
    const instance = await harness();

    await expect(instance.service.updateSettings(settings())).resolves.toMatchObject({
      ok: true,
      status: { revision: "1", enabled: true },
    });
    const afterFirstWrite = await readFile(instance.path, "utf8");
    await expect(
      instance.service.updateSettings(
        settings({ expectedRevision: "0", dailySummaryTime: "17:00" }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: "conflict",
      status: { revision: "1", dailySummaryTime: "18:00" },
    });
    expect(await readFile(instance.path, "utf8")).toBe(afterFirstWrite);

    await expect(
      instance.service.updateSettings(
        settings({ expectedRevision: "1", dailySummaryTime: "17:00" }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      status: { revision: "2", dailySummaryTime: "17:00" },
    });
    instance.service.dispose();

    const reopened = await createReminderService({
      path: instance.path,
      clock: instance.clock,
      timer: new FakeTimer(),
      notification: instance.notification,
    });
    expect(reopened.status()).toMatchObject({
      revision: "2",
      dailySummaryTime: "17:00",
    });
    reopened.dispose();
  });

  it("migrates the strict legacy store to a revisioned store before serving it", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokenmonster-reminders-v1-"));
    roots.push(root);
    const path = join(root, "private", "reminders-v1.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify({
        schemaVersion: "1",
        settings: DEFAULT_REMINDER_SETTINGS,
        ledger: [],
      })}\n`,
      { mode: 0o600 },
    );

    const service = await createReminderService({
      path,
      clock: new FakeClock(),
      timer: new FakeTimer(),
      notification: {
        isSupported: () => true,
        show: async () => undefined,
      },
    });
    expect(service.status().revision).toBe("0");
    expect(await readStore(path)).toMatchObject({
      schemaVersion: "2",
      revision: "0",
      settings: DEFAULT_REMINDER_SETTINGS,
    });
    service.dispose();
  });

  it("schedules only while enabled and cancels cleanly when switched off", async () => {
    const instance = await harness();

    await expect(
      instance.service.updateSettings(settings()),
    ).resolves.toMatchObject({
      ok: true,
      status: { enabled: true, scheduled: true },
    });
    expect(instance.timer.callbacks.at(-1)?.delayMs).toBe(1);

    await expect(
      instance.service.updateSettings(
        settings({
          expectedRevision: instance.service.status().revision,
          enabled: false,
        }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      status: { enabled: false, scheduled: false, nextCheckAt: null },
    });
    expect(instance.timer.cleared).toHaveLength(1);
    await expect(instance.service.tick()).resolves.toMatchObject({
      outcome: "disabled",
      triggerId: null,
      status: { scheduled: false },
    });

    instance.service.dispose();
    instance.service.dispose();
    await expect(instance.service.tick()).resolves.toMatchObject({
      outcome: "disposed",
    });
    await expect(
      instance.service.updateSettings(settings()),
    ).resolves.toMatchObject({
      ok: false,
      error: "disposed",
    });
  });

  it("shows one content-blind daily recap and persists same-date dedupe", async () => {
    const instance = await harness({ locale: "en" });
    await instance.service.updateSettings(settings());

    await expect(instance.service.tick()).resolves.toMatchObject({
      outcome: "not-due",
      triggerId: "daily-summary:2026-07-18",
    });
    instance.clock.set("2026-07-18T18:00:00.000Z");
    await expect(instance.service.tick()).resolves.toMatchObject({
      outcome: "shown",
      triggerId: "daily-summary:2026-07-18",
      status: { lastHandledLocalDate: "2026-07-18" },
    });
    await expect(instance.service.tick()).resolves.toMatchObject({
      outcome: "duplicate",
      triggerId: "daily-summary:2026-07-18",
    });
    await instance.service.updateSettings(
      settings({
        expectedRevision: instance.service.status().revision,
        enabled: false,
      }),
    );
    await instance.service.updateSettings(
      settings({
        expectedRevision: instance.service.status().revision,
        dailySummaryTime: "17:00",
      }),
    );
    await expect(instance.service.tick()).resolves.toMatchObject({
      outcome: "duplicate",
      triggerId: "daily-summary:2026-07-18",
    });
    expect(instance.notification.show).toHaveBeenCalledTimes(1);
    const notice = instance.notification.show.mock.calls[0]?.[0];
    expect(notice).toMatchObject({
      id: "daily-summary:2026-07-18",
      silent: false,
    });
    expect(JSON.stringify(notice)).not.toContain("SECRET_PROMPT_CANARY");
    expect(JSON.stringify(notice)).not.toContain("/Users/private/project.ts");
    expect(await readStore(instance.path)).toMatchObject({
      ledger: [
        {
          triggerId: "daily-summary:2026-07-18",
          localDate: "2026-07-18",
          state: "handled",
          outcome: "shown",
        },
      ],
    });

    instance.service.dispose();
    const timer = new FakeTimer();
    const reopened = await createReminderService({
      path: instance.path,
      clock: instance.clock,
      timer,
      notification: instance.notification,
      locale: () => "en",
    });
    await expect(reopened.tick()).resolves.toMatchObject({
      outcome: "duplicate",
    });
    expect(instance.notification.show).toHaveBeenCalledTimes(1);
    reopened.dispose();
  });

  it("persists a quiet-hours delay and delivers it at the regular-window end", async () => {
    const instance = await harness({ instant: "2026-07-18T18:00:00.000Z" });
    await instance.service.updateSettings(
      settings({ quietHours: { start: "17:00", end: "19:00" } }),
    );

    await expect(instance.service.tick()).resolves.toMatchObject({
      outcome: "quiet",
      triggerId: "daily-summary:2026-07-18",
    });
    expect(instance.notification.show).not.toHaveBeenCalled();
    expect(await readStore(instance.path)).toMatchObject({
      ledger: [{ localDate: "2026-07-18", state: "pending" }],
    });

    instance.service.dispose();
    instance.clock.set("2026-07-18T19:00:00.000Z");
    const reopened = await createReminderService({
      path: instance.path,
      clock: instance.clock,
      timer: new FakeTimer(),
      notification: instance.notification,
    });
    await expect(reopened.resume()).resolves.toMatchObject({
      outcome: "shown",
      triggerId: "daily-summary:2026-07-18",
    });
    expect(instance.notification.show).toHaveBeenCalledTimes(1);
    reopened.dispose();
  });

  it("keeps a pending recap and its revision when identical settings are saved", async () => {
    const instance = await harness({ instant: "2026-07-18T23:00:00.000Z" });
    const request = settings({
      dailySummaryTime: "23:00",
      quietHours: { start: "22:00", end: "08:00" },
    });
    await instance.service.updateSettings(request);
    await expect(instance.service.tick()).resolves.toMatchObject({
      outcome: "quiet",
    });
    const revision = instance.service.status().revision;

    await expect(
      instance.service.updateSettings({
        ...request,
        expectedRevision: revision,
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: { revision },
    });
    expect(await readStore(instance.path)).toMatchObject({
      revision,
      ledger: [{ localDate: "2026-07-18", state: "pending" }],
    });
    instance.service.dispose();
  });

  it("holds a cross-midnight recap through the next morning and releases at 08:00", async () => {
    const instance = await harness({ instant: "2026-07-18T23:00:00.000Z" });
    await instance.service.updateSettings(
      settings({
        dailySummaryTime: "23:00",
        quietHours: { start: "22:00", end: "08:00" },
      }),
    );

    await expect(instance.service.tick()).resolves.toMatchObject({
      outcome: "quiet",
      triggerId: "daily-summary:2026-07-18",
    });
    instance.clock.set("2026-07-19T07:59:00.000Z");
    await expect(instance.service.resume()).resolves.toMatchObject({
      outcome: "quiet",
      triggerId: "daily-summary:2026-07-18",
    });
    instance.clock.set("2026-07-19T08:00:00.000Z");
    await expect(instance.service.resume()).resolves.toMatchObject({
      outcome: "shown",
      triggerId: "daily-summary:2026-07-18",
    });
    await expect(instance.service.tick()).resolves.toMatchObject({
      outcome: "not-due",
      triggerId: "daily-summary:2026-07-19",
    });
    expect(instance.notification.show).toHaveBeenCalledTimes(1);
    expect(instance.notification.show.mock.calls[0]?.[0]?.body).toContain(
      "上一份本機 AI 足跡摘要",
    );
    expect(instance.notification.show.mock.calls[0]?.[0]?.body).not.toContain(
      "今天的",
    );
  });

  it("expires a cross-midnight recap after the one-hour catch-up window", async () => {
    const instance = await harness({ instant: "2026-07-18T23:00:00.000Z" });
    await instance.service.updateSettings(
      settings({
        dailySummaryTime: "23:00",
        quietHours: { start: "22:00", end: "08:00" },
      }),
    );
    await expect(instance.service.tick()).resolves.toMatchObject({
      outcome: "quiet",
      triggerId: "daily-summary:2026-07-18",
    });
    instance.service.dispose();

    instance.clock.set("2026-07-19T09:00:00.000Z");
    const reopened = await createReminderService({
      path: instance.path,
      clock: instance.clock,
      timer: new FakeTimer(),
      notification: instance.notification,
    });
    await expect(reopened.resume()).resolves.toMatchObject({
      outcome: "expired",
      triggerId: "daily-summary:2026-07-18",
      status: { lastHandledLocalDate: "2026-07-18" },
    });
    expect(instance.notification.show).not.toHaveBeenCalled();
    expect(await readStore(instance.path)).toMatchObject({
      ledger: [
        {
          localDate: "2026-07-18",
          state: "handled",
          outcome: "expired",
        },
      ],
    });
    await expect(reopened.tick()).resolves.toMatchObject({
      outcome: "not-due",
      triggerId: "daily-summary:2026-07-19",
    });
    reopened.dispose();
  });

  it("recomputes immediately on resume and leaves a periodic check armed", async () => {
    const instance = await harness();
    await instance.service.updateSettings(settings());
    const firstHandle = instance.timer.callbacks.at(-1)?.handle;
    instance.clock.set("2026-07-18T18:00:00.000Z");

    await expect(instance.service.resume()).resolves.toMatchObject({
      outcome: "shown",
      status: { scheduled: true },
    });
    expect(instance.timer.cleared).toContain(firstHandle);
    expect(instance.timer.callbacks.at(-1)?.delayMs).toBe(60_000);
  });

  it("fails closed when a timer adapter invokes its callback synchronously", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokenmonster-reminders-sync-"));
    roots.push(root);
    const path = join(root, "private", "reminders-v1.json");
    const clear = vi.fn();
    const set = vi.fn((_: number, callback: () => void): unknown => {
      callback();
      return 91;
    });
    const show = vi.fn(async (): Promise<void> => undefined);
    const service = await createReminderService({
      path,
      clock: new FakeClock(),
      timer: { set, clear },
      notification: { isSupported: () => true, show },
    });

    await expect(service.updateSettings(settings())).resolves.toMatchObject({
      ok: true,
      status: {
        enabled: true,
        scheduled: false,
        nextCheckAt: null,
      },
    });
    expect(set).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledWith(91);
    await expect(service.tick()).resolves.toMatchObject({
      outcome: "not-due",
      status: { scheduled: false, nextCheckAt: null },
    });
    expect(set).toHaveBeenCalledTimes(2);
    expect(show).not.toHaveBeenCalled();
    service.dispose();
  });

  it("keeps tests independent from opt-in and retries a due recap after support returns", async () => {
    const instance = await harness({ instant: "2026-07-18T18:00:00.000Z" });

    await expect(instance.service.testNotification()).resolves.toMatchObject({
      outcome: "shown",
      status: { enabled: false, scheduled: false },
    });
    expect((await readStore(instance.path)).ledger).toEqual([]);

    instance.setSupported(false);
    await expect(instance.service.testNotification()).resolves.toMatchObject({
      outcome: "unsupported",
    });
    await instance.service.updateSettings(settings());
    await expect(instance.service.tick()).resolves.toMatchObject({
      outcome: "unsupported",
    });
    expect((await readStore(instance.path)).ledger).toEqual([]);

    instance.setSupported(true);
    await expect(instance.service.tick()).resolves.toMatchObject({
      outcome: "shown",
    });
    expect(instance.notification.show).toHaveBeenCalledTimes(2);
  });

  it("claims a trigger before showing so notification failures do not duplicate", async () => {
    const instance = await harness({
      instant: "2026-07-18T18:00:00.000Z",
      show: async () => {
        throw new Error("OS_NOTIFICATION_FAILURE_CANARY");
      },
    });
    await instance.service.updateSettings(settings());

    await expect(instance.service.tick()).resolves.toMatchObject({
      outcome: "failed",
      triggerId: "daily-summary:2026-07-18",
    });
    await expect(instance.service.tick()).resolves.toMatchObject({
      outcome: "duplicate",
    });
    expect(instance.notification.show).toHaveBeenCalledTimes(1);
    expect(await readStore(instance.path)).toMatchObject({
      ledger: [{ state: "handled", outcome: "failed" }],
    });
  });

  it("fails closed on a corrupt store without overwriting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokenmonster-reminders-bad-"));
    roots.push(root);
    const path = join(root, "private", "reminders-v1.json");
    await mkdir(dirname(path), { recursive: true });
    const corrupt = '{"schemaVersion":"1","unexpected":true}\n';
    await writeFile(path, corrupt, { mode: 0o600 });
    const show = vi.fn(async (): Promise<void> => undefined);
    const service = await createReminderService({
      path,
      clock: new FakeClock("2026-07-18T18:00:00.000Z"),
      timer: new FakeTimer(),
      notification: { isSupported: () => true, show },
    });

    expect(service.status()).toMatchObject({
      storage: "unavailable",
      enabled: false,
      scheduled: false,
    });
    await expect(service.tick()).resolves.toMatchObject({
      outcome: "storage-unavailable",
    });
    await expect(service.updateSettings(settings())).resolves.toMatchObject({
      ok: false,
      error: "storage-unavailable",
    });
    expect(await readFile(path, "utf8")).toBe(corrupt);
    expect(show).not.toHaveBeenCalled();
  });
});
