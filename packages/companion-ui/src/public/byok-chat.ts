import type {
  ByokChatErrorCode,
  ByokChatMessage,
  CharacterId,
} from "./dto.js";
import { localizeUiText } from "./localization.js";

export const BYOK_CHAT_CHARACTER_IDS = Object.freeze([
  "chatgpt",
  "claude",
  "gemini",
  "grok",
] as const);
export const MAX_BYOK_CHAT_HISTORY_MESSAGES = 12;
export const MAX_BYOK_CHAT_HISTORY_BYTES = 48 * 1_024;

export type ByokChatCharacterId =
  (typeof BYOK_CHAT_CHARACTER_IDS)[number];

export function isByokChatCharacter(
  characterId: CharacterId | null,
): characterId is ByokChatCharacterId {
  return BYOK_CHAT_CHARACTER_IDS.some((candidate) => candidate === characterId);
}

function historyBytes(history: readonly ByokChatMessage[]): number {
  const encoder = new TextEncoder();
  return history.reduce(
    (total, message) => total + encoder.encode(message.text).byteLength,
    0,
  );
}

export function appendByokChatExchange(
  history: readonly ByokChatMessage[],
  userText: string,
  assistantText: string,
): readonly ByokChatMessage[] {
  const next: ByokChatMessage[] = [
    ...history,
    Object.freeze({ role: "user", text: userText }),
    Object.freeze({ role: "assistant", text: assistantText }),
  ];
  while (
    next.length > MAX_BYOK_CHAT_HISTORY_MESSAGES ||
    historyBytes(next) > MAX_BYOK_CHAT_HISTORY_BYTES
  ) {
    next.splice(0, Math.min(2, next.length));
  }
  return Object.freeze(next);
}

export function byokChatErrorText(error: ByokChatErrorCode): string {
  const raw = (() => {
    switch (error) {
    case "not-configured":
      return "OpenAI API key 已不在本機，重新設定後才能繼續聊。";
    case "provider-authentication-failed":
      return "OpenAI 沒有接受這把 key；請清除後重新設定。";
    case "provider-rate-limited":
      return "OpenAI 現在很忙，稍後再聊；本機固定台詞仍可使用。";
    case "busy":
      return "上一句還在回覆，等她說完再送下一句。";
    case "request-aborted":
      return "這次對話已取消，內容沒有寫進 TokenMonster 儲存。";
    case "response-too-large":
    case "malformed-response":
    case "incomplete-response":
    case "unsupported-response":
    case "empty-response":
      return "OpenAI 的回覆這次無法顯示；先讓本機台詞陪你。";
    case "unavailable":
    case "request-timeout":
    case "network-error":
    case "provider-request-rejected":
    case "provider-unavailable":
    case "provider-error":
    case "local-service-error":
        return "即時對話暫時沒接上；角色與本機固定台詞都不受影響。";
    }
  })();
  return localizeUiText(raw);
}
