# TokenMonster 實作與正式上線計畫

> Architecture update (2026-07-15): phases that build a collector fork,
> Tokscale authority, or Electron-owned collection are superseded. Continue
> from the permanent sidecar migration sequence in
> [ADR 0005](adr/0005-permanent-tokentracker-sidecar-adapter.md).

> 狀態：跨 Phase 0–4 的 source vertical slice 已完成；尚未 production deploy
>
> 適用範圍：歷史原始計畫；永久 sidecar／adapter／gateway／CLI 路徑以 ADR 0005 為準
>
> 估算方式：以下都是「工程投入量」，不是日曆承諾；1 工程週以 5 個專注工程日計。

本計畫把 TokenMonster 從目前的文件骨架推進到可正式公開使用的產品。產品的第一優先不是全球數字有多大，而是本機資料安全、數字不重複、角色變化看得懂，以及使用者即使完全不開雲端也能得到完整價值。

本文件的階段順序是交付順序。任何階段若未通過退出條件，不得用「之後再補」跳過隱私、資料正確性、刪除或資產權利閘門。

### 目前執行快照（2026-07-15）

- 已完成 source/test：monorepo與contracts、exact-pinned Tokscale adapter、四個
  Tier-1 projection、local SQLite與完整掃描ledger、monster/角色placeholder、
  Electron secure IPC、direct OpenAI BYOK、7/28-day insights、local share/export/reset、
  匿名 contribution實際preview／enrollment／OS-backed scoped secrets／背景sync與冪等
  retry／停止／刪除與狀態查詢、public Web/API、D1 mutation/deletion/status、
  Durable Object quota/suppression、`day-all-v1` k=20 anonymous compaction，以及
  `deletion → compactor → preserving retention → projection` scheduled maintenance。
  Compactor只處理完整結束且到期的UTC日，每次cron最多一日；未達20人或超過安全
  容量的日整日drop，成功與cleanup在commit-time recheck後原子完成並由migration
  triggers封閉。含native collector的unsigned Linux package/ZIP evidence亦已產生。
- 已完成部署形狀但未建立遠端資源：單一 Worker bundle、Static Assets、兩個
  SQLite-backed Durable Object classes/migration與minute cron均通過Wrangler dry-run。
  Checked-in config刻意沒有D1 UUID、routes、secrets或mutation enable flag。
- 仍是STOP：Companion background sync的staging packet capture／wake soak、Cloudflare
  account/D1/domain/secrets與remote rehearsal/staging E2E、backup/restore與suppression replay、macOS nested-code
  signing/notarization/DMG、sandbox-enabled實機smoke、project license與legal/privacy/
  terms、raster rights、Alpha cohort。
- `tokentracker-cli@0.79.8` bridge仍是target design，不是目前可選的runtime feature；
  current companion authority只有Tokscale。

以下 Phase 描述是完整 launch target與依賴順序，不應被誤讀為當前 feature list。

## 1. 正式上線的定義

### 1.1 GA 必須包含

- `apps/companion` 可在沒有帳號、沒有 API key、沒有網路的情況下啟動 exact-pinned tokscale collector，顯示本機用量圖表、角色狀態、變化原因、提醒與腳本式互動；有自備 OpenAI key 的使用者另可在本機直接啟用最低限度的角色對話。
- `packages/collector-tokscale` 只用固定 argv 讀取經核准的本機聚合資料，將上游格式轉成 TokenMonster 自有 contract；`packages/collector-tokentracker-bridge` 是與它互斥的選配路徑。上游 dashboard、帳號、遙測與 cloud path 不進入產品資料流。
- `packages/monster-engine` 以可解釋的 workflow traits 產生角色、心情及文字原因。角色是橫向風格差異，不是強度或付費階級。
- `packages/characters` 首批角色範圍只包含 ChatGPT、Claude、Gemini、Grok；四張 AI-Sister WebP 目前一律標記 `releaseStatus: "blocked"`，只有取得 owner public-use grant 並通過 brand review 後才能進入對外 artifact，否則使用 placeholder。
- 匿名分享預設關閉。使用者可以先預覽將上傳的欄位，再明確開啟、隨時關閉並刪除已貢獻資料。
- `apps/api` 接受版本化的 UTC 每日 aggregate buckets；本機 hourly buckets 只供 monster／mood 使用，永不上傳。重送、重播、重掃、修正與亂序傳遞不會讓總量重複增加。
- `apps/web` 提供安裝與隱私說明、分享卡／分享頁，以及文案固定為「由選擇加入的貢獻者分享的 token」的公開 counter。
- 已支援的平台有可重現、帶 checksum 的安裝包；正式包完成簽章／notarization、更新與 rollback 驗證。
- Production 有 migration、備份、還原、監控、告警、事故處理、刪除與撤銷 runbook。

### 1.2 初次 GA 明確不包含

- 不抓 ChatGPT、Claude、Gemini、Grok 消費者網頁版內容，也不以 browser scraping 估算用量。
- 不做公開排行榜、完整全球角色牆、好友系統、留言、交易或付費功能。
- 不做以 token 燃燒量解鎖戰力、稀有度或抽卡次數的機制。
- 不上線 Live2D、VRM、3D、真實人物聲音 clone 或來源不明的 voice pack。
- 不把 API key 送到公開網站或公開 API。MVP 需包含本機 OpenAI Responses adapter；金鑰只在 OS secret store，request 由 companion 直接送往 OpenAI 且明確設定 `store: false`。Anthropic、Gemini、xAI 等進階多 provider BYOK 延後。
- 不一次匯入 AI-Sister 的完整網站、community、billing、auth、hero art 或未建檔的原始素材。

## 2. 計畫假設與投入估算

估算以一名能處理 TypeScript、桌面封裝與後端的資深工程師為基準，另有兼任設計／產品與安全審查。兩名工程師可平行推進 local 與 cloud workstream，但 contract、Alpha 觀察與 release gate 仍是共同關鍵路徑，不能簡單把時間除以二。

| 階段 | 工程投入估算 | 主要產出 |
|---|---:|---|
| Phase 0 — 基線與契約 | 4–6 工程日 | Monorepo、資料契約、威脅模型、CI、權利清單 |
| Phase 1 — Local data spine + BYOK | 10–15 工程日 | Collector adapter、local store、離線 companion、OpenAI Responses adapter |
| Phase 2 — Monster 體驗 | 8–12 工程日 | Trait engine、四角色、圖表、提醒、分享卡 |
| Phase 3 — Opt-in cloud slice | 10–15 工程日 | Enrollment、idempotent ingest、deletion、counter、公開 Web |
| Phase 4 — Alpha release readiness | 8–12 工程日 | 安裝包、staging、runbook、安全與隱私驗收 |
| Phase 5 — Private Alpha | 5–10 工程日，另加至少 7 日觀察窗 | 30 人實測、量化判斷、一次收斂迭代 |
| Phase 6 — Beta / Release Candidate | 8–12 工程日 | 規模、相容、可用性、法務與 RC freeze |
| GA — 分批正式上線 | 3–5 工程日 | Production rollout、監控與 handoff |

