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

export async function runPipeline(
  bank: string,
  out: string,
  persona: string,
) {
  const child = spawn(
    process.execPath,
    [
      PIPELINE_PATH,
      "--allow-png-passthrough",
      "--out",
      out,
      "--personas",
      persona,
      "--themes",
      "tech",
    ],
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
