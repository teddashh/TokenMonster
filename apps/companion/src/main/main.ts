import { Buffer } from "node:buffer"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  powerMonitor,
  protocol,
  safeStorage,
  session,
  type IpcMainInvokeEvent
} from "electron"

import { createOpenAiByokAdapter } from "@tokenmonster/byok-openai"
import { CharacterIdSchema } from "@tokenmonster/characters"
import {
  createEncryptedSecretSlot,
  type AsyncSafeStoragePort
} from "@tokenmonster/secret-vault"
import { openLocalStore, type LocalStore } from "@tokenmonster/local-store"
import {
  createContributionService,
  createContributionSyncScheduler,
  type ContributionService,
  type ContributionSyncScheduler
} from "@tokenmonster/contribution-runtime"

import {
  createFixedInteraction,
  getCompanionBootstrap,
  selectCompanionCharacter
} from "./bridge-domain.js"
import { createByokChatService, type ByokChatService } from "./byok-chat.js"
import {
  createTokscaleCollectorService,
  type CompanionCollectorService
} from "./collector-service.js"
import { deriveLocalMonsterSummary } from "./monster-state.js"
import {
  createLocalDataExport,
  createShareCardSvg,
  createSupportDiagnostic,
  parseFixedJsonExportRequest,
  parseLocalSourceResetRequest,
  parseShareCardSaveRequest,
  writeNewUserSelectedFile
} from "./local-actions.js"
import {
  deleteContributionWithSchedulerPaused,
  stopContributionWithSchedulerPaused
} from "./contribution-scheduler-boundary.js"
import {
  ensurePrivateChildDirectory,
  ensurePrivateCollectorDirectory
} from "./private-directory.js"
import { verifiedPackagedTokscaleBinary } from "./packaged-collector.js"
import {
  initializeLocalConfig,
  localRuntimeStatus,
  saveSelectedCharacter,
  stopContributionForLocalSourceReset
} from "./local-state.js"
import { showPetWindow, startPetCompanion } from "./pet/pet.js"
import { acquireCompanionRuntimeLease } from "./runtime-lease.js"
import {
  closeLegacyOwnedServices,
  createLegacyStartupFence,
  createLegacyShutdownCoordinator,
  disposeLegacyOwnedServices,
  startLegacyRuntimeWithOwnedLease
} from "./legacy-shutdown.js"
import {
  createFatalQuitController,
  createPetStartupQuitBridge,
  handleModeAwareBeforeQuit,
  runPetStartupWithOwnedLease
} from "./graceful-fatal-quit.js"
import {
  closeLegacyAppWhenWindowless,
  suspendLegacyWindowByok
} from "./legacy-window-lifecycle.js"
import {
  RENDERER_CSP,
  createIpcRequestGate,
  installSessionGuards,
  isTrustedIpcSender,
  isTrustedRendererUrl,
  resolveRendererAsset,
  secureWebPreferences
} from "./security.js"
import { IPC_CHANNELS, TOKENMONSTER_APP_ORIGIN } from "../shared/ipc.js"
import type {
  LocalFileSaveResponse,
  LocalUsageInsights
} from "../shared/ipc.js"

import { handleDefaultSquirrelStartup } from "./squirrel-startup.js"