合計約 56–87 工程日，亦即約 12–18 個單人工程週。這不包含等待網域、hosting credential、Apple／Windows 簽章資格、角色資產權利確認、外部安全審查及 Alpha 受試者招募的時間。

## 3. 關鍵依賴順序

```text
資料清單 + Threat model
          │
          ▼
packages/contracts v1
     ┌────┴───────────────┐
     ▼                    ▼
collector-adapter      API ingest schema
     │                    │
     ▼                    ▼
local aggregate store  canonical cloud buckets
     │                    │
     ▼                    ▼
monster-engine         deletion + aggregate read
     │                    │
     ▼                    ▼
companion + share card  public counter + share page
     └──────────┬─────────┘
                ▼
       consent／egress／replay E2E
                ▼
         signed Private Alpha
                ▼
          metrics gate → RC → GA
```

依賴規則如下：

1. Contract v1 與資料 allowlist 未凍結前，不實作 production ingest。
2. Collector adapter 的 safe fixture 未通過前，不讓 monster engine 依賴上游未投影的原始 payload。
3. Consent preview、撤銷與 deletion E2E 未通過前，不開放 Alpha 雲端貢獻。
4. 角色資產權利未書面確認前，只能用 placeholder 開發，不得對外散佈 AI-Sister portrait。
5. Counter 只能從 30 天內可識別的 canonical bucket rows 加上不可逆 anonymous historical rollups 重算，不得以 `counter += clientDelta` 作為真相來源。
6. Alpha 指標未達標前，不投入全球角色牆、抽卡、進階動畫或 OpenAI 以外的多 provider BYOK；已承諾的最低限度 OpenAI local BYOK 不延後。
7. Production backup restore、rollback 與 incident drill 未通過前，不進入 GA。

## 4. Workstreams 與責任邊界

| ID | Workstream | 擁有的交付物 | 不得擁有的責任 | 前置依賴 |
|---|---|---|---|---|
| W1 | Contracts & Privacy | Versioned schemas、資料清單、consent receipt、privacy regression tests | UI framework 細節、上游原始 model | 無 |
| W2 | Collector & Adapter | Pinned tokscale process、選配 TokenTracker bridge、相容檢查、local queue | 公開 API、角色規則 | W1 |
| W3 | Local Companion | Local store、圖表、設定、提醒、collector lifecycle、offline UX、OS secret store、OpenAI Responses local adapter | Provider credential cloud storage、server-side model proxy | W1、W2 |
| W4 | Monster & Characters | Deterministic trait engine、explanations、四角色 manifest、fallback lines | Collector parser、排行榜／戰力 | W1、資產權利 |
| W5 | Cloud API & Data | Enrollment、ingest、revision/upsert、deletion、aggregate read | Prompt／response、provider auth | W1 |
| W6 | Public Web & Sharing | Counter、install/privacy education、share card/page | Local raw usage、BYOK | W1、W4、W5 |
| W7 | Release & Operations | CI/CD、signing、SBOM、backup、monitoring、runbooks、rollback | 產品資料規則 | 所有實作 workstreams |
| W8 | Product Validation | Alpha protocol、問卷、認知測試、decision log | 未同意的背景 telemetry | W3、W4、W5、W6 |

所有 domain logic 必須放在 `packages/*`，framework handler 只負責 transport、auth、rate limit 與呼叫 domain service。所有新 TypeScript 使用 strict mode。

## 5. 分階段實作計畫

### 5.1 Phase 0 — 基線、資料契約與不可跨越的邊界

**目標：** 讓後續工程有一致的 repo、資料與安全基線。

**估算：** 4–6 工程日。

**可平行外部工作：** `EXT-01` 資產權利、`EXT-02` 專案授權、`EXT-03` hosting／domain 選擇。

#### 交付物

- 建立 root workspace、統一 lockfile、strict `tsconfig`、lint、format、test 與 build scripts。
- 建立並可獨立 build：
  - `apps/web`
  - `apps/api`
  - `apps/companion`
  - `packages/contracts`
  - `packages/collector-core`
  - `packages/collector-tokscale`
  - `packages/collector-tokentracker-bridge`
  - `packages/monster-engine`
  - `packages/characters`
- 新增 CI：乾淨安裝、typecheck、lint、unit、contract snapshot、privacy regression、build、dependency audit、secret scan。
- 在 `packages/contracts` 建立 v1 schema 與 JSON Schema／OpenAPI 輸出：
  - local aggregate snapshot；
  - cloud `IngestSnapshotV1`／`DailyAggregateBucketV1`；
  - enrollment／token issue response；
  - consent receipt；
  - batch ingest response；
  - deletion request／receipt；
  - public aggregate response；
  - share snapshot。
- Schema 使用 `additionalProperties: false`；所有 numeric 欄位定義最大值、非負整數、UTC bucket 邊界與 enum fallback 行為。
- 建立 `docs/DATA_INVENTORY.md`：逐欄寫用途、來源、本機／雲端、保留期、刪除方式與是否出現在 log／metric。
- 建立 `docs/THREAT_MODEL.md`：至少涵蓋惡意上游資料、loopback CSRF、local process spoofing、replay、亂序 revision、bucket poisoning、credential leak、log leak、share URL 猜測與供應鏈風險。
- 建立 runtime／packaging ADR；明確選定 companion shell、本機儲存、local secret store 與 collector supervision 模式。
- 建立 AI-Sister asset manifest 空殼，預定目的地為 `packages/characters/assets/portraits/`；四張候選 WebP 初始值必須是 `releaseStatus: "blocked"`。每個檔案要求 source commit、source path、SHA-256、尺寸、owner public-use grant、brand review 結論及 attribution，兩項審查通過後才可改為 `approved`。
- Exact-pin `tokscale@4.5.2` 作為預設 parser authority；另記錄選配 `tokentracker-cli@0.79.8` 與 fork 上游 commit `82d0c345cee5aaf486a97d9801d8212b489da775`。文件必須說明兩者互斥、fork `teddashh/tokenmonster-collector` 的使用條件與 upstream remote。

#### 退出／驗收條件

- 新環境從 clean checkout 以單一文件化命令完成 install、typecheck、test、build。
- 所有 package 啟用 TypeScript strict；無 `skipLibCheck` 或廣域 `any` 逃生門，例外需 ADR。
- Contract fixture 中加入 prompts、response、filename、path、API key、OAuth token 等誘餌欄位時，validator 必須拒絕整個 cloud payload，而非靜默上傳。
- Threat model 無未指派 owner 的 Critical／High 項目。
- CI 不含 production credential，secret scan 通過。
- Public copy test 鎖定「由選擇加入的貢獻者分享的 token」語意；不得出現「全世界全部 AI 用量」等聲稱。
- 未完成資產權利時，build 使用明確的 placeholder；不阻擋純工程開發，但阻擋任何對外 Alpha 包。

### 5.2 Phase 1 — Local data spine、離線 companion 與最低限度 BYOK

