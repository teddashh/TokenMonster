export const COMPANION_PNG_SAVE_CHANNEL =
  "tokenmonster:companion:save-png" as const;
export const COMPANION_PNG_SUGGESTED_NAME =
  "tokenmonster-local-share-card.png" as const;
export const COMPANION_PNG_WIDTH = 1_200 as const;
export const COMPANION_PNG_HEIGHT = 630 as const;
export const MAX_COMPANION_PNG_BYTES = 8 * 1_024 * 1_024;

export interface CompanionPngSaveRequest {
  readonly bytes: Uint8Array;
  readonly suggestedName: typeof COMPANION_PNG_SUGGESTED_NAME;
}

export type CompanionPngSaveStatus =
  | "saved"
  | "cancelled"
  | "already-exists"
  | "failed";

export type CompanionPngSaveResponse = Readonly<{
  status: CompanionPngSaveStatus;
}>;

export interface TokenMonsterCompanionBridge
  extends TokenMonsterReminderBridge,
    TokenMonsterAutomaticUpdateBridge {
  savePng(request: CompanionPngSaveRequest): Promise<CompanionPngSaveResponse>;
}

const PNG_SIGNATURE = Object.freeze([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PNG_CHUNKS = 1_024;

export function isCompanionPlainRecord(
  value: unknown
): value is Record<PropertyKey, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype === null) return true;
    const constructor = Object.getOwnPropertyDescriptor(
      prototype,
      "constructor"
    )?.value;
    return (
      Object.prototype.toString.call(value) === "[object Object]" &&
      Object.getPrototypeOf(prototype) === null &&
      typeof constructor === "function" &&
      constructor.name === "Object"
    );
  } catch {
    return false;
  }
}

function chunkType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset]!,
    bytes[offset + 1]!,
    bytes[offset + 2]!,
    bytes[offset + 3]!
  );
}

function crc32(bytes: Uint8Array, from: number, to: number): number {
  let crc = 0xffff_ffff;
  for (let index = from; index < to; index += 1) {
    crc ^= bytes[index]!;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function isUint8ArrayAcrossRealms(value: unknown): value is Uint8Array {
  try {
    if (!ArrayBuffer.isView(value)) return false;
    const prototype = Object.getPrototypeOf(value) as object | null;
    const constructor =
      prototype === null
        ? undefined
        : Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
    return (
      Object.prototype.toString.call(value) === "[object Uint8Array]" &&
      Object.prototype.toString.call(value.buffer) === "[object ArrayBuffer]" &&
      typeof constructor === "function" &&
      constructor.name === "Uint8Array"
    );
  } catch {
    return false;
  }
}

function isNormalizedCompanionShareCardPng(bytes: Uint8Array): boolean {
  if (
    bytes.byteLength < 57 ||
    bytes.byteLength > MAX_COMPANION_PNG_BYTES ||
    PNG_SIGNATURE.some((value, index) => bytes[index] !== value)
  ) {
    return false;
  }
  return validatePngChunks(bytes);
}

/**
 * Accepts only one bounded, structurally valid PNG card. This is deliberately
 * narrower than a generic image upload: the desktop bridge is a save surface,
 * not an arbitrary renderer-to-filesystem byte pipe.
 */
export function isCompanionShareCardPng(bytes: unknown): bytes is Uint8Array {
  if (!isUint8ArrayAcrossRealms(bytes)) return false;
  return isNormalizedCompanionShareCardPng(bytes);
}

/**
 * Copies a renderer/IPC view into this realm before validating it. Electron's
 * context bridge can preserve a typed array from another JavaScript realm, so
 * an `instanceof` or exact-prototype check would reject valid renderer bytes.
 * SharedArrayBuffer, Buffer, DataView, clamped arrays, and arbitrary array-like
 * objects remain outside the contract.
 */
export function copyCompanionShareCardPng(input: unknown): Uint8Array | null {
  if (!isUint8ArrayAcrossRealms(input)) return null;
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(input.byteLength);
    bytes.set(input);
  } catch {
    return null;
  }
  return isNormalizedCompanionShareCardPng(bytes) ? bytes : null;
}

function validatePngChunks(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = PNG_SIGNATURE.length;
  let chunkCount = 0;
  let sawHeader = false;
  let sawImageData = false;
  let sawEnd = false;

  while (offset < bytes.byteLength) {
    chunkCount += 1;
    if (chunkCount > MAX_PNG_CHUNKS || bytes.byteLength - offset < 12) {
      return false;
    }
    const length = view.getUint32(offset, false);
    const typeOffset = offset + 4;
    const dataOffset = typeOffset + 4;
    const dataEnd = dataOffset + length;
    const crcOffset = dataEnd;
    if (
      length > MAX_COMPANION_PNG_BYTES ||
      dataEnd < dataOffset ||
      crcOffset + 4 > bytes.byteLength
    ) {
      return false;
    }
    const type = chunkType(bytes, typeOffset);
    if (!/^[A-Za-z]{4}$/u.test(type)) return false;
    if (
      crc32(bytes, typeOffset, dataEnd) !== view.getUint32(crcOffset, false)
    ) {
      return false;
    }

    if (chunkCount === 1) {
      if (type !== "IHDR" || length !== 13) return false;
      if (
        view.getUint32(dataOffset, false) !== COMPANION_PNG_WIDTH ||
        view.getUint32(dataOffset + 4, false) !== COMPANION_PNG_HEIGHT ||
        bytes[dataOffset + 8] !== 8 ||
        (bytes[dataOffset + 9] !== 2 && bytes[dataOffset + 9] !== 6) ||
        bytes[dataOffset + 10] !== 0 ||
        bytes[dataOffset + 11] !== 0 ||
        bytes[dataOffset + 12] !== 0
      ) {
        return false;
      }
      sawHeader = true;
    } else if (type === "IHDR") {
      return false;
    }

    if (type === "IDAT") sawImageData = true;
    if (type === "IEND") {
      if (length !== 0 || crcOffset + 4 !== bytes.byteLength) return false;
      sawEnd = true;
    } else if (sawEnd) {
      return false;
    }
    offset = crcOffset + 4;
  }

  return sawHeader && sawImageData && sawEnd;
}

export function isCompanionPngSaveResponse(
  value: unknown
): value is CompanionPngSaveResponse {
  if (
    !isCompanionPlainRecord(value) ||
    Reflect.ownKeys(value).length !== 1
  ) {
    return false;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "status");
  return (
    descriptor !== undefined &&
    "value" in descriptor &&
    (descriptor.value === "saved" ||
      descriptor.value === "cancelled" ||
      descriptor.value === "already-exists" ||
      descriptor.value === "failed")
  );
}
import type { TokenMonsterReminderBridge } from "./reminders.js";
import type { TokenMonsterAutomaticUpdateBridge } from "./automatic-updates.js";
