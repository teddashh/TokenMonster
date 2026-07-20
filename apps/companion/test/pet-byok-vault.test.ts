import { Buffer } from "node:buffer";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AsyncSafeStoragePort } from "@tokenmonster/secret-vault";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PET_BYOK_SECRET_FILE,
  PET_BYOK_INITIALIZATION_TIMEOUT_MS,
  createPetByokSecretSlot,
  startPetByokSecretSlot
} from "../src/main/pet/byok-vault.js";

const KEY_CANARY = ["sk", "pet_vault_1234567890abcdef_KEY_CANARY"].join("-");
const ERROR_CANARY = "PET_SAFE_STORAGE_ERROR_CANARY";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => rm(directory, { recursive: true, force: true }))
  );
});

class FakeSafeStorage implements AsyncSafeStoragePort {
  public constructor(
    private readonly backend: string,
    private readonly available: boolean,
    private readonly failPolicy = false
  ) {}

  public async isAsyncEncryptionAvailable(): Promise<boolean> {
    if (this.failPolicy) throw new Error(ERROR_CANARY);
    return this.available;
  }

  public getSelectedStorageBackend(): string {
    if (this.failPolicy) throw new Error(ERROR_CANARY);
    return this.backend;
  }

  public async encryptStringAsync(plainText: string): Promise<Uint8Array> {
    return Uint8Array.from(
      Buffer.from(plainText, "utf8"),
      (value) => value ^ 0x5a
    );
  }

  public async decryptStringAsync(
    encrypted: Uint8Array
  ): Promise<Readonly<{ result: string; shouldReEncrypt: boolean }>> {
    return Object.freeze({
      result: Buffer.from(
        Uint8Array.from(encrypted, (value) => value ^ 0x5a)
      ).toString("utf8"),
      shouldReEncrypt: false
    });
  }
}

