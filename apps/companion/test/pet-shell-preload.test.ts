import Module, { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

interface PetShellBridge {
  togglePin(): Promise<unknown>;
  openDashboard(): Promise<unknown>;
  hideWindow(): Promise<unknown>;
}

interface LoadableModule {
  _load(
    request: string,
    parent: NodeModule | undefined,
    isMain: boolean
  ): unknown;
}

describe("pet shell preload", () => {
  it("exposes exactly togglePin, openDashboard, and hideWindow", async () => {
    const calls: string[] = [];
    let exposedName: string | undefined;
    let exposedBridge: PetShellBridge | undefined;
    const electronMock = Object.freeze({
      contextBridge: Object.freeze({
        exposeInMainWorld(
          name: string,
          bridge: PetShellBridge
        ): void {
          exposedName = name;
          exposedBridge = bridge;
        }
      }),
      ipcRenderer: Object.freeze({
        invoke(channel: string): Promise<boolean> {
          calls.push(channel);
          return Promise.resolve(true);
        }
      })
    });
    const loadableModule = Module as unknown as LoadableModule;
    const originalLoad = loadableModule._load;
    try {
      loadableModule._load = function loadWithElectronMock(
        request,
        parent,
        isMain
      ) {
        return request === "electron"
          ? electronMock
          : originalLoad.call(this, request, parent, isMain);
      };
      require("../dist/main/preload/pet-shell.cjs");
    } finally {
      loadableModule._load = originalLoad;
    }

    expect(exposedName).toBe("tokenMonsterPet");
    if (exposedBridge === undefined) throw new Error("bridge not exposed");
    const bridge: PetShellBridge = exposedBridge;
    expect(Object.isFrozen(bridge)).toBe(true);
    expect(Object.keys(bridge).sort()).toEqual([
      "hideWindow",
      "openDashboard",
      "togglePin"
    ]);
    await bridge.togglePin();
    await bridge.openDashboard();
    await bridge.hideWindow();
    expect(calls).toEqual([
      "tokenmonster:pet:toggle-pin",
      "tokenmonster:pet:open-dashboard",
      "tokenmonster:pet:hide-window"
    ]);
  });
});
