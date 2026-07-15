const { contextBridge, ipcRenderer }: typeof import("electron") = require("electron");
const {
  chatRequest,
  collectorScanRequest,
  configureRequest,
  contributionDeleteRequest,
  contributionDeletionStatusRequest,
  contributionEnableRequest,
  contributionPreviewRequest,
  contributionStopRequest,
  contributionSyncRequest,
  createInvokeGuard,
  fixedRequest,
  localSourceResetRequest,
  shareCardSaveRequest,
  usageInsightsRequest,
  validatedCharacterId
}: typeof import("./guards.cjs") = require("./guards.cjs");

import type {
  ByokChatRequest,
  CharacterSummary,
  CollectorScanRequest,
  ConfigureByokRequest,
  ContributionDeleteRequest,
  ContributionDeletionStatusRequest,
  ContributionEnableRequest,
  ContributionPreviewRequest,
  ContributionStopRequest,
  ContributionSyncRequest,
  FixedInteractionRequest,
  LocalSourceResetRequest,
  ShareCardSaveRequest,
  TokenMonsterBridge,
  UsageInsightsRequest
} from "../shared/ipc.js";

const IPC_CHANNELS = {
  bootstrap: "tokenmonster:bootstrap",
  usageInsights: "tokenmonster:usage-insights",
  selectCharacter: "tokenmonster:select-character",
  fixedInteraction: "tokenmonster:fixed-interaction",
  configureByok: "tokenmonster:configure-byok",
  clearByok: "tokenmonster:clear-byok",
  byokChat: "tokenmonster:byok-chat",
  scanUsage: "tokenmonster:scan-usage",
  saveShareCard: "tokenmonster:save-share-card",
  exportLocalData: "tokenmonster:export-local-data",
  exportSupportDiagnostic: "tokenmonster:export-support-diagnostic",
  resetLocalSourceData: "tokenmonster:reset-local-source-data",
  contributionStatus: "tokenmonster:contribution-status",
  contributionPreview: "tokenmonster:contribution-preview",
  contributionEnable: "tokenmonster:contribution-enable",
  contributionSync: "tokenmonster:contribution-sync",
  contributionStop: "tokenmonster:contribution-stop",
  contributionDelete: "tokenmonster:contribution-delete",
  contributionDeletionStatus: "tokenmonster:contribution-deletion-status"
} as const;

const invokeGuarded = createInvokeGuard((channel, argument) =>
  argument === undefined
    ? ipcRenderer.invoke(channel)
    : ipcRenderer.invoke(channel, argument)
);

const bridge: TokenMonsterBridge = Object.freeze({
  getBootstrap: () => invokeGuarded(IPC_CHANNELS.bootstrap) as ReturnType<TokenMonsterBridge["getBootstrap"]>,
  getUsageInsights: (request: UsageInsightsRequest) =>
    invokeGuarded(
      IPC_CHANNELS.usageInsights,
      usageInsightsRequest(request)
    ) as ReturnType<TokenMonsterBridge["getUsageInsights"]>,
  selectCharacter: (selectedCharacterId: CharacterSummary["id"]) =>
    invokeGuarded(
      IPC_CHANNELS.selectCharacter,
      validatedCharacterId(selectedCharacterId)
    ) as ReturnType<TokenMonsterBridge["selectCharacter"]>,
  interact: (request: FixedInteractionRequest) =>
    invokeGuarded(
      IPC_CHANNELS.fixedInteraction,
      fixedRequest(request)
    ) as ReturnType<TokenMonsterBridge["interact"]>,
  configureByok: (request: ConfigureByokRequest) =>
    invokeGuarded(
      IPC_CHANNELS.configureByok,
      configureRequest(request)
    ) as ReturnType<TokenMonsterBridge["configureByok"]>,
  clearByok: () =>
    invokeGuarded(IPC_CHANNELS.clearByok) as ReturnType<TokenMonsterBridge["clearByok"]>,
  chat: (request: ByokChatRequest) =>
    invokeGuarded(
      IPC_CHANNELS.byokChat,
      chatRequest(request)
    ) as ReturnType<TokenMonsterBridge["chat"]>,
  scanUsage: (request: CollectorScanRequest) =>
    invokeGuarded(
      IPC_CHANNELS.scanUsage,
      collectorScanRequest(request)
    ) as ReturnType<TokenMonsterBridge["scanUsage"]>,
  saveShareCard: (request: ShareCardSaveRequest) =>
    invokeGuarded(
      IPC_CHANNELS.saveShareCard,
      shareCardSaveRequest(request)
    ) as ReturnType<TokenMonsterBridge["saveShareCard"]>,
  exportLocalData: () =>
    invokeGuarded(
      IPC_CHANNELS.exportLocalData,
      Object.freeze({ format: "json-v1" })
    ) as ReturnType<TokenMonsterBridge["exportLocalData"]>,
  exportSupportDiagnostic: () =>
    invokeGuarded(
      IPC_CHANNELS.exportSupportDiagnostic,
      Object.freeze({ format: "json-v1" })
    ) as ReturnType<TokenMonsterBridge["exportSupportDiagnostic"]>,
  resetLocalSourceData: (request: LocalSourceResetRequest) =>
    invokeGuarded(
      IPC_CHANNELS.resetLocalSourceData,
      localSourceResetRequest(request)
    ) as ReturnType<TokenMonsterBridge["resetLocalSourceData"]>,
  getContributionStatus: () =>
    invokeGuarded(
      IPC_CHANNELS.contributionStatus
    ) as ReturnType<TokenMonsterBridge["getContributionStatus"]>,
  prepareContributionPreview: (request: ContributionPreviewRequest) =>
    invokeGuarded(
      IPC_CHANNELS.contributionPreview,
      contributionPreviewRequest(request)
    ) as ReturnType<TokenMonsterBridge["prepareContributionPreview"]>,
  enableContribution: (request: ContributionEnableRequest) =>
    invokeGuarded(
      IPC_CHANNELS.contributionEnable,
      contributionEnableRequest(request)
    ) as ReturnType<TokenMonsterBridge["enableContribution"]>,
  syncContribution: (request: ContributionSyncRequest) =>
    invokeGuarded(
      IPC_CHANNELS.contributionSync,
      contributionSyncRequest(request)
    ) as ReturnType<TokenMonsterBridge["syncContribution"]>,
  stopContribution: (request: ContributionStopRequest) =>
    invokeGuarded(
      IPC_CHANNELS.contributionStop,
      contributionStopRequest(request)
    ) as ReturnType<TokenMonsterBridge["stopContribution"]>,
  deleteContributionData: (request: ContributionDeleteRequest) =>
    invokeGuarded(
      IPC_CHANNELS.contributionDelete,
      contributionDeleteRequest(request)
    ) as ReturnType<TokenMonsterBridge["deleteContributionData"]>,
  refreshContributionDeletionStatus: (
    request: ContributionDeletionStatusRequest
  ) =>
    invokeGuarded(
      IPC_CHANNELS.contributionDeletionStatus,
      contributionDeletionStatusRequest(request)
    ) as ReturnType<TokenMonsterBridge["refreshContributionDeletionStatus"]>
});

contextBridge.exposeInMainWorld("tokenMonster", bridge);
