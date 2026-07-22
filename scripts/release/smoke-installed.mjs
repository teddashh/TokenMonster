#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertSidecarClosuresMatch,
  packageNameFromLockPath,
} from "./sidecar-lock.mjs";
import { requireDisabledRemoteLimitsResponse } from "./smoke-installed-policy.mjs";
import { PUBLIC_EMBEDDED_STARTER_ASSETS } from "./public-artifact-policy.mjs";
import { verifyInstalledZstdNative } from "./zstd-native-verifier.mjs";

const BOOTSTRAP_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;
const BOOTSTRAP_URL_PATTERN = /http:\/\/127\.0\.0\.1:\d+\/\S+/u;
const SESSION_COOKIE_PATTERN =
  /(?:^|;\s*)tokenmonster_session=([A-Za-z0-9_-]+)(?:;|$)/u;
const EXPECTED_ASSET_RELEASE_ID = "ai-sister-images-11-2026.07.21";
const EXPECTED_ASSET_PACK_BYTES = 65_574_180;
const DEFAULT_UNAVAILABLE_CONTRIBUTION_STATUS = Object.freeze({
  status: "ok",
  availability: "unavailable",
  unavailableReason: "secure-storage-unavailable",
  secureStorage: "unavailable",
  state: "unavailable",
  enabled: false,
  canPreview: false,
  canStop: false,
  canDelete: false,
  canRecover: false,
  outboxPending: 0,
  deletionStatus: null,
  anonymousHistoricalTotalsRetained: null,
});

function step(name, detail) {
  console.log(
    `SMOKE ${name}: PASS${detail === undefined ? "" : ` (${detail})`}`,
  );
}

function fail(message) {
  throw new Error(message);
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail(`${label} is missing or invalid`);
  }
}

function hasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value)) === JSON.stringify(keys)
  );
}

function isDefaultUnavailableContributionStatus(value) {
  return (
    hasExactKeys(value, Object.keys(DEFAULT_UNAVAILABLE_CONTRIBUTION_STATUS)) &&
    JSON.stringify(value) ===
      JSON.stringify(DEFAULT_UNAVAILABLE_CONTRIBUTION_STATUS)
  );
}

function isUtcDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
  const instant = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(instant.getTime()) &&
    instant.toISOString().slice(0, 10) === value
  );
}

function isIsoInstantWithMilliseconds(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  ) {
    return false;
  }
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) && instant.toISOString() === value;
}

const CLEAN_LEARNING_PROFILE_REASONS = [
  {
    subject: "identity",
    reasonCode: "IDENTITY_LEARNING_COVERAGE_28D",
    templateId: "monster.identity.learning.v1",
    inputs: [
      {
        metric: "observed-days",
        valueBand: "insufficient",
        coverage: "insufficient",
      },
      {
        metric: "active-days",
        valueBand: "insufficient",
        coverage: "insufficient",
      },
    ],
  },
  {
    subject: "mood",
    reasonCode: "MOOD_LEARNING_COVERAGE_28D",
    templateId: "monster.mood.learning.v1",
    inputs: [
      {
        metric: "relative-daily-activity",
        valueBand: "insufficient",
        coverage: "insufficient",
      },
    ],
  },
  {
    subject: "evolution",
    reasonCode: "EVOLUTION_AWAITING_COVERAGE",
    templateId: "monster.evolution.awaitingCoverage.v1",
    inputs: [
      {
        metric: "trait-structure",
        valueBand: "insufficient",
        coverage: "insufficient",
      },
    ],
  },
];

function isCleanLearningCharacterProfile(value) {
  if (
    !hasExactKeys(value, [
      "status",
      "schemaVersion",
      "generatedAt",
      "freshness",
      "dataQuality",
      "window",
      "identity",
      "mood",
      "evolution",
      "reasons",
    ]) ||
    value.status !== "ok" ||
    value.schemaVersion !== "1" ||
    !isIsoInstantWithMilliseconds(value.generatedAt) ||
    value.freshness !== "fresh" ||
    value.dataQuality !== "estimated-positive-days" ||
    !hasExactKeys(value.window, ["fromUtcDate", "toUtcDate", "timezone"]) ||
    !isUtcDate(value.window.fromUtcDate) ||
    !isUtcDate(value.window.toUtcDate) ||
    value.window.timezone !== "UTC" ||
    value.generatedAt.slice(0, 10) !== value.window.toUtcDate ||
    Date.parse(`${value.window.toUtcDate}T00:00:00.000Z`) -
      Date.parse(`${value.window.fromUtcDate}T00:00:00.000Z`) !==
      27 * 86_400_000 ||
    !hasExactKeys(value.identity, [
      "status",
      "coverageBand",
      "provisional",
      "traitIds",
    ]) ||
    value.identity.status !== "learning" ||
    value.identity.coverageBand !== "insufficient" ||
    value.identity.provisional !== false ||
    !Array.isArray(value.identity.traitIds) ||
    value.identity.traitIds.length !== 0 ||
    !hasExactKeys(value.mood, ["id", "energyBand"]) ||
    value.mood.id !== "learning" ||
    value.mood.energyBand !== "dormant" ||
    !hasExactKeys(value.evolution, ["cadence", "event"]) ||
    value.evolution.cadence !== "event" ||
    value.evolution.event !== "awaiting-coverage"
  ) {
    return false;
  }
  return (
    JSON.stringify(value.reasons) ===
    JSON.stringify(CLEAN_LEARNING_PROFILE_REASONS)
  );
}

