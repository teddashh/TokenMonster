import { chmod, lstat, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SecretVaultError,
  createEncryptedSecretSlot,
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
  public throwOnEncrypt = false;
  public throwOnDecrypt = false;

  public constructor(
    public backend = "unknown",
    public available = true
  ) {}

  public async isAsyncEncryptionAvailable(): Promise<boolean> {
    return this.available;
  }

  public getSelectedStorageBackend(): string {
    return this.backend;
  }

  public async encryptStringAsync(plainText: string): Promise<Uint8Array> {
    this.encryptCalls += 1;
    if (this.throwOnEncrypt) throw new Error(SECRET_CANARY);
    return Buffer.from(`cipher:${[...plainText].reverse().join("")}`, "utf8");
  }

  public async decryptStringAsync(
    encrypted: Uint8Array
  ): Promise<Readonly<{ result: string; shouldReEncrypt: boolean }>> {
    this.decryptCalls += 1;
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
    expect(status.configured).toBe(true);
    expect(slot.get()).toBe(SECRET_CANARY);
    await expect(lstat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes old ciphertext when the current backend is not OS-backed", async () => {
    const filePath = await temporaryPath();
    const safeStorage = new FakeSafeStorage("unknown");
    await createEncryptedSecretSlot({
      safeStorage,
      platform: "darwin",
      filePath
    }).set(SECRET_CANARY);
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
    await expect(lstat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
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
});
