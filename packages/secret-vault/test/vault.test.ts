import { fstatSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readFile,
  symlink,
  writeFile,
  type FileHandle
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SecretVaultError,
  createEncryptedSecretSlot,
  createMemorySecretSlot,
  type AsyncSafeStoragePort
} from "../src/index.js";

const SECRET_CANARY = ["sk", "SECRET_CANARY_1234567890"].join("-");
const temporaryDirectories: string[] = [];

async function temporaryPath(name = "secret.json"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tokenmonster-vault-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "secrets", name);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dirname(path), { recursive: true });
  return path;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    )
  );
});

class FakeSafeStorage implements AsyncSafeStoragePort {
  public encryptCalls = 0;
  public decryptCalls = 0;
  public shouldReEncrypt = false;
  public throwOnAvailabilityProbe = false;
  public throwOnBackendProbe = false;
  public throwOnEncrypt = false;
  public throwOnDecrypt = false;
  public encryptBarrier: Promise<void> | null = null;
  public decryptBarrier: Promise<void> | null = null;

  public constructor(
    public backend = "unknown",
    public available = true
  ) {}

  public async isAsyncEncryptionAvailable(): Promise<boolean> {
    if (this.throwOnAvailabilityProbe) throw new Error(SECRET_CANARY);
    return this.available;
  }

  public getSelectedStorageBackend(): string {
    if (this.throwOnBackendProbe) throw new Error(SECRET_CANARY);
    return this.backend;
  }

  public async encryptStringAsync(plainText: string): Promise<Uint8Array> {
    this.encryptCalls += 1;
    if (this.encryptBarrier !== null) await this.encryptBarrier;
    if (this.throwOnEncrypt) throw new Error(SECRET_CANARY);
    return Buffer.from(`cipher:${[...plainText].reverse().join("")}`, "utf8");
  }

  public async decryptStringAsync(
    encrypted: Uint8Array
  ): Promise<Readonly<{ result: string; shouldReEncrypt: boolean }>> {
    this.decryptCalls += 1;
    if (this.decryptBarrier !== null) await this.decryptBarrier;
    if (this.throwOnDecrypt) throw new Error(SECRET_CANARY);
    const serialized = Buffer.from(encrypted).toString("utf8");
    if (!serialized.startsWith("cipher:")) throw new Error(SECRET_CANARY);
    return {
      result: [...serialized.slice("cipher:".length)].reverse().join(""),
      shouldReEncrypt: this.shouldReEncrypt
    };
  }
}

function serializedError(error: unknown): string {
  return error instanceof Error
    ? [error.name, error.message, error.stack, JSON.stringify(error)].join("\n")
    : JSON.stringify(error);
}

async function captureError(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
    throw new Error("Expected rejection.");
  } catch (error) {
    return error;
  }
}

async function spyOnDirectorySync(
  filePath: string,
  failureCode?: string
): Promise<Readonly<{
  count: () => number;
  restore: () => void;
}>> {
  const probe = await open(dirname(filePath), "r");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  const originalSync = prototype.sync;
  await probe.close();
  let directorySyncCount = 0;
  const spy = vi
    .spyOn(prototype, "sync")
    .mockImplementation(async function (this: FileHandle): Promise<void> {
      if (fstatSync(this.fd).isDirectory()) {
        directorySyncCount += 1;
        if (failureCode !== undefined) {
          throw Object.assign(new Error("directory sync failed"), {
            code: failureCode
          });
        }
      }
      await Reflect.apply(originalSync, this, []);
    });
  return Object.freeze({
    count: () => directorySyncCount,
    restore: () => spy.mockRestore()
  });
}

async function abortOnFirstDirectorySync(
  filePath: string,
  controller: AbortController
): Promise<Readonly<{
  count: () => number;
  restore: () => void;
}>> {
  const probe = await open(dirname(filePath), "r");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  const originalSync = prototype.sync;
  await probe.close();
  let directorySyncCount = 0;
  const spy = vi
    .spyOn(prototype, "sync")
    .mockImplementation(async function (this: FileHandle): Promise<void> {
      const isDirectory = fstatSync(this.fd).isDirectory();
      await Reflect.apply(originalSync, this, []);
      if (isDirectory) {
        directorySyncCount += 1;
        if (directorySyncCount === 1) controller.abort();
      }
    });
  return Object.freeze({
    count: () => directorySyncCount,
    restore: () => spy.mockRestore()
  });
}

