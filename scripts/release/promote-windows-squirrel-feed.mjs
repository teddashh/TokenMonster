#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  executeWindowsSquirrelPromotion,
} from "./windows-squirrel-feed-executor-policy.mjs";
import {
  requireWindowsSquirrelCandidate,
  verifyPreparedWindowsSquirrelCandidate,
  WINDOWS_SQUIRREL_FULL_PACKAGE_MAX_BYTES,
  WINDOWS_SQUIRREL_RELEASES_MAX_BYTES,
} from "./windows-squirrel-promotion-policy.mjs";
import {
  classifyWranglerR2Get,
  requireExactWranglerVersionOutput,
} from "./wrangler-r2-get-policy.mjs";

const CDN_ORIGIN = "https://cdn.ted-h.com";
const COMMAND_TIMEOUT_MS = 180_000;
const EXECUTOR_DEADLINE_MS = 60 * 60 * 1_000;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1_024;
// Worst case includes commit response loss, authoritative readback, six public
// attempts, recovery GET, rollback mutation/readback, and public convergence.
// Their individual fences total below 23 minutes; keep 30 minutes reserved.
const METADATA_CRITICAL_WINDOW_MS = 30 * 60 * 1_000;
const WRANGLER_VERSION = "4.111.0";
const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      !["--prepared-dir", "--candidate", "--bucket"].includes(name) ||
      value === undefined ||
      value.startsWith("--") ||
      values.has(name)
    ) {
      throw new Error(
        "Usage: promote-windows-squirrel-feed.mjs --prepared-dir <dir> --candidate <file> --bucket <R2-bucket>",
      );
    }
    values.set(name, value);
  }
  if (values.size !== 3) {
    throw new Error(
      "Usage: promote-windows-squirrel-feed.mjs --prepared-dir <dir> --candidate <file> --bucket <R2-bucket>",
    );
  }
  const bucket = values.get("--bucket");
  if (
    typeof bucket !== "string" ||
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(bucket)
  ) {
    throw new Error("Windows release R2 bucket name is malformed");
  }
  return Object.freeze({
    preparedDirectory: resolve(values.get("--prepared-dir")),
    candidatePath: resolve(values.get("--candidate")),
    bucket,
  });
}

async function requireCanonicalCandidate(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Windows Squirrel candidate must be a physical file");
  }
  const text = await readFile(path, "utf8");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Windows Squirrel candidate must be valid JSON");
  }
  if (text !== `${JSON.stringify(value, null, 2)}\n`) {
    throw new Error("Windows Squirrel candidate JSON is not canonical");
  }
  return requireWindowsSquirrelCandidate(value);
}

async function digestFile(path, algorithm) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function observeFile(path, role, cacheControl = null) {
  const metadata = await lstat(path);
  const maximum =
    role === "releases"
      ? WINDOWS_SQUIRREL_RELEASES_MAX_BYTES
      : WINDOWS_SQUIRREL_FULL_PACKAGE_MAX_BYTES;
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    !Number.isSafeInteger(metadata.size) ||
    metadata.size < 1 ||
    metadata.size > maximum
  ) {
    throw new Error("Retrieved Squirrel object is not a bounded physical file");
  }
  const [sha256, sha1, contents] = await Promise.all([
    digestFile(path, "sha256"),
    role === "full-package" ? digestFile(path, "sha1") : null,
    role === "releases" ? readFile(path) : null,
  ]);
  return Object.freeze({
    state: "present",
    bytes: metadata.size,
    sha256,
    sha1,
    contents,
    cacheControl,
  });
}

function runBounded(command, arguments_, { cwd, deadline }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const remainingMs = deadline - Date.now();
    if (!Number.isSafeInteger(remainingMs) || remainingMs < 1) {
      rejectPromise(new Error("Squirrel promotion aggregate deadline expired"));
      return;
    }
    const child = spawn(command, arguments_, {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let exceeded = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, Math.min(COMMAND_TIMEOUT_MS, remainingMs));
    timeout.unref();
    const collect = (target, chunk, kind) => {
      if (exceeded) return;
      if (kind === "stdout") stdoutBytes += chunk.byteLength;
      else stderrBytes += chunk.byteLength;
      if (
        stdoutBytes > MAX_PROCESS_OUTPUT_BYTES ||
        stderrBytes > MAX_PROCESS_OUTPUT_BYTES
      ) {
        exceeded = true;
        child.kill("SIGKILL");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk, "stdout"));
    child.stderr.on("data", (chunk) => collect(stderr, chunk, "stderr"));
    child.on("error", () => {
      clearTimeout(timeout);
      rejectPromise(new Error("release command failed to start"));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (
        exceeded ||
        timedOut ||
        signal !== null ||
        !Number.isSafeInteger(code)
      ) {
        rejectPromise(new Error("release command returned an invalid result"));
        return;
      }
      resolvePromise(
        Object.freeze({
          exitCode: code,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        }),
      );
    });
  });
}

