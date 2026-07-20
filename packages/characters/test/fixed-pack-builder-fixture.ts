import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const FIXED_PACK_BUILDER_PATH = join(
  REPOSITORY_ROOT,
  "scripts",
  "asset-pipeline",
  "build-fixed-pack.mjs",
);

export async function runFixedPackBuilder(
  releaseManifest: string,
  assetRoot: string,
  out: string,
) {
  const child = spawn(
    process.execPath,
    [
      FIXED_PACK_BUILDER_PATH,
      "--release-manifest",
      releaseManifest,
      "--asset-root",
      assetRoot,
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
