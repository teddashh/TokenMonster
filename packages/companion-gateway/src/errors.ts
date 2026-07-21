import type { CompanionGatewayErrorCode } from "./types.js";

const MESSAGE_BY_CODE: Readonly<Record<CompanionGatewayErrorCode, string>> = {
  "invalid-configuration": "The companion gateway configuration is invalid.",
  "already-started": "The companion gateway has already been started.",
  closed: "The companion gateway has been closed."
};

export class CompanionGatewayError extends Error {
  public override readonly name = "CompanionGatewayError";
  public readonly code: CompanionGatewayErrorCode;

  public constructor(code: CompanionGatewayErrorCode) {
    super(MESSAGE_BY_CODE[code]);
    this.code = code;
  }
}