async function streamPublicObservation(response, role) {
  const cacheControl = response.headers.get("cache-control");
  if (response.body === null) {
    return Object.freeze({ state: "unknown" });
  }
  const maximum =
    role === "releases"
      ? WINDOWS_SQUIRREL_RELEASES_MAX_BYTES
      : WINDOWS_SQUIRREL_FULL_PACKAGE_MAX_BYTES;
  const sha256 = createHash("sha256");
  const sha1 = role === "full-package" ? createHash("sha1") : null;
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > maximum) {
      await response.body.cancel();
      return Object.freeze({ state: "unknown" });
    }
    sha256.update(chunk);
    sha1?.update(chunk);
    if (role === "releases") chunks.push(Buffer.from(chunk));
  }
  if (bytes < 1) return Object.freeze({ state: "unknown" });
  return Object.freeze({
    state: "present",
    bytes,
    sha256: sha256.digest("hex"),
    sha1: sha1?.digest("hex") ?? null,
    contents: role === "releases" ? Buffer.concat(chunks) : null,
    cacheControl,
  });
}

async function main() {
  const { preparedDirectory, candidatePath, bucket } = parseArguments(
    process.argv.slice(2),
  );
  for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
    const value = process.env[name];
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      /[\r\n]/u.test(value)
    ) {
      throw new Error("protected Cloudflare release credentials are unavailable");
    }
  }
  const candidate = await requireCanonicalCandidate(candidatePath);
  await verifyPreparedWindowsSquirrelCandidate(preparedDirectory, candidate);
  const releasesObject = candidate.objects.find(
    (object) => object.role === "releases",
  );
  const fullPackageObject = candidate.objects.find(
    (object) => object.role === "full-package",
  );
  if (releasesObject === undefined || fullPackageObject === undefined) {
    throw new Error("Windows Squirrel candidate object roles are incomplete");
  }
  const releasesPath = join(preparedDirectory, releasesObject.sourceFileName);
  const fullPackagePath = join(
    preparedDirectory,
    fullPackageObject.sourceFileName,
  );
  const [releasesObservation, fullPackageObservation] = await Promise.all([
    observeFile(releasesPath, "releases"),
    observeFile(fullPackagePath, "full-package"),
  ]);

  const wranglerDirectory = join(REPOSITORY_ROOT, "apps/web");
  const wranglerScript = join(
    REPOSITORY_ROOT,
    "node_modules/wrangler/bin/wrangler.js",
  );
  const wranglerMetadata = await lstat(wranglerScript);
  if (!wranglerMetadata.isFile() || wranglerMetadata.isSymbolicLink()) {
    throw new Error("repo-pinned Wrangler entry point is unavailable");
  }
  const workingDirectory = await mkdtemp(
    join(tmpdir(), "tokenmonster-squirrel-promotion-"),
  );
  const executionDeadline = Date.now() + EXECUTOR_DEADLINE_MS;
  let sequence = 0;
  try {
    const versionResult = await runBounded(
      process.execPath,
      [wranglerScript, "--version"],
      { cwd: wranglerDirectory, deadline: executionDeadline },
    );
    if (versionResult.exitCode !== 0 || versionResult.stderr !== "") {
      throw new Error("R2 publication requires pinned Wrangler 4.111.0");
    }
    requireExactWranglerVersionOutput(versionResult.stdout, WRANGLER_VERSION);

    const getR2 = async ({ key, role }) => {
      sequence += 1;
      const target = join(workingDirectory, `get-${sequence}`);
      const result = await runBounded(
        process.execPath,
        [
          wranglerScript,
          "r2",
          "object",
          "get",
          `${bucket}/${key}`,
          "--file",
          target,
          "--remote",
        ],
        { cwd: wranglerDirectory, deadline: executionDeadline },
      );
      let state;
      try {
        state = classifyWranglerR2Get(result.exitCode, result.stderr);
      } catch {
        return Object.freeze({ state: "unknown" });
      }
      if (state === "missing") return Object.freeze({ state: "missing" });
      try {
        return await observeFile(target, role);
      } catch {
        return Object.freeze({ state: "unknown" });
      }
    };

    const putR2 = async ({
      key,
      role,
      contentType,
      cacheControl,
      source,
      expectedSha256,
      expectedSha1,
      expectedBytes,
    }) => {
      let sourcePath;
      if (typeof source === "string") {
        sequence += 1;
        sourcePath = join(workingDirectory, `put-${sequence}`);
        await copyFile(source, sourcePath);
      } else if (
        role === "releases" &&
        source !== null &&
        typeof source === "object" &&
        source.kind === "inline-releases" &&
        source.contents instanceof Uint8Array
      ) {
        sequence += 1;
        sourcePath = join(workingDirectory, `rollback-${sequence}`);
        await writeFile(sourcePath, source.contents, {
          flag: "wx",
          mode: 0o600,
        });
      } else {
        throw new Error("Squirrel R2 write source is malformed");
      }
      const sourceObservation = await observeFile(sourcePath, role);
      if (
        sourceObservation.sha256 !== expectedSha256 ||
        sourceObservation.sha1 !== expectedSha1 ||
        sourceObservation.bytes !== expectedBytes
      ) {
        throw new Error("Squirrel R2 write source changed after verification");
      }
      const result = await runBounded(
        process.execPath,
        [
          wranglerScript,
          "r2",
          "object",
          "put",
          `${bucket}/${key}`,
          "--file",
          sourcePath,
          "--content-type",
          contentType,
          "--cache-control",
          cacheControl,
          "--force",
          "--remote",
        ],
        { cwd: wranglerDirectory, deadline: executionDeadline },
      );
      if (result.exitCode !== 0) {
        throw new Error("authoritative Squirrel R2 write failed");
      }
    };

    const deleteR2 = async ({ key }) => {
      const result = await runBounded(
        process.execPath,
        [
          wranglerScript,
          "r2",
          "object",
          "delete",
          `${bucket}/${key}`,
          "--force",
          "--remote",
        ],
        { cwd: wranglerDirectory, deadline: executionDeadline },
      );
      if (result.exitCode !== 0) {
        throw new Error("authoritative Squirrel R2 rollback delete failed");
      }
    };

    const getPublic = async ({ key, role }) => {
      try {
        const remainingMs = executionDeadline - Date.now();
        if (!Number.isSafeInteger(remainingMs) || remainingMs < 1) {
          return Object.freeze({ state: "unknown" });
        }
        const response = await fetch(`${CDN_ORIGIN}/${key}`, {
          cache: "no-store",
          redirect: "manual",
          headers: Object.freeze({
            Accept: "application/octet-stream",
            "Cache-Control": "no-cache",
          }),
          signal: AbortSignal.timeout(Math.min(30_000, remainingMs)),
        });
        if (response.status === 404) {
          await response.body?.cancel();
          return Object.freeze({ state: "missing" });
        }
        if (response.status !== 200) {
          await response.body?.cancel();
          return Object.freeze({ state: "unknown" });
        }
        return await streamPublicObservation(response, role);
      } catch {
        return Object.freeze({ state: "unknown" });
      }
    };

    const evidence = await executeWindowsSquirrelPromotion({
      candidate,
      candidateSources: Object.freeze({
        releases: Object.freeze({
          source: releasesPath,
          observation: releasesObservation,
        }),
        fullPackage: Object.freeze({
          source: fullPackagePath,
          observation: fullPackageObservation,
        }),
      }),
      getR2,
      putR2,
      deleteR2,
      getPublic,
      publicReadAttempts: 6,
      wait: () => {
        if (executionDeadline - Date.now() < 5_000) {
          throw new Error("Squirrel promotion aggregate deadline expired");
        }
        return new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
      },
      executionDeadline,
      minimumMetadataWindowMs: METADATA_CRITICAL_WINDOW_MS,
    });
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  } finally {
    await rm(workingDirectory, { force: true, recursive: true });
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown failure";
  process.stderr.write(`Windows Squirrel feed promotion failed: ${message}\n`);
  process.exitCode = 1;
}