async function temporaryUserData(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tokenmonster-pet-byok-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("default pet BYOK vault composition", () => {
  it("persists only encrypted bytes at the legacy-compatible OS-backed path", async () => {
    const userDataDirectory = await temporaryUserData();
    const safeStorage = new FakeSafeStorage("gnome_libsecret", true);
    const slot = await createPetByokSecretSlot({
      userDataDirectory,
      safeStorage,
      platform: "linux"
    });
    expect(slot).not.toBeNull();
    expect(await slot!.set(KEY_CANARY, { persist: true })).toMatchObject({
      configured: true,
      persistence: "os-backed",
      backend: "gnome_libsecret"
    });

    const secretsDirectory = join(userDataDirectory, "secrets");
    const secretPath = join(secretsDirectory, PET_BYOK_SECRET_FILE);
    expect(secretPath).toBe(
      join(userDataDirectory, "secrets", "openai-byok.json")
    );
    if (process.platform !== "win32") {
      expect((await lstat(secretsDirectory)).mode & 0o777).toBe(0o700);
      expect((await lstat(secretPath)).mode & 0o777).toBe(0o600);
    }
    const persisted = await readFile(secretPath, "utf8");
    expect(persisted).not.toContain(KEY_CANARY);
    expect(JSON.stringify(slot!.status())).not.toContain(KEY_CANARY);

    const reopened = await createPetByokSecretSlot({
      userDataDirectory,
      safeStorage,
      platform: "linux"
    });
    expect(reopened?.get()).toBe(KEY_CANARY);
    expect(JSON.stringify(reopened?.status())).not.toContain(KEY_CANARY);
  });

  it("stays usable but RAM-only when the backend is not approved", async () => {
    const userDataDirectory = await temporaryUserData();
    const slot = await createPetByokSecretSlot({
      userDataDirectory,
      safeStorage: new FakeSafeStorage("basic_text", true),
      platform: "linux"
    });
    expect(slot).not.toBeNull();
    expect(await slot!.set(KEY_CANARY, { persist: true })).toMatchObject({
      configured: true,
      persistence: "memory-only",
      backend: "basic_text"
    });
    expect(slot!.get()).toBe(KEY_CANARY);
    expect(JSON.stringify(slot!.status())).not.toContain(KEY_CANARY);
    await expect(
      lstat(join(userDataDirectory, "secrets", PET_BYOK_SECRET_FILE))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns unavailable authority for private-directory, safeStorage, or vault-load failure", async () => {
    const missingRoot = join(await temporaryUserData(), "missing");
    await expect(
      createPetByokSecretSlot({
        userDataDirectory: missingRoot,
        safeStorage: new FakeSafeStorage("gnome_libsecret", true),
        platform: "linux"
      })
    ).resolves.toBeNull();

    const unavailableRoot = await temporaryUserData();
    await expect(
      createPetByokSecretSlot({
        userDataDirectory: unavailableRoot,
        safeStorage: new FakeSafeStorage("gnome_libsecret", true, true),
        platform: "linux"
      })
    ).resolves.toBeNull();

    const corruptRoot = await temporaryUserData();
    const corruptDirectory = join(corruptRoot, "secrets");
    await mkdir(corruptDirectory, { mode: 0o700 });
    await writeFile(join(corruptDirectory, PET_BYOK_SECRET_FILE), "not-json", {
      mode: 0o600
    });
    await expect(
      createPetByokSecretSlot({
        userDataDirectory: corruptRoot,
        safeStorage: new FakeSafeStorage("gnome_libsecret", true),
        platform: "linux"
      })
    ).resolves.toBeNull();
  });

  it("bounds a hanging safeStorage policy probe without blocking the pet", async () => {
    const userDataDirectory = await temporaryUserData();
    const writer = await createPetByokSecretSlot({
      userDataDirectory,
      safeStorage: new FakeSafeStorage("gnome_libsecret", true),
      platform: "linux"
    });
    await writer!.set(KEY_CANARY, { persist: true });
    const secretPath = join(userDataDirectory, "secrets", PET_BYOK_SECRET_FILE);
    const oldCiphertext = await readFile(secretPath, "utf8");
    let announceProbe!: () => void;
    let releaseProbe!: (available: boolean) => void;
    const probeStarted = new Promise<void>((resolve) => {
      announceProbe = resolve;
    });
    const probeGate = new Promise<boolean>((resolve) => {
      releaseProbe = resolve;
    });
    const safeStorage: AsyncSafeStoragePort = Object.freeze({
      isAsyncEncryptionAvailable: async () => {
        announceProbe();
        return probeGate;
      },
      getSelectedStorageBackend: () => "basic_text",
      encryptStringAsync: async () => Uint8Array.of(1),
      decryptStringAsync: async () => ({
        result: KEY_CANARY,
        shouldReEncrypt: false
      })
    });
    vi.useFakeTimers();

    const pending = createPetByokSecretSlot({
      userDataDirectory,
      safeStorage,
      platform: "linux"
    });
    await probeStarted;
    await vi.advanceTimersByTimeAsync(PET_BYOK_INITIALIZATION_TIMEOUT_MS);

    await expect(pending).resolves.toBeNull();
    releaseProbe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(await readFile(secretPath, "utf8")).toBe(oldCiphertext);
  });

  it("aborts the bounded result but keeps raw policy work quiescent", async () => {
    const userDataDirectory = await temporaryUserData();
    let announceProbe!: () => void;
    let releaseProbe!: (available: boolean) => void;
    const probeStarted = new Promise<void>((resolve) => {
      announceProbe = resolve;
    });
    const probeGate = new Promise<boolean>((resolve) => {
      releaseProbe = resolve;
    });
    const startup = startPetByokSecretSlot({
      userDataDirectory,
      safeStorage: Object.freeze({
        isAsyncEncryptionAvailable: async () => {
          announceProbe();
          return await probeGate;
        },
        getSelectedStorageBackend: () => "basic_text",
        encryptStringAsync: async () => Uint8Array.of(1),
        decryptStringAsync: async () => ({
          result: KEY_CANARY,
          shouldReEncrypt: false
        })
      }),
      platform: "linux"
    });
    await probeStarted;
    let quiesced = false;
    const quiescence = startup.quiesce().then(() => {
      quiesced = true;
    });

    startup.abort();
    await expect(startup.result).resolves.toBeNull();
    expect(quiesced).toBe(false);

    releaseProbe(true);
    await quiescence;
    expect(quiesced).toBe(true);
  });

  it("bounds a hanging vault decrypt without exposing a late authority", async () => {
    const userDataDirectory = await temporaryUserData();
    const writer = await createPetByokSecretSlot({
      userDataDirectory,
      safeStorage: new FakeSafeStorage("gnome_libsecret", true),
      platform: "linux"
    });
    await writer!.set(KEY_CANARY, { persist: true });
    const secretPath = join(userDataDirectory, "secrets", PET_BYOK_SECRET_FILE);
    const oldCiphertext = await readFile(secretPath, "utf8");
    let announceDecrypt!: () => void;
    let releaseDecrypt!: () => void;
    const decryptStarted = new Promise<void>((resolve) => {
      announceDecrypt = resolve;
    });
    const decryptGate = new Promise<void>((resolve) => {
      releaseDecrypt = resolve;
    });
    let encryptCalls = 0;
    const safeStorage: AsyncSafeStoragePort = Object.freeze({
      isAsyncEncryptionAvailable: async () => true,
      getSelectedStorageBackend: () => "gnome_libsecret",
      encryptStringAsync: async () => {
        encryptCalls += 1;
        return Uint8Array.of(1);
      },
      decryptStringAsync: async (): Promise<
        Readonly<{ result: string; shouldReEncrypt: boolean }>
      > => {
        announceDecrypt();
        await decryptGate;
        return Object.freeze({
          result: KEY_CANARY,
          shouldReEncrypt: true
        });
      }
    });
    vi.useFakeTimers();

    const pending = createPetByokSecretSlot({
      userDataDirectory,
      safeStorage,
      platform: "linux"
    });
    await decryptStarted;
    await vi.advanceTimersByTimeAsync(PET_BYOK_INITIALIZATION_TIMEOUT_MS);

    await expect(pending).resolves.toBeNull();
    releaseDecrypt();
    await vi.advanceTimersByTimeAsync(0);
    expect(encryptCalls).toBe(0);
    expect(await readFile(secretPath, "utf8")).toBe(oldCiphertext);
  });
});
