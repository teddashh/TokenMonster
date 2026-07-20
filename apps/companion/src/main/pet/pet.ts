import { Buffer } from "node:buffer"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  app,
  autoUpdater,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  WebContentsView,
  dialog,
  ipcMain,
  nativeImage,
  powerMonitor,
  safeStorage,
  screen,
  session,
  type IpcMainInvokeEvent,
  type NativeImage
} from "electron"

import type { TokenMonsterRuntimeLease } from "@tokenmonster/token-tracker-runtime"
import type { EncryptedSecretSlot } from "@tokenmonster/secret-vault"

import {
  createAutomaticUpdateController,
  type WindowsSquirrelUpdaterEventName,
  type WindowsSquirrelUpdaterListener,
  type WindowsSquirrelUpdaterPort
} from "../automatic-update-controller.js"
import { registerAutomaticUpdateIpcHandlers } from "../automatic-update-ipc.js"
import {
  createAutomaticUpdateService,
  type AutomaticUpdateService
} from "../automatic-update-service.js"
import { closeCompanionRuntimeLeaseAfter } from "../runtime-lease.js"
import {
  createReminderService,
  type ReminderService
} from "../reminder-service.js"
import { registerReminderIpcHandlers } from "../reminder-ipc.js"
import { installSessionGuards } from "../security.js"
import {
  DEFAULT_PET_WINDOW_STATE,
  placeDefaultPetWindowState,
  readPetWindowState,
  writePetWindowState,
  type PetWindowState
} from "./bounds-store.js"
import {
  createElectronAsyncSafeStoragePort,
  createPetByokSecretSlot
} from "./byok-vault.js"
import { originNavigationGuard, petViewUrl } from "./navigation.js"
import {
  isTrustedCompanionPngSender,
  parseCompanionPngSaveRequest,
  writeNewCompanionPng
} from "./png-save.js"
import {
  PET_STARTUP_MESSAGES,
  PetStartupError,
  closePetServices,
  startPetServices,
  type PetServices
} from "./services.js"
import { petShellDataUrl, type PetShellStatus } from "./shell-page.js"
import {
  COMPANION_PNG_SAVE_CHANNEL,
  type CompanionPngSaveResponse
} from "../../shared/companion-png.js"
import {
  type ReminderNotification
} from "../../shared/reminders.js"

const PET_DRAG_BAR_HEIGHT = 32
const PET_SESSION_PARTITION = "persist:tokenmonster-pet"
const PET_STATE_FILE = "pet-window-state.json"
const REMINDER_STATE_FILE = "reminders-v1.json"
const AUTOMATIC_UPDATE_STATE_FILE = "automatic-updates-v1.json"
const NATIVE_NOTIFICATION_TIMEOUT_MS = 5_000
// CI smoke mode: report the boot outcome on stdout and exit, so the packaged
// app (not just the dev tree) proves the sidecar and gateway actually start.
// Dual-gated (env var AND argv flag) so an inherited environment variable
// alone can never flip a real user's install into exit-after-boot behavior.
const SMOKE_MODE =
  process.env["TOKENMONSTER_SMOKE"] === "1" &&
  process.argv.includes("--tokenmonster-smoke")
const SMOKE_EXIT_TIMEOUT_MS = 10_000

function reportSmokeOutcome(
  outcome: "ok" | "gateway" | "sidecar",
  windDown: () => Promise<void>
): void {
  if (!SMOKE_MODE) return
  process.stdout.write(
    outcome === "ok"
      ? "TOKENMONSTER_SMOKE_OK\n"
      : `TOKENMONSTER_SMOKE_FAIL:${outcome}\n`
  )
  const code = outcome === "ok" ? 0 : 1
  // Wind services down first so the sidecar exits cleanly instead of being
  // torn down mid-write by app.exit; bound the wait so a wedged shutdown
  // cannot hang CI.
  const forced = setTimeout(() => app.exit(code), SMOKE_EXIT_TIMEOUT_MS)
  void windDown()
    .catch(() => undefined)
    .finally(() => {
      clearTimeout(forced)
      app.exit(code)
    })
}
const PET_SHELL_CHANNELS = Object.freeze({
  hideWindow: "tokenmonster:pet:hide-window",
  openDashboard: "tokenmonster:pet:open-dashboard",
  togglePin: "tokenmonster:pet:toggle-pin"
})

