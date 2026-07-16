import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PET_WINDOW_STATE,
  parsePetWindowState,
  readPetWindowState,
  writePetWindowState
} from "../src/main/pet/bounds-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

describe("pet window bounds store", () => {
  it("accepts only exact bounds and pin-state keys", () => {
    const state = {
      bounds: { x: -120, y: 42, width: 380, height: 600 },
      pinned: false
    };
    expect(parsePetWindowState(state)).toEqual(state);
    expect(parsePetWindowState({ ...state, projectPath: "/private" })).toBe(
      DEFAULT_PET_WINDOW_STATE
    );
    expect(
      parsePetWindowState({
        bounds: { ...state.bounds, filename: "private.ts" },
        pinned: false
      })
    ).toBe(DEFAULT_PET_WINDOW_STATE);
    expect(
      parsePetWindowState(
        Object.defineProperty(
          { bounds: state.bounds },
          "pinned",
          { enumerable: true, get: () => false }
        )
      )
    ).toBe(DEFAULT_PET_WINDOW_STATE);
  });

  it("falls back for missing or corrupt JSON and writes only the exact shape", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tokenmonster-pet-state-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "state.json");
    expect(await readPetWindowState(path)).toBe(DEFAULT_PET_WINDOW_STATE);

    await writeFile(path, "{ definitely-not-json", "utf8");
    expect(await readPetWindowState(path)).toBe(DEFAULT_PET_WINDOW_STATE);

    const state = {
      bounds: { x: 12, y: 34, width: 380, height: 600 },
      pinned: true
    } as const;
    await writePetWindowState(path, state);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(state);
  });
});
