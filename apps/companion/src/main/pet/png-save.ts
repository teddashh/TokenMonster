import { writeFile } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";

import {
  COMPANION_PNG_SUGGESTED_NAME,
  copyCompanionShareCardPng,
  isCompanionPlainRecord,
  type CompanionPngSaveRequest,
  type CompanionPngSaveResponse
} from "../../shared/companion-png.js";

type PlainRecord = Record<PropertyKey, unknown>;

export interface CompanionPngSenderEvent {
  readonly sender: Readonly<{ mainFrame: unknown }>;
  readonly senderFrame: Readonly<{ url: string }> | null;
}

function isCompanionDocumentUrl(input: string, origin: string): boolean {
  try {
    const url = new URL(input);
    return (
      url.origin === origin &&
      url.pathname === "/" &&
      (url.search === "" || url.search === "?view=pet") &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

export function isTrustedCompanionPngSender(
  event: CompanionPngSenderEvent,
  allowedSenders: ReadonlySet<object>,
  origin: string
): boolean {
  return (
    allowedSenders.has(event.sender) &&
    event.senderFrame !== null &&
    event.senderFrame === event.sender.mainFrame &&
    isCompanionDocumentUrl(event.senderFrame.url, origin)
  );
}

function strictRecord(input: unknown, keys: readonly string[]): PlainRecord {
  if (
    !isCompanionPlainRecord(input)
  ) {
    throw new Error("IPC_REQUEST_REJECTED");
  }
  const ownKeys = Reflect.ownKeys(input);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    throw new Error("IPC_REQUEST_REJECTED");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new Error("IPC_REQUEST_REJECTED");
    }
  }
  return input as PlainRecord;
}

function dataValue(record: PlainRecord, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new Error("IPC_REQUEST_REJECTED");
  }
  return descriptor.value as unknown;
}

function errorCode(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const descriptor = Object.getOwnPropertyDescriptor(input, "code");
  return descriptor !== undefined &&
    "value" in descriptor &&
    typeof descriptor.value === "string"
    ? descriptor.value
    : null;
}

export function parseCompanionPngSaveRequest(
  input: unknown
): CompanionPngSaveRequest {
  const record = strictRecord(input, ["bytes", "suggestedName"]);
  const bytes = copyCompanionShareCardPng(dataValue(record, "bytes"));
  if (
    dataValue(record, "suggestedName") !== COMPANION_PNG_SUGGESTED_NAME ||
    bytes === null
  ) {
    throw new Error("IPC_REQUEST_REJECTED");
  }
  return {
    // Copy before the save dialog opens so renderer mutation cannot alter the
    // bytes after validation.
    bytes,
    suggestedName: COMPANION_PNG_SUGGESTED_NAME
  };
}

export async function writeNewCompanionPng(input: Readonly<{
  filePath: string;
  bytes: Uint8Array;
}>): Promise<CompanionPngSaveResponse> {
  const bytes = copyCompanionShareCardPng(input.bytes);
  if (
    typeof input.filePath !== "string" ||
    !isAbsolute(input.filePath) ||
    input.filePath.includes("\0") ||
    extname(input.filePath).toLowerCase() !== ".png" ||
    bytes === null
  ) {
    return Object.freeze({ status: "failed" });
  }
  try {
    await writeFile(input.filePath, bytes, {
      flag: "wx",
      mode: 0o600
    });
    return Object.freeze({ status: "saved" });
  } catch (error: unknown) {
    return Object.freeze({
      status: errorCode(error) === "EEXIST" ? "already-exists" : "failed"
    });
  }
}