**目標：** 在完全沒有 TokenMonster cloud 的情況下完成收集、聚合、圖表與本機 AI 互動的最小垂直切片。

**估算：** 10–15 工程日。

**依賴：** Phase 0 contracts、runtime ADR。

#### 交付物

- `packages/collector-tokscale`：
  - 啟動／停止／健康檢查 exact-pinned `tokscale@4.5.2` subprocess；
  - 只允許固定 report argv，使用 `shell: false`、sanitized environment、isolated config、pricing cache-only、timeout 與 stdout cap；
  - 不呼叫 `graph`、`clients`、`login`、`submit`、autosubmit、usage 或任何任意 shell／網路功能；
  - 先用 strict schema 驗證上游 JSON，再立即以 allowlist 投影；raw JSON、workspace、session、path、project、message count、cost 與 diagnostics 不落盤、不進 log；
  - 將上游 client／provider／model 正規化成受控 provider、tool 與 model-family enum，未知值只進 coarse `other`／`unknown`；
  - collector 不存在、timeout、輸出超限、schema 漂移或資料損壞時 fail closed 並提供可恢復錯誤狀態。
- `packages/collector-tokentracker-bridge`：
  - 只有使用者已安裝 TokenTracker 且主動選擇時才啟用；強制 `TOKENTRACKER_NO_TELEMETRY=1`；
  - 只綁定 loopback、檢查 API／schema compatibility，並用 local session token／等價機制防惡意網頁讀取；
  - 與 tokscale parser authority 互斥，同一來源時間窗絕不相加。
- `apps/companion`：
  - First-run privacy promise；
  - collector 狀態、最後成功同步時間、診斷與 retry；
  - 本機 SQLite／等價 local store，只保存安全 aggregate buckets 與 UI preferences；
  - 今日、7 日、30 日 provider／tool／model-family 圖表；
  - cloud toggle 存在但預設關閉，Phase 1 不會產生任何 contribution request；
  - export／diagnostic 輸出亦套用相同 allowlist。
