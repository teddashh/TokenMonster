import { useEffect, useMemo, useRef, useState } from "react";

import type {
  CharacterSummary,
  CollectorClient,
  CollectorDay,
  CompanionBootstrap,
  ContributionActionCode,
  ContributionPreview,
  ContributionRuntimeStatus,
  FixedInteractionResponse,
  LocalFileSaveResponse,
  LocalUsageInsights,
  UsageInsightProviderId,
  UsageInsightToolId,
  UsageInsightWindowDays
} from "../../shared/ipc.js";
import {
  mergeByokStatus,
  settleCredentialRefresh,
} from "./credential-mutation.js";
import {
  contributionScanCopy,
  contributionTopbarCopy
} from "./contribution-copy.js";

type LoadState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; data: CompanionBootstrap }>
  | Readonly<{ kind: "failed" }>;

type InsightState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; data: LocalUsageInsights }>
  | Readonly<{ kind: "failed" }>;

const PROVIDER_LABELS: Readonly<Record<UsageInsightProviderId, string>> =
  Object.freeze({
    anthropic: "Anthropic",
    google: "Google",
    openai: "OpenAI",
    openrouter: "OpenRouter",
    xai: "xAI",
    other: "其他供應商"
  });

const TOOL_LABELS: Readonly<Record<UsageInsightToolId, string>> = Object.freeze({
  "claude-code": "Claude Code",
  "codex-cli": "Codex CLI",
  "gemini-cli": "Gemini CLI",
  "grok-build": "Grok Build",
  other: "其他工具"
});

const COLLECTOR_STATE_LABELS: Readonly<
  Record<CompanionBootstrap["collector"]["state"], string>
> = Object.freeze({
  "not-configured": "尚未設定",
  stopped: "已停止",
  running: "已取得掃描權（執行時驗證）",
  degraded: "安全停用"
});

const MONSTER_COVERAGE_LABELS: Readonly<
  Record<CompanionBootstrap["monster"]["coverage"], string>
> = Object.freeze({
  insufficient: "不足",
  partial: "部分",
  good: "良好",
  full: "完整"
});

const MONSTER_ENERGY_LABELS: Readonly<
  Record<CompanionBootstrap["monster"]["energy"], string>
> = Object.freeze({
  dormant: "等待足跡",
  low: "低",
  medium: "中",
  high: "高"
});

const CONTRIBUTION_STATE_LABELS: Readonly<
  Record<ContributionRuntimeStatus["state"], string>
> = Object.freeze({
  off: "關閉（預設）",
  active: "已明確加入",
  stopped: "已暫停後續上傳",
  "deletion-pending": "刪除處理中",
  "deletion-complete": "可識別雲端資料已刪除",
  "deletion-failed": "刪除工作失敗",
  unavailable: "安全停用"
});

function contributionErrorMessage(code: ContributionActionCode): string {
  const messages: Record<ContributionActionCode, string> = {
    enabled: "已明確加入自願貢獻。",
    resumed: "已重新確認 consent，並恢復原有 enrollment 的背景同步。",
    stopped: "後續上傳已暫停；原有 enrollment 與 deletion authority 保留。",
    "pause-pending": "本機上傳已停止；遠端 pause 尚待網路恢復後重試。",
    "deletion-requested": "刪除請求已送出。",
    "deletion-status-updated": "刪除狀態已更新。",
    uploaded: "已送出完成 UTC 日的 absolute snapshots。",
    "nothing-due": "目前沒有完成且需要送出的 UTC 日資料。",
    "api-not-configured": "尚未設定受信任的 TokenMonster HTTPS API；維持關閉。",
    "secure-storage-unavailable": "作業系統安全儲存不可用；accountless enrollment 已阻擋。",
    "secure-storage-failed": "憑證無法完整安全保存；沒有啟用貢獻。",
    "contract-mismatch": "伺服器 consent 或回應不符合固定合約；沒有送出資料。",
    "network-error": "無法連到 TokenMonster API；佇列保留供重試。",
    timeout: "TokenMonster API 逾時；佇列保留供重試。",
    "rate-limited": "伺服器暫時限制頻率；已安排安全重試。",
    "server-unavailable": "TokenMonster API 暫時不可用；佇列保留供重試。",
    "request-rejected": "伺服器拒絕請求；沒有改寫本機資料。",
    "local-data-too-large": "本機候選資料超過安全上限；沒有送出。",
    "authority-conflict": "Collector authority 不一致；沒有送出。",
    "local-service-error": "本機貢獻服務安全停止；沒有洩漏內容。",
    "preview-expired": "預覽已過期；請重新產生並再次確認。",
    "state-conflict": "目前狀態不允許加入或恢復貢獻。",
    "not-enabled": "貢獻尚未啟用。",
    "consent-stale": "Consent 文件已更新；請先暫停，再重新預覽並明確同意。",
    "deletion-credential-unavailable": "沒有可用的 deletion authority。",
    "deletion-status-unavailable": "沒有可查詢的 deletion status credential。",
    busy: "另一個貢獻動作仍在處理。"
  };
  return messages[code];
}

function CharacterAvatar({ character }: { readonly character: CharacterSummary }) {
  return (
    <span
      className={`avatar avatar--${character.id}`}
      role="img"
      aria-label={`${character.alias} 字母角色`}
    >
      <span aria-hidden="true">{character.glyph}</span>
    </span>
  );
}

