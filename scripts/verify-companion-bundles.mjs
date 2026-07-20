import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext, Script } from "node:vm";
import { deflateSync } from "node:zlib";

import { rootDirectory } from "./repository-files.mjs";

const require = createRequire(import.meta.url);
const mainPath = join(
  rootDirectory,
  "apps",
  "companion",
  "dist",
  "main",
  "main",
  "main.js"
);
const preloadPath = join(
  rootDirectory,
  "apps",
  "companion",
  "dist",
  "main",
  "preload",
  "index.cjs"
);
const guardsPath = join(
  rootDirectory,
  "apps",
  "companion",
  "dist",
  "main",
  "preload",
  "guards.cjs"
);
const companionPreloadPath = join(
  rootDirectory,
  "apps",
  "companion",
  "dist",
  "main",
  "preload",
  "companion.cjs"
);

// The Electron main process must retain Node's real builtins. Vite rewrites a
// bare builtin such as yauzl's `require("fs")` to this empty browser shim when
// it is not explicitly externalized; that bundle builds successfully but the
// fixed asset-pack installer then fails only after a player enables art.
const mainSource = await readFile(mainPath, "utf8");
const defaultPetByokMarkers = [
  "createPetByokSecretSlot",
  "createElectronAsyncSafeStoragePort",
  'PET_BYOK_SECRET_FILE = "openai-byok.json"',
  "startPetServices(petByokSecretSlot)",
  'var BYOK_STATUS_PATH = "/api/byok/status"',
  "store: false"
];
if (defaultPetByokMarkers.some((marker) => !mainSource.includes(marker))) {
  throw new Error(
    "Bundled Electron main process lost the default pet BYOK composition."
  );
}
const defaultPetAutomaticUpdateMarkers = [
  "createAutomaticUpdateController",
  "createAutomaticUpdateService",
  "registerAutomaticUpdateIpcHandlers",
  'AUTOMATIC_UPDATE_STATE_FILE = "automatic-updates-v1.json"',
  "https://cdn.ted-h.com/tokenmonster/releases/windows/squirrel/latest/",
  "https://cdn.ted-h.com/tokenmonster/releases/windows/squirrel/next/",
  "before-quit-for-update",
  "updateWindowCloseAllowed",
  "beginShutdown"
];
if (
  defaultPetAutomaticUpdateMarkers.some(
    (marker) => !mainSource.includes(marker)
  )
) {
  throw new Error(
    "Bundled Electron main process lost the default-off fixed-feed updater composition."
  );
}
if (mainSource.includes("__vite-browser-external")) {
  throw new Error(
    "Bundled Electron main process contains a browser-external Node shim."
  );
}
const commonJsRequireBridge =
  "const require = createRequire(import.meta.url);\n";
if (
  !mainSource.startsWith(commonJsRequireBridge) ||
  mainSource.split(commonJsRequireBridge).length !== 2 ||
  !mainSource.includes('createRequire } from "node:module";')
) {
  throw new Error(
    "Bundled Electron ESM main process lost its CommonJS builtin bridge."
  );
}

// Evaluate the exact production bundle through all eager module factories,
// including yauzl. Only remove the Electron import and final app entry call so
// this smoke needs neither a display nor user-data writes. A missing ESM
// `createRequire` bridge fails here before any product startup side effect.
const electronImports = [
  ...mainSource.matchAll(/^import \{[^\n]+\} from "electron";$/gmu)
];
const appEntryCalls = [...mainSource.matchAll(/^run\(\);$/gmu)];
if (electronImports.length !== 1 || appEntryCalls.length !== 1) {
  throw new Error("Bundled Electron main entry shape changed.");
}
const appEntryIndex = appEntryCalls[0].index;
if (appEntryIndex === undefined) {
  throw new Error("Bundled Electron main entry has no stable location.");
}
const sourceWithoutAppEntry =
  mainSource.slice(0, appEntryIndex) +
  mainSource.slice(appEntryIndex + appEntryCalls[0][0].length);