function run(): void {
  if (handleDefaultSquirrelStartup(() => app.quit())) {
    return
  }

  protocol.registerSchemesAsPrivileged([
    {
      scheme: "tokenmonster",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: false,
        corsEnabled: false,
        bypassCSP: false
      }
    }
  ])
  app.enableSandbox()
  const petMode = !process.argv.slice(1).includes("--legacy")
  const ownsSingleInstance = app.requestSingleInstanceLock()
  const ipcGate = createIpcRequestGate()
  const fatalQuit = createFatalQuitController(app)
  const petStartupQuit = createPetStartupQuitBridge(() => app.quit())
  const legacyStartup = createLegacyStartupFence()
  let byokService: ByokChatService | null = null
  let collectorService: CompanionCollectorService | null = null
  let contributionService: ContributionService | null = null
  let contributionSyncScheduler: ContributionSyncScheduler | null = null
  let localStore: LocalStore | null = null
  let lastSuccessfulScanAt: string | null = null
  let legacyWindow: BrowserWindow | null = null
  let legacyRuntimeLease:
    | import("@tokenmonster/token-tracker-runtime").TokenMonsterRuntimeLease
    | null = null
  const legacyShutdown = createLegacyShutdownCoordinator({
    closeOwnedServices: async () => {
      legacyStartup.requestShutdown()
      const startupScheduler = contributionSyncScheduler
      disposeLegacyOwnedServices({
        scheduler: startupScheduler,
        detachScheduler:
          startupScheduler === null
            ? null
            : () => powerMonitor.off("resume", startupScheduler.wake),
        byok: byokService,
        contribution: contributionService,
        collector: collectorService,
        store: localStore
      })
      const startupWindow = legacyWindow
      legacyWindow = null
      if (startupWindow !== null && !startupWindow.isDestroyed()) {
        startupWindow.destroy()
      }
      await legacyStartup.join()
      const scheduler = contributionSyncScheduler
      const contribution = contributionService
      const services = Object.freeze({
        scheduler,
        detachScheduler:
          scheduler === null
            ? null
            : () => powerMonitor.off("resume", scheduler.wake),
        byok: byokService,
        contribution,
        collector: collectorService,
        store: localStore
      })
      contributionSyncScheduler = null
      byokService = null
      contributionService = null
      collectorService = null
      localStore = null
      await closeLegacyOwnedServices(services)
    },
    releaseLease: async () => {
      const lease = legacyRuntimeLease
      legacyRuntimeLease = null
      await lease?.release()
    },
    quit: fatalQuit.completeLegacyShutdown
  })

  function trustedSender(event: IpcMainInvokeEvent): boolean {
    return isTrustedIpcSender(event)
  }

  function requireTrustedSender(event: IpcMainInvokeEvent): void {
    if (!trustedSender(event)) {
      throw new Error("IPC_REQUEST_REJECTED")
    }
  }

  async function handleIpc<T>(
    event: IpcMainInvokeEvent,
    channel: string,
    operation: () => T | Promise<T>
  ): Promise<T> {
    let release: (() => void) | null = null
    try {
      requireTrustedSender(event)
      release = ipcGate.enter(event.sender, channel)
      return await operation()
    } catch {
      throw new Error("IPC_REQUEST_REJECTED")
    } finally {
      release?.()
    }
  }

  async function saveUserSelectedFile(
    event: IpcMainInvokeEvent,
    options: Readonly<{
      title: string
      defaultPath: string
      extension: ".json" | ".svg"
      content: string
    }>
  ): Promise<LocalFileSaveResponse> {
    const parent = BrowserWindow.fromWebContents(event.sender)
    if (parent === null) return Object.freeze({ status: "failed" })
    const selected = await dialog.showSaveDialog(parent, {
      title: options.title,
      defaultPath: options.defaultPath,
      buttonLabel: "建立新檔案",
      filters: [
        {
          name: options.extension === ".svg" ? "SVG" : "JSON",
          extensions: [options.extension.slice(1)]
        }
      ],
      showsTagField: false,
      properties: ["dontAddToRecent"]
    })
    if (selected.canceled) return Object.freeze({ status: "cancelled" })
    if (selected.filePath.length === 0) {
      return Object.freeze({ status: "invalid-selection" })
    }
    return await writeNewUserSelectedFile({
      filePath: selected.filePath,
      extension: options.extension,
      content: options.content
    })
  }

  function registerIpc(
    service: ByokChatService,
    collector: CompanionCollectorService,
    store: LocalStore,
    contribution: ContributionService,
    backgroundSync: ContributionSyncScheduler
  ): void {
    let collectorControlBusy = false
    ipcMain.handle(IPC_CHANNELS.bootstrap, (event) =>
      handleIpc(event, IPC_CHANNELS.bootstrap, () =>
        getCompanionBootstrap(
          service.status(),
          localRuntimeStatus(store, lastSuccessfulScanAt),
          deriveLocalMonsterSummary(
            store,
            store.getConfig()?.selectedCharacterId ?? "chatgpt"
          ),
          contribution.status()
        )
      )
    )
    ipcMain.handle(IPC_CHANNELS.usageInsights, (event, input: unknown) =>
      handleIpc(
        event,
        IPC_CHANNELS.usageInsights,
        () => store.getLocalUsageInsights(input) satisfies LocalUsageInsights
      )
    )
    ipcMain.handle(
      IPC_CHANNELS.selectCharacter,
      (event, characterId: unknown) =>
        handleIpc(event, IPC_CHANNELS.selectCharacter, () => {
          const selectedCharacterId = CharacterIdSchema.parse(characterId)
          saveSelectedCharacter(store, selectedCharacterId)
          service.selectCharacter(selectedCharacterId)
          const data = selectCompanionCharacter(
            selectedCharacterId,
            service.status(),
            localRuntimeStatus(store, lastSuccessfulScanAt),
            deriveLocalMonsterSummary(store, selectedCharacterId),
            contribution.status()
          )
          return data
        })
    )
    ipcMain.handle(IPC_CHANNELS.fixedInteraction, (event, input: unknown) =>
      handleIpc(event, IPC_CHANNELS.fixedInteraction, () =>
        createFixedInteraction(
          input,
          Date.now() % Number.MAX_SAFE_INTEGER,
          deriveLocalMonsterSummary(
            store,
            store.getConfig()?.selectedCharacterId ?? "chatgpt"
          )
        )
      )
    )
    ipcMain.handle(IPC_CHANNELS.configureByok, (event, input: unknown) =>
      handleIpc(event, IPC_CHANNELS.configureByok, () =>
        service.configure(input)
      )
    )
    ipcMain.handle(IPC_CHANNELS.clearByok, (event) =>
      handleIpc(event, IPC_CHANNELS.clearByok, () => service.clear())
    )
    ipcMain.handle(IPC_CHANNELS.byokChat, (event, input: unknown) =>
      handleIpc(event, IPC_CHANNELS.byokChat, () => service.send(input))
    )
    ipcMain.handle(IPC_CHANNELS.scanUsage, (event, input: unknown) =>
      handleIpc(event, IPC_CHANNELS.scanUsage, async () => {
        if (collectorControlBusy) throw new Error("IPC_REQUEST_BUSY")
        collectorControlBusy = true
        try {
          const result = await collector.scan(input)
          if (result.kind === "applied") backgroundSync.wake()
          return result
        } finally {
          collectorControlBusy = false
        }
      })
    )
    ipcMain.handle(IPC_CHANNELS.saveShareCard, (event, input: unknown) =>
      handleIpc(event, IPC_CHANNELS.saveShareCard, async () => {
        const request = parseShareCardSaveRequest(input)
        const insights = store.getLocalUsageInsights({
          windowDays: request.windowDays
        })
        return await saveUserSelectedFile(event, {
          title: "儲存 TokenMonster 本機足跡分享卡",
          defaultPath: "tokenmonster-local-summary.svg",
          extension: ".svg",
          content: createShareCardSvg(request.characterId, insights)
        })
      })
    )
    ipcMain.handle(IPC_CHANNELS.exportLocalData, (event, input: unknown) =>
      handleIpc(event, IPC_CHANNELS.exportLocalData, async () => {
        parseFixedJsonExportRequest(input)
        return await saveUserSelectedFile(event, {
          title: "匯出 TokenMonster 本機資料",
          defaultPath: "tokenmonster-local-data.json",
          extension: ".json",
          content: createLocalDataExport(store)
        })
      })
    )
    ipcMain.handle(
      IPC_CHANNELS.exportSupportDiagnostic,
      (event, input: unknown) =>
        handleIpc(event, IPC_CHANNELS.exportSupportDiagnostic, async () => {
          parseFixedJsonExportRequest(input)
          const platform =
            process.platform === "darwin" ||
            process.platform === "linux" ||
            process.platform === "win32"
              ? process.platform
              : "other"
          return await saveUserSelectedFile(event, {
            title: "匯出 TokenMonster 支援診斷",
            defaultPath: "tokenmonster-support-diagnostic.json",
            extension: ".json",
            content: createSupportDiagnostic({
              generatedAt: new Date().toISOString(),
              appVersion: app.getVersion(),
              platform,
              localStore: store.getDiagnosticSummary()
            })
          })
        })
    )
    ipcMain.handle(IPC_CHANNELS.resetLocalSourceData, (event, input: unknown) =>
      handleIpc(event, IPC_CHANNELS.resetLocalSourceData, async () => {
        if (collectorControlBusy) throw new Error("IPC_REQUEST_BUSY")
        collectorControlBusy = true
        try {
          parseLocalSourceResetRequest(input)
          backgroundSync.pause()
          try {
            await stopContributionForLocalSourceReset(contribution)
          } catch (error: unknown) {
            if (contribution.status().enabled) backgroundSync.wake()
            throw error
          }
          collector.dispose()
          await collector.quiesce()
          store.clearCollectorAuthority()
          lastSuccessfulScanAt = null
          return Object.freeze({
            status: "reset" as const,
            byokPreserved: true as const
          })
        } finally {
          collectorControlBusy = false
        }
      })
    )
    ipcMain.handle(IPC_CHANNELS.contributionStatus, (event) =>
      handleIpc(event, IPC_CHANNELS.contributionStatus, () =>
        contribution.status()
      )
    )
    ipcMain.handle(IPC_CHANNELS.contributionPreview, (event, input: unknown) =>
      handleIpc(event, IPC_CHANNELS.contributionPreview, async () => {
        assertFixedConfirmation(input, "preview-content-blind-contribution")
        return await contribution.preparePreview()
      })
    )
    ipcMain.handle(IPC_CHANNELS.contributionEnable, (event, input: unknown) =>
      handleIpc(event, IPC_CHANNELS.contributionEnable, async () => {
        const previewId = parseContributionEnableRequest(input)
        const result = await contribution.enable(previewId)
        if (result.ok) backgroundSync.wake()
        return result
      })
    )
    ipcMain.handle(IPC_CHANNELS.contributionSync, (event, input: unknown) =>
      handleIpc(event, IPC_CHANNELS.contributionSync, async () => {
        assertFixedConfirmation(input, "sync-content-blind-contribution")
        return await contribution.sync()
      })
    )
    ipcMain.handle(IPC_CHANNELS.contributionStop, (event, input: unknown) =>
      handleIpc(event, IPC_CHANNELS.contributionStop, async () => {
        assertFixedConfirmation(input, "stop-content-blind-contribution")
        return await stopContributionWithSchedulerPaused(
          contribution,
          backgroundSync
        )
      })
    )
    ipcMain.handle(IPC_CHANNELS.contributionDelete, (event, input: unknown) =>
      handleIpc(event, IPC_CHANNELS.contributionDelete, async () => {
        assertFixedConfirmation(input, "delete-identifiable-contribution-data")
        return await deleteContributionWithSchedulerPaused(
          contribution,
          backgroundSync
        )
      })
    )
    ipcMain.handle(
      IPC_CHANNELS.contributionDeletionStatus,
      (event, input: unknown) =>
        handleIpc(event, IPC_CHANNELS.contributionDeletionStatus, async () => {
          assertFixedConfirmation(input, "check-contribution-deletion-status")
          return await contribution.refreshDeletionStatus()
        })
    )
  }

  function exactDataRecord(
    input: unknown,
    expectedKeys: readonly string[]
  ): Record<string, unknown> {
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input) ||
      (Object.getPrototypeOf(input) !== Object.prototype &&
        Object.getPrototypeOf(input) !== null)
    ) {
      throw new Error("IPC_REQUEST_REJECTED")
    }
    const record = input as Record<string, unknown>
    const keys = Reflect.ownKeys(record)
    if (
      keys.length !== expectedKeys.length ||
      keys.some(
        (key) => typeof key !== "string" || !expectedKeys.includes(key)
      ) ||
      expectedKeys.some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(record, key)
        return descriptor === undefined || !("value" in descriptor)
      })
    ) {
      throw new Error("IPC_REQUEST_REJECTED")
    }
    return record
  }

  function assertFixedConfirmation(input: unknown, expected: string): void {
    const record = exactDataRecord(input, ["confirmation"])
    if (record["confirmation"] !== expected) {
      throw new Error("IPC_REQUEST_REJECTED")
    }
  }

  function parseContributionEnableRequest(input: unknown): string {
    const record = exactDataRecord(input, ["confirmation", "previewId"])
    const previewId = record["previewId"]
    if (
      record["confirmation"] !== "enable-content-blind-contribution" ||
      typeof previewId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        previewId
      )
    ) {
      throw new Error("IPC_REQUEST_REJECTED")
    }
    return previewId
  }

  async function registerRendererProtocol(): Promise<void> {
    const mainDirectory = dirname(fileURLToPath(import.meta.url))
    const rendererRoot = join(mainDirectory, "..", "..", "renderer")
    await protocol.handle("tokenmonster", async (request) => {
      const asset = resolveRendererAsset(rendererRoot, request.url)
      if (asset === null) {
        return new Response(null, { status: 404 })
      }
      try {
        const body = await readFile(asset.path)
        return new Response(new Uint8Array(body), {
          status: 200,
          headers: {
            "Content-Type": asset.contentType,
            "Content-Security-Policy": RENDERER_CSP,
            "Cache-Control": "no-store",
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cross-Origin-Resource-Policy": "same-origin",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff"
          }
        })
      } catch {
        return new Response(null, { status: 404 })
      }
    })
  }

  function hardenSession(): void {
    installSessionGuards(session.defaultSession)
  }

  async function createWindow(): Promise<BrowserWindow> {
    const preloadPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "preload",
      "index.cjs"
    )
    const window = new BrowserWindow({
      width: 1160,
      height: 780,
      minWidth: 840,
      minHeight: 620,
      show: false,
      backgroundColor: "#f4f0e8",
      title: "TokenMonster",
      webPreferences: secureWebPreferences(preloadPath, !app.isPackaged)
    })
    legacyWindow = window
    let closeRequested = false
    window.once("close", () => {
      closeRequested = true
    })
    window.webContents.on("will-navigate", (event, targetUrl) => {
      if (!isTrustedRendererUrl(targetUrl)) {
        event.preventDefault()
      }
    })
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    window.once("ready-to-show", () => window.show())
    window.once("closed", () => {
      if (legacyWindow === window) legacyWindow = null
      suspendLegacyWindowByok(byokService)
    })
    try {
      await window.loadURL(`${TOKENMONSTER_APP_ORIGIN}/index.html`)
    } catch {
      if (closeRequested) return window
      if (!legacyStartup.shutdownRequested()) {
        fatalQuit.markLegacyFatalIntent()
      }
      if (!window.isDestroyed()) window.destroy()
      throw new Error("RENDERER_START_FAILED")
    }
    return window
  }

  function electronSafeStoragePort(): AsyncSafeStoragePort {
    return Object.freeze({
      isAsyncEncryptionAvailable: () =>
        safeStorage.isAsyncEncryptionAvailable(),
      getSelectedStorageBackend: () => safeStorage.getSelectedStorageBackend(),
      encryptStringAsync: async (plainText: string) =>
        new Uint8Array(await safeStorage.encryptStringAsync(plainText)),
      decryptStringAsync: async (encrypted: Uint8Array) => {
        const decrypted = await safeStorage.decryptStringAsync(
          Buffer.from(encrypted)
        )
        return Object.freeze({
          result: decrypted.result,
          shouldReEncrypt: decrypted.shouldReEncrypt
        })
      }
    })
  }

  async function startCompanion(): Promise<void> {
    legacyStartup.assertRunning()
    hardenSession()
    await registerRendererProtocol()
    legacyStartup.assertRunning()
    const userDataDirectory = app.getPath("userData")
    const dataDirectory = await ensurePrivateChildDirectory(userDataDirectory, [
      "data"
    ])
    legacyStartup.assertRunning()
    const secretsDirectory = await ensurePrivateChildDirectory(
      userDataDirectory,
      ["secrets"]
    )
    legacyStartup.assertRunning()
    if (dataDirectory === null || secretsDirectory === null) {
      throw new Error("PRIVATE_STORAGE_DIRECTORY_UNAVAILABLE")
    }
    const store = await openLocalStore({
      path: join(dataDirectory, "tokenmonster.sqlite")
    })
    localStore = store
    legacyStartup.assertRunning()
    lastSuccessfulScanAt = store.getLastSuccessfulScanAt()
    const config = initializeLocalConfig(
      store,
      Intl.DateTimeFormat().resolvedOptions().timeZone
    )
    selectCompanionCharacter(
      config.selectedCharacterId,
      undefined,
      localRuntimeStatus(store, lastSuccessfulScanAt)
    )
    const secretSlot = createEncryptedSecretSlot({
      safeStorage: electronSafeStoragePort(),
      platform: process.platform,
      filePath: join(secretsDirectory, "openai-byok.json")
    })
    const service = createByokChatService({
      adapter: createOpenAiByokAdapter(),
      secretSlot,
      initialCharacterId: config.selectedCharacterId
    })
    byokService = service
    await service.initialize()
    legacyStartup.assertRunning()
    const uploadCredential = createEncryptedSecretSlot({
      safeStorage: electronSafeStoragePort(),
      platform: process.platform,
      filePath: join(secretsDirectory, "contribution-upload.json")
    })
    const deletionCredential = createEncryptedSecretSlot({
      safeStorage: electronSafeStoragePort(),
      platform: process.platform,
      filePath: join(secretsDirectory, "contribution-deletion.json")
    })
    const statusCredential = createEncryptedSecretSlot({
      safeStorage: electronSafeStoragePort(),
      platform: process.platform,
      filePath: join(secretsDirectory, "contribution-status.json")
    })
    const pendingEnrollmentCredential = createEncryptedSecretSlot({
      safeStorage: electronSafeStoragePort(),
      platform: process.platform,
      filePath: join(secretsDirectory, "contribution-enrollment-pending.json")
    })
    const contribution = createContributionService({
      store,
      uploadCredential,
      deletionCredential,
      statusCredential,
      pendingEnrollmentCredential,
      configuredBaseUrl: process.env["TOKENMONSTER_API_BASE_URL"]
    })
    contributionService = contribution
    await contribution.initialize()
    legacyStartup.assertRunning()
    const backgroundSync = createContributionSyncScheduler({ contribution })
    contributionSyncScheduler = backgroundSync
    const collectorConfigDirectory =
      await ensurePrivateCollectorDirectory(userDataDirectory)
    legacyStartup.assertRunning()
    const packagedCollectorBinary = app.isPackaged
      ? await verifiedPackagedTokscaleBinary({
          appPath: app.getAppPath(),
          resourcesPath: process.resourcesPath
        })
      : undefined
    legacyStartup.assertRunning()
    const collectorRuntimeReady =
      collectorConfigDirectory !== null &&
      (!app.isPackaged || packagedCollectorBinary !== null)
    const collector = createTokscaleCollectorService({
      store,
      configDir:
        collectorRuntimeReady && collectorConfigDirectory !== null
          ? collectorConfigDirectory
          : "",
      ...(typeof packagedCollectorBinary === "string"
        ? { binaryPath: packagedCollectorBinary }
        : {}),
      onApplied: (at) => {
        lastSuccessfulScanAt = at
        try {
          store.setLastSuccessfulScanAt(at)
        } catch {
          // The absolute aggregate commit remains valid even if this optional
          // content-free UX timestamp cannot be persisted.
        }
      }
    })
    collectorService = collector
    registerIpc(service, collector, store, contribution, backgroundSync)
    powerMonitor.on("resume", backgroundSync.wake)
    backgroundSync.start()
    await createWindow()
    legacyStartup.assertRunning()

    app.on("activate", () => {
      if (legacyStartup.shutdownRequested()) return
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow().catch((error: unknown) => {
          if (legacyStartup.shutdownRequested()) return
          console.error("TokenMonster window creation failed:", error)
          fatalQuit.requestLegacyFatalQuit()
        })
      }
    })
  }

  async function showRuntimeLeaseFailure(
    kind: "already-running" | "unavailable"
  ): Promise<void> {
    try {
      await dialog.showMessageBox({
        type: kind === "already-running" ? "info" : "error",
        title: "TokenMonster",
        message:
          kind === "already-running"
            ? "TokenMonster 已在執行中"
            : "TokenMonster 暫時無法啟動",
        detail:
          kind === "already-running"
            ? "請使用已開啟的 TokenMonster，或先關閉它再試。"
            : "無法取得本機執行權。請重新啟動系統後再試。",
        buttons: ["確定"],
        defaultId: 0,
        noLink: true
      })
    } catch {
      // Headless startup still exits with the same sanitized state.
    }
  }

  async function startRuntimeOwnedCompanion(): Promise<void> {
    if (!petMode) legacyStartup.assertRunning()
    const result = await acquireCompanionRuntimeLease()
    if (result.kind !== "acquired") {
      if (!petMode) legacyStartup.assertRunning()
      await showRuntimeLeaseFailure(result.kind)
      app.quit()
      return
    }
    if (petMode) {
      await runPetStartupWithOwnedLease(result.lease, startPetCompanion)
      return
    }
    await startLegacyRuntimeWithOwnedLease(
      result.lease,
      (lease) => {
        legacyRuntimeLease = lease
      },
      async () => {
        legacyStartup.assertRunning()
        await startCompanion()
      }
    )
  }

  if (!ownsSingleInstance) {
    app.quit()
  } else {
    app.on("second-instance", () => {
      if (petMode) {
        showPetWindow()
        return
      }
      const window = BrowserWindow.getAllWindows()[0]
      if (window !== undefined) {
        if (window.isMinimized()) window.restore()
        window.focus()
      }
    })
    const startupOperation = app.whenReady().then(startRuntimeOwnedCompanion)
    if (petMode) petStartupQuit.track(startupOperation)
    else legacyStartup.track(startupOperation)
    void startupOperation.catch((error: unknown) => {
      if (!petMode && legacyStartup.shutdownRequested()) return
      // Local stderr only: a silent exit(1) is undiagnosable in the field.
      console.error("TokenMonster startup failed:", error)
      if (petMode) fatalQuit.exitPetFatalAfterDrain()
      else fatalQuit.requestLegacyFatalQuit()
    })
  }

  app.on("before-quit", (event) => {
    if (petMode && petStartupQuit.handleBeforeQuit(event)) return
    handleModeAwareBeforeQuit(petMode, legacyShutdown, event)
  })

  app.on("window-all-closed", () => {
    if (petMode) return
    closeLegacyAppWhenWindowless(process.platform, () => app.quit())
  })
}

run()
