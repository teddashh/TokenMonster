import { writeFile } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";

import {
  CharacterIdSchema,
  getCharacterDefinition,
  type CharacterId
} from "@tokenmonster/characters";
import type {
  LocalContentBlindExportV1,
  LocalStore,
  LocalStoreDiagnosticSummary,
  LocalUsageInsightsV1
} from "@tokenmonster/local-store";

import type {
  LocalFileSaveResponse,
  LocalSourceResetRequest,
  ShareCardSaveRequest
} from "../shared/ipc.js";

const MAX_USER_FILE_BYTES = 8 * 1_024 * 1_024;
const WINDOWS = new Set([7, 28]);
const PROVIDER_LABELS = Object.freeze({
  anthropic: "Anthropic",
  google: "Google",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  xai: "xAI",
  other: "其他供應商"
} as const);
const TOOL_LABELS = Object.freeze({
  "claude-code": "Claude Code",
  "codex-cli": "Codex CLI",
  "gemini-cli": "Gemini CLI",
  "grok-build": "Grok Build",
  other: "其他工具"
} as const);
const CHARACTER_COLORS: Readonly<Record<CharacterId, string>> = Object.freeze({
  chatgpt: "#4a9d84",
  claude: "#c47c55",
  gemini: "#6d83d7",
  grok: "#777d87"
});

type PlainRecord = Record<PropertyKey, unknown>;

function strictRecord(input: unknown, keys: readonly string[]): PlainRecord {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
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
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    keys.some((key) => {
      const descriptor = descriptors[key];
      return descriptor === undefined || !("value" in descriptor);
    })
  ) {
    throw new Error("IPC_REQUEST_REJECTED");
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

export function parseShareCardSaveRequest(input: unknown): ShareCardSaveRequest {
  const record = strictRecord(input, ["windowDays", "characterId"]);
  const windowDays = dataValue(record, "windowDays");
  if (typeof windowDays !== "number" || !WINDOWS.has(windowDays)) {
    throw new Error("IPC_REQUEST_REJECTED");
  }
  let characterId: CharacterId;
  try {
    characterId = CharacterIdSchema.parse(dataValue(record, "characterId"));
  } catch {
    throw new Error("IPC_REQUEST_REJECTED");
  }
  return Object.freeze({
    windowDays: windowDays as ShareCardSaveRequest["windowDays"],
    characterId
  });
}

export function parseFixedJsonExportRequest(input: unknown): void {
  const record = strictRecord(input, ["format"]);
  if (dataValue(record, "format") !== "json-v1") {
    throw new Error("IPC_REQUEST_REJECTED");
  }
}

export function parseLocalSourceResetRequest(
  input: unknown
): LocalSourceResetRequest {
  const record = strictRecord(input, ["confirmation"]);
  if (dataValue(record, "confirmation") !== "clear-collector-derived-data") {
    throw new Error("IPC_REQUEST_REJECTED");
  }
  return Object.freeze({ confirmation: "clear-collector-derived-data" });
}

function escapeXml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function compactTokens(input: string): string {
  if (!/^(?:0|[1-9]\d{0,63})$/u.test(input)) {
    throw new Error("LOCAL_SUMMARY_INVALID");
  }
  return new Intl.NumberFormat("zh-TW", {
    notation: "compact",
    maximumFractionDigits: 1
  }).format(BigInt(input));
}

function boundedShare(input: number): number {
  if (!Number.isInteger(input) || input < 0 || input > 10_000) {
    throw new Error("LOCAL_SUMMARY_INVALID");
  }
  return input;
}

function fixedLabel(
  labels: Readonly<Record<string, string>>,
  input: unknown
): string {
  if (typeof input !== "string" || !Object.hasOwn(labels, input)) {
    throw new Error("LOCAL_SUMMARY_INVALID");
  }
  const label = labels[input];
  if (label === undefined) throw new Error("LOCAL_SUMMARY_INVALID");
  return label;
}

export function createShareCardSvg(
  characterIdInput: unknown,
  insights: LocalUsageInsightsV1
): string {
  let characterId: CharacterId;
  try {
    characterId = CharacterIdSchema.parse(characterIdInput);
  } catch {
    throw new Error("LOCAL_SUMMARY_INVALID");
  }
  if (
    insights.schemaVersion !== "1" ||
    !WINDOWS.has(insights.windowDays) ||
    !Array.isArray(insights.providers) ||
    !Array.isArray(insights.tools)
  ) {
    throw new Error("LOCAL_SUMMARY_INVALID");
  }
  const character = getCharacterDefinition(characterId);
  const provider = insights.providers[0];
  const tool = insights.tools[0];
  const providerLabel =
    provider === undefined
      ? "尚無足跡"
      : fixedLabel(PROVIDER_LABELS, provider.id);
  const toolLabel =
    tool === undefined ? "尚無足跡" : fixedLabel(TOOL_LABELS, tool.id);
  const providerWidth =
    provider === undefined ? 0 : Math.round(boundedShare(provider.shareBasisPoints) * 0.052);
  const toolWidth =
    tool === undefined ? 0 : Math.round(boundedShare(tool.shareBasisPoints) * 0.052);
  const total = escapeXml(compactTokens(insights.totalTokens));
  const alias = escapeXml(character.alias);
  const glyph = escapeXml(character.glyph);
  const period = `${insights.windowDays} 天 UTC`;
  const accent = CHARACTER_COLORS[characterId];

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-labelledby="title desc">',
    '<title id="title">TokenMonster 本機足跡分享卡</title>',
    `<desc id="desc">${escapeXml(period)} 的內容盲 Token 摘要</desc>`,
    '<rect width="1200" height="630" rx="48" fill="#fffdf8"/>',
    '<rect x="24" y="24" width="1152" height="582" rx="36" fill="none" stroke="#17332c" stroke-width="6"/>',
    `<circle cx="152" cy="154" r="82" fill="${accent}" stroke="#17332c" stroke-width="6"/>`,
    `<text x="152" y="181" text-anchor="middle" font-family="system-ui,sans-serif" font-size="84" font-weight="900" fill="#fffdf8">${glyph}</text>`,
    '<text x="276" y="112" font-family="system-ui,sans-serif" font-size="28" font-weight="800" letter-spacing="4" fill="#37685a">TOKENMONSTER · LOCAL FOOTPRINT</text>',
    `<text x="276" y="173" font-family="system-ui,sans-serif" font-size="54" font-weight="900" fill="#17332c">${alias} 的最近 ${escapeXml(period)}</text>`,
    `<text x="76" y="330" font-family="system-ui,sans-serif" font-size="112" font-weight="950" fill="#17332c">${total}</text>`,
    '<text x="80" y="374" font-family="system-ui,sans-serif" font-size="28" font-weight="700" fill="#536b63">僅含這台裝置的內容盲摘要</text>',
    '<text x="650" y="294" font-family="system-ui,sans-serif" font-size="25" font-weight="800" fill="#17332c">主要供應商</text>',
    `<text x="1114" y="294" text-anchor="end" font-family="system-ui,sans-serif" font-size="25" fill="#536b63">${escapeXml(providerLabel)}</text>`,
    '<rect x="650" y="314" width="520" height="22" rx="11" fill="#dce8e2"/>',
    `<rect x="650" y="314" width="${providerWidth}" height="22" rx="11" fill="${accent}"/>`,
    '<text x="650" y="410" font-family="system-ui,sans-serif" font-size="25" font-weight="800" fill="#17332c">主要工具</text>',
    `<text x="1114" y="410" text-anchor="end" font-family="system-ui,sans-serif" font-size="25" fill="#536b63">${escapeXml(toolLabel)}</text>`,
    '<rect x="650" y="430" width="520" height="22" rx="11" fill="#dce8e2"/>',
    `<rect x="650" y="430" width="${toolWidth}" height="22" rx="11" fill="${accent}"/>`,
    '<text x="76" y="552" font-family="system-ui,sans-serif" font-size="22" fill="#536b63">內容盲日彙總，不含提示、回覆、程式碼、檔名、路徑、金鑰、帳號 ID 或模型字串。</text>',
    '<text x="1120" y="552" text-anchor="end" font-family="system-ui,sans-serif" font-size="22" font-weight="700" fill="#37685a">獨立、未獲供應商背書</text>',
    '</svg>',
    ''
  ].join("\n");
}