describe("OS-backed encrypted secret slot", () => {
  it.each<[NodeJS.Platform, string]>([
    ["darwin", "unknown"],
    ["win32", "unknown"],
    ["linux", "gnome_libsecret"],
    ["linux", "kwallet"],
    ["linux", "kwallet5"],
    ["linux", "kwallet6"]
  ])("persists ciphertext on %s with %s", async (platform, backend) => {
    const filePath = await temporaryPath();
    const safeStorage = new FakeSafeStorage(backend);
    const slot = createEncryptedSecretSlot({ safeStorage, platform, filePath });

    const status = await slot.set(SECRET_CANARY);
    expect(status).toEqual({
      configured: true,
      persistence: "os-backed",
      activePersistence: "os-backed",
      backend
    });
    expect(slot.get()).toBe(SECRET_CANARY);
    const contents = await readFile(filePath, "utf8");
    expect(contents).not.toContain(SECRET_CANARY);
    expect(JSON.parse(contents)).toEqual({
      schemaVersion: 1,
      ciphertext: Buffer.from(
        `cipher:${[...SECRET_CANARY].reverse().join("")}`
      ).toString("base64")
    });
    expect((await lstat(filePath)).mode & 0o777).toBe(0o600);
    expect((await lstat(join(filePath, ".."))).mode & 0o777).toBe(0o700);
  });

  it("reopens a persisted value without exposing it in status", async () => {
    const filePath = await temporaryPath();
    const safeStorage = new FakeSafeStorage("unknown");
    await createEncryptedSecretSlot({
      safeStorage,
      platform: "darwin",
      filePath
    }).set(SECRET_CANARY);
    const reopened = createEncryptedSecretSlot({
      safeStorage,
      platform: "darwin",
      filePath
    });

    expect(await reopened.initialize()).toEqual({
      configured: true,
      persistence: "os-backed",
      activePersistence: "os-backed",
      backend: "unknown"
    });
    expect(reopened.get()).toBe(SECRET_CANARY);
    expect(JSON.stringify(reopened.status())).not.toContain(SECRET_CANARY);
    await reopened.initialize();
    expect(safeStorage.decryptCalls).toBe(1);
  });

  it("atomically re-encrypts ciphertext after an OS key rotation", async () => {
    const filePath = await temporaryPath();
    const safeStorage = new FakeSafeStorage();
    const first = createEncryptedSecretSlot({
      safeStorage,
      platform: "win32",
      filePath
    });
    await first.set(SECRET_CANARY);
    safeStorage.shouldReEncrypt = true;
    const reopened = createEncryptedSecretSlot({
      safeStorage,
      platform: "win32",
      filePath
    });
    await reopened.initialize();
    expect(safeStorage.decryptCalls).toBe(1);
    expect(safeStorage.encryptCalls).toBe(2);
    expect(reopened.get()).toBe(SECRET_CANARY);
  });

  it("keeps old ciphertext but clears plaintext state when key rotation fails", async () => {
    const filePath = await temporaryPath();
    const safeStorage = new FakeSafeStorage();
    await createEncryptedSecretSlot({
      safeStorage,
      platform: "win32",
      filePath
    }).set(SECRET_CANARY);
    const oldCiphertext = await readFile(filePath, "utf8");
    safeStorage.shouldReEncrypt = true;
    safeStorage.throwOnEncrypt = true;
    const reopened = createEncryptedSecretSlot({
      safeStorage,
      platform: "win32",
      filePath
    });

    await expect(reopened.initialize()).rejects.toMatchObject({
      code: "storage-failed"
    });
    expect(reopened.get()).toBeNull();
    expect(reopened.status()).toMatchObject({
      configured: false,
      activePersistence: "memory-only"
    });
    expect(await readFile(filePath, "utf8")).toBe(oldCiphertext);

    safeStorage.throwOnEncrypt = false;
    await expect(reopened.initialize()).resolves.toMatchObject({
      configured: true,
      activePersistence: "os-backed"
    });
    expect(reopened.get()).toBe(SECRET_CANARY);
  });

  it("fences an aborted initialization before plaintext or rotation can commit", async () => {
    const filePath = await temporaryPath();
    const safeStorage = new FakeSafeStorage();
    await createEncryptedSecretSlot({
      safeStorage,
      platform: "win32",
      filePath
    }).set(SECRET_CANARY);
    const oldCiphertext = await readFile(filePath, "utf8");
    safeStorage.shouldReEncrypt = true;
    let releaseDecryption!: () => void;
    safeStorage.decryptBarrier = new Promise<void>((resolve) => {
      releaseDecryption = resolve;
    });
    const reopened = createEncryptedSecretSlot({
      safeStorage,
      platform: "win32",
      filePath
    });
    const controller = new AbortController();
    const initializing = reopened.initialize({ signal: controller.signal });
    await vi.waitFor(() => expect(safeStorage.decryptCalls).toBe(1));

    controller.abort();
    releaseDecryption();

    await expect(initializing).rejects.toMatchObject({ code: "storage-failed" });
    expect(reopened.get()).toBeNull();
    expect(reopened.status()).toMatchObject({
      configured: false,
      activePersistence: "memory-only"
    });
    expect(safeStorage.encryptCalls).toBe(1);
    expect(await readFile(filePath, "utf8")).toBe(oldCiphertext);
  });

  it("clears memory and the independent encrypted file", async () => {
    const filePath = await temporaryPath();
    const slot = createEncryptedSecretSlot({
      safeStorage: new FakeSafeStorage(),
      platform: "darwin",
      filePath
    });
    await slot.set(SECRET_CANARY);
    expect((await slot.clear()).configured).toBe(false);
    expect(slot.get()).toBeNull();
    await expect(lstat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(slot.clear()).resolves.toMatchObject({ configured: false });
  });
});

describe("fail-closed platform policy", () => {
  it.each<[NodeJS.Platform, string, boolean]>([
    ["linux", "basic_text", true],
    ["linux", "unknown", true],
    ["linux", "gnome_libsecret", false],
    ["freebsd", "unknown", true]
  ])("keeps %s/%s/%s RAM-only", async (platform, backend, available) => {
    const filePath = await temporaryPath();
    const safeStorage = new FakeSafeStorage(backend, available);
    const slot = createEncryptedSecretSlot({ safeStorage, platform, filePath });
    expect(await slot.set(SECRET_CANARY)).toEqual({
      configured: true,
      persistence: "memory-only",
      activePersistence: "memory-only",
      backend
    });
    expect(slot.get()).toBe(SECRET_CANARY);
    expect(safeStorage.encryptCalls).toBe(0);
    await expect(lstat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("honors an explicit RAM-only choice even when OS encryption exists", async () => {
    const filePath = await temporaryPath();
    const slot = createEncryptedSecretSlot({
      safeStorage: new FakeSafeStorage(),
      platform: "darwin",
      filePath
    });
    const status = await slot.set(SECRET_CANARY, { persist: false });
    expect(status).toMatchObject({
      configured: true,
      persistence: "os-backed",
      activePersistence: "memory-only"
    });
    expect(slot.get()).toBe(SECRET_CANARY);
    await expect(lstat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves old ciphertext when the current backend is not OS-backed", async () => {
    const filePath = await temporaryPath();
    const safeStorage = new FakeSafeStorage("unknown");
    await createEncryptedSecretSlot({
      safeStorage,
      platform: "darwin",
      filePath
    }).set(SECRET_CANARY);
    const ciphertextBeforeProbe = await readFile(filePath);
    const downgradedStorage = new FakeSafeStorage("basic_text");
    const downgraded = createEncryptedSecretSlot({
      safeStorage: downgradedStorage,
      platform: "linux",
      filePath
    });
    expect(await downgraded.initialize()).toMatchObject({
      configured: false,
      persistence: "memory-only",
      backend: "basic_text"
    });
    expect(downgradedStorage.decryptCalls).toBe(0);
    expect(await readFile(filePath)).toEqual(ciphertextBeforeProbe);
  });

  it.each(["unavailable", "availability-throws", "backend-throws"] as const)(
    "does not erase ciphertext when the backend probe is temporarily %s",
    async (failureMode) => {
      const filePath = await temporaryPath();
      await createEncryptedSecretSlot({
        safeStorage: new FakeSafeStorage(),
        platform: "darwin",
        filePath
      }).set(SECRET_CANARY);
      const ciphertextBeforeProbe = await readFile(filePath);
      const unavailable = new FakeSafeStorage("gnome_libsecret");
      if (failureMode === "unavailable") unavailable.available = false;
      if (failureMode === "availability-throws") {
        unavailable.throwOnAvailabilityProbe = true;
      }
      if (failureMode === "backend-throws") {
        unavailable.throwOnBackendProbe = true;
      }
      const slot = createEncryptedSecretSlot({
        safeStorage: unavailable,
        platform: "linux",
        filePath
      });

      expect(await slot.initialize()).toEqual({
        configured: false,
        persistence: "memory-only",
        activePersistence: "memory-only",
        backend:
          failureMode === "unavailable" ? "gnome_libsecret" : "unknown"
      });
      expect(slot.get()).toBeNull();
      expect(unavailable.decryptCalls).toBe(0);
      expect(await readFile(filePath)).toEqual(ciphertextBeforeProbe);
    }
  );

  it("keeps old ciphertext when a requested persistent set falls back to RAM", async () => {
    const filePath = await temporaryPath();
    await createEncryptedSecretSlot({
      safeStorage: new FakeSafeStorage(),
      platform: "darwin",
      filePath
    }).set("old-secret");
    const ciphertextBeforeFallback = await readFile(filePath);
    const slot = createEncryptedSecretSlot({
      safeStorage: new FakeSafeStorage("basic_text"),
      platform: "linux",
      filePath
    });
    await slot.initialize();

    expect(await slot.set("new-memory-secret")).toEqual({
      configured: true,
      persistence: "memory-only",
      activePersistence: "memory-only",
      backend: "basic_text"
    });
    expect(slot.get()).toBe("new-memory-secret");
    expect(await readFile(filePath)).toEqual(ciphertextBeforeFallback);
  });

  it("durably removes old ciphertext for an explicit RAM-only replacement", async () => {
    const filePath = await temporaryPath();
    const slot = createEncryptedSecretSlot({
      safeStorage: new FakeSafeStorage(),
      platform: "darwin",
      filePath
    });
    await slot.set("old-secret");

    expect(await slot.set("new-memory-secret", { persist: false })).toMatchObject({
      configured: true,
      persistence: "os-backed",
      activePersistence: "memory-only"
    });
    expect(slot.get()).toBe("new-memory-secret");
    await expect(lstat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("explicit memory-only slot", () => {
  it("retains a bounded secret only in memory and cannot claim persistence", async () => {
    const slot = createMemorySecretSlot();

    expect(await slot.initialize()).toEqual({
      configured: false,
      persistence: "memory-only",
      activePersistence: "memory-only",
      backend: "memory-only"
    });
    expect(
      await slot.set(SECRET_CANARY, { persist: true })
    ).toEqual({
      configured: true,
      persistence: "memory-only",
      activePersistence: "memory-only",
      backend: "memory-only"
    });
    expect(slot.get()).toBe(SECRET_CANARY);
    expect(JSON.stringify(slot.status())).not.toContain(SECRET_CANARY);

    expect(await slot.clear()).toMatchObject({ configured: false });
    expect(slot.get()).toBeNull();
    await expect(slot.clear()).resolves.toMatchObject({ configured: false });
  });

  it("enforces the 4096-byte UTF-8 boundary and rejects NULs", async () => {
    const slot = createMemorySecretSlot();
    const exactBoundary = "é".repeat(2_048);

    await expect(slot.set(exactBoundary)).resolves.toMatchObject({
      configured: true
    });
    expect(slot.get()).toBe(exactBoundary);
    await expect(slot.set(`${exactBoundary}a`)).rejects.toMatchObject({
      code: "invalid-secret"
    });
    await expect(slot.set("valid\0suffix")).rejects.toMatchObject({
      code: "invalid-secret"
    });
    await expect(slot.set("x".repeat(4_097))).rejects.toMatchObject({
      code: "invalid-secret"
    });
    expect(slot.get()).toBe(exactBoundary);
  });

  it("replaces a configured value without retaining the previous secret", async () => {
    const slot = createMemorySecretSlot();
    await slot.set("first-secret");
    await slot.set("replacement-secret");
    expect(slot.get()).toBe("replacement-secret");
    expect(JSON.stringify(slot.status())).not.toContain("first-secret");
  });

  it("retains its value when clear is already aborted", async () => {
    const slot = createMemorySecretSlot();
    await slot.set(SECRET_CANARY);
    const controller = new AbortController();
    controller.abort();

    await expect(slot.clear({ signal: controller.signal })).rejects.toMatchObject({
      code: "storage-failed"
    });
    expect(slot.get()).toBe(SECRET_CANARY);
    expect(slot.status().configured).toBe(true);
  });

  it("rejects invalid secrets and accessor-backed options without retaining data", async () => {
    const slot = createMemorySecretSlot();
    const accessor = {};
    Object.defineProperty(accessor, "persist", {
      enumerable: true,
      get() {
        throw new Error(SECRET_CANARY);
      }
    });
    const signalAccessor = {};
    Object.defineProperty(signalAccessor, "signal", {
      enumerable: true,
      get() {
        throw new Error(SECRET_CANARY);
      }
    });

    await expect(slot.set("", {})).rejects.toMatchObject({
      code: "invalid-secret"
    });
    await expect(
      slot.set(SECRET_CANARY, accessor as never)
    ).rejects.toMatchObject({ code: "invalid-configuration" });
    await expect(
      slot.set(SECRET_CANARY, signalAccessor as never)
    ).rejects.toMatchObject({ code: "invalid-configuration" });
    await expect(
      slot.set(SECRET_CANARY, new (class SetOptions {})() as never)
    ).rejects.toMatchObject({ code: "invalid-configuration" });
    expect(slot.get()).toBeNull();
  });
});

describe("transactional durability", () => {
  it("keeps prior ciphertext authoritative when encryption fails", async () => {
    const filePath = await temporaryPath();
    const safeStorage = new FakeSafeStorage();
    const slot = createEncryptedSecretSlot({
      safeStorage,
      platform: "darwin",
      filePath
    });
    await slot.set("old-secret");
    const ciphertextBeforeFailure = await readFile(filePath);
    safeStorage.throwOnEncrypt = true;

    await expect(slot.set("new-secret")).rejects.toMatchObject({
      code: "storage-failed"
    });
    expect(slot.get()).toBeNull();
    expect(slot.status()).toMatchObject({
      configured: false,
      activePersistence: "memory-only"
    });
    expect(await readFile(filePath)).toEqual(ciphertextBeforeFailure);
  });

  it("keeps prior authority when cancellation arrives before rename", async () => {
    const filePath = await temporaryPath();
    const slot = createEncryptedSecretSlot({
      safeStorage: new FakeSafeStorage(),
      platform: "darwin",
      filePath
    });
    await slot.set("old-secret");
    const ciphertextBeforeAbort = await readFile(filePath);
    const controller = new AbortController();
    const probe = await open(dirname(filePath), "r");
    const prototype = Object.getPrototypeOf(probe) as FileHandle;
    const originalSync = prototype.sync;
    await probe.close();
    let aborted = false;
    const spy = vi
      .spyOn(prototype, "sync")
      .mockImplementation(async function (this: FileHandle): Promise<void> {
        await Reflect.apply(originalSync, this, []);
        if (!fstatSync(this.fd).isDirectory() && !aborted) {
          aborted = true;
          controller.abort();
        }
      });
    try {
      await expect(
        slot.set("new-secret", { signal: controller.signal })
      ).rejects.toMatchObject({ code: "storage-failed" });
    } finally {
      spy.mockRestore();
    }

    expect(slot.get()).toBeNull();
    expect(slot.status()).toMatchObject({
      configured: false,
      activePersistence: "memory-only"
    });
    expect(await readFile(filePath)).toEqual(ciphertextBeforeAbort);
  });

  it("retains RAM/status/ciphertext when clear is already aborted", async () => {
    const filePath = await temporaryPath();
    const slot = createEncryptedSecretSlot({
      safeStorage: new FakeSafeStorage(),
      platform: "darwin",
      filePath
    });
    await slot.set(SECRET_CANARY);
    const ciphertextBeforeAbort = await readFile(filePath);
    const statusBeforeAbort = slot.status();
    const controller = new AbortController();
    controller.abort();

    await expect(slot.clear({ signal: controller.signal })).rejects.toMatchObject({
      code: "storage-failed"
    });
    expect(slot.get()).toBe(SECRET_CANARY);
    expect(slot.status()).toEqual(statusBeforeAbort);
    expect(await readFile(filePath)).toEqual(ciphertextBeforeAbort);
  });

  it("rolls back a replacement when directory fsync really fails", async () => {
    const filePath = await temporaryPath();
    const slot = createEncryptedSecretSlot({
      safeStorage: new FakeSafeStorage(),
      platform: "darwin",
      filePath
    });
    await slot.set("old-secret");
    const ciphertextBeforeFailure = await readFile(filePath);
    const directorySync = await spyOnDirectorySync(filePath, "EIO");
    try {
      await expect(slot.set("new-secret")).rejects.toMatchObject({
        code: "storage-failed"
      });
      expect(slot.get()).toBeNull();
      expect(slot.status()).toMatchObject({
        configured: false,
        activePersistence: "memory-only"
      });
      expect(await readFile(filePath)).toEqual(ciphertextBeforeFailure);
      expect(directorySync.count()).toBeGreaterThanOrEqual(2);
    } finally {
      directorySync.restore();
    }
  });

  it("rolls back clear and retains status when directory fsync really fails", async () => {
    const filePath = await temporaryPath();
    const slot = createEncryptedSecretSlot({
      safeStorage: new FakeSafeStorage(),
      platform: "darwin",
      filePath
    });
    await slot.set(SECRET_CANARY);
    const ciphertextBeforeFailure = await readFile(filePath);
    const statusBeforeFailure = slot.status();
    const directorySync = await spyOnDirectorySync(filePath, "EIO");
    try {
      await expect(slot.clear()).rejects.toMatchObject({
        code: "storage-failed"
      });
      expect(slot.get()).toBe(SECRET_CANARY);
      expect(slot.status()).toEqual(statusBeforeFailure);
      expect(await readFile(filePath)).toEqual(ciphertextBeforeFailure);
      expect(directorySync.count()).toBeGreaterThanOrEqual(2);
    } finally {
      directorySync.restore();
    }
  });

  it("rolls back a replacement aborted during directory fsync before a queued writer", async () => {
    const filePath = await temporaryPath();
    const slot = createEncryptedSecretSlot({
      safeStorage: new FakeSafeStorage(),
      platform: "darwin",
      filePath
    });
    await slot.set("old-secret");
    const ciphertextBeforeAbort = await readFile(filePath);
    const controller = new AbortController();
    const directorySync = await abortOnFirstDirectorySync(
      filePath,
      controller
    );
    const queuedStorage = new FakeSafeStorage();
    let releaseQueuedEncryption!: () => void;
    queuedStorage.encryptBarrier = new Promise<void>((resolve) => {
      releaseQueuedEncryption = resolve;
    });
    const queuedSlot = createEncryptedSecretSlot({
      safeStorage: queuedStorage,
      platform: "darwin",
      filePath
    });
    const abortedWrite = slot.set("aborted-secret", {
      signal: controller.signal
    });
    const queuedWrite = queuedSlot.set("queued-secret");

    try {
      await expect(abortedWrite).rejects.toMatchObject({
        code: "storage-failed"
      });
      await vi.waitFor(() => expect(queuedStorage.encryptCalls).toBe(1));
      expect(directorySync.count()).toBe(2);
      expect(await readFile(filePath)).toEqual(ciphertextBeforeAbort);
      expect(slot.get()).toBeNull();
      expect(slot.status()).toEqual({
        configured: false,
        persistence: "os-backed",
        activePersistence: "memory-only",
        backend: "unknown"
      });

      releaseQueuedEncryption();
      await expect(queuedWrite).resolves.toMatchObject({
        configured: true,
        activePersistence: "os-backed"
      });
      expect(directorySync.count()).toBe(3);
      const reopened = createEncryptedSecretSlot({
        safeStorage: queuedStorage,
        platform: "darwin",
        filePath
      });
      await reopened.initialize();
      expect(reopened.get()).toBe("queued-secret");
    } finally {
      releaseQueuedEncryption();
      await queuedWrite.catch(() => undefined);
      directorySync.restore();
    }
  });

  it("rolls back clear aborted during directory fsync before a queued writer", async () => {
    const filePath = await temporaryPath();
    const slot = createEncryptedSecretSlot({
      safeStorage: new FakeSafeStorage(),
      platform: "darwin",
      filePath
    });
    await slot.set(SECRET_CANARY);
    const ciphertextBeforeAbort = await readFile(filePath);
    const statusBeforeAbort = slot.status();
    const controller = new AbortController();
    const directorySync = await abortOnFirstDirectorySync(
      filePath,
      controller
    );
    const queuedStorage = new FakeSafeStorage();
    let releaseQueuedEncryption!: () => void;
    queuedStorage.encryptBarrier = new Promise<void>((resolve) => {
      releaseQueuedEncryption = resolve;
    });
    const queuedSlot = createEncryptedSecretSlot({
      safeStorage: queuedStorage,
      platform: "darwin",
      filePath
    });
    const abortedClear = slot.clear({ signal: controller.signal });
    const queuedWrite = queuedSlot.set("queued-after-clear");

    try {
      await expect(abortedClear).rejects.toMatchObject({
        code: "storage-failed"
      });
      await vi.waitFor(() => expect(queuedStorage.encryptCalls).toBe(1));
      expect(directorySync.count()).toBe(2);
      expect(await readFile(filePath)).toEqual(ciphertextBeforeAbort);
      expect(slot.get()).toBe(SECRET_CANARY);
      expect(slot.status()).toEqual(statusBeforeAbort);

      releaseQueuedEncryption();
      await expect(queuedWrite).resolves.toMatchObject({
        configured: true,
        activePersistence: "os-backed"
      });
      expect(directorySync.count()).toBe(3);
      const reopened = createEncryptedSecretSlot({
        safeStorage: queuedStorage,
        platform: "darwin",
        filePath
      });
      await reopened.initialize();
      expect(reopened.get()).toBe("queued-after-clear");
    } finally {
      releaseQueuedEncryption();
      await queuedWrite.catch(() => undefined);
      directorySync.restore();
    }
  });

  it("fsyncs the parent directory after rename and unlink", async () => {
    const filePath = await temporaryPath();
    const directorySync = await spyOnDirectorySync(filePath);
    try {
      const slot = createEncryptedSecretSlot({
        safeStorage: new FakeSafeStorage(),
        platform: "darwin",
        filePath
      });
      await slot.set(SECRET_CANARY);
      await slot.clear();
      expect(directorySync.count()).toBe(2);
    } finally {
      directorySync.restore();
    }
  });

  it.each<[NodeJS.Platform, string]>([
    ["darwin", "EINVAL"],
    ["darwin", "ENOTSUP"],
    ["darwin", "EOPNOTSUPP"],
    ["darwin", "ENOSYS"],
    ["win32", "EISDIR"],
    ["win32", "EPERM"]
  ])(
    "uses the explicit %s directory-fsync fallback for %s",
    async (platform, failureCode) => {
      const filePath = await temporaryPath();
      const directorySync = await spyOnDirectorySync(filePath, failureCode);
      try {
        const slot = createEncryptedSecretSlot({
          safeStorage: new FakeSafeStorage(),
          platform,
          filePath
        });
        await expect(slot.set(SECRET_CANARY)).resolves.toMatchObject({
          configured: true,
          activePersistence: "os-backed"
        });
        await expect(slot.clear()).resolves.toMatchObject({ configured: false });
        expect(directorySync.count()).toBe(2);
      } finally {
        directorySync.restore();
      }
    }
  );
});

describe("corruption and leakage resistance", () => {
  it.each([
    "not json",
    JSON.stringify({ schemaVersion: 1, ciphertext: "" }),
    JSON.stringify({ schemaVersion: 1, ciphertext: "%%%" }),
    JSON.stringify({ schemaVersion: 2, ciphertext: "YQ==" }),
    JSON.stringify({ schemaVersion: 1, ciphertext: "YQ==", prompt: SECRET_CANARY })
  ])("rejects a malformed strict document without echoing it", async (contents) => {
    const filePath = await temporaryPath();
    await writeFile(filePath, contents, { encoding: "utf8", mode: 0o600 });
    const slot = createEncryptedSecretSlot({
      safeStorage: new FakeSafeStorage(),
      platform: "darwin",
      filePath
    });
    const error = await captureError(slot.initialize());
    expect(error).toMatchObject({ code: "storage-corrupt" });
    expect(serializedError(error)).not.toContain(SECRET_CANARY);
  });

  it("rejects oversized and symlink secret files", async () => {
    const oversizedPath = await temporaryPath("oversized.json");
    await writeFile(oversizedPath, "x".repeat(16_385));
    const oversized = createEncryptedSecretSlot({
      safeStorage: new FakeSafeStorage(),
      platform: "darwin",
      filePath: oversizedPath
    });
    await expect(oversized.initialize()).rejects.toMatchObject({
      code: "storage-corrupt"
    });

    const target = await temporaryPath("target.json");
    await writeFile(target, JSON.stringify({ schemaVersion: 1, ciphertext: "YQ==" }));
    const link = target + ".link";
    await symlink(target, link);
    const linked = createEncryptedSecretSlot({
      safeStorage: new FakeSafeStorage(),
      platform: "darwin",
      filePath: link
    });
    await expect(linked.initialize()).rejects.toMatchObject({
      code: "storage-corrupt"
    });
  });

  it("sanitizes encryption and decryption failures", async () => {
    const writePath = await temporaryPath("write.json");
    const failingEncrypt = new FakeSafeStorage();
    failingEncrypt.throwOnEncrypt = true;
    const writeError = await captureError(
      createEncryptedSecretSlot({
        safeStorage: failingEncrypt,
        platform: "darwin",
        filePath: writePath
      }).set(SECRET_CANARY)
    );
    expect(writeError).toMatchObject({ code: "storage-failed" });
    expect(serializedError(writeError)).not.toContain(SECRET_CANARY);

    const readPath = await temporaryPath("read.json");
    const writer = new FakeSafeStorage();
    await createEncryptedSecretSlot({
      safeStorage: writer,
      platform: "darwin",
      filePath: readPath
    }).set(SECRET_CANARY);
    writer.throwOnDecrypt = true;
    const readError = await captureError(
      createEncryptedSecretSlot({
        safeStorage: writer,
        platform: "darwin",
        filePath: readPath
      }).initialize()
    );
    expect(readError).toMatchObject({ code: "storage-corrupt" });
    expect(serializedError(readError)).not.toContain(SECRET_CANARY);
  });

  it("clears RAM and any secret file when an encrypted write cannot commit", async () => {
    const nestedPath = await temporaryPath("unused.json");
    const directoryPath = dirname(nestedPath);
    const slot = createEncryptedSecretSlot({
      safeStorage: new FakeSafeStorage(),
      platform: "darwin",
      filePath: directoryPath
    });

    await expect(slot.set(SECRET_CANARY)).rejects.toMatchObject({
      code: "storage-failed"
    });
    expect(slot.get()).toBeNull();
    expect(slot.status().configured).toBe(false);
  });

  it.each(["", "\0", "x".repeat(4_097)])(
    "rejects an invalid secret without writing it: %j",
    async (value) => {
      const filePath = await temporaryPath();
      const slot = createEncryptedSecretSlot({
        safeStorage: new FakeSafeStorage(),
        platform: "darwin",
        filePath
      });
      await expect(slot.set(value)).rejects.toBeInstanceOf(SecretVaultError);
      expect(slot.get()).toBeNull();
      await expect(lstat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it("repairs permissive file and directory modes on the next write", async () => {
    const filePath = await temporaryPath();
    const slot = createEncryptedSecretSlot({
      safeStorage: new FakeSafeStorage(),
      platform: "darwin",
      filePath
    });
    await slot.set("first-secret");
    await chmod(filePath, 0o666);
    await chmod(join(filePath, ".."), 0o777);
    await slot.set("second-secret");
    expect((await lstat(filePath)).mode & 0o777).toBe(0o600);
    expect((await lstat(join(filePath, ".."))).mode & 0o777).toBe(0o700);
  });

  it("does not commit an encrypted replacement after its signal aborts", async () => {
    const filePath = await temporaryPath();
    const safeStorage = new FakeSafeStorage();
    const slot = createEncryptedSecretSlot({
      safeStorage,
      platform: "darwin",
      filePath
    });
    await slot.set("first-secret");
    const ciphertextBeforeAbort = await readFile(filePath);

    let releaseEncryption!: () => void;
    safeStorage.encryptBarrier = new Promise<void>((resolve) => {
      releaseEncryption = resolve;
    });
    const controller = new AbortController();
    const replacement = slot.set("replacement-secret", {
      signal: controller.signal
    });
    await vi.waitFor(() => expect(safeStorage.encryptCalls).toBe(2));
    controller.abort();
    releaseEncryption();

    await expect(replacement).rejects.toMatchObject({ code: "storage-failed" });
    expect(slot.get()).toBeNull();
    expect(slot.status()).toMatchObject({
      configured: false,
      activePersistence: "memory-only"
    });
    expect(await readFile(filePath)).toEqual(ciphertextBeforeAbort);

    const reopened = createEncryptedSecretSlot({
      safeStorage,
      platform: "darwin",
      filePath
    });
    await expect(reopened.initialize()).resolves.toMatchObject({
      configured: true,
      activePersistence: "os-backed"
    });
    expect(reopened.get()).toBe("first-secret");
  });

  it("serializes independent slots so aborted cleanup cannot delete a newer authority", async () => {
    const filePath = await temporaryPath();
    const oldStorage = new FakeSafeStorage();
    const newStorage = new FakeSafeStorage();
    let releaseOldEncryption!: () => void;
    oldStorage.encryptBarrier = new Promise<void>((resolve) => {
      releaseOldEncryption = resolve;
    });
    const oldSlot = createEncryptedSecretSlot({
      safeStorage: oldStorage,
      platform: "darwin",
      filePath
    });
    const newSlot = createEncryptedSecretSlot({
      safeStorage: newStorage,
      platform: "darwin",
      filePath: `${dirname(filePath)}${sep}.${sep}secret.json`
    });
    const controller = new AbortController();
    const oldWrite = oldSlot.set("old-credential", {
      signal: controller.signal
    });
    await vi.waitFor(() => expect(oldStorage.encryptCalls).toBe(1));
    controller.abort();

    const newWrite = newSlot.set("new-credential");
    await Promise.resolve();
    expect(newStorage.encryptCalls).toBe(0);
    releaseOldEncryption();

    await expect(oldWrite).rejects.toMatchObject({ code: "storage-failed" });
    await expect(newWrite).resolves.toMatchObject({
      configured: true,
      activePersistence: "os-backed"
    });
    expect(oldSlot.get()).toBeNull();
    expect(newSlot.get()).toBe("new-credential");
    await expect(lstat(filePath)).resolves.toMatchObject({});

    const reopened = createEncryptedSecretSlot({
      safeStorage: newStorage,
      platform: "darwin",
      filePath
    });
    await expect(reopened.initialize()).resolves.toMatchObject({
      configured: true,
      activePersistence: "os-backed"
    });
    expect(reopened.get()).toBe("new-credential");
  });
});
