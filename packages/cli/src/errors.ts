export type TokenMonsterCliErrorCode =
  | "invalid-arguments"
  | "already-running"
  | "runtime-lease-failed"
  | "sidecar-start-failed"
  | "gateway-start-failed"

const MESSAGE_BY_CODE: Readonly<Record<TokenMonsterCliErrorCode, string>> = {
  "invalid-arguments": "不支援這個參數。請執行 tokenmonster --help。",
  "already-running":
    "TokenMonster 已在執行中。請使用已開啟的視窗，或先關閉它再試。",
  "runtime-lease-failed":
    "TokenMonster 無法取得本機執行權。請重新啟動系統後再試。",
  "sidecar-start-failed":
    "TokenTracker sidecar 無法啟動。請確認 Node.js 版本後重新執行 TokenMonster。",
  "gateway-start-failed":
    "TokenMonster 本機介面無法啟動。請關閉其他執行中的 TokenMonster 後再試。"
}

export class TokenMonsterCliError extends Error {
  public override readonly name = "TokenMonsterCliError"
  public readonly code: TokenMonsterCliErrorCode

  public constructor(code: TokenMonsterCliErrorCode) {
    super(MESSAGE_BY_CODE[code])
    this.code = code
  }
}
