import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  WebContentsView,
  ipcMain,
  nativeImage,
  session,
  type IpcMainInvokeEvent,
  type NativeImage
} from "electron";

import { installSessionGuards } from "../security.js";
import {
  DEFAULT_PET_WINDOW_STATE,
  readPetWindowState,
  writePetWindowState,
  type PetWindowState
} from "./bounds-store.js";
import { originNavigationGuard } from "./navigation.js";
import {
  PET_STARTUP_MESSAGES,
  PetStartupError,
  closePetServices,
  startPetServices,
  type PetServices
} from "./services.js";
import { petShellDataUrl, type PetShellStatus } from "./shell-page.js";

const PET_DRAG_BAR_HEIGHT = 32;
const PET_SESSION_PARTITION = "persist:tokenmonster-pet";
const PET_STATE_FILE = "pet-window-state.json";
// CI smoke mode: report the boot outcome on stdout and exit, so the packaged
// app (not just the dev tree) proves the sidecar and gateway actually start.
// Dual-gated (env var AND argv flag) so an inherited environment variable
// alone can never flip a real user's install into exit-after-boot behavior.
const SMOKE_MODE =
  process.env["TOKENMONSTER_SMOKE"] === "1" &&
  process.argv.includes("--tokenmonster-smoke");
const SMOKE_EXIT_TIMEOUT_MS = 10_000;

function reportSmokeOutcome(
  outcome: "ok" | "gateway" | "sidecar",
  windDown: () => Promise<void>
): void {
  if (!SMOKE_MODE) return;
  process.stdout.write(
    outcome === "ok" ? "TOKENMONSTER_SMOKE_OK\n" : `TOKENMONSTER_SMOKE_FAIL:${outcome}\n`
  );
  const code = outcome === "ok" ? 0 : 1;
  // Wind services down first so the sidecar exits cleanly instead of being
  // torn down mid-write by app.exit; bound the wait so a wedged shutdown
  // cannot hang CI.
  const forced = setTimeout(() => app.exit(code), SMOKE_EXIT_TIMEOUT_MS);
  void windDown()
    .catch(() => undefined)
    .finally(() => {
      clearTimeout(forced);
      app.exit(code);
    });
}
const PET_SHELL_CHANNELS = Object.freeze({
  hideWindow: "tokenmonster:pet:hide-window",
  openDashboard: "tokenmonster:pet:open-dashboard",
  togglePin: "tokenmonster:pet:toggle-pin"
});

interface PetController {
  show(): void;
}

let activeController: PetController | null = null;

export function showPetWindow(): void {
  activeController?.show();
}

function shellPreloadPath(): string {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "preload",
    "pet-shell.cjs"
  );
}

function isTrustedShellSender(
  event: IpcMainInvokeEvent,
  shellWindow: BrowserWindow
): boolean {
  return (
    !shellWindow.isDestroyed() &&
    event.sender === shellWindow.webContents &&
    event.senderFrame === shellWindow.webContents.mainFrame
  );
}

function updateGatewayViewBounds(
  shellWindow: BrowserWindow,
  gatewayView: WebContentsView | null
): void {
  if (gatewayView === null) return;
  const contentSize = shellWindow.getContentSize();
  const width = contentSize[0] ?? 0;
  const height = contentSize[1] ?? 0;
  gatewayView.setBounds({
    x: 0,
    y: PET_DRAG_BAR_HEIGHT,
    width,
    height: Math.max(0, height - PET_DRAG_BAR_HEIGHT)
  });
}

function closeView(
  shellWindow: BrowserWindow,
  gatewayView: WebContentsView | null
): void {
  if (gatewayView === null) return;
  if (!shellWindow.isDestroyed()) {
    shellWindow.contentView.removeChildView(gatewayView);
  }
  if (!gatewayView.webContents.isDestroyed()) gatewayView.webContents.close();
}