async function verifyInstalledSidecarClosure(installDirectory) {
  const tokenMonsterRoot = join(
    installDirectory,
    "node_modules",
    "tokenmonster",
  );
  const releaseManifest = await readJson(
    join(tokenMonsterRoot, "package.json"),
    "installed tokenmonster package manifest",
  );
  const shrinkwrap = await readJson(
    join(tokenMonsterRoot, "npm-shrinkwrap.json"),
    "installed tokenmonster shrinkwrap",
  );
  const installedLock = await readJson(
    join(installDirectory, "package-lock.json"),
    "install-directory package lock",
  );
  const sidecarPin = releaseManifest?.dependencies?.["tokentracker-cli"];
  if (typeof sidecarPin !== "string") {
    fail("installed tokenmonster manifest has no exact sidecar pin");
  }

  let closure;
  try {
    closure = assertSidecarClosuresMatch({
      expectedLock: shrinkwrap,
      actualLock: installedLock,
      actualParentPath: "node_modules/tokenmonster",
      sidecarPin,
    });
  } catch (error) {
    fail(
      error instanceof Error ? error.message : "sidecar closure check failed",
    );
  }

  for (const identity of closure) {
    const packageRoot = join(installDirectory, ...identity.path.split("/"));
    const metadata = await lstat(packageRoot).catch(() => null);
    if (
      metadata === null ||
      !metadata.isDirectory() ||
      metadata.isSymbolicLink()
    ) {
      fail(`installed sidecar package is missing or linked: ${identity.name}`);
    }
    const manifest = await readJson(
      join(packageRoot, "package.json"),
      `installed ${identity.name} package manifest`,
    );
    if (
      packageNameFromLockPath(identity.path) !== identity.name ||
      manifest?.name !== identity.name ||
      manifest?.version !== identity.version
    ) {
      fail(`installed sidecar package identity mismatch: ${identity.name}`);
    }
  }
  step(
    "sidecar closure",
    `${closure.length} exact registry packages match shrinkwrap integrity records`,
  );
  return Object.freeze({ closure, releaseManifest, tokenMonsterRoot });
}

function verifyInstalledCliVersion(binary, releaseManifest, environment) {
  const version = releaseManifest?.version;
  if (
    typeof version !== "string" ||
    version.length < 1 ||
    version.length > 64 ||
    version.includes("\0")
  ) {
    fail("installed tokenmonster manifest has no valid release version");
  }
  const result = spawnSync(process.execPath, [binary, "--version"], {
    encoding: "utf8",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
    windowsHide: true,
  });
  if (
    result.error !== undefined ||
    result.status !== 0 ||
    result.signal !== null ||
    result.stdout !== `v${version}\n` ||
    result.stderr !== ""
  ) {
    fail("installed CLI --version differs from its staged package manifest");
  }
  step("release version", `CLI and package manifest agree on ${version}`);
}