const evaluationSource = sourceWithoutAppEntry.replace(
  electronImports[0][0],
  ""
);
const evaluationDirectory = await mkdtemp(
  join(tmpdir(), "tokenmonster-main-bundle-smoke-")
);
try {
  const evaluationPath = join(evaluationDirectory, "main.mjs");
  await writeFile(evaluationPath, evaluationSource, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  await import(pathToFileURL(evaluationPath).href);
} finally {
  await rm(evaluationDirectory, { recursive: true, force: true });
}

function crc32(bytes) {
  let crc = 0xffff_ffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function pngChunk(type, data) {
  const output = Buffer.alloc(12 + data.byteLength);
  output.writeUInt32BE(data.byteLength, 0);
  output.write(type, 4, 4, "ascii");
  Buffer.from(data).copy(output, 8);
  output.writeUInt32BE(
    crc32(output.subarray(4, 8 + data.byteLength)),
    8 + data.byteLength
  );
  return output;
}

function companionPngFixture() {
  const width = 1_200;
  const height = 630;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk("IHDR", header),
      pngChunk("IDAT", deflateSync(raw)),
      pngChunk("IEND", new Uint8Array())
    ])
  );
}

const expectedGuardKeys = [
  "chatRequest",
  "collectorScanRequest",
  "configureRequest",
  "contributionDeleteRequest",
  "contributionDeletionStatusRequest",
  "contributionEnableRequest",
  "contributionPreviewRequest",
  "contributionStopRequest",
  "contributionSyncRequest",
  "createInvokeGuard",
  "fixedRequest",
  "localSourceResetRequest",
  "shareCardSaveRequest",
  "usageInsightsRequest",
  "validatedCharacterId"
];
const expectedBridgeKeys = [
  "chat",
  "clearByok",
  "configureByok",
  "deleteContributionData",
  "enableContribution",
  "exportLocalData",
  "exportSupportDiagnostic",
  "getBootstrap",
  "getContributionStatus",
  "getUsageInsights",
  "interact",
  "prepareContributionPreview",
  "refreshContributionDeletionStatus",
  "resetLocalSourceData",
  "saveShareCard",
  "scanUsage",
  "selectCharacter",
  "stopContribution",
  "syncContribution"
];

const guards = require(guardsPath);
if (
  JSON.stringify(Object.keys(guards).sort()) !==
    JSON.stringify(expectedGuardKeys)
) {
  throw new Error("Bundled preload guards expose an unexpected API.");
}
for (const key of expectedGuardKeys) {
  if (typeof guards[key] !== "function") {
    throw new Error(`Bundled preload guard ${key} is not callable.`);
  }
}

// `sandbox: true` preloads receive Electron's limited require and cannot load
// sibling chunks. Fail the normal bundle gate if a future multi-entry build
// extracts Rolldown runtime or shared validation into another file.
const companionPreloadSource = await readFile(companionPreloadPath, "utf8");
new Script(companionPreloadSource, { filename: "companion.cjs" });
const companionPreloadRequires = [
  ...companionPreloadSource.matchAll(/\brequire\(["']([^"']+)["']\)/gu)
].map((match) => match[1]);
if (
  JSON.stringify(companionPreloadRequires) !== JSON.stringify(["electron"])
) {
  throw new Error(
    "Bundled companion preload is not one self-contained sandbox script."
  );
}

let bridge;
const calls = [];
const electronMock = Object.freeze({
  contextBridge: Object.freeze({
    exposeInMainWorld(name, value) {
      if (name !== "tokenMonster" || bridge !== undefined) {
        throw new Error("Bundled preload exposed an unexpected bridge.");
      }
      bridge = value;
    }
  }),
  ipcRenderer: Object.freeze({
    invoke(channel, argument) {
      calls.push([channel, argument]);
      return Promise.resolve(Object.freeze({ ok: true }));
    }
  })
});

