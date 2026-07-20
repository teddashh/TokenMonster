import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";
import type { AsyncSafeStoragePort } from "@tokenmonster/secret-vault";

import {
  CONTRIBUTION_CREDENTIAL_FILES,
  createContributionCredentialHost,
} from "../src/credential-host.js";

class NativeTestStorage implements AsyncSafeStoragePort {
  isAsyncEncryptionAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  getSelectedStorageBackend(): string {
    return "keychain";
  }

  encryptStringAsync(plainText: string): Promise<Uint8Array> {
    return Promise.resolve(Buffer.from(plainText, "utf8").map((byte) => byte ^ 0xa5));
  }

  decryptStringAsync(
    encrypted: Uint8Array,
  ): Promise<Readonly<{ result: string; shouldReEncrypt: boolean }>> {
    return Promise.resolve({
      result: Buffer.from(encrypted.map((byte) => byte ^ 0xa5)).toString("utf8"),
      shouldReEncrypt: false,
    });
  }
}

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("contribution credential host", () => {
  it("creates only the four fixed encrypted OS-vault slots", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tokenmonster-contribution-"));
    directories.push(directory);
    const slots = createContributionCredentialHost({
      safeStorage: new NativeTestStorage(),
      platform: "darwin",
    }).openCredentialSlots(directory);

    const entries = Object.entries(slots);
    expect(entries.map(([name]) => name)).toEqual([
      "uploadCredential",
      "deletionCredential",
      "statusCredential",
      "pendingEnrollmentCredential",
    ]);
    for (const [index, [, slot]] of entries.entries()) {
      await slot.initialize();
      await slot.set(`secret-${index}`);
      expect(slot.status().persistence).toBe("os-backed");
    }

    const files = Object.values(CONTRIBUTION_CREDENTIAL_FILES);
    expect(files).toHaveLength(4);
    for (const [index, fileName] of files.entries()) {
      const serialized = await readFile(join(directory, fileName), "utf8");
      expect(serialized).toContain('"schemaVersion":1');
      expect(serialized).not.toContain(`secret-${index}`);
    }
  });

  it("fails closed to memory-only for an unaudited Linux backend", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tokenmonster-contribution-"));
    directories.push(directory);
    const storage = new NativeTestStorage();
    storage.getSelectedStorageBackend = () => "basic_text";
    const slots = createContributionCredentialHost({
      safeStorage: storage,
      platform: "linux",
    }).openCredentialSlots(directory);

    const statuses = await Promise.all(
      Object.values(slots).map((slot) => slot.initialize()),
    );
    expect(statuses.every((status) => status.persistence === "memory-only")).toBe(true);
  });

  it("rejects relative state roots before constructing a slot", () => {
    const host = createContributionCredentialHost({
      safeStorage: new NativeTestStorage(),
      platform: "win32",
    });
    expect(() => host.openCredentialSlots("relative/path")).toThrow(
      "Invalid contribution credential state directory",
    );
  });
});