export function createLocalDataExport(store: LocalStore): string {
  const data: LocalContentBlindExportV1 = store.exportContentBlindState({
    maxDailyRows: 5_000
  });
  return `${JSON.stringify(
    {
      kind: "tokenmonster-local-data",
      schemaVersion: "1",
      privacy: {
        includes:
          "Content-blind daily aggregates, local companion state, non-secret settings, and collector authority.",
        excludes:
          "Prompts, responses, source code, filenames, project paths, credentials, cloud outbox payloads, and provider keys."
      },
      data
    },
    null,
    2
  )}\n`;
}

export function createSupportDiagnostic(input: Readonly<{
  generatedAt: string;
  appVersion: string;
  platform: "darwin" | "linux" | "win32" | "other";
  localStore: LocalStoreDiagnosticSummary;
}>): string {
  return `${JSON.stringify(
    {
      kind: "tokenmonster-support-diagnostic",
      schemaVersion: "1",
      generatedAt: input.generatedAt,
      privacy:
        "Content-free health metadata only. This file contains no usage rows, prompts, responses, model strings, IDs, paths, or credentials.",
      runtime: {
        appVersion: input.appVersion,
        platform: input.platform
      },
      localStore: input.localStore
    },
    null,
    2
  )}\n`;
}

function errorCode(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const descriptor = Object.getOwnPropertyDescriptor(input, "code");
  return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : null;
}

export async function writeNewUserSelectedFile(input: Readonly<{
  filePath: string;
  extension: ".json" | ".svg";
  content: string;
}>): Promise<LocalFileSaveResponse> {
  if (
    typeof input.filePath !== "string" ||
    !isAbsolute(input.filePath) ||
    input.filePath.includes("\0") ||
    extname(input.filePath).toLowerCase() !== input.extension ||
    typeof input.content !== "string" ||
    Buffer.byteLength(input.content, "utf8") > MAX_USER_FILE_BYTES
  ) {
    return Object.freeze({ status: "invalid-selection" });
  }
  try {
    await writeFile(input.filePath, input.content, {
      encoding: "utf8",
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