interface PetController {
  show(): void
}

let activeController: PetController | null = null

export function showPetWindow(): void {
  activeController?.show()
}

async function showNativeReminder(
  reminder: ReminderNotification
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const notification = new Notification({
      title: reminder.title,
      body: reminder.body,
      silent: reminder.silent
    })
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      notification.removeAllListeners("show")
      notification.removeAllListeners("failed")
      if (error === undefined) resolve()
      else reject(error)
    }
    const timeout = setTimeout(
      () => finish(new Error("REMINDER_NOTIFICATION_TIMEOUT")),
      NATIVE_NOTIFICATION_TIMEOUT_MS
    )
    notification.once("show", () => finish())
    notification.once("failed", (_event, error) =>
      finish(new Error(error || "REMINDER_NOTIFICATION_FAILED"))
    )
    notification.once("click", showPetWindow)
    try {
      notification.show()
    } catch (error: unknown) {
      finish(
        error instanceof Error
          ? error
          : new Error("REMINDER_NOTIFICATION_FAILED")
      )
    }
  })
}

function shellPreloadPath(): string {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "preload",
    "pet-shell.cjs"
  )
}

function companionPreloadPath(): string {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "preload",
    "companion.cjs"
  )
}

function isTrustedShellSender(
  event: IpcMainInvokeEvent,
  shellWindow: BrowserWindow
): boolean {
  return (
    !shellWindow.isDestroyed() &&
    event.sender === shellWindow.webContents &&
    event.senderFrame === shellWindow.webContents.mainFrame
  )
}

function updateGatewayViewBounds(
  shellWindow: BrowserWindow,
  gatewayView: WebContentsView | null
): void {
  if (gatewayView === null) return
  const contentSize = shellWindow.getContentSize()
  const width = contentSize[0] ?? 0
  const height = contentSize[1] ?? 0
  gatewayView.setBounds({
    x: 0,
    y: PET_DRAG_BAR_HEIGHT,
    width,
    height: Math.max(0, height - PET_DRAG_BAR_HEIGHT)
  })
}

function closeView(
  shellWindow: BrowserWindow,
  gatewayView: WebContentsView | null
): void {
  if (gatewayView === null) return
  if (!shellWindow.isDestroyed()) {
    shellWindow.contentView.removeChildView(gatewayView)
  }
  if (!gatewayView.webContents.isDestroyed()) gatewayView.webContents.close()
}

