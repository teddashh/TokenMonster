import { useCallback, useEffect, useState } from "react";

import {
  PUBLIC_CHARACTER_CHOICES,
  type CharacterId,
  type PublicCharacterChoice,
} from "./characters.js";
import {
  PUBLIC_COUNTER_DISCLAIMER,
  PUBLIC_COUNTER_LABEL,
  fetchPublicTotals,
  formatTokenDecimal,
  formatVerifiedAt,
  publicTotalsAreFresh,
  type PublicCounterState,
} from "./public-totals.js";

export interface AppProps {
  readonly counterState?: PublicCounterState;
}

interface PublicCounterProps {
  readonly state: PublicCounterState;
  readonly onRetry: () => void;
}

interface LetterMonsterProps {
  readonly character: PublicCharacterChoice;
  readonly size?: "compact" | "large";
}

function usePublicCounter(): readonly [PublicCounterState, () => void] {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PublicCounterState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timeout = globalThis.setTimeout(() => {
      controller.abort();
      if (active) {
        setState({ status: "unavailable" });
      }
    }, 8_000);
    setState((current) =>
      current.status === "verified" && publicTotalsAreFresh(current.snapshot)
        ? current
        : { status: "loading" },
    );
    void fetchPublicTotals(globalThis.fetch, controller.signal)
      .then((snapshot) => {
        if (active) {
          setState({ status: "verified", snapshot });
        }
      })
      .catch(() => {
        if (active) {
          setState({ status: "unavailable" });
        }
      })
      .finally(() => {
        globalThis.clearTimeout(timeout);
      });
    return () => {
      active = false;
      globalThis.clearTimeout(timeout);
      controller.abort();
    };
  }, [attempt]);

  useEffect(() => {
    const refresh = (): void => {
      setState((current) =>
        current.status === "verified" && !publicTotalsAreFresh(current.snapshot)
          ? { status: "unavailable" }
          : current,
      );
      setAttempt((current) => current + 1);
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === "visible") {
        refresh();
      }
    };
    const interval = globalThis.setInterval(refresh, 60_000);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      globalThis.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  const retry = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  return [state, retry] as const;
}

function LetterMonster({ character, size = "compact" }: LetterMonsterProps) {
  return (
    <span
      className={`letter-monster letter-monster--${character.id} letter-monster--${size}`}
      role="img"
      aria-label={`${character.alias} 字母角色 placeholder`}
    >
      <span className="letter-monster__antenna" aria-hidden="true" />
      <span className="letter-monster__face" aria-hidden="true">
        <span className="letter-monster__eyes" />
        <span className="letter-monster__glyph">{character.glyph}</span>
      </span>
    </span>
  );
}

export function PublicCounter({ state, onRetry }: PublicCounterProps) {
  return (
    <section className="counter-card" aria-labelledby="public-counter-title">
      <div className="eyebrow-row">
        <p className="eyebrow">VERIFIED PROJECTION</p>
        <span className={`status-dot status-dot--${state.status}`} aria-hidden="true" />
      </div>
      <h2 id="public-counter-title">{PUBLIC_COUNTER_LABEL}</h2>

      <div className="counter-card__live" aria-live="polite" aria-atomic="true">
        {state.status === "loading" ? (
          <div className="counter-state" aria-busy="true">
            <strong>正在取得經驗證資料</strong>
            <span>Loading verified aggregate…</span>
          </div>
        ) : null}

        {state.status === "unavailable" ? (
          <div className="counter-state counter-state--unavailable">
            <strong>目前無法顯示經驗證總量</strong>
            <span>我們不會用示範數字或動畫假裝資料存在。</span>
            <button className="text-button" type="button" onClick={onRetry}>
              重新驗證
            </button>
          </div>
        ) : null}

        {state.status === "verified" ? (
          <div className="counter-state counter-state--verified">
            <data
              className="counter-total"
              value={state.snapshot.allTimeTokens}
              aria-label={`${formatTokenDecimal(state.snapshot.allTimeTokens)} tokens`}
            >
              {formatTokenDecimal(state.snapshot.allTimeTokens)}
            </data>
            <span className="counter-unit">tokens shared</span>
            <dl className="counter-breakdown">
              <div>
                <dt>今日（UTC）</dt>
                <dd>{formatTokenDecimal(state.snapshot.todayUtcTokens)}</dd>
              </div>
              <div>
                <dt>近 30 日活躍分享安裝</dt>
                <dd>{formatTokenDecimal(state.snapshot.contributors)}</dd>
              </div>
            </dl>
            <p className="verified-time">
              最後驗證：
              <time dateTime={state.snapshot.generatedAt}>
                {formatVerifiedAt(state.snapshot.generatedAt)}
              </time>
            </p>
          </div>
        ) : null}
      </div>

      <p className="counter-disclaimer">{PUBLIC_COUNTER_DISCLAIMER}</p>
    </section>
  );
}