const originalLoad = Module._load;
try {
  Module._load = function loadWithElectronMock(request, parent, isMain) {
    return request === "electron"
      ? electronMock
      : originalLoad.call(this, request, parent, isMain);
  };
  require(preloadPath);
} finally {
  Module._load = originalLoad;
}

if (
  bridge === undefined ||
  !Object.isFrozen(bridge) ||
  JSON.stringify(Object.keys(bridge).sort()) !== JSON.stringify(expectedBridgeKeys)
) {
  throw new Error("Bundled preload bridge has an unexpected shape.");
}

await bridge.getBootstrap();
await bridge.getUsageInsights({ windowDays: 7 });
await bridge.selectCharacter("chatgpt");
await bridge.interact({ characterId: "claude", trigger: "greeting" });
await bridge.configureByok({
  apiKey: ["sk", "bundle_smoke_1234567890abcdef"].join("-"),
  persist: false
});
await bridge.clearByok();
await bridge.chat({ characterId: "gemini", message: "bundle smoke" });
await bridge.scanUsage({ client: "codex", day: "today" });
await bridge.saveShareCard({ windowDays: 28, characterId: "grok" });
await bridge.exportLocalData();
await bridge.exportSupportDiagnostic();
await bridge.resetLocalSourceData({
  confirmation: "clear-collector-derived-data"
});
await bridge.getContributionStatus();
await bridge.prepareContributionPreview({
  confirmation: "preview-content-blind-contribution"
});
await bridge.enableContribution({
  confirmation: "enable-content-blind-contribution",
  previewId: "10000000-0000-4000-8000-000000000001"
});
await bridge.syncContribution({
  confirmation: "sync-content-blind-contribution"
});
await bridge.stopContribution({
  confirmation: "stop-content-blind-contribution"
});
await bridge.deleteContributionData({
  confirmation: "delete-identifiable-contribution-data"
});
await bridge.refreshContributionDeletionStatus({
  confirmation: "check-contribution-deletion-status"
});

const expectedCalls = [
  ["tokenmonster:bootstrap", undefined],
  ["tokenmonster:usage-insights", { windowDays: 7 }],
  ["tokenmonster:select-character", "chatgpt"],
  [
    "tokenmonster:fixed-interaction",
    { characterId: "claude", trigger: "greeting" }
  ],
  [
    "tokenmonster:configure-byok",
    {
      apiKey: ["sk", "bundle_smoke_1234567890abcdef"].join("-"),
      persist: false
    }
  ],
  ["tokenmonster:clear-byok", undefined],
  [
    "tokenmonster:byok-chat",
    { characterId: "gemini", message: "bundle smoke" }
  ],
  ["tokenmonster:scan-usage", { client: "codex", day: "today" }],
  [
    "tokenmonster:save-share-card",
    { windowDays: 28, characterId: "grok" }
  ],
  ["tokenmonster:export-local-data", { format: "json-v1" }],
  ["tokenmonster:export-support-diagnostic", { format: "json-v1" }],
  [
    "tokenmonster:reset-local-source-data",
    { confirmation: "clear-collector-derived-data" }
  ],
  ["tokenmonster:contribution-status", undefined],
  [
    "tokenmonster:contribution-preview",
    { confirmation: "preview-content-blind-contribution" }
  ],
  [
    "tokenmonster:contribution-enable",
    {
      confirmation: "enable-content-blind-contribution",
      previewId: "10000000-0000-4000-8000-000000000001"
    }
  ],
  [
    "tokenmonster:contribution-sync",
    { confirmation: "sync-content-blind-contribution" }
  ],
  [
    "tokenmonster:contribution-stop",
    { confirmation: "stop-content-blind-contribution" }
  ],
  [
    "tokenmonster:contribution-delete",
    { confirmation: "delete-identifiable-contribution-data" }
  ],
  [
    "tokenmonster:contribution-deletion-status",
    { confirmation: "check-contribution-deletion-status" }
  ]
];
if (JSON.stringify(calls) !== JSON.stringify(expectedCalls)) {
  throw new Error("Bundled preload invoked an unexpected guarded IPC request set.");
}

