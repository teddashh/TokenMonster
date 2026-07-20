import type { CharacterAssetPackStatus } from "./dto.js";

export type CharacterAssetPackPrimaryAction =
  | "enable"
  | "installing"
  | "repair"
  | "cleanup"
  | null;

export interface CharacterAssetPackControlMode {
  readonly primaryAction: CharacterAssetPackPrimaryAction;
  readonly showRevoke: boolean;
}

/** Keep destructive removal visually separate from the primary happy path. */
export function characterAssetPackControlMode(
  pack: CharacterAssetPackStatus,
): CharacterAssetPackControlMode {
  if (pack.phase === "unavailable") {
    return Object.freeze({ primaryAction: null, showRevoke: false });
  }
  if (pack.phase === "installed") {
    return Object.freeze({ primaryAction: null, showRevoke: true });
  }
  if (pack.phase === "installing") {
    return Object.freeze({ primaryAction: "installing", showRevoke: false });
  }
  if (pack.phase === "repair-needed") {
    return Object.freeze({
      primaryAction: pack.consented ? "repair" : "cleanup",
      showRevoke: pack.consented,
    });
  }
  return Object.freeze({ primaryAction: "enable", showRevoke: false });
}
