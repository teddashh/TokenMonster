import { CloudflareAdapterError } from "./errors.js";

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE64URL_INDEX = new Map(
  [...BASE64URL_ALPHABET].map((character, index) => [character, index])
);

export function encodeBase64Url(bytes: Uint8Array<ArrayBuffer>): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    if (first === undefined) break;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    output += BASE64URL_ALPHABET[first >>> 2] ?? "";
    output +=
      BASE64URL_ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >>> 4)] ??
      "";
    if (second !== undefined) {
      output +=
        BASE64URL_ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >>> 6)] ??
        "";
    }
    if (third !== undefined) {
      output += BASE64URL_ALPHABET[third & 0x3f] ?? "";
    }
  }
  return output;
}

export function decodeCanonicalBase64Url(
  input: string,
  expectedBytes: number
): Uint8Array<ArrayBuffer> | null {
  if (
    input.length === 0 ||
    input.includes("=") ||
    !/^[A-Za-z0-9_-]+$/.test(input)
  ) {
    return null;
  }
  const output = new Uint8Array(expectedBytes);
  let buffer = 0;
  let bitCount = 0;
  let outputIndex = 0;
  for (const character of input) {
    const value = BASE64URL_INDEX.get(character);
    if (value === undefined) {
      output.fill(0);
      return null;
    }
    buffer = (buffer << 6) | value;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      if (outputIndex >= output.length) {
        output.fill(0);
        return null;
      }
      output[outputIndex] = (buffer >>> bitCount) & 0xff;
      outputIndex += 1;
      buffer &= (1 << bitCount) - 1;
    }
  }
  if (
    outputIndex !== expectedBytes ||
    buffer !== 0 ||
    encodeBase64Url(output) !== input
  ) {
    output.fill(0);
    return null;
  }
  return output;
}

export function encodeUtf8(input: string): Uint8Array<ArrayBuffer> {
  try {
    return new TextEncoder().encode(input);
  } catch {
    throw new CloudflareAdapterError("CRYPTO_OPERATION_FAILED");
  }
}
