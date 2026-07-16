#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BOOTSTRAP_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;
const BOOTSTRAP_URL_PATTERN = /http:\/\/127\.0\.0\.1:\d+\/\S+/u;
const SESSION_COOKIE_PATTERN =
  /(?:^|;\s*)tokenmonster_session=([A-Za-z0-9_-]+)(?:;|$)/u;

function step(name, detail) {
  console.log(`SMOKE ${name}: PASS${detail === undefined ? "" : ` (${detail})`}`);
}

function fail(message) {
  throw new Error(message);
}

function waitForBootstrapUrl(child, captured) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      console.error("SMOKE bootstrap stdout on timeout:");
      console.error(captured.stdout.length === 0 ? "(empty)" : captured.stdout);
      console.error("SMOKE bootstrap stderr on timeout:");
      console.error(captured.stderr.length === 0 ? "(empty)" : captured.stderr);
      finish(reject, new Error("bootstrap URL was not emitted within 120s"));
    }, BOOTSTRAP_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      captured.stdout += chunk;
      const match = captured.stdout.match(BOOTSTRAP_URL_PATTERN);
      if (match !== null) finish(resolve, match[0]);
    });
    child.stderr.on("data", (chunk) => {
      captured.stderr += chunk;
    });
    child.once("error", () => {
      finish(reject, new Error("installed binary could not be spawned"));
    });
    child.once("exit", (code, signal) => {
      const result = signal === null ? `code ${code ?? "unknown"}` : `signal ${signal}`;
      finish(
        reject,
        new Error(`installed binary exited before bootstrap URL (${result})`),
      );
    });
  });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

async function stopChild(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  if (await waitForExit(child, SHUTDOWN_TIMEOUT_MS)) return;
  child.kill("SIGKILL");
  throw new Error("installed binary did not exit within the 15s shutdown grace");
}

async function getJson(response, label) {
  try {
    return await response.json();
  } catch {
    fail(`${label} did not return valid JSON`);
  }
}

async function request(url, options, label) {
  try {
    return await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    fail(`${label} request failed`);
  }
}

async function runSmoke(installDirectory, isolatedHome) {
  const binary = join(
    installDirectory,
    "node_modules",
    "tokenmonster",
    "dist",
    "bin.js",
  );
  const captured = { stdout: "", stderr: "" };
  const child = spawn(
    process.execPath,
    [binary, "--no-open", "--no-character-downloads"],
    {
      env: {
        ...process.env,
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );

  let failure;
  try {
    const bootstrapUrl = await waitForBootstrapUrl(child, captured);
    step("launch", "bootstrap URL captured");

    const bootstrapResponse = await request(
      bootstrapUrl,
      { redirect: "manual" },
      "bootstrap",
    );
    if (bootstrapResponse.status !== 303) {
      fail(`bootstrap returned HTTP ${bootstrapResponse.status}, expected 303`);
    }
    const setCookie = bootstrapResponse.headers.get("set-cookie");
    const cookieMatch = setCookie?.match(SESSION_COOKIE_PATTERN) ?? null;
    await bootstrapResponse.body?.cancel();
    if (cookieMatch === null) {
      fail("bootstrap did not set the tokenmonster_session cookie");
    }
    const cookie = `tokenmonster_session=${cookieMatch[1]}`;
    const origin = new URL(bootstrapUrl).origin;
    step("bootstrap", `HTTP ${bootstrapResponse.status}, session cookie captured`);

    const statusResponse = await request(
      `${origin}/api/companion/status`,
      { headers: { Cookie: cookie } },
      "companion status",
    );
    if (statusResponse.status !== 200) {
      fail(`companion status returned HTTP ${statusResponse.status}, expected 200`);
    }
    const status = await getJson(statusResponse, "companion status");
    if (
      status === null ||
      typeof status !== "object" ||
      typeof status.phase !== "string"
    ) {
      fail("companion status JSON did not contain a string phase field");
    }
    step("companion status", `HTTP ${statusResponse.status}, phase is a string`);

    const charactersResponse = await request(
      `${origin}/api/characters`,
      { headers: { Cookie: cookie } },
      "characters",
    );
    if (charactersResponse.status !== 200) {
      fail(`characters returned HTTP ${charactersResponse.status}, expected 200`);
    }
    const characters = await getJson(charactersResponse, "characters");
    if (
      characters === null ||
      typeof characters !== "object" ||
      !Array.isArray(characters.characters) ||
      characters.characters.length !== 11
    ) {
      fail("characters JSON did not contain exactly 11 characters");
    }
    step("characters", `HTTP ${charactersResponse.status}, 11 characters`);

    const missingAssetResponse = await request(
      `${origin}/assets/characters/objects/${"0".repeat(64)}.webp`,
      { headers: { Cookie: cookie } },
      "unknown character asset",
    );
    const missingAssetStatus = missingAssetResponse.status;
    await missingAssetResponse.body?.cancel();
    if (missingAssetStatus !== 404) {
      fail(`unknown character asset returned HTTP ${missingAssetStatus}, expected 404`);
    }
    step("unknown character asset", `HTTP ${missingAssetStatus}`);

    const anonymousResponse = await request(
      `${origin}/api/characters`,
      {},
      "anonymous characters",
    );
    const anonymousStatus = anonymousResponse.status;
    await anonymousResponse.body?.cancel();
    if (anonymousStatus !== 404) {
      fail(`anonymous characters returned HTTP ${anonymousStatus}, expected 404`);
    }
    step("anonymous characters", `HTTP ${anonymousStatus}`);
  } catch (error) {
    failure = error;
  }

  try {
    await stopChild(child);
    step("shutdown", "child exited");
  } catch (error) {
    failure ??= error;
  }

  if (failure !== undefined) throw failure;
}

const installDirectory = process.argv[2];
if (process.argv.length !== 3 || installDirectory === undefined) {
  console.error("SMOKE usage: node scripts/release/smoke-installed.mjs <install-dir>");
  process.exit(1);
}

let isolatedHome;
let failure;
try {
  isolatedHome = await mkdtemp(join(tmpdir(), "tokenmonster-release-smoke-"));
  step("isolated home", "HOME and USERPROFILE isolated");
  await runSmoke(installDirectory, isolatedHome);
} catch (error) {
  failure = error;
} finally {
  if (isolatedHome !== undefined) {
    await rm(isolatedHome, { recursive: true, force: true });
  }
}

if (failure !== undefined) {
  const message = failure instanceof Error ? failure.message : "unknown failure";
  console.error(`SMOKE FAIL: ${message}`);
  process.exit(1);
}

console.log("SMOKE RESULT: PASS");
process.exit(0);