let rejected = false;
try {
  await bridge.scanUsage({ client: "unknown", day: "today" });
} catch (error) {
  rejected = error instanceof Error && error.message === "IPC_REQUEST_REJECTED";
}
if (!rejected || calls.length !== expectedCalls.length) {
  throw new Error("Bundled preload did not reject invalid input before IPC.");
}

let companionBridge;
const companionCalls = [];
const disabledReminderStatus = Object.freeze({
  contractVersion: 1,
  revision: "0",
  storage: "ready",
  notificationSupported: true,
  enabled: false,
  dailySummaryTime: "18:00",
  quietHours: Object.freeze({ start: "22:00", end: "08:00" }),
  scheduled: false,
  nextCheckAt: null,
  lastHandledLocalDate: null
});
const enabledReminderStatus = Object.freeze({
  ...disabledReminderStatus,
  revision: "1",
  enabled: true,
  scheduled: true,
  nextCheckAt: "2026-07-18T18:01:00.000Z"
});
const automaticUpdateStatus = Object.freeze({
  contractVersion: 1,
  revision: "0",
  preferenceStorage: "ready",
  automaticChecksEnabled: false,
  update: Object.freeze({
    contractVersion: 1,
    currentVersion: "0.1.0",
    channel: "latest",
    status: "idle",
    lastCheckedAt: null,
    availableVersion: null,
    errorCode: null
  })
});
const automaticUpdateEnabledStatus = Object.freeze({
  ...automaticUpdateStatus,
  revision: "1",
  automaticChecksEnabled: true
});
const companionElectronMock = Object.freeze({
  contextBridge: Object.freeze({
    exposeInMainWorld(name, value) {
      if (name !== "tokenMonsterCompanion" || companionBridge !== undefined) {
        throw new Error("Bundled companion preload exposed an unexpected bridge.");
      }
      companionBridge = value;
    }
  }),
  ipcRenderer: Object.freeze({
    invoke(channel, argument) {
      companionCalls.push([channel, argument]);
      if (channel === "tokenmonster:companion:save-png") {
        return Promise.resolve(Object.freeze({ status: "saved" }));
      }
      if (channel === "tokenmonster:companion:reminder-status") {
        return Promise.resolve(disabledReminderStatus);
      }
      if (channel === "tokenmonster:companion:update-reminders") {
        return Promise.resolve(
          Object.freeze({ ok: true, status: enabledReminderStatus })
        );
      }
      if (channel === "tokenmonster:companion:test-reminder") {
        return Promise.resolve(
          Object.freeze({ outcome: "shown", status: disabledReminderStatus })
        );
      }
      if (channel === "tokenmonster:companion:automatic-update-status") {
        return Promise.resolve(automaticUpdateStatus);
      }
      if (channel === "tokenmonster:companion:automatic-update-preference") {
        return Promise.resolve(
          Object.freeze({ ok: true, status: automaticUpdateEnabledStatus })
        );
      }
      if (channel === "tokenmonster:companion:automatic-update-check") {
        return Promise.resolve(
          Object.freeze({
            ok: true,
            code: "check-started",
            status: automaticUpdateStatus
          })
        );
      }
      if (channel === "tokenmonster:companion:automatic-update-install") {
        return Promise.resolve(
          Object.freeze({
            ok: false,
            code: "not-ready",
            status: automaticUpdateStatus
          })
        );
      }
      return Promise.reject(new Error("IPC_REQUEST_REJECTED"));
    }
  })
});
try {
  Module._load = function loadWithCompanionElectronMock(request, parent, isMain) {
    return request === "electron"
      ? companionElectronMock
      : originalLoad.call(this, request, parent, isMain);
  };
  require(companionPreloadPath);
} finally {
  Module._load = originalLoad;
}