function formatTokenCount(value: string): string {
  try {
    return new Intl.NumberFormat("zh-TW").format(BigInt(value));
  } catch {
    return "—";
  }
}

function fileSaveMessage(
  response: LocalFileSaveResponse,
  successMessage: string
): string {
  const messages: Readonly<Record<LocalFileSaveResponse["status"], string>> = {
    saved: successMessage,
    cancelled: "已取消；沒有建立檔案。",
    "already-exists": "沒有覆寫既有檔案；請改用新的檔名再試一次。",
    "invalid-selection": "所選位置或副檔名不符合安全規則；沒有建立檔案。",
    failed: "無法建立檔案；沒有覆寫既有內容。"
  };
  return messages[response.status];
}

function InsightBreakdown<Id extends string>({
  caption,
  rows,
  labels
}: Readonly<{
  caption: string;
  rows: readonly Readonly<{
    id: Id;
    totalTokens: string;
    shareBasisPoints: number;
  }>[];
  labels: Readonly<Record<Id, string>>;
}>) {
  if (rows.length === 0) {
    return <p className="empty-insight">這個 UTC 視窗尚無本機 Token 足跡。</p>;
  }
  return (
    <table className="insight-table">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">分類</th>
          <th scope="col">占比</th>
          <th scope="col">Token</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <th scope="row">{labels[row.id]}</th>
            <td>
              <progress
                max={10_000}
                value={row.shareBasisPoints}
                aria-label={`${labels[row.id]} 占 ${(row.shareBasisPoints / 100).toFixed(1)}%`}
              />
            </td>
            <td>{formatTokenCount(row.totalTokens)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function App() {
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const [insightWindow, setInsightWindow] =
    useState<UsageInsightWindowDays>(7);
  const [insightState, setInsightState] = useState<InsightState>({
    kind: "loading"
  });
  const [line, setLine] = useState<FixedInteractionResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [chatMessage, setChatMessage] = useState("");
  const [byokNotice, setByokNotice] = useState<string | null>(null);
  const [persistKey, setPersistKey] = useState(false);
  const [scanClient, setScanClient] = useState<CollectorClient>("codex");
  const [scanDay, setScanDay] = useState<CollectorDay>("today");
  const [collectorNotice, setCollectorNotice] = useState<string | null>(null);
  const [localActionNotice, setLocalActionNotice] = useState<string | null>(
    null
  );
  const [resetConfirmed, setResetConfirmed] = useState(false);
  const [contributionPreview, setContributionPreview] =
    useState<ContributionPreview | null>(null);
  const [contributionConfirmed, setContributionConfirmed] = useState(false);
  const [deletionConfirmed, setDeletionConfirmed] = useState(false);
  const [contributionNotice, setContributionNotice] = useState<string | null>(
    null
  );
  const apiKeyInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    window.tokenMonster
      .getBootstrap()
      .then((data) => {
        if (active) setLoadState({ kind: "ready", data });
      })
      .catch(() => {
        if (active) setLoadState({ kind: "failed" });
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setInsightState({ kind: "loading" });
    window.tokenMonster
      .getUsageInsights({ windowDays: insightWindow })
      .then((data) => {
        if (active) setInsightState({ kind: "ready", data });
      })
      .catch(() => {
        if (active) setInsightState({ kind: "failed" });
      });
    return () => {
      active = false;
    };
  }, [insightWindow]);

  const selected = useMemo(() => {
    if (loadState.kind !== "ready") return null;
    return (
      loadState.data.characters.find(
        ({ id }) => id === loadState.data.selectedCharacterId
      ) ?? null
    );
  }, [loadState]);

  async function selectCharacter(characterId: CharacterSummary["id"]): Promise<void> {
    setBusy(true);
    setLine(null);
    setChatMessage("");
    setByokNotice("已切換角色；上一個角色的 RAM 對話已清除。");
    try {
      const data = await window.tokenMonster.selectCharacter(characterId);
      setLoadState({ kind: "ready", data });
    } catch {
      setLoadState({ kind: "failed" });
    } finally {
      setBusy(false);
    }
  }

  async function refreshBootstrap(): Promise<void> {
    const data = await window.tokenMonster.getBootstrap();
    setLoadState({ kind: "ready", data });
  }

  async function refreshInsights(): Promise<void> {
    const data = await window.tokenMonster.getUsageInsights({
      windowDays: insightWindow
    });
    setInsightState({ kind: "ready", data });
  }

  function applyContributionStatus(status: ContributionRuntimeStatus): void {
    setLoadState((current) =>
      current.kind === "ready"
        ? {
            kind: "ready",
            data: Object.freeze({ ...current.data, contribution: status })
          }
        : current
    );
  }

  async function prepareContributionPreview(): Promise<void> {
    setBusy(true);
    setContributionNotice(null);
    setContributionPreview(null);
    setContributionConfirmed(false);
    try {
      const preview = await window.tokenMonster.prepareContributionPreview({
        confirmation: "preview-content-blind-contribution"
      });
      setContributionPreview(preview);
      setContributionNotice(
        preview.payload === null
          ? "預覽已驗證；目前沒有已結束且四種 client 都完整掃描的 UTC 日資料。"
          : "預覽已驗證：本批 " +
              String(preview.eligibleBucketCount) +
              " 筆 absolute daily buckets；另有 " +
              String(preview.remainingEligibleBucketCount) +
              " 筆留待之後同步。"
      );
    } catch {
      setContributionNotice(
        "無法取得受信任 consent 與實際 payload 預覽；貢獻維持關閉。"
      );
    } finally {
      setBusy(false);
    }
  }

  async function enableContribution(): Promise<void> {
    if (contributionPreview === null || !contributionConfirmed) return;
    setBusy(true);
    setContributionNotice(null);
    try {
      const result = await window.tokenMonster.enableContribution({
        confirmation: "enable-content-blind-contribution",
        previewId: contributionPreview.previewId
      });
      applyContributionStatus(result.status);
      setContributionNotice(contributionErrorMessage(result.code));
      if (result.ok) {
        setContributionPreview(null);
        setContributionConfirmed(false);
      }
    } catch {
      setContributionNotice("加入請求被安全拒絕；貢獻維持關閉。");
    } finally {
      setBusy(false);
    }
  }

  async function syncContribution(): Promise<void> {
    setBusy(true);
    setContributionNotice(null);
    try {
      const result = await window.tokenMonster.syncContribution({
        confirmation: "sync-content-blind-contribution"
      });
      applyContributionStatus(result.status);
      setContributionNotice(
        contributionErrorMessage(result.code) +
          (result.uploadedBatches > 0
            ? " 本次完成 " + String(result.uploadedBatches) + " 個冪等批次。"
            : "")
      );
    } catch {
      setContributionNotice("同步請求被安全拒絕；未送出新資料。");
    } finally {
      setBusy(false);
    }
  }

  async function stopContribution(): Promise<void> {
    setBusy(true);
    setContributionNotice(null);
    try {
      const result = await window.tokenMonster.stopContribution({
        confirmation: "stop-content-blind-contribution"
      });
      applyContributionStatus(result.status);
      setContributionPreview(null);
      setContributionConfirmed(false);
      setContributionNotice(contributionErrorMessage(result.code));
    } catch {
      setContributionNotice("停止請求被安全拒絕；請重新啟動後確認狀態。");
    } finally {
      setBusy(false);
    }
  }

  async function deleteContributionData(): Promise<void> {
    if (!deletionConfirmed) return;
    setBusy(true);
    setContributionNotice(null);
    try {
      const result = await window.tokenMonster.deleteContributionData({
        confirmation: "delete-identifiable-contribution-data"
      });
      applyContributionStatus(result.status);
      setDeletionConfirmed(false);
      setContributionNotice(contributionErrorMessage(result.code));
    } catch {
      setContributionNotice(
        "刪除請求被安全拒絕；請保留這台裝置並稍後用同一 authority 重試。"
      );
    } finally {
      setBusy(false);
    }
  }

  async function refreshContributionDeletionStatus(): Promise<void> {
    setBusy(true);
    setContributionNotice(null);
    try {
      const result =
        await window.tokenMonster.refreshContributionDeletionStatus({
          confirmation: "check-contribution-deletion-status"
        });
      applyContributionStatus(result.status);
      setContributionNotice(contributionErrorMessage(result.code));
    } catch {
      setContributionNotice(
        "無法安全查詢刪除狀態；status credential 仍由作業系統保護。"
      );
    } finally {
      setBusy(false);
    }
  }

  async function configureByok(): Promise<void> {
    const input = apiKeyInput.current;
    if (input === null) return;
    const apiKey = input.value;
    input.value = "";
    setBusy(true);
    setByokNotice(null);
    try {
      const result = await window.tokenMonster.configureByok({
        apiKey,
        persist: persistKey
      });
      input.value = "";
      setLoadState((current) =>
        current.kind === "ready"
          ? { kind: "ready", data: mergeByokStatus(current.data, result.byok) }
          : current
      );
      if (!result.ok) {
        setByokNotice(
          result.errorCode === "invalid-key"
            ? "API key 格式不正確；沒有保存。"
            : "無法安全保存 API key；沒有送出訊息。"
        );
      } else {
        const refreshed = await settleCredentialRefresh(refreshBootstrap);
        setByokNotice(
          `${result.byok.persistence === "os-backed"
            ? "BYOK 已啟用，key 由作業系統加密保護。"
            : "BYOK 已啟用；這個環境只在本次執行的 RAM 保留 key。"}${
            refreshed ? "" : " 狀態重新整理失敗，但剛才的 key 設定結果不變。"
          }`
        );
      }
    } catch {
      input.value = "";
      setByokNotice("BYOK 設定被安全拒絕；沒有送出訊息。");
    } finally {
      setBusy(false);
    }
  }

  async function clearByok(): Promise<void> {
    setBusy(true);
    setByokNotice(null);
    try {
      const result = await window.tokenMonster.clearByok();
      setLoadState((current) =>
        current.kind === "ready"
          ? { kind: "ready", data: mergeByokStatus(current.data, result.byok) }
          : current
      );
      setLine(null);
      setChatMessage("");
      const refreshed = await settleCredentialRefresh(refreshBootstrap);
      setByokNotice(
        `${result.ok
          ? "OpenAI key 與 RAM 對話已清除。"
          : "清除未能安全完成；請重新啟動後再確認。"}${
          refreshed ? "" : " 狀態重新整理失敗；上述清除結果不變。"
        }`
      );
    } catch {
      setByokNotice("清除請求被安全拒絕。");
    } finally {
      setBusy(false);
    }
  }

  async function chat(): Promise<void> {
    if (selected === null || chatMessage.trim().length === 0) return;
    const message = chatMessage;
    setBusy(true);
    setByokNotice(null);
    try {
      const response = await window.tokenMonster.chat({
        characterId: selected.id,
        message
      });
      if (response.kind === "assistant") {
        setLine({
          kind: "fixed-line",
          lineId: "byok-direct",
          characterId: response.characterId,
          text: response.text
        });
        setChatMessage("");
      } else {
        try {
          setLine(
            await window.tokenMonster.interact({
              characterId: selected.id,
              trigger: "idle"
            })
          );
        } catch {
          setLine(null);
        }
        const messages: Record<typeof response.errorCode, string> = {
          "not-configured": "請先設定 OpenAI BYOK。",
          busy: "上一則訊息仍在處理。",
          "invalid-message": "訊息為空白或超過本機 4 KiB 限制。",
          "request-timeout": "OpenAI 回應逾時；你可以稍後重試。",
          "request-aborted": "這則請求已在本機取消。",
          "network-error": "目前無法連到 OpenAI。",
          "provider-authentication-failed": "OpenAI 拒絕這把 API key。",
          "provider-rate-limited": "OpenAI 暫時限制請求頻率。",
          "provider-request-rejected": "OpenAI 拒絕這則請求。",
          "provider-unavailable": "OpenAI 目前暫時不可用。",
          "provider-error": "OpenAI 回傳非預期狀態。",
          "response-too-large": "回應超過本機安全限制，已丟棄。",
          "malformed-response": "OpenAI 回應格式無法安全讀取。",
          "incomplete-response": "OpenAI 沒有完成這則回應。",
          "unsupported-response": "回應含有未支援的內容，已丟棄。",
          "empty-response": "OpenAI 沒有回傳可顯示的文字。",
          "local-service-error": "本機 BYOK 服務安全停止；沒有保存內容。"
        };
        setByokNotice(messages[response.errorCode]);
      }
    } catch {
      setByokNotice("訊息被安全拒絕；沒有保存內容。");
    } finally {
      setBusy(false);
    }
  }

  async function scanUsage(): Promise<void> {
    setBusy(true);
    setCollectorNotice(null);
    try {
      const result = await window.tokenMonster.scanUsage({
        client: scanClient,
        day: scanDay
      });
      if (result.kind === "applied") {
        let refreshed = true;
        try {
          await Promise.all([refreshBootstrap(), refreshInsights()]);
        } catch {
          refreshed = false;
        }
        const correction =
          result.inferredZeroRows === 0
            ? ""
            : `，並把 ${result.inferredZeroRows} 筆消失的舊值修正為 0`;
        const contributionCopy =
          loadState.kind === "ready"
            ? contributionScanCopy(loadState.data.contribution.state)
            : "本次掃描只更新本機；雲端狀態目前無法顯示。";
        setCollectorNotice(
          `已完成 ${result.bucketStart.slice(0, 10)} 的本機 absolute scan：讀到 ${result.observedRows} 筆，套用 ${result.appliedRows} 筆${correction}。${contributionCopy}${
            refreshed ? "" : " 畫面摘要重新整理失敗，但掃描結果不變。"
          }`
        );
        return;
      }
      const messages: Record<typeof result.errorCode, string> = {
        "authority-conflict": "偵測到另一個 collector authority；為避免重複計數，本次沒有掃描。",
        busy: "另一個本機掃描仍在進行。",
        "collector-unavailable": "Tokscale 或作業系統網路隔離目前不可用；舊資料未被改動。",
        "invalid-output": "Collector 輸出未通過內容盲合約；本次沒有套用。",
        "local-service-error": "本機 Collector 服務安全停止；沒有上傳資料。",
        "storage-error": "本機資料庫無法安全套用完整掃描；沒有上傳資料。"
      };
      try {
        await refreshBootstrap();
      } catch {
        // The scan result remains useful even if the status refresh is unavailable.
      }
      setCollectorNotice(messages[result.errorCode]);
    } catch {
      try {
        await refreshBootstrap();
      } catch {
        // Keep the local failure notice without replacing it with stale assumptions.
      }
      setCollectorNotice("掃描請求被安全拒絕；沒有上傳資料。");
    } finally {
      setBusy(false);
    }
  }

  async function saveShareCard(): Promise<void> {
    if (selected === null || insightState.kind !== "ready") return;
    setBusy(true);
    setLocalActionNotice(null);
    try {
      const result = await window.tokenMonster.saveShareCard({
        windowDays: insightWindow,
        characterId: selected.id
      });
      setLocalActionNotice(
        fileSaveMessage(result, "分享卡 SVG 已建立；既有檔案從未被覆寫。")
      );
    } catch {
      setLocalActionNotice("分享卡匯出被安全拒絕；沒有建立檔案。");
    } finally {
      setBusy(false);
    }
  }

  async function exportLocalData(): Promise<void> {
    setBusy(true);
    setLocalActionNotice(null);
    try {
      const result = await window.tokenMonster.exportLocalData();
      setLocalActionNotice(
        fileSaveMessage(
          result,
          "本機資料 JSON 已建立；它與支援診斷不同，會包含內容盲日彙總與角色狀態。"
        )
      );
    } catch {
      setLocalActionNotice("本機資料匯出被安全拒絕；沒有建立檔案。");
    } finally {
      setBusy(false);
    }
  }

  async function exportSupportDiagnostic(): Promise<void> {
    setBusy(true);
    setLocalActionNotice(null);
    try {
      const result = await window.tokenMonster.exportSupportDiagnostic();
      setLocalActionNotice(
        fileSaveMessage(
          result,
          "支援診斷 JSON 已建立；其中只有版本、狀態與筆數，不含用量明細。"
        )
      );
    } catch {
      setLocalActionNotice("支援診斷匯出被安全拒絕；沒有建立檔案。");
    } finally {
      setBusy(false);
    }
  }

  async function resetLocalSourceData(): Promise<void> {
    if (!resetConfirmed) return;
    setBusy(true);
    setLocalActionNotice(null);
    try {
      const result = await window.tokenMonster.resetLocalSourceData({
        confirmation: "clear-collector-derived-data"
      });
      let refreshed = true;
      try {
        await Promise.all([refreshBootstrap(), refreshInsights()]);
      } catch {
        refreshed = false;
      }
      setResetConfirmed(false);
      setCollectorNotice(null);
      setLine(null);
      setLocalActionNotice(
        `${result.byokPreserved
          ? "雲端 upload authority 已先停止，Collector 來源資料才永久清除；deletion authority 保留。OpenAI BYOK key 與本次 RAM 對話未清除；若也要清除，請使用獨立控制。"
          : "Collector 來源資料已永久清除。"}${
          refreshed ? "" : " 畫面狀態重新整理失敗，但上述清除結果不變。"
        }`
      );
    } catch {
      setLocalActionNotice("本機來源重設未能安全完成；請重新啟動後再確認。");
    } finally {
      setBusy(false);
    }
  }

  async function interact(): Promise<void> {
    if (selected === null) return;
    setBusy(true);
    try {
      const response = await window.tokenMonster.interact({
        characterId: selected.id,
        trigger: line === null ? "greeting" : "idle"
      });
      setLine(response);
    } catch {
      setLine(null);
    } finally {
      setBusy(false);
    }
  }

  if (loadState.kind === "loading") {
    return <main className="state-card" aria-live="polite">正在開啟本機空間…</main>;
  }
  if (loadState.kind === "failed" || selected === null) {
    return (
      <main className="state-card" role="alert">
        Companion 無法安全初始化。請重新啟動；沒有任何資料送出。
      </main>
    );
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <span className="brand-mark" aria-hidden="true">TM</span>
          <strong>TokenMonster</strong>
        </div>
        <span className="local-pill">
          {contributionTopbarCopy(
            loadState.data.contribution,
            loadState.data.mode
          )}
        </span>
      </header>

      <main className="layout">
        <section className="stage" aria-labelledby="companion-heading">
          <p className="eyebrow">YOUR LETTER COMPANION</p>
          <h1 id="companion-heading">今天和 {selected.alias} 待一會</h1>
          <div className="character-scene">
            <CharacterAvatar character={selected} />
            <div className="speech" aria-live="polite">
              {line?.text ?? "你的詳細 Token 足跡只在這台裝置上整理；雲端貢獻只接受由你明確操作的內容盲 UTC 日彙總。想開始時，我在這裡。"}
            </div>
          </div>
          <section className="monster-profile" aria-labelledby="monster-profile-heading">
            <div>
              <p className="eyebrow">CONTENT-BLIND PROFILE</p>
              <h2 id="monster-profile-heading">{loadState.data.monster.moodLabel}</h2>
            </div>
            <dl className="monster-facts">
              <div>
                <dt>觀測覆蓋</dt>
                <dd>{MONSTER_COVERAGE_LABELS[loadState.data.monster.coverage]}</dd>
              </div>
              <div>
                <dt>足跡能量</dt>
                <dd>{MONSTER_ENERGY_LABELS[loadState.data.monster.energy]}</dd>
              </div>
            </dl>
            {loadState.data.monster.identityStatus === "learning" ? (
              <p className="learning-note">
                至少需要 14 個完整觀測 UTC 日期、其中 7 個有用量，才會顯示分析特質；一天須完成四種工具掃描才算已觀測，未掃描日不算零。同一 UTC 視窗內的補掃與修正會在下一個視窗重算特質。
              </p>
            ) : (
              <ul className="trait-list" aria-label="內容盲特質">
                {loadState.data.monster.traits.map((trait) => (
                  <li key={trait.id}>
                    <strong>{trait.label}</strong>
                    <span>{trait.reason}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="monster-window">
              UTC 視窗：{loadState.data.monster.window.from} 至 {loadState.data.monster.window.to}
            </p>
            <p className="monster-disclosure">{loadState.data.monster.disclosure}</p>
          </section>
          <section className="usage-insights" aria-labelledby="usage-insights-heading">
            <div className="insight-heading-row">
              <div>
                <p className="eyebrow">LOCAL · CONTENT-BLIND</p>
                <h2 id="usage-insights-heading">Token 足跡摘要</h2>
              </div>
              <div className="window-switch" aria-label="摘要 UTC 視窗">
                {([7, 28] as const).map((windowDays) => (
                  <button
                    key={windowDays}
                    type="button"
                    aria-pressed={insightWindow === windowDays}
                    disabled={busy}
                    onClick={() => setInsightWindow(windowDays)}
                  >
                    {windowDays} 天
                  </button>
                ))}
              </div>
            </div>
            {insightState.kind === "loading" ? (
              <p className="empty-insight" aria-live="polite">正在讀取本機日彙總…</p>
            ) : insightState.kind === "failed" ? (
              <p className="empty-insight" role="alert">本機摘要目前無法安全讀取。</p>
            ) : (
              <>
                <div className="insight-total">
                  <strong>{formatTokenCount(insightState.data.totalTokens)}</strong>
                  <span>Token</span>
                  <small>
                    UTC {insightState.data.fromInclusive.slice(0, 10)} 至 {new Date(Date.parse(insightState.data.toExclusive) - 86_400_000).toISOString().slice(0, 10)}
                  </small>
                </div>
                <p className="insight-note">
                  只加總這台裝置已取得的日彙總；未掃描日期不會被當成 0，也不代表完整帳單用量。
                </p>
                <div className="insight-grids">
                  <InsightBreakdown
                    caption="依供應商彙總"
                    rows={insightState.data.providers}
                    labels={PROVIDER_LABELS}
                  />
                  <InsightBreakdown
                    caption="依工具彙總"
                    rows={insightState.data.tools}
                    labels={TOOL_LABELS}
                  />
                </div>
                <section className="share-preview" aria-labelledby="share-preview-heading">
                  <div className="share-preview-card">
                    <span className="share-glyph" aria-hidden="true">{selected.glyph}</span>
                    <div>
                      <p className="eyebrow">TOKENMONSTER · LOCAL FOOTPRINT</p>
                      <h3 id="share-preview-heading">{selected.alias} 的最近 {insightWindow} 天 UTC</h3>
                      <strong>{formatTokenCount(insightState.data.totalTokens)} Token</strong>
                      <small>
                        {insightState.data.providers[0] === undefined
                          ? "尚無足跡"
                          : `主要供應商：${PROVIDER_LABELS[insightState.data.providers[0].id]}`}
                        {insightState.data.tools[0] === undefined
                          ? ""
                          : ` · 主要工具：${TOOL_LABELS[insightState.data.tools[0].id]}`}
                      </small>
                    </div>
                  </div>
                  <p>
                    預覽與 SVG 只含角色別名、期間、總量及粗粒度供應商／工具；不含帳號 ID、路徑或模型字串。建立新檔時不覆寫既有檔案。
                  </p>
                  <button
                    className="secondary"
                    type="button"
                    disabled={busy}
                    onClick={() => void saveShareCard()}
                  >
                    儲存分享卡 SVG
                  </button>
                </section>
              </>
            )}
          </section>
          <button className="primary" type="button" disabled={busy} onClick={interact}>
            {busy ? "稍等一下…" : line === null ? "打聲招呼" : "再聊一句"}
          </button>
          {loadState.data.byok.configured ? (
            <form
              className="chat-form"
              autoComplete="off"
              onSubmit={(event) => {
                event.preventDefault();
                void chat();
              }}
            >
              <label htmlFor="chat-message">直接問 {selected.alias}</label>
              <textarea
                id="chat-message"
                value={chatMessage}
                maxLength={4_096}
                rows={3}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="none"
                disabled={busy}
                onChange={(event) => setChatMessage(event.target.value)}
              />
              <button className="secondary" type="submit" disabled={busy || chatMessage.trim().length === 0}>
                透過 OpenAI 傳送
              </button>
            </form>
          ) : null}
          <p className="disclosure">{selected.disclosure}</p>
        </section>

        <aside className="sidebar" aria-label="本機狀態">
          <section className="panel">
            <p className="eyebrow">LOCAL DATA</p>
            <h2>本機資料庫已就緒</h2>
            <p>
              內容盲的 SQLite 保存日彙總、角色狀態與必要的本機設定／同步狀態。只有你按下按鈕才會執行固定 Tokscale report；掃描程序會斷網執行，而且掃描本身永遠不會觸發上傳。雲端貢獻的目前狀態顯示於下方。
            </p>
            <dl>
              <div><dt>Collector</dt><dd>{COLLECTOR_STATE_LABELS[loadState.data.collector.state]}</dd></div>
              <div><dt>本機日彙總</dt><dd>{loadState.data.collector.dailyAggregateRows}</dd></div>
              <div><dt>雲端貢獻</dt><dd>{CONTRIBUTION_STATE_LABELS[loadState.data.contribution.state]}</dd></div>
              <div><dt>OpenAI BYOK</dt><dd>{loadState.data.byok.configured ? "已設定" : "未設定"}</dd></div>
              <div><dt>對話保存</dt><dd>磁碟不保存；RAM 最近 12 則</dd></div>
              <div><dt>最後成功掃描</dt><dd>{loadState.data.collector.lastSuccessfulScanAt === null ? "尚無" : new Date(loadState.data.collector.lastSuccessfulScanAt).toLocaleString("zh-TW")}</dd></div>
            </dl>
            <form
              className="collector-form"
              onSubmit={(event) => {
                event.preventDefault();
                void scanUsage();
              }}
            >
              <label>
                工具
                <select
                  value={scanClient}
                  disabled={busy}
                  onChange={(event) => setScanClient(event.target.value as CollectorClient)}
                >
                  <option value="codex">Codex CLI</option>
                  <option value="claude">Claude Code</option>
                  <option value="gemini">Gemini CLI</option>
                  <option value="grok">Grok Build</option>
                </select>
              </label>
              <label>
                UTC 日期
                <select
                  value={scanDay}
                  disabled={busy}
                  onChange={(event) => setScanDay(event.target.value as CollectorDay)}
                >
                  <option value="today">今天</option>
                  <option value="previous">昨天</option>
                </select>
              </label>
              <button className="secondary" type="submit" disabled={busy || loadState.data.collector.state !== "running"}>
                {busy ? "掃描中…" : "立即掃描本機日彙總"}
              </button>
            </form>
            {collectorNotice === null ? null : <p className="notice" role="status">{collectorNotice}</p>}
          </section>

          <section className="panel contribution-controls" aria-labelledby="contribution-heading">
            <p className="eyebrow">VOLUNTARY CONTRIBUTION · DEFAULT OFF</p>
            <h2 id="contribution-heading">分享內容盲 UTC 日彙總</h2>
            <p>
              只會送出下方實際預覽的 strict daily aggregate 欄位；不送 prompt、response、程式碼、檔名／路徑、raw log、event/session、hourly bucket 或任何 provider credential。今天尚未結束的 UTC 日不會送出。
            </p>
            <dl>
              <div><dt>狀態</dt><dd>{CONTRIBUTION_STATE_LABELS[loadState.data.contribution.state]}</dd></div>
              <div><dt>API</dt><dd>{loadState.data.contribution.configured ? "受信任 HTTPS origin" : "未設定（fail closed）"}</dd></div>
              <div><dt>憑證保存</dt><dd>{loadState.data.contribution.secureStorage === "os-backed" ? "OS-backed" : "不可用"}</dd></div>
              <div><dt>待送批次</dt><dd>{loadState.data.contribution.outboxPending}</dd></div>
            </dl>
            {loadState.data.contribution.state === "off" ||
            loadState.data.contribution.state === "stopped" ||
            loadState.data.contribution.state === "deletion-complete" ? (
              <>
                <button
                  className="secondary"
                  type="button"
                  disabled={busy || !loadState.data.contribution.canEnable}
                  onClick={() => void prepareContributionPreview()}
                >
                  取得 consent 與實際 payload 預覽
                </button>
                {contributionPreview === null ? null : (
                  <div className="contribution-preview">
                    <h3>{contributionPreview.document.title}</h3>
                    <p>{contributionPreview.document.summary}</p>
                    <p>{contributionPreview.document.retentionDisclosure}</p>
                    <details>
                      <summary>查看這次允許送出的 exact JSON payload</summary>
                      <pre>{JSON.stringify(contributionPreview.payload, null, 2)}</pre>
                    </details>
                    <p>
                      明確排除：{contributionPreview.forbidden.join("；")}。Consent revision：
                      <code>{contributionPreview.document.revision}</code>。
                    </p>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={contributionConfirmed}
                        disabled={busy}
                        onChange={(event) => setContributionConfirmed(event.target.checked)}
                      />
                      我已檢查實際 payload，了解 current buckets 最多可識別 30 天；達 k≥20 混入無 enrollment mapping 的歷史總數後，不能個別抽出或刪除。加入或恢復後，Companion 會在背景以相同 strict payload 與冪等佇列同步；暫停會立即取消後續排程並清空待送佇列，但保留原有 enrollment 與 deletion authority。
                    </label>
                    <button
                      className="secondary"
                      type="button"
                      disabled={busy || !contributionConfirmed}
                      onClick={() => void enableContribution()}
                    >
                      {loadState.data.contribution.state === "stopped"
                        ? "重新同意並恢復原有 enrollment"
                        : "明確加入並開啟背景同步"}
                    </button>
                  </div>
                )}
              </>
            ) : null}
            {loadState.data.contribution.state === "active" ? (
              <div className="contribution-buttons">
                <button className="secondary" type="button" disabled={busy} onClick={() => void syncContribution()}>
                  立即同步／重試完成 UTC 日
                </button>
                <button className="secondary danger" type="button" disabled={busy} onClick={() => void stopContribution()}>
                  立即停止後續上傳
                </button>
              </div>
            ) : null}
            {loadState.data.contribution.canDelete ? (
              <fieldset className="reset-control">
                <legend>刪除仍可識別的雲端貢獻資料</legend>
                <p>
                  使用獨立 deletion authority。已混入 anonymous historical totals、且不再有 enrollment mapping 的數字無法個別扣除。
                </p>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={deletionConfirmed}
                    disabled={busy}
                    onChange={(event) => setDeletionConfirmed(event.target.checked)}
                  />
                  我了解刪除完成後，若要再次貢獻必須重新 preview 與 enrollment。
                </label>
                <button className="secondary danger" type="button" disabled={busy || !deletionConfirmed} onClick={() => void deleteContributionData()}>
                  要求刪除可識別雲端資料
                </button>
              </fieldset>
            ) : null}
            {loadState.data.contribution.deletion === null ? null : (
              <div className="deletion-status">
                <p>
                  刪除狀態：{loadState.data.contribution.deletion.status}。匿名歷史總數保留：是。
                </p>
                <button className="secondary" type="button" disabled={busy} onClick={() => void refreshContributionDeletionStatus()}>
                  查詢刪除狀態
                </button>
              </div>
            )}
            {contributionNotice === null ? null : (
              <p className="notice" role="status">{contributionNotice}</p>
            )}
          </section>

          <section className="panel local-controls" aria-labelledby="local-controls-heading">
            <p className="eyebrow">LOCAL DATA CONTROL</p>
            <h2 id="local-controls-heading">匯出與來源重設</h2>
            <div className="export-choice">
              <h3>本機資料匯出</h3>
              <p>
                包含內容盲日彙總、角色狀態、非機密設定與 collector 狀態；不含提示、回覆、程式碼、路徑、憑證或 OpenAI key。
              </p>
              <button
                className="secondary"
                type="button"
                disabled={busy}
                onClick={() => void exportLocalData()}
              >
                匯出本機資料 JSON
              </button>
            </div>
            <div className="export-choice">
              <h3>支援診斷</h3>
              <p>
                只含 app／schema 版本、collector 健康狀態與資料筆數；不含任何用量列、模型字串、ID、路徑或 key，適合自行檢查後交給支援人員。
              </p>
              <button
                className="secondary"
                type="button"
                disabled={busy}
                onClick={() => void exportSupportDiagnostic()}
              >
                匯出支援診斷 JSON
              </button>
            </div>
            <fieldset className="reset-control">
              <legend>永久重設 Collector 來源資料</legend>
              <p>
                會先在本機停止雲端貢獻、清空待送佇列並嘗試確認遠端 pause；只有停止成功才清除日彙總、完整掃描證據、角色狀態、同步鏡像／佇列與最後掃描時間。原有 enrollment 與 deletion authority 保留；若要恢復，仍須重新取得實際 payload preview 並明確同意。
              </p>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={resetConfirmed}
                  disabled={busy}
                  onChange={(event) => setResetConfirmed(event.target.checked)}
                />
                我了解這是不可復原的本機刪除；OpenAI BYOK key 是另一個控制，不會一起清除。
              </label>
              <button
                className="secondary danger"
                type="button"
                disabled={busy || !resetConfirmed}
                onClick={() => void resetLocalSourceData()}
              >
                永久清除 Collector 來源資料
              </button>
            </fieldset>
            {localActionNotice === null ? null : (
              <p className="notice" role="status">{localActionNotice}</p>
            )}
          </section>

          <section className="panel" aria-labelledby="byok-heading">
            <p className="eyebrow">OPTIONAL BYOK</p>
            <h2 id="byok-heading">和角色即時互動</h2>
            <p>
              訊息只會由主程序直接送到 OpenAI Responses API，不會寫入 TokenMonster SQLite 或貢獻雲端。最近 12 則、合計最多 48 KiB 只在 RAM 作為上下文，會隨後續請求再送到 OpenAI；切換角色、清除 key 或關閉視窗時清除。模型固定為 gpt-5.6-luna。
            </p>
            {loadState.data.byok.configured ? (
              <div className="byok-controls">
                <p className="status-line">
                  {loadState.data.byok.persistence === "os-backed"
                    ? "Key：作業系統加密保存"
                    : "Key：僅本次執行 RAM"}
                </p>
                <button className="secondary danger" type="button" disabled={busy} onClick={clearByok}>
                  清除 OpenAI key
                </button>
              </div>
            ) : (
              <form
                className="byok-form"
                autoComplete="off"
                onSubmit={(event) => {
                  event.preventDefault();
                  void configureByok();
                }}
              >
                <label htmlFor="openai-key">OpenAI API key</label>
                <input
                  ref={apiKeyInput}
                  id="openai-key"
                  name="openai-key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={512}
                  required
                  disabled={busy}
                />
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={persistKey}
                    disabled={busy || !loadState.data.byok.canPersist}
                    onChange={(event) => setPersistKey(event.target.checked)}
                  />
                  由作業系統加密保存
                </label>
                {!loadState.data.byok.canPersist ? (
                  <small>目前 backend（{loadState.data.byok.backend}）不符合安全持久化條件，因此只能放在 RAM。</small>
                ) : null}
                <button className="secondary" type="submit" disabled={busy}>
                  啟用 BYOK
                </button>
              </form>
            )}
            {byokNotice === null ? null : <p className="notice" role="status">{byokNotice}</p>}
            <p className="retention-note">
              請注意：<code>store:false</code> 會關閉 Responses 的 application-state 儲存，但不等於供應商端零保留；OpenAI 的預設 abuse-monitoring logs 可能保留最多 30 天。資料控制說明：developers.openai.com/api/docs/guides/your-data
            </p>
          </section>

          <section className="panel">
            <p className="eyebrow">CHOOSE A COMPANION</p>
            <div className="choices">
              {loadState.data.characters.map((character) => (
                <button
                  className={character.id === selected.id ? "choice active" : "choice"}
                  type="button"
                  key={character.id}
                  aria-pressed={character.id === selected.id}
                  disabled={busy}
                  onClick={() => selectCharacter(character.id)}
                >
                  <CharacterAvatar character={character} />
                  <span><strong>{character.alias}</strong><small>{character.description}</small></span>
                </button>
              ))}
            </div>
          </section>
        </aside>
      </main>
    </div>
  );
}
