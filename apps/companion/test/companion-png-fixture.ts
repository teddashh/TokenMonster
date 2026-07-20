import { deflateSync } from "node:zlib";

import {
  COMPANION_PNG_HEIGHT,
  COMPANION_PNG_WIDTH
} from "../src/shared/companion-png.js";

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.byteLength);
  output.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(output, 4);
  Buffer.from(data).copy(output, 8);
  output.writeUInt32BE(
    crc32(output.subarray(4, 8 + data.byteLength)),
    8 + data.byteLength
  );
  return output;
}

export function companionPngFixture(
  width: number = COMPANION_PNG_WIDTH,
  height: number = COMPANION_PNG_HEIGHT
): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  // One filter byte followed by an all-black RGB row, repeated for the full
  // card. The result is a real decodable PNG while staying tiny when deflated.
  const raw = Buffer.alloc((width * 3 + 1) * height);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", new Uint8Array())
    ])
  );
}
