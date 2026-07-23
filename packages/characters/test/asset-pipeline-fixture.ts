import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

export const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const PIPELINE_PATH = join(
  REPOSITORY_ROOT,
  "scripts",
  "asset-pipeline",
  "build-manifest.mjs",
);
const PROVENANCE_PATH = join(
  REPOSITORY_ROOT,
  "scripts",
  "asset-pipeline",
  "build-provenance.mjs",
);
const SOURCE_EVIDENCE_PREPARER_PATH = join(
  REPOSITORY_ROOT,
  "scripts",
  "asset-pipeline",
  "prepare-source-evidence.mjs",
);
const RIGHTS_LEDGER_PATH = join(
  REPOSITORY_ROOT,
  "scripts",
  "asset-pipeline",
  "prepare-rights-ledger.mjs",
);

export const SOLID_COLOR_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function imagePaths(root: string, directory = root): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await imagePaths(root, path)));
    } else if (entry.isFile() && /\.(?:jpe?g|png)$/iu.test(entry.name)) {
      paths.push(relative(root, path).split(sep).join("/"));
    }
  }
  return paths.sort();
}

export async function writeSourceEvidenceFixture(
  bank: string,
  receiptRoot: string,
  evidencePath: string,
) {
  const paths = await imagePaths(bank);
  const receiptDirectory = join(receiptRoot, "receipts");
  await mkdir(receiptDirectory, { recursive: true });
  const entries = [];
  for (const [index, path] of paths.entries()) {
    const sourceBytes = await readFile(join(bank, ...path.split("/")));
    const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
    const receiptPath = `receipts/source-${String(index).padStart(4, "0")}.json`;
    const receiptBytes = Buffer.from(
      `${JSON.stringify({ schemaVersion: "1", sourceSha256 })}\n`,
    );
    await writeFile(join(receiptRoot, ...receiptPath.split("/")), receiptBytes);
    entries.push({
      path,
      sha256: sourceSha256,
      upstream: {
        repository: {
          repositoryId: "test-source-repository",
          revision: "d".repeat(40),
        },
        steps: [
          {
            operation: "import",
            receipt: {
              path: receiptPath,
              sha256: createHash("sha256").update(receiptBytes).digest("hex"),
            },
            tool: { name: "fixture-importer", version: "1.0.0" },
            model: null,
            inputs: [],
            outputSha256: sourceSha256,
          },
        ],
      },
    });
  }
  const evidence = {
    schemaVersion: "1",
    inventoryId: "test-reviewed-inventory",
    entries,
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
}

export function createRiffChunk(id: string, payload: Buffer): Buffer {
  if (!/^[\x20-\x7e]{4}$/u.test(id)) {
    throw new Error(`Invalid fixture RIFF chunk ID: ${id}`);
  }
  const chunk = Buffer.alloc(8 + payload.length + (payload.length % 2));
  chunk.write(id, 0, "ascii");
  chunk.writeUInt32LE(payload.length, 4);
  payload.copy(chunk, 8);
  return chunk;
}

export function createWavFromChunks(chunks: readonly Buffer[]): Buffer {
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(header.length + body.length - 8, 4);
  header.write("WAVE", 8, "ascii");
  return Buffer.concat([header, body]);
}

export function createPcm16Wav({
  sampleRate = 22_050,
  channels = 1,
  frameCount = 441,
  sampleValues,
}: {
  sampleRate?: number;
  channels?: number;
  frameCount?: number;
  sampleValues?: readonly number[];
} = {}): Buffer {
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataBytes = frameCount * blockAlign;
  if (
    sampleValues !== undefined &&
    sampleValues.length !== frameCount * channels
  ) {
    throw new Error("Fixture sample count does not match its PCM dimensions");
  }

  const format = Buffer.alloc(16);
  format.writeUInt16LE(1, 0);
  format.writeUInt16LE(channels, 2);
  format.writeUInt32LE(sampleRate, 4);
  format.writeUInt32LE(sampleRate * blockAlign, 8);
  format.writeUInt16LE(blockAlign, 12);
  format.writeUInt16LE(16, 14);

  const data = Buffer.alloc(dataBytes);
  for (let index = 0; index < (sampleValues?.length ?? 0); index += 1) {
    const sample = sampleValues![index]!;
    if (!Number.isInteger(sample) || sample < -32_768 || sample > 32_767) {
      throw new Error(`Invalid fixture PCM16 sample: ${sample}`);
    }
    data.writeInt16LE(sample, index * bytesPerSample);
  }

  return createWavFromChunks([
    createRiffChunk("fmt ", format),
    createRiffChunk("data", data),
  ]);
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
  const child = spawn(process.execPath, arguments_, {
    cwd: REPOSITORY_ROOT,
    env: {
      ...process.env,
      ASSET_BANK_DIR: bank,
      SOURCE_DATE_EPOCH: "1_700_000_000".replaceAll("_", ""),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
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

export async function runBuildProvenance(
  bank: string,
  integrity: string,
  sourceEvidence: string,
  receiptRoot: string,
  out: string,
) {
  const child = spawn(
    process.execPath,
    [
      PROVENANCE_PATH,
      "--integrity",
      integrity,
      "--asset-bank",
      bank,
      "--inventory-id",
      "test-reviewed-inventory",
      "--source-evidence",
      sourceEvidence,
      "--receipt-root",
      receiptRoot,
      "--out",
      out,
    ],
    {
      cwd: REPOSITORY_ROOT,
      env: process.env,
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

export async function runPrepareSourceEvidence(
  options: Readonly<{
    integrity: string;
    bank: string;
    inventoryId?: string;
    repositoryId?: string;
    sourceRevision?: string;
    receiptRoot: string;
    out: string;
  }>,
) {
  const child = spawn(
    process.execPath,
    [
      SOURCE_EVIDENCE_PREPARER_PATH,
      "--integrity",
      options.integrity,
      "--asset-bank",
      options.bank,
      "--inventory-id",
      options.inventoryId ?? "test-reviewed-inventory",
      "--repository-id",
      options.repositoryId ?? "test-source-repository",
      "--source-revision",
      options.sourceRevision ?? "d".repeat(40),
      "--receipt-root",
      options.receiptRoot,
      "--out",
      options.out,
    ],
    {
      cwd: REPOSITORY_ROOT,
      env: process.env,
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

export async function runPrepareRightsLedger(
  buildProvenance: string,
  out: string,
) {
  const child = spawn(
    process.execPath,
    [
      RIGHTS_LEDGER_PATH,
      "--build-provenance",
      buildProvenance,
      "--release-id",
      "characters-test-release",
      "--out",
      out,
    ],
    {
      cwd: REPOSITORY_ROOT,
      env: process.env,
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