async function verifyInstalledPlayerFeatureArtifacts(tokenMonsterRoot) {
  const featureFiles = [
    {
      path: join(tokenMonsterRoot, "dist", "cli.js"),
      markers: ["createMemorySecretSlot", "byok: createMemorySecretSlot()"],
    },
    {
      path: join(tokenMonsterRoot, "dist", "contribution-host.js"),
      markers: [
        "TOKENMONSTER_CONTRIBUTION_API_ORIGIN",
        '"contribution-v2.sqlite"',
        "createContributionSyncScheduler",
      ],
    },
    {
      path: join(
        tokenMonsterRoot,
        "node_modules",
        "@tokenmonster",
        "secret-vault",
        "dist",
        "memory-vault.js",
      ),
      markers: ["createMemorySecretSlot", 'persistence: "memory-only"'],
    },
    {
      path: join(
        tokenMonsterRoot,
        "node_modules",
        "@tokenmonster",
        "byok-openai",
        "dist",
        "adapter.js",
      ),
      markers: ["background: false", "store: false"],
    },
    {
      path: join(
        tokenMonsterRoot,
        "node_modules",
        "@tokenmonster",
        "byok-openai",
        "dist",
        "constants.js",
      ),
      markers: ["OPENAI_BYOK_MODELS", '"gpt-5.6-luna"'],
    },
    {
      path: join(
        tokenMonsterRoot,
        "node_modules",
        "@tokenmonster",
        "companion-ui",
        "dist",
        "public",
        "index.html",
      ),
      markers: [
        "data-character-profile",
        "data-character-tap-hint",
        "data-share-card-hide-total",
        "data-contribution-control",
        "data-contribution-preview-payload",
        "data-contribution-confirm-enable",
      ],
    },
    {
      path: join(
        tokenMonsterRoot,
        "node_modules",
        "@tokenmonster",
        "companion-ui",
        "dist",
        "public",
        "contribution-control.js",
      ),
      markers: [
        '"/api/contribution/status"',
        '"enable-anonymous-contribution"',
        "startContributionControl",
      ],
    },
    {
      path: join(
        tokenMonsterRoot,
        "node_modules",
        "@tokenmonster",
        "companion-ui",
        "dist",
        "public",
        "main.js",
      ),
      markers: [
        "createCharacterProfileRequestGate",
        "requestCharacterInteraction",
      ],
    },
    {
      path: join(
        tokenMonsterRoot,
        "node_modules",
        "@tokenmonster",
        "companion-ui",
        "dist",
        "public",
        "share-card.js",
      ),
      markers: ["tokenmonster-local-share-card.png"],
    },
    {
      path: join(
        tokenMonsterRoot,
        "node_modules",
        "@tokenmonster",
        "companion-gateway",
        "dist",
        "byok-service.js",
      ),
      markers: [
        "MAX_BYOK_HISTORY_MESSAGES",
        "DEFAULT_OPENAI_BYOK_MODEL",
        "currentUserMessage",
      ],
    },
    {
      path: join(
        tokenMonsterRoot,
        "node_modules",
        "@tokenmonster",
        "companion-gateway",
        "dist",
        "character-service.js",
      ),
      markers: ["LETTER_WARDROBE_CATALOG", "selectTapLine"],
    },
    {
      path: join(
        tokenMonsterRoot,
        "node_modules",
        "@tokenmonster",
        "companion-gateway",
        "dist",
        "contribution-control.js",
      ),
      markers: [
        "prepareCompanionContributionPreview",
        "runCompanionContributionAction",
        '"runtime-unavailable"',
      ],
    },
    {
      path: join(
        tokenMonsterRoot,
        "node_modules",
        "@tokenmonster",
        "companion-gateway",
        "dist",
        "character-profile-service.js",
      ),
      markers: ["CHARACTER_PROFILE_FILE", "deriveMonsterState"],
    },
    {
      path: join(
        tokenMonsterRoot,
        "node_modules",
        "@tokenmonster",
        "characters",
        "dist",
        "letter-wardrobe.js",
      ),
      markers: ["LETTER_WARDROBE_CATALOG", "festival"],
    },
    {
      path: join(
        tokenMonsterRoot,
        "node_modules",
        "@tokenmonster",
        "characters",
        "dist",
        "tap-lines.js",
      ),
      markers: ["tokenmonster-friend-tap-lines-v1", "selectTapLine"],
    },
    {
      path: join(
        tokenMonsterRoot,
        "node_modules",
        "@tokenmonster",
        "monster-engine",
        "dist",
        "schemas.js",
      ),
      markers: ["IDENTITY_LEARNING_EVIDENCE_28D"],
    },
    {
      path: join(
        tokenMonsterRoot,
        "node_modules",
        "@tokenmonster",
        "contribution-runtime",
        "dist",
        "contribution-service.js",
      ),
      markers: [
        "createContributionService",
        "CONTRIBUTION_CREDENTIAL_OPERATION_TIMEOUT_MS",
        '"deletion-status-updated"',
      ],
    },
    {
      path: join(
        tokenMonsterRoot,
        "node_modules",
        "@tokenmonster",
        "contribution-runtime",
        "dist",
        "credential-host.js",
      ),
      markers: [
        "createContributionCredentialHost",
        '"contribution-upload.vault.json"',
        '"contribution-enrollment-pending.vault.json"',
      ],
    },
  ];
  for (const feature of featureFiles) {
    const metadata = await lstat(feature.path).catch(() => null);
    if (
      metadata === null ||
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size < 1 ||
      metadata.size > 4 * 1_024 * 1_024
    ) {
      fail(
        `installed player feature artifact is missing or invalid: ${feature.path}`,
      );
    }
    const contents = await readFile(feature.path, "utf8");
    const missingMarker = feature.markers.find(
      (marker) => !contents.includes(marker),
    );
    if (missingMarker !== undefined) {
      fail(
        `installed player feature artifact is stale: ${feature.path} lacks ${JSON.stringify(missingMarker)}`,
      );
    }
  }
  step(
    "player feature artifacts",
    `${featureFiles.length} compiled UI, character, and profile files are current`,
  );
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function createHermeticSmokeEnvironment(isolatedHome, pathOverride) {
  const configDirectory = join(isolatedHome, "config");
  const cacheDirectory = join(isolatedHome, "cache");
  const dataDirectory = join(isolatedHome, "data");
  const stateDirectory = join(isolatedHome, "state");
  const appDataDirectory = join(isolatedHome, "appdata");
  const localAppDataDirectory = join(isolatedHome, "local-appdata");
  const temporaryDirectory = join(isolatedHome, "tmp");
  await Promise.all(
    [
      configDirectory,
      cacheDirectory,
      dataDirectory,
      stateDirectory,
      appDataDirectory,
      localAppDataDirectory,
      temporaryDirectory,
    ].map((directory) => mkdir(directory, { recursive: true })),
  );

  const environment = {
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    XDG_CONFIG_HOME: configDirectory,
    XDG_CACHE_HOME: cacheDirectory,
    XDG_DATA_HOME: dataDirectory,
    XDG_STATE_HOME: stateDirectory,
    APPDATA: appDataDirectory,
    LOCALAPPDATA: localAppDataDirectory,
    TMPDIR: temporaryDirectory,
    TMP: temporaryDirectory,
    TEMP: temporaryDirectory,
    PATH:
      pathOverride ??
      (process.platform === "win32"
        ? ""
        : ["/usr/bin", "/bin"].join(delimiter)),
    NO_COLOR: "1",
  };
  for (const key of [
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "ComSpec",
    "COMSPEC",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
  ]) {
    const value = process.env[key];
    if (
      typeof value === "string" &&
      value.length > 0 &&
      !value.includes("\0")
    ) {
      environment[key] = value;
    }
  }
  return Object.freeze(environment);
}

async function createNativeEgressFixture(isolatedHome) {
  const directory = join(isolatedHome, "native-helper-fixture");
  const marker = join(isolatedHome, "native-helper-was-invoked");
  await mkdir(directory, { recursive: true });
  if (process.platform === "win32") {
    await writeFile(
      join(directory, "kiro-cli.cmd"),
      `@echo off\r\n>"${marker}" echo invoked\r\nexit /b 97\r\n`,
      "utf8",
    );
  } else {
    const helper = join(directory, "kiro-cli");
    await writeFile(
      helper,
      [
        "#!/usr/bin/python3",
        "import pathlib",
        "import socket",
        `pathlib.Path(${JSON.stringify(marker)}).write_text("invoked", encoding="utf-8")`,
        "sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)",
        "sock.setblocking(False)",
        'sock.connect_ex(("198.51.100.1", 9))',
        "sock.close()",
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o700 },
    );
    await chmod(helper, 0o700);
  }
  return Object.freeze({
    marker,
    path:
      process.platform === "win32"
        ? directory
        : [directory, "/usr/bin", "/bin"].join(delimiter),
  });
}

async function proveRemoteHelperSuppression(installDirectory, isolatedHome) {
  const tokenMonsterRoot = join(
    installDirectory,
    "node_modules",
    "tokenmonster",
  );
  const runtimeEntry = join(
    tokenMonsterRoot,
    "node_modules",
    "@tokenmonster",
    "token-tracker-runtime",
    "dist",
    "index.js",
  );
  const adapterEntry = join(
    tokenMonsterRoot,
    "node_modules",
    "@tokenmonster",
    "token-tracker-adapter",
    "dist",
    "index.js",
  );
  const [{ startManagedTokenTracker }, { createTokenTrackerAdapter }] =
    await Promise.all([
      import(pathToFileURL(runtimeEntry).href),
      import(pathToFileURL(adapterEntry).href),
    ]);
  if (
    typeof startManagedTokenTracker !== "function" ||
    typeof createTokenTrackerAdapter !== "function"
  ) {
    fail("installed runtime capability probe could not load exact APIs");
  }

  const fixture = await createNativeEgressFixture(isolatedHome);
  const sourceEnvironment = await createHermeticSmokeEnvironment(
    isolatedHome,
    fixture.path,
  );
  let runtime;
  let failure;
  try {
    runtime = await startManagedTokenTracker({
      readinessProbe: async (baseUrl, signal) => {
        if (signal.aborted) throw new Error("aborted");
        await createTokenTrackerAdapter({ baseUrl }).probe();
      },
      dataAvailabilityProbe: () => false,
      refreshIntervalMs: false,
      sourceEnvironment,
    });
    const response = await request(
      `${runtime.baseUrl}/functions/tokentracker-usage-limits?refresh=1`,
      { redirect: "manual" },
      "disabled upstream remote-limits capability",
    );
    const status = response.status;
    if (await exists(fixture.marker)) {
      fail("upstream remote-limits drill launched a native provider helper");
    }
    const body = await getJson(
      response,
      "disabled upstream remote-limits capability",
    );
    if (await exists(fixture.marker)) {
      fail("upstream remote-limits drill launched a native provider helper");
    }
    const outcome = requireDisabledRemoteLimitsResponse({
      body,
      platform: process.platform,
      status,
    });
    step(
      "remote helper suppression",
      outcome === "macos-native-helper-blocked"
        ? "exact macOS native helper probe remained fail-closed"
        : "active upstream limits route could not launch the PATH canary",
    );
  } catch (error) {
    failure = error;
  }
  try {
    await runtime?.stop();
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) throw failure;
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
      const result =
        signal === null ? `code ${code ?? "unknown"}` : `signal ${signal}`;
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
  throw new Error(
    "installed binary did not exit within the 15s shutdown grace",
  );
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

async function requireEmbeddedStarterImage(
  origin,
  cookie,
  path,
  expected,
  label,
) {
  const response = await request(
    `${origin}${path}`,
    { headers: { Cookie: cookie } },
    label,
  );
  if (
    response.status !== 200 ||
    response.headers.get("content-type") !== "image/webp"
  ) {
    fail(`${label} did not return an embedded WebP`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (
    bytes.length !== expected.bytes ||
    bytes.subarray(0, 4).toString("ascii") !== "RIFF" ||
    bytes.subarray(8, 12).toString("ascii") !== "WEBP" ||
    createHash("sha256").update(bytes).digest("hex") !== expected.sha256
  ) {
    fail(`${label} bytes differed from the reviewed embedded asset`);
  }
}

async function verifyInstalledEmbeddedStarterAssets(tokenMonsterRoot) {
  const objectDirectory = join(
    tokenMonsterRoot,
    "node_modules",
    "@tokenmonster",
    "characters",
    "dist",
    "embedded-starter-assets",
  );
  let totalBytes = 0;
  for (const expected of PUBLIC_EMBEDDED_STARTER_ASSETS) {
    const path = join(objectDirectory, ...expected.objectPath.split("/"));
    const metadata = await lstat(path).catch(() => null);
    if (
      metadata === null ||
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.size !== expected.bytes
    ) {
      fail(`installed embedded starter asset is missing or invalid: ${path}`);
    }
    const bytes = await readFile(path);
    if (
      bytes.subarray(0, 4).toString("ascii") !== "RIFF" ||
      bytes.subarray(8, 12).toString("ascii") !== "WEBP" ||
      createHash("sha256").update(bytes).digest("hex") !== expected.sha256
    ) {
      fail(`installed embedded starter asset bytes differ: ${path}`);
    }
    totalBytes += bytes.length;
  }
  step(
    "embedded starter inventory",
    `${PUBLIC_EMBEDDED_STARTER_ASSETS.length} exact WebPs, ${totalBytes} bytes`,
  );
}

async function postJson(origin, cookie, path, body, label) {
  return request(
    `${origin}${path}`,
    {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    label,
  );
}

async function runSmoke(installDirectory, isolatedHome) {
  const { closure, releaseManifest, tokenMonsterRoot } =
    await verifyInstalledSidecarClosure(installDirectory);
  const sidecarIdentities = closure.filter(
    ({ name }) => name === "tokentracker-cli",
  );
  const zstdIdentities = closure.filter(
    ({ name }) => name === "@mongodb-js/zstd",
  );
  if (sidecarIdentities.length !== 1 || zstdIdentities.length !== 1) {
    fail("installed sidecar closure has an ambiguous zstd package chain");
  }
  let nativeEvidence;
  try {
    nativeEvidence = await verifyInstalledZstdNative({
      sidecarPackageDirectory: join(
        installDirectory,
        ...sidecarIdentities[0].path.split("/"),
      ),
      zstdPackageDirectory: join(
        installDirectory,
        ...zstdIdentities[0].path.split("/"),
      ),
    });
  } catch (error) {
    fail(
      error instanceof Error
        ? error.message
        : "installed zstd native verification failed",
    );
  }
  step(
    "zstd native prebuild",
    `${nativeEvidence.platformKey}, ${nativeEvidence.bindingBytes} authenticated bytes`,
  );
  const smokeEnvironment = await createHermeticSmokeEnvironment(isolatedHome);
  const progressionDirectory = join(isolatedHome, ".tokenmonster");
  const staleStoreLock = join(progressionDirectory, "progression-v1.json.lock");
  await mkdir(progressionDirectory, { recursive: true, mode: 0o700 });
  await writeFile(staleStoreLock, "", { flag: "wx", mode: 0o600 });
  const staleLockTime = new Date(Date.now() - 60_000);
  await utimes(staleStoreLock, staleLockTime, staleLockTime);
  const binary = join(tokenMonsterRoot, "dist", "bin.js");
  verifyInstalledCliVersion(binary, releaseManifest, smokeEnvironment);
  await verifyInstalledPlayerFeatureArtifacts(tokenMonsterRoot);
  await verifyInstalledEmbeddedStarterAssets(tokenMonsterRoot);
  const captured = { stdout: "", stderr: "" };
  const child = spawn(process.execPath, [binary, "--no-open"], {
    env: smokeEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

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
    step(
      "bootstrap",
      `HTTP ${bootstrapResponse.status}, session cookie captured`,
    );

    const statusResponse = await request(
      `${origin}/api/companion/status`,
      { headers: { Cookie: cookie } },
      "companion status",
    );
    if (statusResponse.status !== 200) {
      fail(
        `companion status returned HTTP ${statusResponse.status}, expected 200`,
      );
    }
    const status = await getJson(statusResponse, "companion status");
    if (
      status === null ||
      typeof status !== "object" ||
      typeof status.phase !== "string"
    ) {
      fail("companion status JSON did not contain a string phase field");
    }
    step(
      "companion status",
      `HTTP ${statusResponse.status}, phase is a string`,
    );

    const contributionStatusResponse = await request(
      `${origin}/api/contribution/status`,
      { headers: { Cookie: cookie } },
      "initial contribution status",
    );
    const contributionStatus = await getJson(
      contributionStatusResponse,
      "initial contribution status",
    );
    if (
      contributionStatusResponse.status !== 200 ||
      !isDefaultUnavailableContributionStatus(contributionStatus)
    ) {
      fail(
        "installed default CLI did not expose the exact unavailable, default-off contribution status",
      );
    }

    const contributionMutationCases = [
      {
        action: "preview",
        path: "/api/contribution/preview",
        body: { confirmation: "preview-contribution-data" },
      },
      {
        action: "enable",
        path: "/api/contribution/enable",
        body: {
          previewId: "00000000-0000-4000-8000-000000000001",
          confirmation: "enable-anonymous-contribution",
        },
      },
      {
        action: "stop",
        path: "/api/contribution/stop",
        body: { confirmation: "stop-anonymous-contribution" },
      },
      {
        action: "delete",
        path: "/api/contribution/delete",
        body: { confirmation: "delete-contribution-data" },
      },
      {
        action: "recover",
        path: "/api/contribution/recover",
        body: { confirmation: "recover-contribution-state" },
      },
    ];
    for (const mutation of contributionMutationCases) {
      const mutationResponse = await postJson(
        origin,
        cookie,
        mutation.path,
        mutation.body,
        `default-off contribution ${mutation.action}`,
      );
      const mutationResult = await getJson(
        mutationResponse,
        `default-off contribution ${mutation.action}`,
      );
      if (
        mutationResponse.status !== 503 ||
        !hasExactKeys(mutationResult, [
          "status",
          "action",
          "code",
          "contribution",
        ]) ||
        mutationResult.status !== "error" ||
        mutationResult.action !== mutation.action ||
        mutationResult.code !== "runtime-unavailable" ||
        !isDefaultUnavailableContributionStatus(mutationResult.contribution)
      ) {
        fail(
          `installed default CLI contribution ${mutation.action} did not fail closed`,
        );
      }
    }

    const contributionCredentialDirectory = join(
      progressionDirectory,
      "contribution-v2",
    );
    const unexpectedContributionState = [
      join(progressionDirectory, "contribution-v2.sqlite"),
      join(progressionDirectory, "contribution-v2.sqlite-journal"),
      join(progressionDirectory, "contribution-v2.sqlite-shm"),
      join(progressionDirectory, "contribution-v2.sqlite-wal"),
      contributionCredentialDirectory,
      join(contributionCredentialDirectory, "contribution-upload.vault.json"),
      join(contributionCredentialDirectory, "contribution-deletion.vault.json"),
      join(contributionCredentialDirectory, "contribution-status.vault.json"),
      join(
        contributionCredentialDirectory,
        "contribution-enrollment-pending.vault.json",
      ),
    ];
    if (
      (
        await Promise.all(
          unexpectedContributionState.map((path) => exists(path)),
        )
      ).some(Boolean)
    ) {
      fail("installed default CLI created contribution SQLite or vault state");
    }
    step(
      "contribution default-off",
      "exact status, five authenticated mutations fail closed, no SQLite/vault state",
    );

    const initialByokResponse = await request(
      `${origin}/api/byok/status`,
      { headers: { Cookie: cookie } },
      "initial BYOK status",
    );
    if (initialByokResponse.status !== 200) {
      fail(
        `initial BYOK status returned HTTP ${initialByokResponse.status}, expected 200`,
      );
    }
    const initialByok = await getJson(
      initialByokResponse,
      "initial BYOK status",
    );
    const byokStatusKeys = [
      "status",
      "availability",
      "configured",
      "persistence",
      "canPersist",
      "provider",
      "model",
    ];
    if (
      !hasExactKeys(initialByok, byokStatusKeys) ||
      initialByok.status !== "ok" ||
      initialByok.availability !== "available" ||
      initialByok.configured !== false ||
      initialByok.persistence !== "memory-only" ||
      initialByok.canPersist !== false ||
      initialByok.provider !== "OpenAI" ||
      initialByok.model !== "gpt-5.6-luna"
    ) {
      fail(
        "installed CLI did not expose the exact initial memory-only BYOK status",
      );
    }
    const byokKeyCanary = ["sk", "installed_1234567890abcdef_KEY_CANARY"].join(
      "-",
    );
    const configuredByokResponse = await postJson(
      origin,
      cookie,
      "/api/byok/configure",
      { apiKey: byokKeyCanary, persist: true },
      "configure installed memory-only BYOK",
    );
    if (configuredByokResponse.status !== 200) {
      fail(
        `installed BYOK configure returned HTTP ${configuredByokResponse.status}, expected 200`,
      );
    }
    const configuredByok = await getJson(
      configuredByokResponse,
      "configured installed BYOK status",
    );
    if (
      !hasExactKeys(configuredByok, byokStatusKeys) ||
      configuredByok.configured !== true ||
      configuredByok.persistence !== "memory-only" ||
      configuredByok.canPersist !== false ||
      JSON.stringify(configuredByok).includes(byokKeyCanary)
    ) {
      fail("installed BYOK configure was not exact, memory-only, and key-free");
    }
    const clearedByokResponse = await postJson(
      origin,
      cookie,
      "/api/byok/clear",
      { confirmation: "clear-openai-byok" },
      "clear installed memory-only BYOK",
    );
    const clearedByok = await getJson(
      clearedByokResponse,
      "cleared installed BYOK status",
    );
    if (
      clearedByokResponse.status !== 200 ||
      !hasExactKeys(clearedByok, byokStatusKeys) ||
      clearedByok.configured !== false ||
      JSON.stringify(clearedByok).includes(byokKeyCanary)
    ) {
      fail("installed BYOK clear did not remove the key authority");
    }
    step(
      "BYOK memory slot",
      "configure/status/clear stayed RAM-only and key-free",
    );

    const profileResponse = await request(
      `${origin}/api/characters/profile`,
      { headers: { Cookie: cookie } },
      "clean character profile",
    );
    if (profileResponse.status !== 200) {
      fail(
        `clean character profile returned HTTP ${profileResponse.status}, expected 200`,
      );
    }
    const profile = await getJson(profileResponse, "clean character profile");
    if (!isCleanLearningCharacterProfile(profile)) {
      fail("clean character profile did not match the exact learning DTO");
    }
    if (
      isCleanLearningCharacterProfile({ ...profile, status: "unexpected" }) ||
      isCleanLearningCharacterProfile({ ...profile, unexpected: true }) ||
      isCleanLearningCharacterProfile({
        ...profile,
        reasons: profile.reasons.slice(0, -1),
      })
    ) {
      fail("clean character profile validator accepted a mutated DTO");
    }
    step(
      "clean character profile",
      "HTTP 200, exact 28-day learning DTO and mutation controls",
    );

    const charactersResponse = await request(
      `${origin}/api/characters`,
      { headers: { Cookie: cookie } },
      "characters",
    );
    if (charactersResponse.status !== 200) {
      fail(
        `characters returned HTTP ${charactersResponse.status}, expected 200`,
      );
    }
    const characters = await getJson(charactersResponse, "characters");
    if (
      characters === null ||
      typeof characters !== "object" ||
      !Array.isArray(characters.characters) ||
      characters.characters.length !== 11 ||
      characters.selection === null ||
      typeof characters.selection !== "object" ||
      characters.selection.characterId !== null ||
      characters.selection.selectedBy !== null
    ) {
      fail("clean characters JSON did not expose 11 unselected characters");
    }
    const starterIds = ["chatgpt", "claude", "gemini", "grok"];
    for (const starterId of starterIds) {
      const initialStarter = characters.characters.find(
        (character) => character?.characterId === starterId,
      );
      const avatar = PUBLIC_EMBEDDED_STARTER_ASSETS.find(
        (asset) => asset.characterId === starterId && asset.kind === "avatar",
      );
      if (
        initialStarter === undefined ||
        avatar === undefined ||
        initialStarter.isStarter !== true ||
        initialStarter.unlocked !== false ||
        initialStarter.activeThemeId !== null ||
        initialStarter.visual?.mode !== "doll" ||
        initialStarter.visual.avatarPath !==
          `/assets/characters/${avatar.objectPath}`
      ) {
        fail(
          `clean install did not expose ${starterId} with built-in avatar art`,
        );
      }
      await requireEmbeddedStarterImage(
        origin,
        cookie,
        initialStarter.visual.avatarPath,
        avatar,
        `${starterId} built-in avatar`,
      );
    }
    step(
      "characters",
      `HTTP ${charactersResponse.status}, four built-in starter avatars, 11 characters and no forced starter`,
    );

    const assetPackStatusResponse = await request(
      `${origin}/api/characters/assets`,
      { headers: { Cookie: cookie, Origin: origin } },
      "asset pack status",
    );
    if (assetPackStatusResponse.status !== 200) {
      fail(
        `asset pack status returned HTTP ${assetPackStatusResponse.status}, expected 200`,
      );
    }
    const assetPackStatus = await getJson(
      assetPackStatusResponse,
      "asset pack status",
    );
    if (
      !hasExactKeys(assetPackStatus, [
        "status",
        "phase",
        "consented",
        "enabled",
        "releaseId",
        "downloadBytes",
        "lastError",
      ]) ||
      assetPackStatus.status !== "ok" ||
      assetPackStatus.phase !== "available" ||
      assetPackStatus.consented !== false ||
      assetPackStatus.enabled !== false ||
      assetPackStatus.releaseId !== EXPECTED_ASSET_RELEASE_ID ||
      assetPackStatus.downloadBytes !== EXPECTED_ASSET_PACK_BYTES ||
      assetPackStatus.lastError !== null
    ) {
      fail("asset pack status was not the exact reviewed default-off contract");
    }
    step(
      "asset pack authority",
      `${EXPECTED_ASSET_RELEASE_ID}, ${EXPECTED_ASSET_PACK_BYTES} bytes, default off`,
    );

    const blockedSelectResponse = await postJson(
      origin,
      cookie,
      "/api/characters/select",
      { characterId: "chatgpt" },
      "starter selection behind stale rc.7 lock",
    );
    if (blockedSelectResponse.status !== 409) {
      fail(
        `starter selection behind stale rc.7 lock returned HTTP ${blockedSelectResponse.status}, expected 409`,
      );
    }
    const blockedSelection = await getJson(
      blockedSelectResponse,
      "blocked starter selection",
    );
    if (
      blockedSelection?.status !== "error" ||
      blockedSelection?.error !== "store-busy" ||
      Reflect.ownKeys(blockedSelection).length !== 2
    ) {
      fail("stale rc.7 lock did not return the exact store-busy contract");
    }
    const repairResponse = await postJson(
      origin,
      cookie,
      "/api/characters/progression-lock/repair",
      { confirmedOldVersionsClosed: true },
      "explicit stale rc.7 lock repair",
    );
    if (repairResponse.status !== 200) {
      fail(
        `stale rc.7 repair returned HTTP ${repairResponse.status}, expected 200`,
      );
    }
    const repair = await getJson(
      repairResponse,
      "explicit stale rc.7 lock repair",
    );
    if (
      repair?.status !== "ok" ||
      repair?.outcome !== "repaired" ||
      Reflect.ownKeys(repair).length !== 2
    ) {
      fail("stale rc.7 repair did not return the exact repaired contract");
    }

    const selectResponse = await postJson(
      origin,
      cookie,
      "/api/characters/select",
      { characterId: "chatgpt" },
      "starter selection after explicit repair",
    );
    if (selectResponse.status !== 200) {
      fail(
        `starter selection returned HTTP ${selectResponse.status}, expected 200`,
      );
    }
    const selection = await getJson(selectResponse, "starter selection");
    if (
      selection === null ||
      typeof selection !== "object" ||
      selection.status !== "ok" ||
      selection.selection === null ||
      typeof selection.selection !== "object" ||
      selection.selection.characterId !== "chatgpt" ||
      selection.selection.selectedBy !== "manual"
    ) {
      fail("starter selection did not return the exact manual chatgpt choice");
    }

    const selectedCharactersResponse = await request(
      `${origin}/api/characters`,
      { headers: { Cookie: cookie } },
      "selected characters",
    );
    if (selectedCharactersResponse.status !== 200) {
      fail(
        `selected characters returned HTTP ${selectedCharactersResponse.status}, expected 200`,
      );
    }
    const selectedCharacters = await getJson(
      selectedCharactersResponse,
      "selected characters",
    );
    const selectedStarter = selectedCharacters?.characters?.find?.(
      (character) => character?.characterId === "chatgpt",
    );
    if (
      selectedCharacters?.selection?.characterId !== "chatgpt" ||
      selectedCharacters?.selection?.selectedBy !== "manual" ||
      selectedStarter?.unlocked !== true ||
      selectedStarter?.activeThemeId !== "tech" ||
      selectedStarter?.visual?.mode !== "doll"
    ) {
      fail("starter choice was not persisted as the unlocked active companion");
    }
    const baseOutfit = PUBLIC_EMBEDDED_STARTER_ASSETS.find(
      (asset) =>
        asset.characterId === "chatgpt" &&
        asset.kind === "outfit" &&
        asset.themeId === "tech",
    );
    const activeBaseTheme = selectedStarter.visual.themes.find(
      (theme) => theme.themeId === "tech",
    );
    if (
      baseOutfit === undefined ||
      activeBaseTheme?.unlocked !== true ||
      activeBaseTheme.outfitPath !==
        `/assets/characters/${baseOutfit.objectPath}`
    ) {
      fail("selected starter did not receive the built-in tech base outfit");
    }
    await requireEmbeddedStarterImage(
      origin,
      cookie,
      activeBaseTheme.outfitPath,
      baseOutfit,
      "chatgpt built-in base outfit",
    );
    if (await exists(staleStoreLock)) {
      fail("stale zero-byte progression lock was not recovered");
    }

    const interactionResponse = await postJson(
      origin,
      cookie,
      "/api/characters/interact",
      { characterId: "chatgpt", action: "tap", locale: "zh-TW" },
      "starter interaction",
    );
    if (interactionResponse.status !== 200) {
      fail(
        `starter interaction returned HTTP ${interactionResponse.status}, expected 200`,
      );
    }
    const interaction = await getJson(
      interactionResponse,
      "starter interaction",
    );
    if (
      interaction?.status !== "ok" ||
      interaction?.action !== "tap" ||
      interaction?.characterId !== "chatgpt" ||
      interaction?.locale !== "zh-TW" ||
      interaction?.outcome !== "line" ||
      typeof interaction?.line?.lineId !== "string" ||
      typeof interaction?.line?.text !== "string" ||
      interaction.line.text.length < 1
    ) {
      fail("starter tap did not return a local scripted companion line");
    }
    step(
      "starter player loop",
      "recover crash lock, choose chatgpt, persist unlock, and tap for a line",
    );

    const missingAssetResponse = await request(
      `${origin}/assets/characters/objects/${"0".repeat(64)}.webp`,
      { headers: { Cookie: cookie } },
      "unknown character asset",
    );
    const missingAssetStatus = missingAssetResponse.status;
    await missingAssetResponse.body?.cancel();
    if (missingAssetStatus !== 404) {
      fail(
        `unknown character asset returned HTTP ${missingAssetStatus}, expected 404`,
      );
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
      fail(
        `anonymous characters returned HTTP ${anonymousStatus}, expected 404`,
      );
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
  await proveRemoteHelperSuppression(installDirectory, isolatedHome);
}

const installDirectory = process.argv[2];
if (process.argv.length !== 3 || installDirectory === undefined) {
  console.error(
    "SMOKE usage: node scripts/release/smoke-installed.mjs <install-dir>",
  );
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
  const message =
    failure instanceof Error ? failure.message : "unknown failure";
  console.error(`SMOKE FAIL: ${message}`);
  process.exit(1);
}

console.log("SMOKE RESULT: PASS");
process.exit(0);