- Local store 可保留 hourly aggregate buckets，供圖表、monster traits 與 mood 使用；local contribution queue 另聚合成 UTC daily rows。兩者都採 absolute snapshot／revision，不採「每次掃描增加 delta」。重新掃描同一份資料不改變 local total。
- 實作 MVP OpenAI Responses local adapter：
  - API key 只寫入 OS secret store，不進 `.env`、localStorage、SQLite、log、analytics、diagnostic 或 crash report；
  - companion 只允許直接連到核准的 OpenAI API origin，不經 TokenMonster Web／API，也不接受可把 key 導向任意 host 的自訂 base URL；
  - 每次 Responses request 明確送出 `store: false`，MVP 不啟用 background mode、hosted file search、conversation object 或 file upload；
  - 使用者 prompt 與 provider response 只在目前 UI session 的記憶體中處理，關閉對話即清除，不寫入 TokenMonster 儲存、log 或 analytics；
  - 沒有 key、provider outage 或使用者關閉 BYOK 時，自動回到完整可用的腳本式 fallback lines；
  - UI 清楚揭露內容會由使用者的 companion 直接送到 OpenAI，TokenMonster public API 不會收到；`store: false` 不被描述成法定 Zero Data Retention，provider 資料處理以 [OpenAI 官方 data controls](https://developers.openai.com/api/docs/guides/your-data) 為準。
- 為 Claude Code、Codex CLI、Gemini CLI 與 Grok Build 建立 golden fixtures；其他上游工具不宣稱已完成 Alpha qualification。
- 建立 collector fork escalation 規則：只有 safe aggregate endpoint 缺失或已確認的 parser correctness bug 才能進 fork；每個 patch 都需 upstream issue／commit link、測試及移除條件。

#### 測試與安全閘門

- Adapter unit／contract tests 覆蓋正常、缺欄、未知 enum、極大數、負數、損毀 JSON、版本漂移與 timeout。
- Rescan／restart／crash-recovery property test：相同輸入執行任意次，local total 不變。
- 以敏感字串 canary fixture 驗證 database、log、crash report、diagnostic export 都不含禁收欄位或值。
- Cloud disabled 的自動 E2E 以 network capture 驗證：除使用者明確觸發更新檢查或 BYOK 對話外，usage flow 對外 egress 為零；更新檢查與 provider request 都不得帶 aggregate usage、installation ID 或 contribution secret。
- BYOK mock E2E 驗證每個 Responses request 都有 `store: false`、金鑰只出現在對 OpenAI origin 的 Authorization header、request／response 不落盤。另以可撤銷的測試 credential 做人工 smoke；CI 永遠使用 mock，不保存真實 key。
- 選配 TokenTracker loopback bridge 需要不可預測的 local session token／等價保護，並驗證惡意網頁無法經瀏覽器發出可讀取使用量的 CSRF request。

#### 退出／驗收條件

- 四組 qualification fixtures 的本機總數與預期完全一致。
- Companion 在 collector 離線及 cloud 故障時仍可讀既有資料、顯示角色 placeholder 與圖表；OpenAI 故障或沒有 key 時 fallback interaction 不受影響。
- 連續 synthetic soak 中無重複計數、未處理 rejection 或無限重啟 loop。
- tokscale 或選配 `tokentracker-cli` 的版本／schema 漂移會被偵測並阻擋，不會默默以未知格式運作。
- 使用者可以完全跳過 cloud 說明並持續使用所有 Phase 1 功能。
- Public API 的 access log、database 與 wire capture 中完全沒有 provider key、prompt 或 response；本機持久層亦沒有對話內容。

### 5.3 Phase 2 — 可解釋 Monster engine、四角色與分享卡

**目標：** 證明 TokenMonster 不是 tracker 換皮，而是能把 workflow 轉成使用者看得懂的角色身份。

**估算：** 8–12 工程日。

**依賴：** Phase 1 safe local snapshot；`EXT-01` 在外部 Alpha 前完成。

#### 交付物

- `packages/monster-engine` 純函式輸入／輸出：
  - 輸入只接受 local aggregate contract；
  - 主要 traits 限定於 provider／model mix、tool diversity、本機 hourly 工作節律、cache／output ratio 與活躍日；來源沒有可信 metadata 時不得宣稱 session 切換或任務類型；
  - 產出 `characterId`、1–3 個有充分證據的 dominant traits、mood、evolution cadence、explanation keys 與顯示用安全數值；provider 證據不完整時省略該類 trait；
  - 相同 snapshot、engine version 與 locale 永遠產生相同核心結果；
  - token 總量只可經 cap／log normalization 影響情緒或材質提示，不能形成戰力、稀有度或更高權限。
- 第一批 archetypes 至少包含可直接由安全 aggregates 證明的「深夜型」、「CLI 專注型」、「多工具切換型」、「多 provider／tool 類別轉換型」；每個 trait 有清楚的門檻、反例與一句歸因。若來源沒有可信的 task metadata，禁止用 debug、research、test 或特定專案工作等名稱猜測行為。
- 日間變化不足時，自動選擇週級／事件級演化；禁止用不可解釋的黑箱隨機數改變主形體。
- `packages/characters`：
  - 四個角色 manifest：ChatGPT、Claude、Gemini、Grok；
  - manifest 目前維持 `releaseStatus: "blocked"`；只有取得 owner public-use grant 並完成 brand review 後，才匯入 AI-Sister `web/public/avatars/{chatgpt,claude,gemini,grok}.webp` 到對外 build；
  - 每個角色提供 neutral／happy／tired／focused 等 UI mood 的 CSS／Motion 表現，不假裝有原生 Live2D 表情；
  - `zh-TW`、`en` 腳本式 fallback lines，依 trait、mood、提醒情境挑選；
  - 明確 unaffiliated／fan-character disclosure。
- Companion character screen：角色、今日狀態、三個主要 trait、每個變化的「為什麼」、圖表切換與提醒設定。
- Reminder 預設克制，可完全關閉；安靜時段與頻率保存在本機。
- 將 Phase 1 OpenAI Responses adapter 接到角色 persona／trait context；system instructions 來自 versioned character manifest，對話仍不持久化，沒有 key 時沿用相同人格的 fallback lines。
- Local share-card renderer：卡片包含 portrait、最多 3 個有證據的 trait、歸因句、期間與可選的 contributor counter；預設下載本機圖片，不建立公開 URL。

#### 測試與體驗閘門

- Determinism golden tests：相同輸入跨重啟、跨平台產出相同 trait IDs 與原因。
- Scaling invariant：把所有 token count 等比例放大十倍，不得自動解鎖更強角色、稀有物或更多權限。
- Boundary tests：門檻上下的結果與說明一致，沒有 UI 顯示 A、engine 判斷 B。
- Snapshot／visual regression 覆蓋四角色、兩語系、長文字與高對比模式。
- Share-card metadata、檔名及影像內容不含 installation ID、device ID、project、path、model 原始字串或 local username。
- Engine 與角色畫面在 airplane mode 下完整運作。

#### 退出／驗收條件

- 內部盲測至少能用卡片文字與視覺區分四種 archetype；正式門檻由 Phase 5 Alpha 決定。
- 每次角色主要變化都能顯示一個可核對的本機資料理由。
- 不存在「多燒 token 才能變強／抽更多」的 copy、欄位或 unlock rule。
- 四張 WebP 的 checksum、來源 commit、attribution、owner public-use grant 與 brand review 結論已進 manifest，且 `releaseStatus` 已由獨立 reviewer 改成 `approved`；任一項缺失就只能用 placeholder，不能進外部 Alpha／GA。

### 5.4 Phase 3 — Opt-in cloud、公開 API 與 counter

**目標：** 完成可刪除、可重送、無帳號的匿名 contribution vertical slice。

**估算：** 10–15 工程日。

**依賴：** Phase 0 contract v1、Phase 1 local revision model；`EXT-03` staging hosting／database credential。

**目前 source status：** Companion已實作content-blind實際payload preview、明確
preview ID確認後enrollment、OS-backed分權credential、只涵蓋完整掃描且已結束UTC日
的daily absolute snapshot、非重疊main-process background sync、手動retry、local
stop、delete與deletion status；scheduler已通過off-state zero-call、no-due zero-egress、
stop-abort與wake／overlap本機tests；server pause/resume已完成upload-scope auth、
current-consent resume、冪等狀態轉移、atomic D1 guard及paused-ingest整合tests。D1 `day-all-v1` compactor及Worker
排程已通過本機測試：每次只關閉最舊的一個完整到期UTC日，k<20或capacity不安全時
整日drop，否則寫入單一mapping-free coarse rollup；commit-time recheck、immutable
closure、atomic source cleanup與projection dirty同批完成。Production仍受本文件外部
依賴與release gates約束。

#### 雲端每日資料模型

- Cloud bucket 固定為 UTC calendar day；local hourly buckets 只用於圖表、monster traits 與 mood，adapter 在 contribution preview 前先聚合成每日 rows，hour／timezone／session timestamps 永不上傳。
- Opt-in enrollment 由 server 建立內部 identity 並一次回傳隨機 bearer secret；companion 只保存 secret，request body 不自報 contributor／enrollment ID。不得從 hardware、MAC、hostname、username 或 provider account 推導識別碼。
- `IngestSnapshotV1` envelope 只允許 `schemaVersion`、`batchId`、`generatedAt`、collector kind／adapterVersion／sourceVersion，以及 1–30 個 buckets；每個 bucket 只允許 UTC `bucketStart`、coarse `provider`／`modelFamily`／`tool`、`valueQuality`、經 contract 限定的 `tokens` 與 monotonic `revision`。Wire 不帶 `bucketId`、client hash、hour、額外行為計數或任何 stable hardware ID。
- Server 從已驗證的 enrollment context 加上 `(day_utc, provider, model_family, tool)` 建立 canonical identity；enrollment identity 從 bearer authentication 推導，不由 request body 自報，也不另建跨安裝 user identity。
- Server 對 normalize 後的安全 payload 自算 canonical hash，database unique key 為 `(authenticated_enrollment_id, day_utc, provider, model_family, tool)`：
  - 同 revision、server hash 相同：回傳成功但不變更；
  - 同 revision、server hash 不同：拒絕並記安全 audit event；
  - 較小 revision：視為 stale，成功略過；
  - 較大 revision：以 absolute values 取代舊 row，允許正向或負向修正；
  - `batchId` 位於 envelope，提供 request-level idempotency，但不能取代每個 canonical key 的 revision。
- Per-enrollment canonical rows 保留 30 天以支援 correction 與個別刪除；到期資料只有在 `k >= 20` 的 coarse cohort 才能 compact 成不含 enrollment mapping 的 anonymous historical rollup。未達門檻者延後 compaction 或刪除，不得用小群體 rollup 洩漏行為。
- Public aggregate 從 anonymous historical rollups 加上仍在 30 天窗口的 canonical rows 重算；cache 遺失時可全量重建。Rollup 必須保存 period／coarse dimensions／totals 與 compaction audit，不得只保存一個不可驗證的累加數字。

#### API 交付物

- `POST /v1/enrollments`：建立匿名 enrollment，並各自一次顯示最小權限的 upload 與 deletion secrets；response 不回 stable enrollment ID。
- `GET /v1/consent-documents/current?purpose=contribution` 與 `PUT /v1/me/consent`：讓 companion 對照 immutable consent revision、field allowlist、retention／delete 語意；product analytics 使用另一個 off-by-default purpose。
- `POST /v1/me/ingest-snapshots`：驗證 upload bearer、schema、body size、bucket 數、revision、retention window 與速率，再執行 transaction upsert。
- `POST /v1/me/pause`、`POST /v1/me/resume`：伺服器狀態與本機立即停止網路的語意分離，resume 重新顯示 consent／payload preview。
- `DELETE /v1/me/data` 與 `GET /v1/deletions/:jobId`：只接受 deletion secret，先撤銷 upload／deletion credentials，再刪除仍可識別的 30 天 buckets、shares 與 consent record，回傳 deletion receipt／狀態。已混入 anonymous rollup 的舊 totals 無法再定位或個別扣除。
- `GET /v1/public/totals`：只回傳 rolling active contributor count、token total、更新時間與方法說明。
- 選配 `POST /v1/me/shares`、`DELETE /v1/me/shares/:id`：只有使用者再次確認後建立高熵 slug；payload 只含預覽過的 derived traits／coarse totals，預設有 expiry。
- Database migrations、indexes、row-level authorization、aggregate refresh job 與 deletion cascade。
- Rate limit 分 enrollment、IP edge bucket 與 endpoint；應用 log 不保存完整 IP，edge log 的保留與存取寫入 data inventory。
- Body size、bucket count、token count 上限；異常速率或極端值進 quarantine，不直接污染 public aggregate。

#### Consent 與 deletion UX

- Cloud toggle 預設 off，且不得以 dark pattern 綁定角色、圖表或安裝流程。
- 開啟前顯示實際 JSON 風格欄位預覽、用途、保留與刪除方式；確認後保存 versioned consent receipt。
- 關閉後立即停止新上傳並保留「只停止」與「停止並刪除」兩個明確選項。
- Delete 完成後本機清除 enrollment secret；primary database 立即刪除仍可識別資料，公開 cache 在定義的短窗口內重建。Consent UI 必須在 opt-in 前說明 30 天後資料會不可逆匿名合併，屆時不能從舊總數中個別抽出；backup retention 與最長清除時間依 data inventory 公開說明。

#### Public Web 交付物

- Landing：一句話價值、四角色預覽、local-first 安裝流程與清楚 privacy boundary。
- Counter：文案固定表達「由選擇加入的貢獻者分享」，顯示 contributor 數與資料更新時間；不得推論代表全體開發者。
- Privacy education：會上傳／永不上傳的逐欄清單、如何關閉、如何刪除、如何驗證 collector 開源碼。
- Share route：安全 social metadata、無登入瀏覽、無公開列舉 endpoint、report／delete 能力。
- 至少 `zh-TW` 與 `en`；搜尋引擎 metadata 不誇大資料代表性。

#### 資料正確性與安全閘門

- Replay suite 對同 batch／daily logical key 重送 100 次，aggregate 與第一次相同；測試同時證明 client 未提供 `bucketId` 或 hash。
- Out-of-order suite 涵蓋 `r3 → r1 → r2`、同 revision 衝突、增加修正與減少修正；結果永遠是最高合法 revision。
- Deletion E2E：同時建立 retention window 內 bucket、已 compact anonymous rollup、share 與 cache；刪除後 current bucket 從公開總數扣除、anonymous historical total 不變、share 消失且舊 secret 無法再寫入，結果與 consent 文案一致。
- Contract fuzz：未知欄位、禁收欄位、深層 object、超大 integer、NaN 變形、壓縮炸彈與 oversized body 均被拒絕。
- Log assertion：request body、bearer、installation secret、usage dimensions 不出現在 access／application／error log。
- Cloud off E2E：API 完全看不到 enrollment、heartbeat 或 usage request。

#### 退出／驗收條件

- Staging counter 可由 anonymous rollups＋current canonical rows 從零重建，重建值與 live cache 完全相同。
- Retry、replay、rescan、修正與亂序測試沒有任何 double count。
- Consent preview 與實際 wire payload 逐欄一致；沒有 preview 外欄位。
- Enrollment deletion、token revoke、current-window counter 扣除、anonymous-history 保持與 share deletion 全部通過 E2E。
- API 在資料庫或 network 暫時故障時回傳可 retry 狀態；companion 保留 local queue，local 功能不受影響。

### 5.5 Phase 4 — 安裝包、Staging 與 Private Alpha readiness

**目標：** 把工程 build 變成外部測試者能安全安裝、更新、移除與回報的產品。

**估算：** 8–12 工程日。

**依賴：** Phase 1–3 vertical slices；`EXT-04` code-signing、`EXT-05` Alpha cohort consent。

#### 交付物

- 先完成一個 primary desktop target，再擴第二平台。建議順序由 Phase 0 ADR 依現有測試設備決定；GA 目標至少涵蓋 macOS Apple Silicon／Intel 與 Windows x64，Linux 可維持 CLI／local-web preview。
- Installer／uninstaller：
  - 安裝 companion 與 pinned collector；
  - 建立最小權限資料目錄；
  - uninstall 不刪本機資料前先詢問，並提供完整清除；
  - cloud enrollment 可在 uninstall 前刪除，或由 retention／recovery flow 後續處理。
- Collector lifecycle：單 instance lock、port negotiation、crash backoff、版本診斷與乾淨 shutdown。
- Signed update manifest、checksum 驗證、canary channel 與上一版 rollback。
- Staging 與 production 完全分離的 database、secrets、domain、rate limit 與 logging policy；不得把 production dump 放進開發環境。
- Release artifact 產生 SBOM、第三方 notices、asset manifest、build provenance 與 checksum。
- 可操作 runbooks：deploy、migration、rollback、collector outage、ingest backlog、counter drift、credential rotation、deletion failure、privacy incident、backup restore。
- Alpha research consent 與最小 metric dictionary。D7 活躍若需 app-open event，必須是獨立、明確同意的 Alpha study telemetry；不得使用 session replay、autocapture 或把 usage dimensions 當 analytics event。

#### Alpha 前硬性閘門

- Clean VM 完成 install → first run → local collection → cloud opt-in → upload → off → delete → uninstall 全流程。
- Cloud/API 完全中斷時，collector、local charts、character、fallback lines 與 local share-card 仍運作。
- 外部散佈包完成相應平台簽章／notarization；若 credential 尚未取得，只能內部 sideload，不得稱公開 Alpha。
- Critical／High dependency、SAST、secret-scan finding 為零；Medium 有 owner 與明確處理決定。
- Backup restore drill 在全新 staging database 成功；還原後 replay 仍 idempotent。
- Privacy review 對 wire capture、log sample、crash sample、database row 與 share payload 各做一次人工核對。
- P0／P1 已知 bug 為零；安裝、更新、rollback 與刪除均有自動或可重現手動測試。

#### 退出／驗收條件

- 產出帶版本、checksum、notices、known issues 的 Alpha artifacts。
- Support／feedback channel、incident owner 與停止 distribution 的方法已驗證。
- Alpha dashboard 只呈現經同意的研究 metric，不混入 prompts、paths、credentials 或細粒度 usage。
- Go／No-Go checklist 由產品、工程、隱私／安全與資產權利 owner 簽核。

### 5.6 Phase 5 — 30 人 Private Alpha 與 Kill Criteria

**目標：** 驗證「workflow 能轉成可辨識角色」及「匿名分享有足夠意願」，同時證明 collector 與 cloud contract 在真實環境不漏資料、不重複。

**估算：** 至少 7 日觀察窗，加 5–10 工程日處理回饋及最多一次主要規則迭代。

**依賴：** Phase 4 通過；`EXT-05` 招募至少 30 名重度 AI coding 使用者。

#### Alpha protocol

- Cohort 至少 30 人，涵蓋不同主要工具、作業系統、時區與單一／多工具 workflow。
- 先完成本機模式，再單獨詢問 cloud opt-in；不得把加入研究等同於同意公開貢獻。
- 每位參與者使用 7 日後看自己的角色卡，以一句話說明「為什麼牠像／不像我」。評分者在不知道原始資料下判斷 archetype。
- 另外以去識別的 share cards 進行陌生評審分類測試；卡片上的文字錨點保留，因為它本來就是產品的一部分。
- 分享行為以 participant 自報或明確 share action 計算，不掃描個人社群帳號。

#### 主要成功指標

| 指標 | 通過門檻 | 計算方式 |
|---|---:|---|
| 本人歸因理解 | ≥ 60% | 能正確說出至少一個主要 trait 及其資料原因 |
| 陌生人 archetype 辨識 | ≥ 50% | 看單張含標籤卡，分到預先定義的合理類型 |
| Cloud opt-in | ≥ 40% | 完成 local onboarding 的 Alpha 使用者中，主動開啟 contribution 的比例 |
| D7 active | ≥ 35% | 第 7 日仍開啟 companion 或有本機 collector 活動；只用已同意研究資料／訪談驗證 |
| 主動分享卡 | 參考門檻 ≥ 20% | 產生後實際使用 share action 或自報已分享 |

#### 安全與品質指標

- Forbidden-data incidents：0。
- 已確認的 replay／rescan double count：0。
- Enrollment deletion 失敗或刪除後仍可寫入：0。
- Qualified install completion ≥ 90%。
- Crash-free companion sessions ≥ 99%；collector crash loop 為 0。
- Public counter 與 canonical recompute 在每日 audit 中差異為 0。

#### Kill／Pivot 規則

以下是硬性停止條件：

1. 任何 prompt、response、source content、filename、path、API key、OAuth token 或 provider credential 進入 TokenMonster cloud wire、database、log、analytics、diagnostic 或 crash report，或 provider key 離開 companion／出現在核准 OpenAI request 的 Authorization header 以外位置：立即停止散佈、關閉相關功能、撤銷 secret、啟動 privacy incident；完成 root cause、清除與 regression test 前不得恢復。使用者明確送出的 BYOK prompt／response 只允許在 companion 與 OpenAI 的單次直接 request／stream 中短暫存在。
2. Replay／rescan 可重複增加總量，或 deletion 無法可靠扣除 retention window 內的公開總量：停止 cloud Alpha；local-only 可繼續，但不得公開 counter。
3. 本人歸因或陌生人辨識未達標：只允許一次 trait mapping／copy 迭代。第二個等規模 cohort 仍未通過，就停止擴張角色、全球牆與抽卡，評估 pivot 成純 local usage companion。
4. D7 < 35%：不進 Beta；先修 onboarding、提醒頻率與 weekly/event cadence，再做一次 cohort 驗證。
5. Opt-in < 40% 但 local D7 與歸因通過：不 kill local product，將 public counter 降為非主打／延後，優先改善信任與預覽；不得以獎勵或功能鎖強迫同意。
6. 每日 trait 維度跨箱比例 < 15%：這不是 kill；把 evolution 改為週級與極端事件里程碑。若跨人資料仍無法形成至少四個可辨 archetype，才視為核心差異化失敗。

#### 退出／驗收條件

- 主要四項門檻全數通過，或有書面 decision record 說明為何縮小 cloud scope 後仍可進 Beta。
- 所有 Alpha P0／P1 問題已關閉；P2 有 owner、重現步驟與 RC 前處理決定。
- Trait version、contract version 與 cohort 結果已封存，可重跑分析。
- 產品決策明確為「繼續」、「local-only pivot」或「停止」，不得以模糊平均分跳過 kill rule。

### 5.7 Phase 6 — Public Beta 與 Release Candidate

**目標：** 在不擴大核心 scope 的前提下完成規模、相容、可用性、法務及維運硬化。

**估算：** 8–12 工程日。

**依賴：** Phase 5 決策為繼續；所有 GA 外部依賴有明確完成證據。

#### 交付物

- 將 Alpha 通過的 trait rules 與 contract v1 feature-freeze；breaking change 只能新增 contract version，不能修改既有 wire semantics。
- 完成最低支援矩陣：macOS Apple Silicon／Intel、Windows x64；主要 local-web browser 為目前兩個穩定版本的 Chrome、Edge、Safari、Firefox。
- `zh-TW` 與 `en` 完整 copy、error、privacy、consent、delete、installer 與 share-card 檢查；其他語系排入 Later。
- Accessibility：keyboard flow、focus、reduced motion、高對比、圖表文字替代與 WCAG 2.2 AA 自動／人工檢查。
- Counter／ingest load test：
  - ingest 至少 50 requests/second 持續 15 分鐘，p95 < 500 ms；
  - cached public reads 至少 200 requests/second，p95 < 300 ms；
  - 5xx < 1%，且壓測後 canonical total、cache 與 replay audit 完全一致。
- Abuse controls：per-enrollment rate、edge rate、body limit、quarantine review、secret rotation；公開 counter 不顯示可被遊戲化的個人排名。
- Production observability：health／readiness、structured metrics、queue age、ingest accept／stale／conflict、aggregate drift、delete latency、release adoption；不得把 usage dimensions 放進 analytics。
- Privacy policy、terms、retention、subprocessor／hosting disclosure、unaffiliated character notice、第三方 notices 與使用者資料刪除說明。
- Release Candidate artifact、migration plan、rollback package、status page／support page與 launch FAQ。

#### RC 閘門

- 所有 CI、contract、privacy、E2E、browser、platform、load、restore 與 rollback suite 綠燈。
- Critical／High security finding 為零；第三方 dependency license 與 SBOM review 完成。
- Production migration 在 staging clone 演練成功；expand／migrate／contract 步驟可回復。
- 備份符合已定義 RPO／RTO，並完成一次從空環境還原；companion local store 能在可用窗口內安全重送，server revision protocol 不 double count。
- RC 進行受控 soak，無 P0／P1、無 counter drift、無 deletion breach、無 update rollback 失敗。
- `EXT-01` 到 `EXT-06` 中標示為 GA blocker 的項目全部關閉。

#### 退出／驗收條件

- Feature-freeze 的 RC 由產品、工程、安全／隱私、維運及資產權利 owner 簽核。
- GA dashboard、告警、on-call／incident contact 與 kill switch 均已實際觸發測試。
- Release notes 清楚說明已支援與尚未支援的 collector tools／OS，不借用上游「全部支援」宣稱未測平台。

### 5.8 GA — 分批正式上線與穩定化

**目標：** 可撤回、可觀察地把通過 RC 的相同 artifact 推向正式使用者。

**估算：** 3–5 工程日，另保留上線後密集觀察。

**依賴：** Phase 6 RC 全部通過。

#### Rollout 順序

1. 先部署 production API 與 Web，但 contribution enrollment 由 server feature flag 關閉。
2. 執行 smoke、migration、public copy、rate limit、delete、backup 與 alert check。
3. 對內部／Alpha cohort 開啟 enrollment，確認 local queue drain、counter 與 deletion。
4. Companion update 依 10% → 50% → 100% 分批；每一批都檢查 crash、adapter compatibility、queue age、conflict 與 delete latency。
5. 指標異常時停止下一批；API schema 不能回滾時採 forward fix，companion 可回上一個 signed artifact。
6. 100% 後才發公開 launch post；public copy 一律使用 opt-in contributor 定位。

#### GA Go／No-Go checklist

- Clean install、upgrade、rollback、uninstall 在支援平台通過。
- Offline/local-only 全功能通過；cloud outage 不阻擋 companion 啟動。
- Contribution default off、preview、consent、stop、delete 全通過 production smoke。
- Replay／out-of-order／revision／recompute audit 全通過。
- Asset rights、project license、privacy／terms、domain／TLS、code signing 全部有可查證紀錄。
- Production backup 最新且 restore drill 有記錄；incident runbook 有當班 owner。
- P0／P1 為零；Critical／High security finding 為零。
- Alpha／RC 指標與 kill criteria 沒有被未記錄地豁免。

#### GA 完成條件

- 100% rollout 後沒有 forbidden-data、double-count、deletion、migration 或 signing incident。
- Public counter 可從 anonymous rollups＋current canonical rows 重建，結果一致。
- Support、status、rollback、security contact 與 delete instructions 對外可用。
- 建立 post-launch review，將未完成事項移入 Now／Next／Later，而不是直接擴 scope。

## 6. 橫跨階段的測試、部署與安全閘門

| Gate | 每個 PR | Alpha 前 | RC／GA 前 |
|---|---|---|---|
| Type／lint／unit | 必須 | 必須 | 必須 |
| Contract snapshots | 資料 shape 變更必須 | v1 freeze | Backward compatibility matrix |
| Privacy regression | 禁收欄位 canary | Wire／DB／log 人工抽查 | 外部或獨立 reviewer sign-off |
| Adapter fixtures | 受影響 tool 必須 | 五個 qualification sources | 全支援矩陣與 pinned-version test |
| Idempotency | Domain unit／property | Staging replay／亂序 E2E | Production smoke + recompute audit |
| Deletion | Domain／DB integration | Full enrollment/share/cache E2E | Production smoke + runbook drill |
| Companion E2E | 受影響 flow | Clean VM install／offline／uninstall | Upgrade／rollback／多平台 |
| Web E2E | 受影響 route | Consent／counter／share | Browser matrix、a11y、SEO copy |
| Security | Secret／dependency scan | SAST、threat review、loopback test | SBOM、license、penetration review、0 High |
| Operations | Migration unit | Staging deploy／restore | Production restore、alert、rollback drill |
| Performance | Hot-path benchmark | Basic soak | API load、desktop resource budget |

額外的 Definition of Done：

- 任何新增／變更 wire or storage 欄位，同一個 PR 必須更新 contract、data inventory、retention／deletion 說明及 privacy regression fixture。
- 任何 collector fork patch 必須附 upstream reference、最小 diff、跨平台測試與下次 upstream sync 的移除判斷。
- 任何角色規則變更必須更新 explanation copy、determinism fixture 與 token-scaling invariant。
- 任何 analytics／error-reporting event 必須在 metric dictionary 中列出完整欄位；未列入即不得送出。
- 所有 production deploy 都產生 immutable artifact、commit SHA、migration version、SBOM 與 rollback target。

## 7. 部署與資料營運策略

### 環境

- `local`：只使用 fixture／synthetic data，不需 cloud credential。
- `development`：共享或個人開發環境，不使用 production data。
- `staging`：與 production 同 topology、獨立 secrets／database／domain；用合成與明確同意的測試資料。
- `production`：最小權限 service accounts、secret manager、獨立 backup、audit access 與經核准的 log retention。

### Web／API deploy

- 新專案預設以單一 Cloudflare Worker 部署 React/Vite Static Assets 與 Hono API；兩者維持 package/domain 邊界，但同一 artifact、同一版本與同一 rollback。未另寫 ADR 前不拆成 Pages＋獨立 Worker。
- D1 保存 canonical rows；application body 上限固定 64 KB、每批最多 30 buckets，不依賴平台較大的 request limit。Paid production database 仍以每 DB 10 GB 為硬上限並監控成長。
- Database migration 採 expand → deploy → migrate → contract；不可在同一步先破壞舊 companion contract。
- API 支援至少目前與前一個 contribution schema version；淘汰需先在 companion 顯示、等待 adoption，再明確停止。
- Counter cache 可丟棄重建；anonymous rollups、current canonical bucket rows、enrollment、consent 與 deletion state 才是資料真相。
- D1 Time Travel 不是唯一備份：production 每日做 logical export／可重建快照，定期從零演練 rollups＋current rows → public counter rebuild 與 rollback。
- API outage 時 companion exponential backoff 並保留有界 local queue；恢復後按 revision 重送。

### Desktop release

- Stable、canary channel 使用不同 feed；artifact 全部簽章並驗 checksum。
- Collector pin 只有通過 adapter compatibility matrix 才能升級。
- Auto-update 不得自動打開 cloud contribution、改 consent 或安裝額外 provider credential helper。
- Crash report 預設不含 dump 內存／local database；若需要詳細診斷，使用者先預覽與手動提交。

## 8. 主要風險與緩解

| 風險 | 早期訊號 | 緩解 | 觸發決策 |
|---|---|---|---|
| tokscale／選配 TokenTracker schema 漂移 | Compatibility test fail、欄位消失 | Exact pins、adapter allowlist、contract fixtures、fail closed | 必要時只在獨立 fork 加最小 parser／hook patch |
| Fork 長期分岔 | Patch 數量／衝突持續增加 | 每個 patch 有移除條件、固定 upstream sync audit | 超過可維護上限時改採 upstream contribution 或重新評估 collector |
| 上游資料夾帶敏感內容 | Fixture 出現 prompt/path-like 欄位 | 只取 aggregate endpoint、allowlist projection、禁收 canary、log redaction | 任一外洩立即停止 distribution／ingest |
| Replay／亂序造成灌水 | Aggregate 與 recompute 漂移 | Absolute values、monotonic revision、unique key、transaction、每日 audit | Drift 非零即關閉 public counter 寫入 |
| 匿名 ID 可被串聯 | 同一 ID 跨 reinstall／share 出現 | 隨機 enrollment、可 rotate／delete、不用 hardware fingerprint、share ID 分離 | Privacy review 未通過不進 Alpha |
| 惡意灌數污染 counter | 異常速率、極端 model bucket | Enrollment secret、limits、quarantine、無個人排名、可重算 | 污染未控前 counter 標示暫停更新 |
| Opt-in 太低 | Preview 後大量取消 | 改善信任與 local value，不綁功能、不給燒量獎勵 | Local-only pivot，不以 dark pattern 補數字 |
| 角色看不懂／每天不變 | 歸因與辨識分數低、日 variance 低 | 明確 trait＋原因、週級／事件級 cadence、只一次 mapping 迭代 | 第二 cohort 仍失敗則停止角色擴張 |
| Token burn 被遊戲化 | 使用者為解鎖而刷量 | Ratio／diversity／streak、cap／log normalization、無戰力／排行 | 出現刷量誘因立即移除該 reward |
| AI-Sister 資產權利不完整 | 缺 source／checksum／書面同意 | Placeholder 開發、manifest、owner approval、unaffiliated disclosure | 未完成不得外部散佈 |
| Live2D／聲音授權風險 | 想沿用 sample model／非官方 TTS | GA 排除；之後只用自有商用 rig 與官方 TTS | 權利未完成不實作／不發布 |
| Desktop signing 延誤 | 無 Apple／Windows credential | 早期申請、內部 sideload 與公開 release 分開 | 未簽只能內測，不宣稱 GA |
| Cloud outage／資料遺失 | Queue age、5xx、restore 失敗 | Local source of truth、idempotent retry、backup／restore drill | 保留 local 功能，暫停 contribution |
| Solo maintainer 維運風險 | Runbook 只有作者能操作 | Automation、runbook、least privilege、第二 reviewer | 無 backup operator 不進 GA |

## 9. 外部依賴與阻擋點

| ID | 外部依賴 | 最晚需要階段 | 阻擋內容 | 可先做的替代 |
|---|---|---|---|---|
| EXT-01 | 四張 AI-Sister WebP 的 owner public-use grant、brand review、來源、checksum 與 attribution | Phase 4 | 將 `releaseStatus` 從 `blocked` 改為 `approved`、外部 Alpha／GA 正式角色素材 | Placeholder portraits |
| EXT-02 | TokenMonster 自有程式／資產 license、商標與 unaffiliated 文案決定 | Phase 6 | Public release／對外授權聲稱 | Private repo 開發 |
| EXT-03 | Hosting、managed database、secret manager、staging／production credential | Phase 3 | Cloud vertical slice | Local API emulator／fixture |
| EXT-04 | Production domain、DNS、TLS 與 Apple／Windows code-signing 資格 | Phase 4／GA | 公開網站、signed installer | Staging domain、內部 sideload |
| EXT-05 | 至少 30 名符合條件的 Alpha 使用者與研究同意 | Phase 5 | Product metrics gate | 內部 synthetic／paper test，不可取代 Alpha |
| EXT-06 | Privacy／security reviewer、privacy policy／terms 最終核准 | Phase 6 | RC／GA | Threat model 與內部 review |
| EXT-07 | Collector fork 發布／CI 權限與 upstream sync owner | Phase 1 | 必要的 fork patch | 保持 npm pin；未需要 patch 時不阻擋 |
| EXT-08 | 可撤銷的 OpenAI API 測試 project／credential 與 spend limit | Phase 1 | 真實 Responses smoke；不阻擋 mock CI 或無 key fallback | Mock provider、使用者自備 key |

每個外部依賴需在 issue tracker 有 owner、證據連結、替代方案及「未完成時不可做什麼」。不得用程式碼中的 TODO 代替 release blocker。

## 10. 歷史 Now／Next／Later backlog（已由 ADR 0005 取代）

以下保留為 migration provenance，不是目前實作指令；不得再替 Tokscale authority、
collector fork 或 Electron-owned collection 新增產品功能。

### Now — 建立安全的 local vertical slice

1. Scaffold monorepo、strict TypeScript、workspace scripts 與 CI。
2. 完成 contract v1、data inventory、threat model 與 privacy canary fixtures。
3. Exact-pin `tokscale@4.5.2`，完成 fixed-command／sanitized-environment adapter；TokenTracker 0.79.8 bridge 只做選配 compatibility spike。
4. 實作 collector allowlist projection、local revision model及四組 qualification fixtures，驗證兩種 parser authority 不會同時計數。
5. 實作 companion collector health、local store、基本圖表與 cloud-off network E2E。
6. 實作 OpenAI Responses local adapter、OS secret store、`store: false` assertion、mock E2E 與 fallback interaction。
7. 啟動 `EXT-01` 資產權利／brand review 與 `EXT-04` signing credential；兩者可等待，但不能拖到 Alpha 打包才開始。

### Next — 完成差異化、雲端閉環與 Alpha

1. 實作 deterministic monster-engine、四個 archetypes 以上、explanation keys 與 scaling invariant tests。
2. 只有 manifest `releaseStatus: "approved"` 時匯入 core-four WebP；否則以 placeholder 完成 character manifests、fallback lines、提醒與 local share card。
3. 實作 enrollment、consent preview、revision-aware ingest、deletion、recompute 與 public aggregate。
4. 實作 public landing、privacy education、counter 與 explicit share pages。
5. 完成 installer、signing、update／rollback、staging、runbooks、SBOM、restore 與 privacy review。
6. 執行 30 人／7 日 Alpha，依 metrics 與 kill criteria 做一次明確決策。

### Later — RC、GA 與通過驗證後的擴充

1. 完成 Beta compatibility、a11y、load、abuse、legal、RC freeze 與分批 GA。
2. 擴充 Local BYOK：在既有 OpenAI Responses MVP 之外加入 Anthropic、Gemini、xAI adapters、較完整的本機 multi-turn UX 與 per-provider policy；公開 API 永遠看不到 key。
3. 更多 AI-Sister／bestie 角色：每個角色獨立 asset provenance、權利與辨識測試，不批次搬入舊 repo。
4. 自有 Live2D／VRM、表情與官方 TTS：只有取得商用權利與效能預算後才啟動。
5. Cosmetic gacha／skin／voice pack：只由多樣性、里程碑與活動取得，不按 raw token burn 給強度，沒有 pay-to-win。
6. 全球角色牆、archetype percentile、multi-device account view：只有 opt-in、D7、分享與 abuse 指標證明必要時再做。
7. 額外語系、Linux native shell、行動版 viewer、進階提醒與可選本機模型。

## 11. 第一個實作迭代的完成定義

第一個迭代不以「畫面看起來像產品」為完成，而以以下可驗證結果為準：

- Clean checkout 能跑 CI。
- Pinned collector 的一組真實／sanitized fixture 經 adapter 變成 contract v1。
- Companion 能在 airplane mode 顯示 aggregate chart。
- Cloud toggle 預設 off，network test 證明沒有 usage egress。
- 相同 fixture 重掃 100 次，local total 不變。
- Forbidden-data canary 不出現在 local DB、log 或 diagnostic。
- Monster engine 接到同一份 fixture 時產生 deterministic placeholder trait 與一句原因。
- OpenAI mock request 明確含 `store: false`，key、prompt、response 都未進入 TokenMonster persistence、log 或 cloud contract；沒有 key 時 fallback line 正常顯示。

這條垂直切片通過後，才開始加入正式角色 art 與 production cloud。它同時驗證整個專案最重要的三件事：資料邊界守得住、上游可以被窄 adapter 隔離，以及 TokenMonster 的 domain logic 不依附在 framework handler 或第三方 dashboard 中。
