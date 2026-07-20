export type ProgressionLockRepairState =
  | "hidden"
  | "available"
  | "checking"
  | "busy"
  | "ready"
  | "failed";

export interface ProgressionLockRepairView {
  readonly showControl: boolean;
  readonly controlDisabled: boolean;
  readonly controlLabel: string;
  readonly reasonOverride: string | null;
}

/** Keeps every repair outcome explicit without ever choosing a character. */
export function progressionLockRepairView(
  state: ProgressionLockRepairState,
): ProgressionLockRepairView {
  const view = (() => {
    switch (state) {
    case "hidden":
      return Object.freeze({
        showControl: false,
        controlDisabled: false,
        controlLabel: "修復角色選擇",
        reasonOverride: null,
      });
    case "available":
      return Object.freeze({
        showControl: true,
        controlDisabled: false,
        controlLabel: "修復角色選擇",
        reasonOverride:
          "舊版進度鎖擋住了角色選擇。請保留這個視窗，並從其他舊版的系統匣／選單列選「結束 TokenMonster」，再安全修復；你的角色進度不會被重設。",
      });
    case "checking":
      return Object.freeze({
        showControl: true,
        controlDisabled: true,
        controlLabel: "正在安全檢查…",
        reasonOverride:
          "正在確認舊版進度鎖；完成前不會變更角色或進度。",
      });
    case "busy":
      return Object.freeze({
        showControl: true,
        controlDisabled: false,
        controlLabel: "結束舊版後再檢查",
        reasonOverride:
          "另一個 TokenMonster 仍在使用角色進度。請保留這個視窗，從其他版本的系統匣／選單列選「結束 TokenMonster」後，再按一次檢查。",
      });
    case "ready":
      return Object.freeze({
        showControl: false,
        controlDisabled: false,
        controlLabel: "修復角色選擇",
        reasonOverride:
          "角色進度已可安全寫入，沒有被重設。請再選一次你想要的夥伴。",
      });
    case "failed":
      return Object.freeze({
        showControl: true,
        controlDisabled: false,
        controlLabel: "重新檢查角色選擇",
        reasonOverride:
          "修復檢查沒有完成，角色進度沒有變動。保留這個視窗，並從其他版本的系統匣／選單列結束 TokenMonster 後，可以再試一次。",
      });
    }
  })();
  return Object.freeze({
    ...view,
    controlLabel: localizeUiText(view.controlLabel),
    reasonOverride:
      view.reasonOverride === null
        ? null
        : localizeUiText(view.reasonOverride),
  });
}
import { localizeUiText } from "./localization.js";