export function App({ counterState }: AppProps) {
  const [liveCounterState, retryCounter] = usePublicCounter();
  const [selectedCharacterId, setSelectedCharacterId] =
    useState<CharacterId>("chatgpt");
  const selectedCharacter =
    PUBLIC_CHARACTER_CHOICES.find(({ id }) => id === selectedCharacterId) ??
    PUBLIC_CHARACTER_CHOICES[0];

  if (selectedCharacter === undefined) {
    throw new Error("The public character catalog is empty.");
  }

  return (
    <>
      <a className="skip-link" href="#main-content">
        跳到主要內容
      </a>

      <header className="site-header">
        <a className="brand" href="#top" aria-label="TokenMonster 首頁">
          <span className="brand__mark" aria-hidden="true">TM</span>
          <span>TokenMonster</span>
        </a>
        <nav aria-label="主要導覽">
          <a href="#characters">角色</a>
          <a href="#method">計算方式</a>
          <a href="#privacy">隱私</a>
          <a href="#download">下載</a>
        </nav>
      </header>

      <main id="main-content">
        <section className="hero" id="top" aria-labelledby="hero-title">
          <div className="hero__copy">
            <p className="eyebrow">LOCAL FIRST · CONTENT BLIND</p>
            <h1 id="hero-title">
              你的 Token 足跡，
              <span>長成自己的字母怪。</span>
            </h1>
            <p className="hero__lede">
              TokenMonster 在本地整理 AI 工具的 Token 日彙總，用可解釋的工作節奏決定角色特質；不讀 prompt、回覆、程式碼或檔案路徑。
            </p>
            <div className="hero__actions">
              <a className="button button--primary" href="#download">
                查看 Alpha 狀態
              </a>
              <a className="button button--quiet" href="#privacy">
                先看資料邊界
              </a>
            </div>
            <ul className="trust-list" aria-label="核心承諾">
              <li>分享預設關閉</li>
              <li>離線功能保留</li>
              <li>特質不是排行榜</li>
            </ul>
          </div>

          <div className="hero__dashboard" aria-label="本地 companion 狀態預覽">
            <div className="dashboard-topline">
              <span>LOCAL COMPANION</span>
              <span className="offline-pill">尚未連線</span>
            </div>
            <div className="dashboard-monster">
              <LetterMonster character={selectedCharacter} size="large" />
              <div>
                <p className="dashboard-label">目前預覽</p>
                <strong>{selectedCharacter.alias}</strong>
                <p>字母 placeholder · 沒有讀取本機資料</p>
              </div>
            </div>
            <dl className="dashboard-facts">
              <div>
                <dt>匿名分享</dt>
                <dd>預設關閉</dd>
              </div>
              <div>
                <dt>今日資料</dt>
                <dd>尚未連線</dd>
              </div>
              <div>
                <dt>角色特質</dt>
                <dd>等待本地足跡</dd>
              </div>
            </dl>
          </div>
        </section>

        <div className="counter-wrap">
          <PublicCounter
            state={counterState ?? liveCounterState}
            onRetry={retryCounter}
          />
        </div>

        <section className="section section--characters" id="characters" aria-labelledby="characters-title">
          <div className="section-heading">
            <p className="eyebrow">FOUR CORE CHARACTERS</p>
            <h2 id="characters-title">先選一個陪你看節奏的字母角色</h2>
            <p>
              選角只改變陪伴語氣與外觀，不改變你的本地統計，也不把 Token 量變成力量或等級。
            </p>
          </div>

          <div className="character-grid" aria-label="四個核心字母角色">
            {PUBLIC_CHARACTER_CHOICES.map((character) => (
              <button
                className="character-choice"
                key={character.id}
                type="button"
                aria-pressed={selectedCharacterId === character.id}
                onClick={() => {
                  setSelectedCharacterId(character.id);
                }}
              >
                <LetterMonster character={character} />
                <span className="character-choice__copy">
                  <strong>{character.alias}</strong>
                  <span>{character.description}</span>
                  <small>字母 placeholder</small>
                </span>
              </button>
            ))}
          </div>

          <aside className="release-gate" aria-label="角色圖像發佈狀態">
            <strong>候選角色圖像：封鎖中</strong>
            <p>
              目前只發佈 TokenMonster 的程式化字母 placeholder。AI-Sister 候選圖稿在取得書面公開／商業授權與品牌審查核准前，不會載入或隨網站出貨。
              這些字母角色是獨立虛構角色，沒有任何供應商合作或背書。
            </p>
          </aside>
        </section>

        <section className="section" id="method" aria-labelledby="method-title">
          <div className="section-heading section-heading--split">
            <div>
              <p className="eyebrow">METHOD</p>
              <h2 id="method-title">總量怎麼來，清楚寫在數字旁邊</h2>
            </div>
            <p>
              公開數字只採用通過合約驗證的 UTC 日彙總；若投影不存在、格式錯誤或服務不可用，頁面就顯示「無法顯示」，不補值。
            </p>
          </div>
          <ol className="method-steps">
            <li>
              <span>01</span>
              <h3>本地收集</h3>
              <p>Companion 只從支援工具的用量紀錄整理 Token 類別，不收內容。</p>
            </li>
            <li>
              <span>02</span>
              <h3>明確同意</h3>
              <p>匿名分享預設關閉；啟用前先預覽實際要送出的 UTC 日彙總。</p>
            </li>
            <li>
              <span>03</span>
              <h3>驗證投影</h3>
              <p>公開頁只顯示伺服器驗證過的 decimal totals 與驗證時間。</p>
            </li>
          </ol>
        </section>

        <section className="section privacy-section" id="privacy" aria-labelledby="privacy-title">
          <div className="section-heading">
            <p className="eyebrow">PRIVACY BOUNDARY</p>
            <h2 id="privacy-title">雲端只能看到窄到不能再窄的日彙總</h2>
          </div>
          <div className="boundary-grid">
            <article className="boundary-card boundary-card--allowed">
              <h3>選擇加入後可分享</h3>
              <ul>
                <li>UTC 日期</li>
                <li>粗粒度工具、供應商與模型家族</li>
                <li>輸入、輸出、cache、reasoning 與其他 Token 總量</li>
                <li>collector 與合約版本</li>
              </ul>
            </article>
            <article className="boundary-card boundary-card--blocked">
              <h3>永遠不進 TokenMonster 雲端</h3>
              <ul>
                <li>Prompt、回覆與訊息內容</li>
                <li>程式碼、檔名、專案或儲存庫路徑</li>
                <li>API key、OAuth token 與供應商憑證</li>
                <li>小時資料、事件與 session 識別碼</li>
              </ul>
            </article>
          </div>
          <p className="privacy-note">
            BYOK 對話由本地 companion 直接送往你選擇的供應商；TokenMonster 公開 API 不接收 provider key 或對話內容。
          </p>
          <p className="privacy-note">
            可識別的 current buckets 最多保留 30 天。到期資料只有在同一粗粒度群組至少有 20 位活躍分享安裝（k ≥ 20）時，才會混入不再保留 enrollment 對照的匿名歷史總量；混入後無法個別抽出或刪除，未達門檻的到期資料會刪除。啟用前請閱讀
            <a href="/v1/consent-documents/current?purpose=contribution&amp;locale=zh-TW">
              完整 contribution consent document
            </a>
            。
          </p>
        </section>

        <section className="section control-section" id="delete" aria-labelledby="delete-title">
          <div>
            <p className="eyebrow">PAUSE · EXPORT · DELETE</p>
            <h2 id="delete-title">控制權留在你手上</h2>
          </div>
          <div className="control-grid">
            <article>
              <h3>暫停分享</h3>
              <p>停止未來上傳，不影響本地圖表、角色與離線互動。</p>
            </article>
            <article>
              <h3>匯出本地資料</h3>
              <p>簽署 Alpha 會提供可攜的本地匯出；公開頁不讀取你的裝置。</p>
            </article>
            <article>
              <h3>刪除可識別資料</h3>
              <p>
                Alpha 會使用獨立刪除憑證移除仍在保留期內的 current buckets。已混入無對照匿名歷史總量的貢獻無法再個別抽出。
              </p>
            </article>
          </div>
          <p className="control-caveat">
            目前公開頁不接受刪除或匯出指令；在端到端流程可驗證前，我們不會放一顆看似能用的按鈕。
          </p>
        </section>

        <section className="section download-section" id="download" aria-labelledby="download-title">
          <div>
            <p className="eyebrow">SIGNED ALPHA</p>
            <h2 id="download-title">下載入口還沒開放</h2>
            <p>
              我們會等 macOS／Windows 簽署、更新與回復流程通過驗證後才提供 Alpha 檔案。現在沒有可安全推薦的安裝包。
            </p>
          </div>
          <div className="download-action">
            <button className="button button--disabled" type="button" disabled aria-describedby="download-status">
              簽署版 Alpha 尚未開放下載
            </button>
            <p id="download-status" role="status">Release status: not available</p>
          </div>
        </section>

        <section className="section support-section" id="support" aria-labelledby="support-title">
          <div>
            <p className="eyebrow">SUPPORT</p>
            <h2 id="support-title">需要協助？先保留敏感內容</h2>
          </div>
          <p>
            正式支援管道會在簽署 Alpha 發佈前一併公布。請不要在 issue、截圖或除錯資料中貼上 prompt、回覆、程式碼、路徑、API key 或 OAuth token；本頁目前沒有收集資料的聯絡表單。
          </p>
        </section>
      </main>

      <footer className="site-footer">
        <div>
          <span className="brand__mark" aria-hidden="true">TM</span>
          <strong>TokenMonster</strong>
        </div>
        <p>本地優先、內容盲、選擇加入。Built with an honest unavailable state.</p>
        <nav aria-label="頁尾導覽">
          <a href="#method">計算方式</a>
          <a href="#delete">刪除說明</a>
          <a href="#support">支援</a>
        </nav>
      </footer>
    </>
  );
}
