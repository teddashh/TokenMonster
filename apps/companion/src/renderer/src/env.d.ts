import type { TokenMonsterBridge } from "../../shared/ipc.js";

declare global {
  interface Window {
    readonly tokenMonster: TokenMonsterBridge;
  }
}

export {};
