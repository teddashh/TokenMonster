import { readFile, writeFile } from "node:fs/promises";

export interface PetWindowBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PetWindowState {
  readonly bounds: PetWindowBounds;
  readonly pinned: boolean;
}

const PET_WINDOW_MARGIN = 12;

export const DEFAULT_PET_WINDOW_STATE: PetWindowState = Object.freeze({
  bounds: Object.freeze({ width: 340, height: 560, x: 0, y: 0 }),
  pinned: true
});

export function placeDefaultPetWindowState(
  state: PetWindowState,
  workArea: PetWindowBounds
): PetWindowState {
  if (state !== DEFAULT_PET_WINDOW_STATE) return state;
  const { width, height } = DEFAULT_PET_WINDOW_STATE.bounds;
  return Object.freeze({
    bounds: Object.freeze({
      x: workArea.x + workArea.width - width - PET_WINDOW_MARGIN,
      y: workArea.y + workArea.height - height - PET_WINDOW_MARGIN,
      width,
      height
    }),
    pinned: DEFAULT_PET_WINDOW_STATE.pinned
  });
}

function exactObject(
  value: unknown,
  expectedKeys: readonly string[]
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(record);
  return (
    keys.length === expectedKeys.length &&
    keys.every((key) => {
      if (typeof key !== "string" || !expectedKeys.includes(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      return (
        descriptor !== undefined && descriptor.enumerable && "value" in descriptor
      );
    })
  );
}

function isCoordinate(value: unknown): value is number {
  return Number.isInteger(value) && Number.isSafeInteger(value);
}

function isDimension(value: unknown): value is number {
  return isCoordinate(value) && value >= 100 && value <= 10_000;
}

export function parsePetWindowState(value: unknown): PetWindowState {
  if (!exactObject(value, ["bounds", "pinned"])) {
    return DEFAULT_PET_WINDOW_STATE;
  }
  const bounds = value["bounds"];
  if (
    typeof value["pinned"] !== "boolean" ||
    !exactObject(bounds, ["height", "width", "x", "y"]) ||
    !isCoordinate(bounds["x"]) ||
    !isCoordinate(bounds["y"]) ||
    !isDimension(bounds["width"]) ||
    !isDimension(bounds["height"])
  ) {
    return DEFAULT_PET_WINDOW_STATE;
  }
  return Object.freeze({
    bounds: Object.freeze({
      x: bounds["x"],
      y: bounds["y"],
      width: bounds["width"],
      height: bounds["height"]
    }),
    pinned: value["pinned"]
  });
}

export async function readPetWindowState(path: string): Promise<PetWindowState> {
  try {
    return parsePetWindowState(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return DEFAULT_PET_WINDOW_STATE;
  }
}

export async function writePetWindowState(
  path: string,
  state: PetWindowState
): Promise<void> {
  const validated = parsePetWindowState(state);
  await writeFile(path, `${JSON.stringify(validated)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}
