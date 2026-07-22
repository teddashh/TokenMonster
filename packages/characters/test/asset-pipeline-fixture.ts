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
