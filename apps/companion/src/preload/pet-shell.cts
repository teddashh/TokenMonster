const { contextBridge, ipcRenderer }: typeof import("electron") = require("electron");

const PET_SHELL_CHANNELS = Object.freeze({
  hideWindow: "tokenmonster:pet:hide-window",
  openDashboard: "tokenmonster:pet:open-dashboard",
  togglePin: "tokenmonster:pet:toggle-pin"
});

const bridge = Object.freeze({
  togglePin: () => ipcRenderer.invoke(PET_SHELL_CHANNELS.togglePin),
  openDashboard: () => ipcRenderer.invoke(PET_SHELL_CHANNELS.openDashboard),
  hideWindow: () => ipcRenderer.invoke(PET_SHELL_CHANNELS.hideWindow)
});

contextBridge.exposeInMainWorld("tokenMonsterPet", bridge);
