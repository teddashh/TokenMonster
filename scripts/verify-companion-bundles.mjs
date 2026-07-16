import { readFile } from "node:fs/promises";
import Module, { createRequire } from "node:module";
import { join } from "node:path";
import { Script } from "node:vm";

import { rootDirectory } from "./repository-files.mjs";

const require = createRequire(import.meta.url);
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

process.stdout.write("Verified bundled preload API and guarded IPC dispatch.\n");