if (
  companionBridge === undefined ||
  !Object.isFrozen(companionBridge) ||
  JSON.stringify(Object.keys(companionBridge)) !==
    JSON.stringify([
      "savePng",
      "getReminderStatus",
      "updateReminderSettings",
      "testReminder",
      "getAutomaticUpdateStatus",
      "updateAutomaticChecks",
      "checkForAutomaticUpdate",
      "installAutomaticUpdate"
    ])
) {
  throw new Error("Bundled companion preload bridge has an unexpected shape.");
}
const companionPng = companionPngFixture();
const rendererRealmRequest = runInNewContext(
  "({ bytes: new Uint8Array(values), suggestedName: name })",
  {
    values: [...companionPng],
    name: "tokenmonster-local-share-card.png"
  }
);
const companionResult = await companionBridge.savePng(rendererRealmRequest);
if (
  !Object.isFrozen(companionResult) ||
  companionResult.status !== "saved" ||
  companionCalls.length !== 1 ||
  companionCalls[0][0] !== "tokenmonster:companion:save-png" ||
  companionCalls[0][1].suggestedName !==
    "tokenmonster-local-share-card.png" ||
  !(companionCalls[0][1].bytes instanceof Uint8Array) ||
  Object.getPrototypeOf(companionCalls[0][1].bytes) !== Uint8Array.prototype ||
  Buffer.compare(
    Buffer.from(companionCalls[0][1].bytes),
    Buffer.from(companionPng)
  ) !== 0
) {
  throw new Error("Bundled companion preload did not normalize guarded PNG IPC.");
}
rejected = false;
try {
  await companionBridge.savePng({
    bytes: companionPng,
    suggestedName: "other.png"
  });
} catch (error) {
  rejected = error instanceof Error && error.message === "IPC_REQUEST_REJECTED";
}
if (!rejected || companionCalls.length !== 1) {
  throw new Error("Bundled companion preload accepted an invalid PNG request.");
}

const reminderStatus = await companionBridge.getReminderStatus();
const rendererReminderRequest = runInNewContext(
  "({ expectedRevision: '0', enabled: true, dailySummaryTime: '18:00', quietHours: { start: '22:00', end: '08:00' } })"
);
const reminderMutation = await companionBridge.updateReminderSettings(
  rendererReminderRequest
);
const reminderTest = await companionBridge.testReminder();
if (
  !Object.isFrozen(reminderStatus) ||
  reminderStatus.enabled !== false ||
  !Object.isFrozen(reminderMutation) ||
  reminderMutation.ok !== true ||
  reminderMutation.status.enabled !== true ||
  !Object.isFrozen(reminderTest) ||
  reminderTest.outcome !== "shown" ||
  companionCalls.length !== 4 ||
  companionCalls[1][0] !== "tokenmonster:companion:reminder-status" ||
  companionCalls[1][1] !== undefined ||
  companionCalls[2][0] !== "tokenmonster:companion:update-reminders" ||
  companionCalls[2][1].expectedRevision !== "0" ||
  companionCalls[2][1].enabled !== true ||
  companionCalls[2][1].dailySummaryTime !== "18:00" ||
  companionCalls[2][1].quietHours.start !== "22:00" ||
  companionCalls[2][1].quietHours.end !== "08:00" ||
  companionCalls[3][0] !== "tokenmonster:companion:test-reminder" ||
  companionCalls[3][1] !== undefined
) {
  throw new Error("Bundled companion preload lost its guarded reminder bridge.");
}
rejected = false;
try {
  await companionBridge.updateReminderSettings({
    ...rendererReminderRequest,
    extra: true
  });
} catch (error) {
  rejected = error instanceof Error && error.message === "IPC_REQUEST_REJECTED";
}
if (!rejected || companionCalls.length !== 4) {
  throw new Error("Bundled companion preload accepted invalid reminder settings.");
}

