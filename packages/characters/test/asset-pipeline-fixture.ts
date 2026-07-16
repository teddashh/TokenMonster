import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

export const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const PIPELINE_PATH = join(
  REPOSITORY_ROOT,
  "scripts",
  "asset-pipeline",
  "build-manifest.mjs",
);

export const SOLID_COLOR_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

export function createPcm16Wav({
  sampleRate = 22_050,
  channels = 1,
  frameCount = 441,
}: {
  sampleRate?: number;
  channels?: number;
  frameCount?: number;
} = {}): Buffer {
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataBytes = frameCount * blockAlign;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * blockAlign, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataBytes, 40);
  return wav;
}

export async function runPipeline(
  bank: string,
  out: string,
  persona: string,
  options: { voiceDir?: string } = {},
) {
  const arguments_ = [
    PIPELINE_PATH,
    "--allow-png-passthrough",
    "--out",
    out,
    "--personas",
    persona,
    "--themes",
    "tech",
  ];
  if (options.voiceDir !== undefined) {
    arguments_.push("--voice-dir", options.voiceDir);
  }
  const child = spawn(
    process.execPath,
    arguments_,
    {
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env,
        ASSET_BANK_DIR: bank,
        SOURCE_DATE_EPOCH: "1_700_000_000".replaceAll("_", ""),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return await new Promise<{
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => {
      resolveResult({ status, signal, stdout, stderr });
    });
  });
}
