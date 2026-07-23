const MAX_VOICE_FILE_BYTES = 400_000;
const MAX_VOICE_DURATION_MS = 6_000;

export function canonicalizeVoiceWav(bytes, sourceLabel) {
  if (!Buffer.isBuffer(bytes)) {
    throw new TypeError(`Voice clip bytes must be a Buffer: ${sourceLabel}`);
  }
  if (bytes.length > MAX_VOICE_FILE_BYTES) {
    throw new Error(
      `Voice clip exceeds ${MAX_VOICE_FILE_BYTES} bytes: ${sourceLabel}`,
    );
  }
  if (
    bytes.length < 12 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error(`Voice clip is not a RIFF/WAVE file: ${sourceLabel}`);
  }
  if (bytes.readUInt32LE(4) !== bytes.length - 8) {
    throw new Error(`Voice clip has an invalid RIFF size: ${sourceLabel}`);
  }

  let format = null;
  let data = null;
  let offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      throw new Error(`Voice clip has a truncated chunk header: ${sourceLabel}`);
    }
    const chunkIdBytes = bytes.subarray(offset, offset + 4);
    if (
      [...chunkIdBytes].some((value) => value < 0x20 || value > 0x7e)
    ) {
      throw new Error(`Voice clip has an invalid chunk ID: ${sourceLabel}`);
    }
    const chunkId = bytes.toString("ascii", offset, offset + 4);
    const chunkSize = bytes.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > bytes.length) {
      throw new Error(
        `Voice clip has a truncated ${chunkId} chunk: ${sourceLabel}`,
      );
    }
    const paddedChunkEnd = chunkEnd + (chunkSize % 2);
    if (paddedChunkEnd > bytes.length) {
      throw new Error(
        `Voice clip has a missing chunk padding byte: ${sourceLabel}`,
      );
    }
    if (paddedChunkEnd !== chunkEnd && bytes[chunkEnd] !== 0) {
      throw new Error(
        `Voice clip has a non-zero chunk padding byte: ${sourceLabel}`,
      );
    }

    if (chunkId === "fmt ") {
      if (format !== null) {
        throw new Error(`Voice clip has duplicate fmt chunks: ${sourceLabel}`);
      }
      if (chunkSize !== 16) {
        throw new Error(`Voice clip has an invalid fmt chunk: ${sourceLabel}`);
      }
      format = {
        audioFormat: bytes.readUInt16LE(chunkStart),
        channels: bytes.readUInt16LE(chunkStart + 2),
        sampleRate: bytes.readUInt32LE(chunkStart + 4),
        byteRate: bytes.readUInt32LE(chunkStart + 8),
        blockAlign: bytes.readUInt16LE(chunkStart + 12),
        bitsPerSample: bytes.readUInt16LE(chunkStart + 14),
      };
    } else if (chunkId === "data") {
      if (data !== null) {
        throw new Error(`Voice clip has duplicate data chunks: ${sourceLabel}`);
      }
      data = bytes.subarray(chunkStart, chunkEnd);
    }

    offset = paddedChunkEnd;
  }

  if (format === null || data === null) {
    throw new Error(
      `Voice clip must contain fmt and data chunks: ${sourceLabel}`,
    );
  }
  if (format.audioFormat !== 1) {
    throw new Error(`Voice clip must use PCM format 1: ${sourceLabel}`);
  }
  if (format.bitsPerSample !== 16) {
    throw new Error(`Voice clip must be 16-bit: ${sourceLabel}`);
  }
  if (format.channels !== 1) {
    throw new Error(`Voice clip must be mono: ${sourceLabel}`);
  }
  if (format.sampleRate !== 22_050) {
    throw new Error(
      `Voice clip must use a 22050 Hz sample rate: ${sourceLabel}`,
    );
  }
  if (format.blockAlign !== 2 || format.byteRate !== 44_100) {
    throw new Error(
      `Voice clip has inconsistent PCM rate fields: ${sourceLabel}`,
    );
  }
  if (data.length % format.blockAlign !== 0) {
    throw new Error(`Voice clip data is not sample-aligned: ${sourceLabel}`);
  }

  const durationMs = Math.round((data.length / format.byteRate) * 1_000);
  if (durationMs < 1 || durationMs > MAX_VOICE_DURATION_MS) {
    throw new Error(
      `Voice clip duration must be between 1 and ${MAX_VOICE_DURATION_MS} ms: ${sourceLabel}`,
    );
  }

  const canonicalBytes = Buffer.alloc(44 + data.length);
  canonicalBytes.write("RIFF", 0, "ascii");
  canonicalBytes.writeUInt32LE(canonicalBytes.length - 8, 4);
  canonicalBytes.write("WAVE", 8, "ascii");
  canonicalBytes.write("fmt ", 12, "ascii");
  canonicalBytes.writeUInt32LE(16, 16);
  canonicalBytes.writeUInt16LE(1, 20);
  canonicalBytes.writeUInt16LE(1, 22);
  canonicalBytes.writeUInt32LE(22_050, 24);
  canonicalBytes.writeUInt32LE(44_100, 28);
  canonicalBytes.writeUInt16LE(2, 32);
  canonicalBytes.writeUInt16LE(16, 34);
  canonicalBytes.write("data", 36, "ascii");
  canonicalBytes.writeUInt32LE(data.length, 40);
  data.copy(canonicalBytes, 44);

  return { bytes: canonicalBytes, durationMs };
}