const updaterStatus = await companionBridge.getAutomaticUpdateStatus();
const rendererUpdaterPreference = runInNewContext(
  "({ expectedRevision: '0', automaticChecksEnabled: true })"
);
const updaterPreference = await companionBridge.updateAutomaticChecks(
  rendererUpdaterPreference
);
const updaterCheck = await companionBridge.checkForAutomaticUpdate();
const updaterInstall = await companionBridge.installAutomaticUpdate();
if (
  !Object.isFrozen(updaterStatus) ||
  updaterStatus.automaticChecksEnabled !== false ||
  !Object.isFrozen(updaterPreference) ||
  updaterPreference.ok !== true ||
  updaterPreference.status.automaticChecksEnabled !== true ||
  updaterCheck.ok !== true ||
  updaterCheck.code !== "check-started" ||
  updaterInstall.ok !== false ||
  updaterInstall.code !== "not-ready" ||
  companionCalls.length !== 8 ||
  companionCalls[4][0] !==
    "tokenmonster:companion:automatic-update-status" ||
  companionCalls[4][1] !== undefined ||
  companionCalls[5][0] !==
    "tokenmonster:companion:automatic-update-preference" ||
  companionCalls[5][1].expectedRevision !== "0" ||
  companionCalls[5][1].automaticChecksEnabled !== true ||
  Reflect.ownKeys(companionCalls[5][1]).length !== 2 ||
  companionCalls[6][0] !==
    "tokenmonster:companion:automatic-update-check" ||
  companionCalls[6][1] !== undefined ||
  companionCalls[7][0] !==
    "tokenmonster:companion:automatic-update-install" ||
  companionCalls[7][1] !== undefined
) {
  throw new Error(
    "Bundled companion preload lost its fixed automatic-update bridge."
  );
}
rejected = false;
try {
  await companionBridge.updateAutomaticChecks({
    ...rendererUpdaterPreference,
    feedUrl: "https://attacker.invalid/"
  });
} catch (error) {
  rejected = error instanceof Error && error.message === "IPC_REQUEST_REJECTED";
}
if (!rejected || companionCalls.length !== 8) {
  throw new Error(
    "Bundled companion preload accepted a renderer-controlled update option."
  );
}

// The sidecar shim is forked as its own file inside a utilityProcess.
// Syntax-check the source (vite copies it into dist verbatim; the package
// verifier asserts the dist copy ships) without executing — running it
// would process.exit().
const shimPath = join(
  rootDirectory,
  "apps",
  "companion",
  "src",
  "main",
  "pet",
  "sidecar-shim.cjs"
);
const shimSource = await readFile(shimPath, "utf8");
new Script(shimSource, { filename: "sidecar-shim.cjs" });
if (!shimSource.includes("process.exit")) {
  throw new Error("Bundled sidecar shim lost its explicit-exit contract.");
}

const networkGuardPath = join(
  rootDirectory,
  "packages",
  "token-tracker-runtime",
  "src",
  "network-deny.cjs"
);
const networkGuardSource = await readFile(networkGuardPath, "utf8");
new Script(networkGuardSource, { filename: "network-deny.cjs" });
for (const marker of [
  "TOKENMONSTER_SIDECAR_EGRESS_BLOCKED",
  "syncBuiltinESMExports",
  'lockFunction(globalThis, "fetch"',
  'lockFunction(childProcess.ChildProcess.prototype, "spawn"',
  'lockFunction(utility.net, "fetch"',
  'lockFunction(dgram.Socket.prototype, property, blocked)',
  'lockFunction(net.Socket.prototype, "connect"',
  'lockFunction(dns, "lookup"',
  "lockMatchingFunctions(dns, /^resolve/u, blocked)",
  'lockFunction(workerThreads, "Worker"'
]) {
  if (!networkGuardSource.includes(marker)) {
    throw new Error(`Sidecar network guard lost required marker: ${marker}`);
  }
}

process.stdout.write(
  "Verified Electron main ESM factories, updater composition, bundled preload APIs, renderer-realm PNG/reminder/update normalization, and guarded IPC dispatch.\n"
);