export async function startPetCompanion(
  runtimeLease: TokenMonsterRuntimeLease
): Promise<void> {
  installSessionGuards(session.fromPartition(PET_SESSION_PARTITION))
  const userDataDirectory = app.getPath("userData")
  const statePath = join(userDataDirectory, PET_STATE_FILE)
  const reminderService: ReminderService = await createReminderService({
    path: join(userDataDirectory, "private", REMINDER_STATE_FILE),
    notification: Object.freeze({
      isSupported: () => Notification.isSupported(),
      show: showNativeReminder
    }),
    locale: () => (app.getLocale().startsWith("en") ? "en" : "zh-TW")
  })
  const resumeReminders = (): void => {
    void reminderService.resume().catch(() => undefined)
  }
  powerMonitor.on("resume", resumeReminders)
  const restored = placeDefaultPetWindowState(
    await readPetWindowState(statePath),
    screen.getPrimaryDisplay().workArea
  )
  let pinned = restored.pinned
  let services: PetServices | null = null
  let petByokSecretSlot: EncryptedSecretSlot | null = null
  let gatewayView: WebContentsView | null = null
  let shellStatus: PetShellStatus = Object.freeze({ kind: "loading" })
  let startupOperation: Promise<void> | null = null
  let shutdownOperation: Promise<void> | null = null
  let quittingAllowed = false
  let updateWindowCloseAllowed = false
  let tray: Tray | null = null
  let automaticUpdateService: AutomaticUpdateService | null = null
  let removeReminderIpcHandlers = (): void => undefined
  let removeAutomaticUpdateIpcHandlers = (): void => undefined
  const dashboardWindows = new Set<BrowserWindow>()

  const shellWindow = new BrowserWindow({
    ...restored.bounds,
    alwaysOnTop: pinned,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    show: false,
    title: "TokenMonster",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: shellPreloadPath(),
      sandbox: true
    }
  })
  shellWindow.setAlwaysOnTop(pinned, "floating")
  shellWindow.setMenu(null)
  shellWindow.on("close", (event) => {
    // Alt+F4 / window-manager close would destroy the shell and crash every
    // later tray or activate callback; the pet hides to the tray instead.
    if (quittingAllowed || updateWindowCloseAllowed) return
    event.preventDefault()
    hideWindow()
  })

  const loadShell = async (): Promise<void> => {
    if (shellWindow.isDestroyed()) return
    await shellWindow.loadURL(petShellDataUrl(shellStatus, pinned))
  }

  const currentState = (): PetWindowState => {
    const bounds = shellWindow.isDestroyed()
      ? DEFAULT_PET_WINDOW_STATE.bounds
      : shellWindow.getBounds()
    return Object.freeze({ bounds: Object.freeze(bounds), pinned })
  }

  let persistence = Promise.resolve()
  const persistState = (): Promise<void> => {
    const snapshot = currentState()
    persistence = persistence
      .catch(() => undefined)
      .then(async () => writePetWindowState(statePath, snapshot))
    return persistence
  }

  const setPinned = (nextPinned: boolean): boolean => {
    pinned = nextPinned
    shellWindow.setAlwaysOnTop(pinned, "floating")
    void persistState()
    rebuildTrayMenu()
    return pinned
  }

  const showWindow = (): void => {
    if (shellWindow.isDestroyed()) return
    if (shellWindow.isMinimized()) shellWindow.restore()
    shellWindow.show()
    shellWindow.focus()
    rebuildTrayMenu()
  }

  const hideWindow = (): void => {
    if (shellWindow.isDestroyed()) return
    shellWindow.hide()
    rebuildTrayMenu()
  }

  const openDashboard = async (): Promise<void> => {
    const activeServices = services
    if (activeServices === null) return
    const dashboard = new BrowserWindow({
      width: 1160,
      height: 780,
      minWidth: 840,
      minHeight: 620,
      show: false,
      title: "TokenMonster dashboard",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        partition: PET_SESSION_PARTITION,
        preload: companionPreloadPath(),
        sandbox: true
      }
    })
    dashboard.setMenu(null)
    dashboardWindows.add(dashboard)
    dashboard.on("closed", () => {
      dashboardWindows.delete(dashboard)
    })
    dashboard.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    const dashboardNavigation = originNavigationGuard(activeServices.origin)
    dashboard.webContents.on("will-navigate", dashboardNavigation)
    dashboard.webContents.on("will-redirect", dashboardNavigation)
    dashboard.once("ready-to-show", () => dashboard.show())
    try {
      await dashboard.loadURL(`${activeServices.origin}/`)
    } catch {
      if (!dashboard.isDestroyed()) dashboard.destroy()
    }
  }

  function rebuildTrayMenu(): void {
    if (tray === null || shellWindow.isDestroyed()) return
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: shellWindow.isVisible()
            ? "隱藏 TokenMonster"
            : "顯示 TokenMonster",
          click: () => {
            if (shellWindow.isDestroyed()) return
            if (shellWindow.isVisible()) hideWindow()
            else showWindow()
          }
        },
        {
          label: pinned ? "取消置頂" : "保持置頂",
          click: () => {
            setPinned(!pinned)
          }
        },
        { label: "開啟完整 dashboard", click: () => void openDashboard() },
        { type: "separator" },
        { label: "結束 TokenMonster", click: () => app.quit() }
      ])
    )
  }

  const stopActiveServices = async (): Promise<void> => {
    const activeServices = services
    services = null
    // Orphaned dashboards would keep polling the old origin; once that port
    // is freed, any local process could reclaim it and harvest the session
    // cookie (host-only cookies on 127.0.0.1 are not port-scoped).
    for (const dashboard of dashboardWindows) {
      if (!dashboard.isDestroyed()) dashboard.destroy()
    }
    dashboardWindows.clear()
    closeView(shellWindow, gatewayView)
    gatewayView = null
    // Clear the cookie while we still own the loopback port, so nothing can
    // present it to whoever reclaims that port after closePetServices.
    try {
      await session
        .fromPartition(PET_SESSION_PARTITION)
        .clearStorageData({ storages: ["cookies"] })
    } catch {
      // Best effort: the next bootstrap overwrites the session cookie anyway.
    }
    await closePetServices(activeServices)
  }

  const stopOwnedRuntime = async (): Promise<void> => {
    await closeCompanionRuntimeLeaseAfter(stopActiveServices, runtimeLease)
  }

  const beginShutdown = (): void => {
    if (shutdownOperation !== null) return
    shutdownOperation = (async (): Promise<void> => {
      await closeCompanionRuntimeLeaseAfter(async () => {
        try {
          await persistState()
        } catch {
          // Persistence failure must not strand the loopback services.
        }
        await stopActiveServices()
        for (const channel of Object.values(PET_SHELL_CHANNELS)) {
          ipcMain.removeHandler(channel)
        }
        ipcMain.removeHandler(COMPANION_PNG_SAVE_CHANNEL)
        removeReminderIpcHandlers()
        removeAutomaticUpdateIpcHandlers()
        powerMonitor.off("resume", resumeReminders)
        reminderService.dispose()
        automaticUpdateService?.dispose()
        tray?.destroy()
        tray = null
        activeController = null
      }, runtimeLease)
    })()
      .catch(() => undefined)
      .finally(() => {
        quittingAllowed = true
        app.quit()
      })
  }

  const updaterPort: WindowsSquirrelUpdaterPort = Object.freeze({
    setFeedURL: (options: Readonly<{ url: string }>) =>
      autoUpdater.setFeedURL(options),
    checkForUpdates: () => autoUpdater.checkForUpdates(),
    quitAndInstall: () => autoUpdater.quitAndInstall(),
    on: (
      event: WindowsSquirrelUpdaterEventName,
      listener: WindowsSquirrelUpdaterListener
    ) => {
      switch (event) {
        case "before-quit-for-update":
          autoUpdater.on("before-quit-for-update", listener)
          break
        case "checking-for-update":
          autoUpdater.on("checking-for-update", listener)
          break
        case "update-available":
          autoUpdater.on("update-available", listener)
          break
        case "update-not-available":
          autoUpdater.on("update-not-available", listener)
          break
        case "update-downloaded":
          autoUpdater.on("update-downloaded", listener)
          break
        case "error":
          autoUpdater.on("error", listener)
          break
      }
    },
    removeListener: (
      event: WindowsSquirrelUpdaterEventName,
      listener: WindowsSquirrelUpdaterListener
    ) => {
      switch (event) {
        case "before-quit-for-update":
          autoUpdater.removeListener("before-quit-for-update", listener)
          break
        case "checking-for-update":
          autoUpdater.removeListener("checking-for-update", listener)
          break
        case "update-available":
          autoUpdater.removeListener("update-available", listener)
          break
        case "update-not-available":
          autoUpdater.removeListener("update-not-available", listener)
          break
        case "update-downloaded":
          autoUpdater.removeListener("update-downloaded", listener)
          break
        case "error":
          autoUpdater.removeListener("error", listener)
          break
      }
    }
  })
  const readyAutomaticUpdateService = await createAutomaticUpdateService({
    path: join(userDataDirectory, "private", AUTOMATIC_UPDATE_STATE_FILE),
    createController: (automaticChecksEnabled) =>
      createAutomaticUpdateController({
        updater: updaterPort,
        timer: Object.freeze({
          set: (delayMs: number, callback: () => void) =>
            setTimeout(callback, delayMs),
          clear: (handle: unknown) =>
            clearTimeout(handle as ReturnType<typeof setTimeout>)
        }),
        clock: Object.freeze({ now: () => new Date() }),
        platform: Object.freeze({ current: () => process.platform }),
        currentVersion: Object.freeze({ current: () => app.getVersion() }),
        automaticChecksEnabled,
        beforeQuitForUpdate: () => {
          // Electron closes updater-owned windows before its ordinary
          // before-quit event. Let that close proceed, but keep the app quit
          // intercepted until the loopback gateway and owned sidecar finish
          // the same bounded cleanup used by a normal pet quit.
          updateWindowCloseAllowed = true
          beginShutdown()
        }
      })
  })
  automaticUpdateService = readyAutomaticUpdateService

  const showFailure = async (kind: "gateway" | "sidecar"): Promise<void> => {
    if (SMOKE_MODE) {
      reportSmokeOutcome(kind, stopOwnedRuntime)
      return
    }
    await stopActiveServices()
    shellStatus = Object.freeze({
      kind: "error",
      message: PET_STARTUP_MESSAGES[kind]
    })
    await loadShell()
    showWindow()
  }

  const startServices = (): Promise<void> => {
    if (startupOperation !== null) return startupOperation
    startupOperation = (async (): Promise<void> => {
      shellStatus = Object.freeze({ kind: "loading" })
      await loadShell()
      await stopActiveServices()
      try {
        // Keep a successfully initialized RAM-only slot across a sidecar retry;
        // retry a null result so a transient keychain/directory failure can heal.
        petByokSecretSlot ??= await createPetByokSecretSlot({
          userDataDirectory,
          safeStorage: createElectronAsyncSafeStoragePort({
            isAsyncEncryptionAvailable: () =>
              safeStorage.isAsyncEncryptionAvailable(),
            getSelectedStorageBackend: () =>
              safeStorage.getSelectedStorageBackend(),
            encryptStringAsync: (plainText: string) =>
              safeStorage.encryptStringAsync(plainText),
            decryptStringAsync: (encrypted: Buffer) =>
              safeStorage.decryptStringAsync(encrypted)
          }),
          platform: process.platform
        })
        const started = await startPetServices(petByokSecretSlot)
        services = started
        const view = new WebContentsView({
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            partition: PET_SESSION_PARTITION,
            preload: companionPreloadPath(),
            sandbox: true
          }
        })
        gatewayView = view
        view.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
        const viewNavigation = originNavigationGuard(started.origin)
        view.webContents.on("will-navigate", viewNavigation)
        view.webContents.on("will-redirect", viewNavigation)
        shellWindow.contentView.addChildView(view)
        updateGatewayViewBounds(shellWindow, view)

        // This is the sole load of this gateway instance's one-shot URL. The
        // 303 response leaves the HttpOnly cookie in this persistent partition.
        // The gateway rejects query strings on the bootstrap path, so the
        // layout selector must not ride on it.
        await view.webContents.loadURL(started.bootstrapUrl)
        if (services !== started) return
        // The bootstrap redirect targets `/`, so a second navigation gives the
        // authenticated page its pet layout selector without replaying bootstrap.
        await view.webContents.loadURL(petViewUrl(`${started.origin}/`))
        if (services !== started) return
        shellStatus = Object.freeze({ kind: "ready" })
        await loadShell()
        reportSmokeOutcome("ok", stopOwnedRuntime)

        void started.runtime.closed.then((exit) => {
          if (services === started && !exit.expected) {
            void showFailure("sidecar")
          }
        })
      } catch (error: unknown) {
        // Local stderr only: the failure page hides every detail by design,
        // which would make packaged-app startup failures undiagnosable.
        console.error("TokenMonster pet startup failed:", error)
        await showFailure(
          error instanceof PetStartupError ? error.kind : "gateway"
        )
      }
    })().finally(() => {
      startupOperation = null
    })
    return startupOperation
  }

  for (const channel of Object.values(PET_SHELL_CHANNELS)) {
    ipcMain.removeHandler(channel)
  }
  ipcMain.removeHandler(COMPANION_PNG_SAVE_CHANNEL)
  const allowedCompanionSenders = (): ReadonlySet<object> => {
    const allowed = new Set<object>()
    if (gatewayView !== null && !gatewayView.webContents.isDestroyed()) {
      allowed.add(gatewayView.webContents)
    }
    for (const dashboard of dashboardWindows) {
      if (!dashboard.isDestroyed()) allowed.add(dashboard.webContents)
    }
    return allowed
  }
  const trustedCompanionSender = (event: IpcMainInvokeEvent): boolean => {
    const activeServices = services
    return (
      activeServices !== null &&
      isTrustedCompanionPngSender(
        event,
        allowedCompanionSenders(),
        activeServices.origin
      )
    )
  }
  let pngSaveInFlight = false
  ipcMain.handle(COMPANION_PNG_SAVE_CHANNEL, async (event, input: unknown) => {
    const activeServices = services
    if (activeServices === null) throw new Error("IPC_REQUEST_REJECTED")
    if (!trustedCompanionSender(event)) {
      throw new Error("IPC_REQUEST_REJECTED")
    }
    const request = parseCompanionPngSaveRequest(input)
    if (pngSaveInFlight) {
      return Object.freeze({
        status: "failed"
      }) satisfies CompanionPngSaveResponse
    }
    const parent =
      gatewayView !== null && event.sender === gatewayView.webContents
        ? shellWindow
        : ([...dashboardWindows].find(
            (dashboard) =>
              !dashboard.isDestroyed() && event.sender === dashboard.webContents
          ) ?? null)
    if (parent === null || parent.isDestroyed()) {
      throw new Error("IPC_REQUEST_REJECTED")
    }
    pngSaveInFlight = true
    try {
      const selected = await dialog.showSaveDialog(parent, {
        title: "儲存 TokenMonster 夥伴卡",
        defaultPath: request.suggestedName,
        buttonLabel: "建立 PNG",
        filters: [{ name: "PNG", extensions: ["png"] }],
        showsTagField: false,
        properties: ["dontAddToRecent"]
      })
      if (selected.canceled) {
        return Object.freeze({
          status: "cancelled"
        }) satisfies CompanionPngSaveResponse
      }
      return await writeNewCompanionPng({
        filePath: selected.filePath,
        bytes: request.bytes
      })
    } catch {
      return Object.freeze({
        status: "failed"
      }) satisfies CompanionPngSaveResponse
    } finally {
      pngSaveInFlight = false
    }
  })
  removeReminderIpcHandlers = registerReminderIpcHandlers({
    ipc: ipcMain,
    service: reminderService,
    trustedSender: trustedCompanionSender
  })
  removeAutomaticUpdateIpcHandlers = registerAutomaticUpdateIpcHandlers({
    ipc: ipcMain,
    service: readyAutomaticUpdateService,
    trustedSender: trustedCompanionSender
  })
  ipcMain.handle(PET_SHELL_CHANNELS.togglePin, (event) => {
    if (!isTrustedShellSender(event, shellWindow)) return false
    return setPinned(!pinned)
  })
  ipcMain.handle(PET_SHELL_CHANNELS.openDashboard, (event) => {
    if (!isTrustedShellSender(event, shellWindow)) return
    void openDashboard()
  })
  ipcMain.handle(PET_SHELL_CHANNELS.hideWindow, (event) => {
    if (!isTrustedShellSender(event, shellWindow)) return
    hideWindow()
  })

  shellWindow.on("resize", () =>
    updateGatewayViewBounds(shellWindow, gatewayView)
  )
  shellWindow.on("move", () => void persistState())
  shellWindow.webContents.on("did-navigate-in-page", (_event, url) => {
    if (
      shellStatus.kind === "error" &&
      new URL(url).hash.startsWith("#retry-")
    ) {
      void startServices()
    }
  })
  shellWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  shellWindow.webContents.on("will-navigate", (event) => event.preventDefault())

  let trayIcon: NativeImage
  try {
    trayIcon = await app.getFileIcon(process.execPath, { size: "small" })
  } catch {
    // Iconless environments (e.g. bare X under CI) have no file icon; a
    // blank tray image keeps the menu and click target functional.
    trayIcon = nativeImage.createEmpty()
  }
  tray = new Tray(trayIcon)
  tray.setToolTip("TokenMonster")
  tray.on("click", () => {
    if (shellWindow.isDestroyed()) return
    if (shellWindow.isVisible()) hideWindow()
    else showWindow()
  })
  rebuildTrayMenu()

  activeController = Object.freeze({ show: showWindow })
  app.on("activate", showWindow)
  app.on("before-quit", (event) => {
    if (quittingAllowed) return
    event.preventDefault()
    beginShutdown()
  })

  await loadShell()
  showWindow()
  await startServices()
}
