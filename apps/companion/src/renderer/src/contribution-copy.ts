import type {
  CompanionBootstrap,
  ContributionRuntimeStatus
} from "../../shared/ipc.js";

const TOPBAR_CLOUD_STATE: Readonly<
  Record<ContributionRuntimeStatus["state"], string>
> = Object.freeze({
  off: "雲端貢獻關閉（預設）",
  active: "自願貢獻已啟用（背景同步）",
  stopped: "後續雲端上傳已停止",
  "deletion-pending": "可識別雲端資料刪除中",
  "deletion-complete": "可識別雲端資料已刪除",
  "deletion-failed": "雲端刪除失敗；上傳停用",
  unavailable: "雲端貢獻安全停用"
});

export function contributionTopbarCopy(
  status: ContributionRuntimeStatus,
  mode: CompanionBootstrap["mode"]
): string {
  const byok = mode === "byok-direct" ? " · BYOK 直連 OpenAI" : "";
  return `本機統計${byok} · ${TOPBAR_CLOUD_STATE[status.state]}`;
}

export function contributionScanCopy(
  state: ContributionRuntimeStatus["state"]
): string {
  switch (state) {
    case "active":
      return "本次掃描只更新本機；若完整的 UTC 日符合預覽規則，背景排程才會嘗試同步。";
    case "off":
      return "本次掃描只更新本機；自願貢獻目前關閉。";
    case "stopped":
      return "本次掃描只更新本機；後續雲端上傳已停止。";
    case "deletion-pending":
      return "本次掃描只更新本機；可識別雲端資料正在刪除。";
    case "deletion-complete":
      return "本次掃描只更新本機；可識別雲端資料已刪除。";
    case "deletion-failed":
      return "本次掃描只更新本機；雲端刪除失敗且上傳維持停用。";
    case "unavailable":
      return "本次掃描只更新本機；雲端貢獻目前安全停用。";
  }
}