export async function startPetCompanion(): Promise<void> {
  installSessionGuards(session.fromPartition(PET_SESSION_PARTITION));
  const statePath = join(app.getPath("userData"), PET_STATE_FILE);
  const restored = await readPetWindowState(statePath);
  let pinned = restored.pinned;
  let services: PetServices | null = null;
  let gatewayView: WebContentsView | null = null;
  let shellStatus: PetShellStatus = Object.freeze({ kind: "loading" });
  let startupOperation: Promise<void> | null = null;
  let shutdownOperation: Promise<void> | null = null;
  let quittingAllowed = false;
  let tray: Tray | null = null;
  const dashboardWindows = new Set<BrowserWindow>();

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
  });
  shellWindow.setAlwaysOnTop(pinned, "floating");
  shellWindow.setMenu(null);
  shellWindow.on("close", (event) => {
    // Alt+F4 / window-manager close would destroy the shell and crash every
    // later tray or activate callback; the pet hides to the tray instead.
    if (quittingAllowed) return;
    event.preventDefault();
    hideWindow();
  });

  const loadShell = async (): Promise<void> => {
    if (shellWindow.isDestroyed()) return;
    await shellWindow.loadURL(petShellDataUrl(shellStatus, pinned));
  };

  const currentState = (): PetWindowState => {
    const bounds = shellWindow.isDestroyed()
      ? DEFAULT_PET_WINDOW_STATE.bounds
      : shellWindow.getBounds();
    return Object.freeze({ bounds: Object.freeze(bounds), pinned });
  };

  let persistence = Promise.resolve();
  const persistState = (): Promise<void> => {
    const snapshot = currentState();
    persistence = persistence
      .catch(() => undefined)
      .then(async () => writePetWindowState(statePath, snapshot));
    return persistence;
  };

  const setPinned = (nextPinned: boolean): boolean => {
    pinned = nextPinned;
    shellWindow.setAlwaysOnTop(pinned, "floating");
    void persistState();
    rebuildTrayMenu();
    return pinned;
  };

  const showWindow = (): void => {
    if (shellWindow.isDestroyed()) return;
    if (shellWindow.isMinimized()) shellWindow.restore();
    shellWindow.show();
    shellWindow.focus();
    rebuildTrayMenu();
  };

  const hideWindow = (): void => {
    if (shellWindow.isDestroyed()) return;
    shellWindow.hide();
    rebuildTrayMenu();
  };

  const openDashboard = async (): Promise<void> => {
    const activeServices = services;
    if (activeServices === null) return;
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
        sandbox: true
      }
    });
    dashboard.setMenu(null);
    dashboardWindows.add(dashboard);
    dashboard.on("closed", () => {
      dashboardWindows.delete(dashboard);
    });
    dashboard.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const dashboardNavigation = originNavigationGuard(activeServices.origin);
    dashboard.webContents.on("will-navigate", dashboardNavigation);
    dashboard.webContents.on("will-redirect", dashboardNavigation);
    dashboard.once("ready-to-show", () => dashboard.show());
    try {
      await dashboard.loadURL(`${activeServices.origin}/`);
    } catch {
      if (!dashboard.isDestroyed()) dashboard.destroy();
    }
  };

  function rebuildTrayMenu(): void {
    if (tray === null || shellWindow.isDestroyed()) return;
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: shellWindow.isVisible() ? "隱藏 TokenMonster" : "顯示 TokenMonster",
          click: () => {
            if (shellWindow.isDestroyed()) return;
            if (shellWindow.isVisible()) hideWindow();
            else showWindow();
          }
        },
        {
          label: pinned ? "取消置頂" : "保持置頂",
          click: () => {
            setPinned(!pinned);
          }
        },
        { label: "開啟完整 dashboard", click: () => void openDashboard() },
        { type: "separator" },
        { label: "結束 TokenMonster", click: () => app.quit() }
      ])
    );
  }

  const stopActiveServices = async (): Promise<void> => {
    const activeServices = services;
    services = null;
    // Orphaned dashboards would keep polling the old origin; once that port
    // is freed, any local process could reclaim it and harvest the session
    // cookie (host-only cookies on 127.0.0.1 are not port-scoped).
    for (const dashboard of dashboardWindows) {
      if (!dashboard.isDestroyed()) dashboard.destroy();
    }
    dashboardWindows.clear();
    closeView(shellWindow, gatewayView);
    gatewayView = null;
    // Clear the cookie while we still own the loopback port, so nothing can
    // present it to whoever reclaims that port after closePetServices.
    try {
      await session
        .fromPartition(PET_SESSION_PARTITION)
        .clearStorageData({ storages: ["cookies"] });
    } catch {
      // Best effort: the next bootstrap overwrites the session cookie anyway.
    }
    await closePetServices(activeServices);
  };

  const showFailure = async (kind: "gateway" | "sidecar"): Promise<void> => {
    if (SMOKE_MODE) {
      reportSmokeOutcome(kind, stopActiveServices);
      return;
    }
    await stopActiveServices();
    shellStatus = Object.freeze({
      kind: "error",
      message: PET_STARTUP_MESSAGES[kind]
    });
    await loadShell();
    showWindow();
  };

  const startServices = (): Promise<void> => {
    if (startupOperation !== null) return startupOperation;
    startupOperation = (async (): Promise<void> => {
      shellStatus = Object.freeze({ kind: "loading" });
      await loadShell();
      await stopActiveServices();
      try {
        const started = await startPetServices();
        services = started;
        const view = new WebContentsView({
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            partition: PET_SESSION_PARTITION,
            sandbox: true
          }
        });
        gatewayView = view;
        view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        const viewNavigation = originNavigationGuard(started.origin);
        view.webContents.on("will-navigate", viewNavigation);
        view.webContents.on("will-redirect", viewNavigation);
        shellWindow.contentView.addChildView(view);
        updateGatewayViewBounds(shellWindow, view);

        // This is the sole load of this gateway instance's one-shot URL. The
        // 303 response leaves the HttpOnly cookie in this persistent partition.
        await view.webContents.loadURL(started.bootstrapUrl);
        if (services !== started) return;
        shellStatus = Object.freeze({ kind: "ready" });
        await loadShell();
        reportSmokeOutcome("ok", stopActiveServices);

        void started.runtime.closed.then((exit) => {
          if (services === started && !exit.expected) {
            void showFailure("sidecar");
          }
        });
      } catch (error: unknown) {
        // Local stderr only: the failure page hides every detail by design,
        // which would make packaged-app startup failures undiagnosable.
        console.error("TokenMonster pet startup failed:", error);
        await showFailure(
          error instanceof PetStartupError ? error.kind : "gateway"
        );
      }
    })().finally(() => {
      startupOperation = null;
    });
    return startupOperation;
  };

  for (const channel of Object.values(PET_SHELL_CHANNELS)) {
    ipcMain.removeHandler(channel);
  }
  ipcMain.handle(PET_SHELL_CHANNELS.togglePin, (event) => {
    if (!isTrustedShellSender(event, shellWindow)) return false;
    return setPinned(!pinned);
  });
  ipcMain.handle(PET_SHELL_CHANNELS.openDashboard, (event) => {
    if (!isTrustedShellSender(event, shellWindow)) return;
    void openDashboard();
  });
  ipcMain.handle(PET_SHELL_CHANNELS.hideWindow, (event) => {
    if (!isTrustedShellSender(event, shellWindow)) return;
    hideWindow();
  });

  shellWindow.on("resize", () => updateGatewayViewBounds(shellWindow, gatewayView));
  shellWindow.on("move", () => void persistState());
  shellWindow.webContents.on("did-navigate-in-page", (_event, url) => {
    if (shellStatus.kind === "error" && new URL(url).hash.startsWith("#retry-")) {
      void startServices();
    }
  });
  shellWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  shellWindow.webContents.on("will-navigate", (event) => event.preventDefault());

  let trayIcon: NativeImage;
  try {
    trayIcon = await app.getFileIcon(process.execPath, { size: "small" });
  } catch {
    // Iconless environments (e.g. bare X under CI) have no file icon; a
    // blank tray image keeps the menu and click target functional.
    trayIcon = nativeImage.createEmpty();
  }
  tray = new Tray(trayIcon);
  tray.setToolTip("TokenMonster");
  tray.on("click", () => {
    if (shellWindow.isDestroyed()) return;
    if (shellWindow.isVisible()) hideWindow();
    else showWindow();
  });
  rebuildTrayMenu();

  activeController = Object.freeze({ show: showWindow });
  app.on("activate", showWindow);
  app.on("before-quit", (event) => {
    if (quittingAllowed) return;
    event.preventDefault();
    if (shutdownOperation === null) {
      shutdownOperation = (async (): Promise<void> => {
        try {
          await persistState();
        } catch {
          // Persistence failure must not strand the loopback services.
        }
        await stopActiveServices();
        for (const channel of Object.values(PET_SHELL_CHANNELS)) {
          ipcMain.removeHandler(channel);
        }
        tray?.destroy();
        tray = null;
        activeController = null;
      })().finally(() => {
        quittingAllowed = true;
        app.quit();
      });
    }
  });

  await loadShell();
  showWindow();
  await startServices();
}
