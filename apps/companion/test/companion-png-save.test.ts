import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import { afterEach, describe, expect, it } from "vitest";

import {
  COMPANION_PNG_SUGGESTED_NAME,
  copyCompanionShareCardPng,
  isCompanionShareCardPng
} from "../src/shared/companion-png.js";
import {
  isTrustedCompanionPngSender,
  parseCompanionPngSaveRequest,
  writeNewCompanionPng
} from "../src/main/pet/png-save.js";

import { companionPngFixture } from "./companion-png-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("companion PNG contract", () => {
  it("accepts only the fixed-size bounded PNG and normalizes a renderer realm", () => {
    const png = companionPngFixture();
    const foreignBytes = runInNewContext("new Uint8Array(values)", {
      values: [...png]
    }) as unknown;

    expect(foreignBytes).not.toBeInstanceOf(Uint8Array);
    expect(isCompanionShareCardPng(foreignBytes)).toBe(true);
    const normalized = copyCompanionShareCardPng(foreignBytes);
    expect(normalized).toBeInstanceOf(Uint8Array);
    expect(Object.getPrototypeOf(normalized)).toBe(Uint8Array.prototype);
    expect(normalized).toEqual(png);

    expect(isCompanionShareCardPng(companionPngFixture(1_199, 630))).toBe(
      false
    );
    expect(isCompanionShareCardPng(companionPngFixture(1_200, 629))).toBe(
      false
    );
    expect(isCompanionShareCardPng(Buffer.from(png))).toBe(false);
    expect(isCompanionShareCardPng(new Uint8ClampedArray(png))).toBe(false);
    expect(isCompanionShareCardPng(new DataView(png.buffer))).toBe(false);

    const corrupted = new Uint8Array(png);
    const lastIndex = corrupted.byteLength - 1;
    corrupted[lastIndex] = (corrupted[lastIndex] ?? 0) ^ 1;
    expect(isCompanionShareCardPng(corrupted)).toBe(false);
    const trailing = new Uint8Array(png.byteLength + 1);
    trailing.set(png);
    expect(isCompanionShareCardPng(trailing)).toBe(false);
  });

  it("strictly parses and copies the fixed request contract", () => {
    const bytes = companionPngFixture();
    const parsed = parseCompanionPngSaveRequest({
      bytes,
      suggestedName: COMPANION_PNG_SUGGESTED_NAME
    });
    expect(parsed).toEqual({
      bytes,
      suggestedName: COMPANION_PNG_SUGGESTED_NAME
    });
    expect(parsed.bytes).not.toBe(bytes);
    const originalFirstByte = parsed.bytes[0];
    bytes[0] = 0;
    expect(parsed.bytes[0]).toBe(originalFirstByte);

    const validBytes = companionPngFixture();
    for (const invalid of [
      null,
      { bytes: validBytes },
      {
        bytes: validBytes,
        suggestedName: "other.png"
      },
      {
        bytes: validBytes,
        suggestedName: COMPANION_PNG_SUGGESTED_NAME,
        extra: true
      },
      {
        get bytes() {
          return validBytes;
        },
        suggestedName: COMPANION_PNG_SUGGESTED_NAME
      }
    ]) {
      expect(() => parseCompanionPngSaveRequest(invalid)).toThrow(
        "IPC_REQUEST_REJECTED"
      );
    }
  });

  it("binds IPC to the active main frame and exact gateway document", () => {
    const origin = "http://127.0.0.1:43123";
    const frame = { url: `${origin}/?view=pet` };
    const sender = { mainFrame: frame };
    const allowed = new Set<object>([sender]);
    expect(
      isTrustedCompanionPngSender({ sender, senderFrame: frame }, allowed, origin)
    ).toBe(true);

    for (const url of [
      `${origin}/?view=pet#main-content`,
      `${origin}/?view=pet#fragment`,
      `${origin}/#main-content`
    ]) {
      const sameDocumentFrame = { url };
      const sameDocumentSender = { mainFrame: sameDocumentFrame };
      expect(
        isTrustedCompanionPngSender(
          { sender: sameDocumentSender, senderFrame: sameDocumentFrame },
          new Set<object>([sameDocumentSender]),
          origin
        )
      ).toBe(true);
    }

    for (const url of [
      `${origin}/other`,
      `${origin}/?view=dashboard`,
      `${origin}/?view=pet&extra=1`,
      `${origin}/other#main-content`,
      "http://127.0.0.1:43124/?view=pet"
    ]) {
      const rejectedFrame = { url };
      const rejectedSender = { mainFrame: rejectedFrame };
      expect(
        isTrustedCompanionPngSender(
          { sender: rejectedSender, senderFrame: rejectedFrame },
          new Set<object>([rejectedSender]),
          origin
        )
      ).toBe(false);
    }
    expect(
      isTrustedCompanionPngSender(
        { sender, senderFrame: { url: frame.url } },
        allowed,
        origin
      )
    ).toBe(false);
    expect(
      isTrustedCompanionPngSender(
        { sender, senderFrame: frame },
        new Set<object>(),
        origin
      )
    ).toBe(false);
  });

  it("writes one private PNG without overwriting an existing card", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tokenmonster-png-save-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, COMPANION_PNG_SUGGESTED_NAME);
    const bytes = companionPngFixture();

    await expect(writeNewCompanionPng({ filePath, bytes })).resolves.toEqual({
      status: "saved"
    });
    expect(new Uint8Array(await readFile(filePath))).toEqual(bytes);
    if (process.platform !== "win32") {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }
    await expect(writeNewCompanionPng({ filePath, bytes })).resolves.toEqual({
      status: "already-exists"
    });
    await expect(
      writeNewCompanionPng({
        filePath: join(directory, "wrong.jpg"),
        bytes
      })
    ).resolves.toEqual({ status: "failed" });
    await expect(
      writeNewCompanionPng({ filePath: "relative.png", bytes })
    ).resolves.toEqual({ status: "failed" });
  });
});
