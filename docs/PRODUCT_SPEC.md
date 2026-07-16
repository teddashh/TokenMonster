# TokenMonster 產品規格

> Architecture update (2026-07-15): local collector/runtime UX is now a
> one-command TokenMonster companion over an exact-pinned TokenTracker sidecar.
> Conflicting Tokscale/Electron or fork language is legacy and is superseded by
> [ADR 0005](adr/0005-permanent-tokentracker-sidecar-adapter.md).

| 欄位 | 內容 |
| --- | --- |
| 文件狀態 | Launch target + tested source-slice baseline；不是 production evidence |
| 文件版本 | 0.3 |
| 更新日期 | 2026-07-16 |
| 產品名稱 | TokenMonster |
| 首要目標 | 將產品安全、可信地上線，並驗證「AI 使用足跡可以養出像自己的角色」 |
| 規格範圍 | 產品承諾、MVP、使用流程、成功指標、驗收條件與待決策項目 |

## 1. 文件用語與決策層級

本文件使用以下規範詞：

- 「必須」：公開 MVP 上線前不可缺少。
- 「應該」：強烈建議；若不實作，需留下決策紀錄與替代方案。
- 「可以」：不阻擋 MVP，可依容量安排。
- 「後續階段」：屬於產品承諾或方向，但不屬於本次 MVP 上線範圍。

本文件刻意區分三類內容：

1. 已承諾的產品需求：來自使用者原始構想與後續明確裁決。
2. MVP 實作範圍：為了可安全上線、可驗證核心價值而收斂的第一版。
3. 建議預設：尚未被產品負責人裁決，但團隊可依此先行，不應阻塞低風險工作。

### 1.1 目前實作快照（2026-07-16）

Local Companion、exact-pinned TokenTracker sidecar、11 位角色與本機進度引擎、按需角色
asset downloader／cache、BYOK 對話、
本機圖表與 export/reset，以及預設關閉的匿名 contribution source slice（實際
payload preview、enrollment、OS-backed scoped secrets、背景 sync／冪等 retry、停止、
刪除與狀態查詢），已有可重跑的本機 source tests。Web/API、D1 mutation/deletion、
`day-all-v1` k=20 anonymous compactor、保留 compaction inputs 的 retention、projection
與 Durable Object quota/suppression 也已有本機測試；minute cron 的順序固定為
`deletion → compactor → preserving retention → projection`，每次最多關閉一個完整、
已結束且到期的 UTC 日。未達 20 人或超過安全容量的日會整日刪除，不產生匿名
rollup。

這些都只是 source-level evidence，不是 production evidence。Companion background
sync的packet capture／wake soak、Cloudflare account／D1／domain／secrets、remote rehearsal／staging E2E、
backup/restore與suppression replay、signed installer、平台實機smoke、專案 license／
法律文件與後續 voice 資產權利仍是上線閘門。本文其餘需求描述的是完整 launch
target；不得因列在本規格中就宣稱已部署或已對外提供。

`tokentracker-cli@0.80.0` 是現有唯一 authoritative collector，Tokscale／Electron
是 migration-only legacy slice。圖像不包在 npm artifact；release 只內嵌核准 manifest，
由 companion 在解鎖後按需下載、驗證並快取。

## 2. 產品摘要

TokenMonster 是一個 local-first 的 AI Token 使用足跡產品。使用者安裝本機 collector 後，可以在本地查看跨 AI 工具、provider 與 model 的 Token 使用量；系統再把不含內容的使用輪廓轉譯成一個 AI 字母人角色的個性、情緒與外觀變化。

使用者可自行選擇是否匿名分享彙總數據。公開網站顯示的不是「全世界真實 AI 使用量」，而是「TokenMonster 貢獻者自願分享的 Token 總量」。訪客可以看到這個公開計數、了解資料邊界，並下載 collector。

TokenMonster 的差異化不是另一個成本報表，而是：

> 把跨工具的 AI 使用足跡，轉成一個可解釋、可陪伴、可分享的開發者身份角色。

## 3. 已確認基線與限制

### 3.1 已驗證的工程基線

- TokenMonster 採自有 monorepo，產品、雲端契約、角色引擎與 consent 邊界不繼承任何 collector 上游的產品架構。
- 預設 collector 是 exact-pinned `tokscale@4.5.2`；首發驗證範圍是 Claude Code、Codex CLI、Gemini CLI 與 Grok Build。每次升級都必須重新跑 golden fixtures 與隱私測試。
- `tokentracker-cli@0.79.8` 只作為尚未實作的相容性 target：未來若提供給已安裝 TokenTracker 的使用者，必須與 tokscale 模式互斥。Bridge 只可讀 loopback aggregate endpoint，強制上游 telemetry 關閉，且永不啟用上游 cloud sync。支援矩陣只反映當前選定 collector 中已通過 TokenMonster fixtures 的來源，不承接上游來源數量或支援清單。
- 公開 fork `teddashh/tokenmonster-collector` 只承載無法在 adapter 解決的最小 parser／hook patch；TokenMonster 不整套搬入 TokenTracker 產品與原始碼作為基底。
- AI-Sister / multi-ai-chat-app 現有角色設計是 raster 圖像資產，不是 Live2D 模型，也沒有可直接使用的 3D rig。
- 四張候選核心角色圖在 owner public-use grant 與 brand review 完成前一律是 `blocked`。MVP 角色系統必須能以 placeholder 完整運作，不得把未清權素材包進公開 artifact。

### 3.2 資料可取得性的限制

- 初期主要服務能由 pinned collector 產出經核准 aggregate output 的 AI coding、CLI、IDE 與開發工具使用者；TokenMonster adapter 不持久化上游 raw log 或 session。
- ChatGPT、Claude、Gemini、Grok 等一般消費者網頁訂閱，不應被宣稱可以由第三方穩定、完整地取得 Token 用量。
- MVP 不以網頁 scraping、瀏覽器 UI 攔截或違反 provider 使用條款的方式補足缺口。
- Provider、model、tool 與 Token 欄位的可得性不同。產品必須顯示「精確、推算或不可得」，不可把推算值偽裝成官方帳務數字。

### 3.3 公開統計的措辭限制

公開頁面的主文案建議固定為：

> TokenMonster 貢獻者已分享的 Token 總量

並在數字附近固定顯示：

> 只包含自願匿名分享者，不代表全球所有 AI 使用量。

英文對應建議為：

> Tokens shared by TokenMonster contributors

禁止使用「全球真實 Token 使用量」、「全人類已消耗」或任何暗示完整市場統計的措辭。

## 4. 產品目標

### 4.1 使用者目標

1. 使用者能在一個地方看到自己跨 AI 工具的累積與近期 Token 使用量。
2. 使用者不需交出 prompt、response、檔案內容或 API key，也能獲得核心追蹤與角色體驗。
3. 使用者能理解角色為何呈現目前的 traits、情緒與變化。
4. 使用者能把 AI 使用習慣看成個人風格，而不是只看到成本或冷冰冰的數字。
5. 使用者可以自行決定是否將匿名彙總貢獻到公開計數。

### 4.2 商業與產品目標

1. 建立可信任、可長期常駐的 collector 安裝基礎。
2. 證明「coding-style fingerprint → 字母人」比一般 Token dashboard 更有辨識度與分享動機。
3. 讓公開網站成為清楚、可傳播的入口，而不是假裝精準的全球統計產品。
4. 建立可擴充到角色收藏、語音包、多裝置同步與社群展示的資料與角色架構。

### 4.3 產品原則

- Local-first：本地追蹤、圖表與角色在中央服務離線時仍可用。
- Consent-first：匿名分享預設關閉，明確 opt-in，隨時可停止。
- Content-blind：不收集或保存 prompt、response、原始程式碼、檔案內容、檔名或專案路徑。
- Explainable identity：主角色 traits 必須可讀、可歸因，不使用黑箱亂數決定身份。
- Horizontal expression：角色長得不同，不代表誰更強。
- Honest aggregation：公開數字只代表 contributors，不代表全體使用者。
- Fun without burn incentives：不獎勵故意燒 Token，也不把高用量設計成競賽。

## 5. 已承諾的產品需求

| ID | 已承諾需求 | MVP 狀態 |
| --- | --- | --- |
| C-01 | 提供可下載的本機 Token collector | 必須 |
| C-02 | 彙總多工具、多 provider、model 與 Token 使用量 | 必須；依支援矩陣誠實標示 |
| C-03 | 避免重掃、重啟與重傳造成重複計數 | 必須 |
| C-04 | 提供本地圖表與累積用量檢視 | 必須 |
| C-05 | 以 AI-Sister core-four 候選設計作為 AI 字母人視覺方向 | 必須；只發布 `approved` raster，未清權時用 placeholder |
| C-06 | 字母人依 tooling、provider/model 比例、使用節律等 coding style 產生特色 | 必須 |
| C-07 | 字母人有短期情緒、較長期發展與用量提醒 | 必須；提醒預設關閉 |
| C-08 | 字母人的發展是水平客製化，不是更強或高低排名 | 必須 |
| C-09 | 使用者可選擇是否匿名上傳彙總數據 | 必須；預設關閉 |
| C-10 | 公開網站顯示自願 contributors 的累積數字 | 必須 |
| C-11 | 使用者可自行提供 API key 與字母人對話 | MVP 必須支援本機 OpenAI Responses BYOK 路徑 |
| C-12 | 未提供 API key 時，字母人仍能說固定系統台詞 | 必須 |
| C-13 | 圖表與角色體驗可切換 | 必須 |
| C-14 | 皮膚、語音包與收藏機制 | 後續階段；純 cosmetic，不做戰力 |
| C-15 | 角色可被分享並表達自己的 AI 使用風格 | MVP 新增的策略性必要需求 |

## 6. 非目標

下列項目不屬於公開 MVP：

- 宣稱統計所有 ChatGPT、Claude、Gemini 或 Grok 消費者的真實 Token 用量。
- 以 scraping 消費者網頁 UI 作為核心資料來源。
- 取代 provider 官方 billing、財務報表或企業 observability。
- 上傳 prompt、response、原始碼、檔案內容、任何檔名／專案路徑或 API key。
- 把使用者 API key 存到 TokenMonster 中央伺服器。
- Token 總量排行榜、戰力排行、SSR 階級或「燒越多越強」。
- 付費 gacha、抽卡商城或以 Token 燃燒量無限發券。
- 完整社群動態牆、留言、追蹤、私訊或公會。
- 在既有 raster 素材上假裝提供 Live2D 或 3D 動畫。
- 第一版完成所有 voice pack、TTS/STT provider 與角色嘴型。
- 以成本最低或精準帳單作為主要產品承諾。

## 7. 目標使用者

### Persona A：重度 AI coding 使用者

- 同時使用 Claude Code、Cursor、Gemini、OpenAI 或其他 AI coding 工具。
- 想知道自己的總使用量與工具分布，但不想逐一打開各服務 dashboard。
- 對「我的 AI workflow 長什麼樣」比單純報表更有興趣。
- 主要價值：跨工具彙總、個人角色、分享卡。

### Persona B：隱私優先的本地使用者

- 願意安裝開源 collector，但會檢查網路流量與上傳欄位。
- 不一定會開啟匿名分享，也不一定提供 API key。
- 主要價值：local-only 圖表、角色、可驗證的資料邊界。

### Persona C：公開網站訪客

- 尚未安裝 collector，可能從分享卡、社群貼文或搜尋進站。
- 想看目前 contributors 分享的累積數字與角色概念。
- 主要價值：理解產品、查看誠實的公開計數、下載 collector。

### Persona D：角色陪伴型使用者

- 對原始 Token 數據興趣普通，但在意 AI-Sister 角色、台詞、提醒與個人化。
- 可能使用 BYOK 對話，也可能只使用固定台詞。
- 主要價值：陪伴感、情緒回饋、角色收藏。

## 8. 核心使用流程

### 8.1 首次安裝

Collector 狀態依序為 `starting` → `syncing` → `ready`；無支援資料但掃描完成時是
`ready-no-data`，無上次成功資料的失敗是 `refresh-failed`，已有上次快照的失敗是
`stale`。使用者可手動「重新掃描」；gateway 共用 in-flight refresh，並限制新 refresh request
至少間隔 5 秒。

1. 使用者從公開網站下載 collector／desktop companion。
2. 安裝頁清楚說明 collector 會讀取什麼、不會讀取什麼。
3. collector 掃描可支援的本地來源，列出偵測結果與資料精確度。
4. 初始 roster 顯示四位姊妹與七位朋友。系統可依下節規則建議一位 starter，但使用者選擇永遠優先；GLM 固定使用內建字母模式。
5. 系統匯入並去重歷史 usage，建立本地 dashboard。
6. 系統生成第一組 2 至 3 個主 traits，並為每個 trait 顯示原因。
7. 系統詢問是否開啟通知；預設不開。
8. 系統另外詢問是否匿名分享；預設不開，且可先預覽 payload。

### 8.1.1 本機 starter 建議

- TokenMonster 只把 TokenTracker exact source IDs `codex`、`claude`、`gemini`、`grok` 分別映射為 `openai`、`anthropic`、`google`、`xai`，再對應四位預設姊妹；不從 model 名稱或其他 source 猜測 provider。
- 最近 28 個 UTC 日中，只有一個 provider 的正數總量嚴格最高時，系統才建議對應 starter。最高值平手、沒有正數資料或 provider breakdown endpoint 失敗時，一律請使用者手動選擇。
- 這是首次呈現的便利建議，同時會把該姊妹記為本機已解鎖的起始角色。使用者可在當下或之後覆寫；進度不形成能力、階級或排名。
- Browser 只收到 allowlisted starter decision 與原因，不收到用來比較的 provider totals、model IDs 或 cost。

### 8.2 日常使用

1. collector 在背景增量讀取新 usage。
2. 本地資料更新後，dashboard 顯示今日、7 日、30 日與累積統計。
3. 身份 traits 依較長時間窗更新；短期 mood 依當日或本機使用節奏相對個人基準更新。這些 hourly／session-like 細節只在本機計算，不進入 cloud wire。
4. 使用者可從角色切到圖表，或點擊「為什麼」查看變化理由。
5. 若使用者開啟提醒，系統依 quiet hours 顯示本地通知。

### 8.3 匿名分享

1. 使用者開啟「貢獻到 TokenMonster」。
2. UI 顯示即將上傳的完整欄位清單與一筆範例 payload。
3. 使用者確認後，collector 只上傳 revisioned UTC daily aggregate snapshots。
4. 中央服務做冪等 upsert，公開 counter 只增加實際淨差額。
5. 使用者關閉分享後，usage 上傳必須立即停止。
6. 使用者可在仍持有本地 contributor secret 時停止分享並刪除 retention window 內仍可識別的貢獻；UI 在 opt-in 前已說明更舊資料會被不可逆混入匿名 rollup，無法再個別抽出。

### 8.4 字母人互動

未提供 API key：

- 角色依 mood、時間與 usage 觸發本地固定台詞。
- 固定台詞不需網路即可使用。

已提供 API key：

- MVP 只開放 OpenAI Responses 路徑；key 存在 OS keychain 或等價 secret store，不得進入 renderer 可讀的明文儲存。
- 對話由 companion main process 直接傳到 OpenAI，每次 Responses request 明確設定 `store: false`；TokenMonster public API 不參與。
- prompt 與 response 只能在當前 UI session 記憶體中短暫處理，關閉對話即清除，不寫入儲存、log、analytics 或雲端。
- 發生 key 無效、限流或網路錯誤時，安全降級到固定台詞。

### 8.5 分享角色

1. 使用者點擊產生分享卡。
2. 分享卡包含角色、2 至 3 個主 traits、簡短歸因句、時間範圍與 contributors counter。
3. 使用者可在匯出前移除總量、工具名稱或公開 counter。
4. 分享卡不得包含本機路徑、專案名稱、帳號、API key 或原始對話內容。

## 9. MVP 定義

本文件中的 MVP 指第一個可公開上線、可安全招募外部使用者的版本，不只是內部 prototype。

### 9.1 MVP 必須包含

#### A. Local collector

- 以 exact-pinned `tokscale@4.5.2` 的狹窄 adapter 作為預設路徑；可選 TokenTracker bridge 必須與它互斥，絕不可把兩者結果相加。
- Claude Code、Codex CLI、Gemini CLI 與 Grok Build 是 Tier 1；每個正式支援來源都必須有無敏感內容的 fixture、欄位投影與重算測試。
- adapter 只執行固定 argv、清洗環境變數、隔離上游設定目錄，並設定 timeout 與 stdout 上限；不可開放任意 shell、登入、遙測或 submit 指令。
- 本地持久化 hourly absolute snapshots，支援離線、重掃與向下修正；雲端 queue 再聚合成 UTC daily snapshots。
- 每筆 snapshot 標示 adapter／source 版本、時間窗、provider/model/tool、Token 類別與精確度；raw upstream JSON 不落盤、不進 log。

#### B. Local dashboard

- 今日、7 日、30 日、累積時間範圍。
- provider、model、tool 分布。
- input、output、cache、reasoning 等欄位僅在來源提供時顯示；`reasoning` 是 `output` 的資訊性子集，不得在 stacked chart 或總量中再加一次。
- 「精確、推算、不可得」狀態。
- 角色／圖表切換。

#### C. AI 字母人

- Launch roster 是 11 位角色；release-embedded strict manifest 為其中 10 位列出各 20 種衣櫥與 pose art，GLM 使用 letter mode。
- 使用圖像切換、裁切、色彩效果、配件 overlay、對話框與輕量 CSS/canvas 動畫呈現狀態。
- 不要求 Live2D、3D rig 或即時嘴型。
- 顯示 2 至 3 個可解釋主 traits。
- 顯示一個短期 mood 與至少一句變化原因。
- 總 Token 可作為能量、光暈或成長背景值，但必須封頂或對數化，不形成戰力與排名。

#### D. 角色規則引擎

- 主身份採可讀且 deterministic 的規則。
- 同一份標準化 footprint 必須得到相同的主 traits。
- 表情、姿勢或材質可以有受限變化，但不可改寫主身份意義。
- 規則只使用 content-blind 欄位。
- 若來源沒有可靠 task metadata，不得宣稱使用者正在 debug、research 或做特定專案工作；只能使用實際可觀察的替代描述。

#### E. Opt-in contributor upload

- 預設關閉。
- 啟用前提供 payload preview。
- 只上傳聚合 bucket，不上傳原始事件。
- 支援離線 queue、重試、冪等 upsert 與停止分享。刪除可扣除 30 天 current window 內仍可識別的貢獻；不含 enrollment mapping 的舊 anonymous rollup 無法個別抽出，必須在 opt-in 前揭露。
- 分享與產品 analytics 必須是兩個獨立 consent。

#### F. 公開網站

- 顯示 all-time 與今日（UTC calendar day）contributors shared tokens。
- 顯示 contributor 數、最後更新時間與資料邊界說明。
- 提供下載、隱私說明、支援來源矩陣與常見問題。
- breakdown 只有在達到最低匿名群體門檻時才公開。
- 不以假資料讓數字持續成長；可做數字動畫，但終點必須是最近一次已確認 aggregate。

#### G. 對話與固定台詞

- 無 key 時提供至少一組可離線的繁體中文固定台詞。
- BYOK 支援本機 OpenAI Responses API 路徑，明確設定 `store: false`；prompt／response 只留在當前 UI session 記憶體，關閉對話即清除。
- key 不得離開本機安全儲存與 provider 請求邊界。

#### H. 提醒與分享卡

- 提醒預設關閉，可設定 quiet hours 並可完全停用。
- 分享卡可匯出 PNG。
- 分享卡自帶 traits、歸因句與 contributor wording。

### 9.2 MVP 應該包含

- 繁體中文與英文基礎介面。
- 自動更新與清楚版本資訊。
- collector 診斷頁，可匯出不含敏感資料的 debug report。
- 角色變化歷史，讓使用者看到「昨天與本週」的差異。
- 降低動態效果設定。
- 完整 OSS notices 與角色素材 attribution。

### 9.3 MVP 明確延後

- 多裝置帳號同步。
- 公開怪物陳列牆。
- 角色追蹤、留言或社交關係。
- 隨機抽卡與稀有度階級。
- 付費 skin／voice pack 商店。
- 完整語音對話、STT、嘴型同步。
- 3D 或 Live2D 重製。
- 企業團隊與正式 billing 功能。

## 10. 功能需求細節

### 10.1 支援來源矩陣

每個 adapter 必須在 UI 與文件中標示：

- 工具名稱與版本範圍。
- 作業系統支援狀態。
- 資料來源機制（例如 pinned subprocess 或 loopback aggregate API）；不顯示、保存或輸出實際檔名與路徑。
- 可取得的 Token 欄位。
- provider/model 是否為原始值或推算值。
- 是否支援歷史匯入、增量追蹤與修正。
- 測試狀態：verified、beta、experimental、disabled。

MVP 的 verified 範圍固定為 Claude Code、Codex CLI、Gemini CLI 與 Grok Build。支援矩陣必須依目前選定的 pinned collector 與 TokenMonster fixtures 實測結果生成；未通過對應 fixture 的來源不得被當作產品能力列出。TokenTracker bridge 不會將上游的完整支援清單轉成 TokenMonster 承諾。

### 10.2 本地 canonical usage snapshot

本地 canonical snapshot 至少包含：

- schema version。
- adapter ID、adapter version 與 exact upstream source version。
- UTC window start／end；hourly bucket 與本地 timezone 僅供本機圖表、mood 與節奏計算，永不進入 cloud wire。
- allowlisted provider family、model family、tool ID。
- input、output、cache read、cache write、reasoning、other、total tokens。
- value quality：exact、estimated、unknown；`unknown` 只能留在本機，未分類前不上傳。
- monotonic revision、first seen 與 last reconciled；後兩者是 local-only reconciliation metadata，不進入 wire。

各數值先以 `BigInt` 驗算，寫入 wire 前必須小於或等於 `Number.MAX_SAFE_INTEGER`。`input` 不含 cache；`reasoning` 是 `output` 的資訊性子集，因此 `total = input + output + cacheRead + cacheWrite + other`，不可再把 reasoning 加一次。

TokenMonster adapter 必須在持久化前丟棄上游的 session、project label、filename、path、message count、cost 與 diagnostics；raw upstream JSON 不落盤、不進 log。本機去重只使用上述 aggregate logical bucket 與 revision，不建立由檔名、路徑、專案或帳號推導的 fingerprint。

### 10.3 去重與修正

去重有兩層：

1. 本地 snapshot 層：重掃同一 upstream usage window、collector 重啟或來源 rotation 後，同一 logical bucket 只會被 absolute value 取代，不得再次累加。
2. 中央彙總層：同一 aggregate snapshot 重送、亂序送達或 retry，不得讓公開數字重複增加。

中央服務只接收 revisioned UTC daily aggregate snapshots，不接收 append-only 原始事件。伺服器用 authenticated contributor／enrollment context 加上 `bucketStart`、`provider`、`modelFamily` 與 `tool` 建立 logical key，並對正規化 payload 自行計算 canonical hash；相同 revision／相同 server hash 是 no-op，相同 revision／不同 server hash 回 `409`，較舊 revision 忽略，較新 revision 以新 absolute value 取代並只反映淨差額。

跨裝置讀到同一份同步 log 的去重在無帳號 MVP 中無法保證。若發生，UI 與公開方法論必須揭露限制；不可暗示已完成全球唯一去重。

### 10.4 上傳 aggregate schema

`IngestSnapshotV1` request body 是 strict object，唯一 allowlist 為：

- Envelope：`schemaVersion: "1"`、client 產生的 UUID `batchId`、UTC `generatedAt`、`collector` 與 `buckets`。`batchId` 只供 whole-request retry 去重，不是身份、憑證或 bucket key。
- `collector`：`kind` 只能是 `tokscale` 或 `tokentracker-bridge`，並帶 TokenMonster `adapterVersion` 與 exact upstream `sourceVersion` SemVer。
- `buckets`：1 至 30 個 UTC calendar-day absolute buckets；每個 bucket 只有 UTC day-boundary `bucketStart`、allowlisted `provider`、normalized `modelFamily`、normalized `tool`、`valueQuality`、正整數 `revision` 與 `tokens`。
- `tokens`：`input`、`output`、`cacheRead`、`cacheWrite`、`reasoning`、`other`、`total` 皆為不超過 `Number.MAX_SAFE_INTEGER` 的 canonical non-negative decimal strings。`reasoning <= output`，且 `total = input + output + cacheRead + cacheWrite + other`。

Upload bearer secret 只存在 Authorization header；獨立 deletion secret 只用於 rotate/delete。Server 只保存兩者的 verifier，並從已驗證的 bearer context 建立 contributor／enrollment identity。Request body 不帶 client-provided contributor ID、enrollment ID、bucket ID、payload hash、timezone、hour、event/session count、client path 或 stable hardware ID。伺服器必須拒絕 unknown fields，而不是靜默保存。

禁止上傳：

- prompt、response 或其摘要。
- 原始程式碼、檔案內容、檔名、完整路徑、repo remote。
- API key、access token、cookie、authorization header。
- 使用者名稱、email、IP 衍生 fingerprint。
- 未正規化的自由文字 tool/model/project 名稱。

### 10.5 字母人 identity、mood 與 evolution

建議將三種時間尺度分開：

| 層級 | 建議時間窗 | 目的 | 範例 |
| --- | --- | --- | --- |
| Identity | 28 日 rolling profile | 穩定、可辨識的主 traits | CLI-heavy、multi-model、night owl |
| Mood | 今日／最近 24 小時相對個人基準 | 即時回饋 | 專注、過熱、好奇、休眠 |
| Evolution | 每週或明確的本機結構變化 | 可看見的長期發展 | 新配件、色彩變化、台詞分支 |

可用且 content-blind 的候選特徵：

- provider、model family 與 tool 比例。
- IDE、CLI、browser 或 agent 類別比例。
- 本機 hourly buckets 的使用時段、活躍日與個人基準偏差。
- input/output ratio、cache ratio、context size bucket。
- 多工具或多 provider 的粗粒度占比。

只有來源明確提供可信 metadata 時，才可以使用 debug、research、test、deploy 等任務標籤。不得從 prompt、檔名或原始碼偷偷推斷。

本節的 hourly、時段、活躍日、結構變化與類 session 節奏都是 local-only 特徵；不得被展開成 cloud event，也不得進入 `IngestSnapshotV1`。

### 10.6 AI-Sister raster 角色呈現

- Launch roster 有 11 位：ChatGPT、Claude、Gemini、Grok、DeepSeek、Qwen、Mistral、Venice／Llama、Sakana、Perplexity 與 GLM。
- Release 內嵌 strict manifest，列出前 10 位角色各 20 種衣櫥與 `supported`、`challenged`、`victory` pose objects；GLM 使用 code-native letter mode。
- 圖像不打包進 npm artifact。解鎖後所需的 hash-named object 才從固定 HTTPS CDN 按需 `GET`，經 SHA-256 驗證後 atomic 寫入 `~/.tokenmonster/asset-cache`。
- `--no-character-downloads` 將 CDN origin 設為 null，只使用逐次驗證的本機 cache 與 letter fallback；用量、圖表與進度不受影響。
- Asset request 沒有 query string、token／provider totals、starter rationale、user／install ID 或本機 path；CDN 仍可看到公開 object key 與 client IP。
- 角色圖像不是 Live2D 或 3D rig；狀態透過核准的 pre-rendered pose 與輕量 UI 效果呈現。原始 parts、生成工具、prompt 與 publisher credential 不進入 TokenMonster。
- 語音後續由同一 manifest、unlock、hash 與 cache gate 交付；目前 manifest 的 `voice` 為空，UI 預設關閉語音。
- 每個角色都應共用同一套 trait 意義，避免角色選擇本身改變 usage 分析結果。

### 10.7 BYOK 與固定台詞

- MVP 先提供文字互動；語音是後續增強。
- MVP 的正式路徑是 companion main process 直接呼叫 OpenAI Responses API，並在每次 request 設 `store: false`；TokenMonster backend 不參與。
- Desktop 環境使用 Electron `safeStorage` 的非同步 API 或等價 OS secret store。若 Linux 回報 `basic_text` backend，MVP 禁止持久化 key。
- 純 Web 環境若無安全 bridge，key 只可存在記憶體或當次 session，不可預設寫入 localStorage。
- TokenMonster backend 不代理、不記錄 BYOK 對話。
- MVP 不啟用 background mode、hosted file search、conversation object 或 file upload。
- prompt、response 與有限對話 context 只在當前 UI session 記憶體處理，關閉對話即清除；不得寫入 TokenMonster 儲存、log、analytics、crash report 或診斷 bundle。
- UI 必須說明請求會直接傳到哪個 provider。
- 固定台詞至少依 idle、今日高於個人基準、今日低於基準、新工具出現、夜間使用與錯誤狀態提供不同回應。
- 固定台詞不可羞辱使用者、鼓勵浪費 Token 或製造帳單恐慌。

### 10.8 提醒

- 通知權限與提醒設定必須在初次體驗分開詢問。
- 預設不發通知。
- 支援 quiet hours、每日摘要與完全關閉。
- 同一本機通知 trigger 不可重複提醒，trigger 不上傳。
- 通知文字以個人基準與角色敘事為主，不使用競賽式語言。

### 10.9 公開網站與分享卡

公開網站 MVP 至少包含：

- 首頁 contributors counter。
- 今日（UTC calendar day）、累積與 contributor 數。
- 最後確認更新時間。
- 資料方法與限制。
- collector 下載入口。
- 支援矩陣。
- 隱私與刪除說明。

公開 breakdown 需使用最小群體門檻。建議某 bucket 至少有 20 位 contributors 才顯示 provider/tool 分布，否則合併為 other 或隱藏。

分享卡至少包含：

- AI-Sister 角色圖。
- 時間範圍。
- 2 至 3 個主 traits。
- 一句可讀歸因。
- 可選的個人 Token 總量。
- contributor wording。
- TokenMonster 品牌與產品入口。

### 10.10 Product analytics

Product analytics 與 Token contribution 必須分開：

- 使用者可以分享 Token aggregate 但拒絕產品 analytics。
- 使用者也可以允許產品 analytics 但不分享 Token aggregate。
- Product analytics 亦預設關閉。只有獨立明確 opt-in 後，其專用契約才能收受事先列入 metric dictionary 的 UI action 類型、client version、成功／失敗狀態與粗略平台；不得收本地 usage payload、usage event/session count 或細粒度使用維度。
- 所有問卷指標可匿名填寫，但要明示用途。

## 11. 資料信任邊界

### 11.1 本機

本機可保存：

- hourly 與 UTC daily canonical aggregate snapshots；hourly 及 timezone 細節只服務本機圖表、角色與 mood，不進 cloud wire。
- 不含檔名、路徑、project label 或帳號的本機 scan／cloud-mirror state。去重使用 aggregate logical bucket 與 revision，不保存 raw event/session 或來源位置。
- 角色 profile、情緒歷史與偏好。
- OS secret store 內的 BYOK secret 與分離的 enrollment upload／deletion bearer secrets；renderer、一般 app storage 與診斷輸出不得讀取明文。

TokenMonster 不得保存 prompt、response、source content、filename、project path、raw collector JSON 或 provider credential 明文副本。BYOK prompt／response 只允許在 companion 與 OpenAI 的單次 request／stream 及當前 UI session 記憶體中短暫存在。

### 11.2 中央服務

中央服務只保存：

- 從 bearer authentication 推導的 pseudonymous contributor／enrollment identity，不接受 body 自報識別碼。
- revisioned UTC daily aggregate buckets 與 server-computed canonical hash。
- consent／revocation 所需紀錄。
- public counter aggregates。
- 必要的 rate-limit 與安全審計紀錄；不含 payload body、raw usage event/session、filename、path 或 secret。

可識別 enrollment 的 daily buckets 最長保留 30 天，只用於 revision 修正與刪除。離開這個 current window 時，只有至少 20 位 contributors（`k >= 20`）的 cohort 可合併成 anonymous historical rollup；rollup 不保留 contributor／enrollment mapping，而對應的 identifiable rows 必須刪除。未達門檻的過期 rows 直接刪除，不進 rollup。

使用者在 30 天 current window 內刪除 enrollment 時，服務必須刪除其 identifiable buckets 並重算 counter。較舊 anonymous rollup 因已沒有 mapping，無法再個別移除；這個限制、保留期與刪除邊界必須在 opt-in 前清楚揭露。

### 11.3 公開資料

公開資料只包含：

- 達匿名門檻的全域 aggregates。
- contributor 數。
- 最新更新時間。
- 明確的方法與限制。

MVP 不公開單一 contributor 的時間序列或可重建個人工具習慣的細粒度資料。

## 12. 階段路線

### Phase 0：基線審查與規格凍結

交付：

- tokscale 4.5.2、可選 TokenTracker 0.79.8 bridge、依賴與四個 Tier-1 adapter 的安全／license 審查。
- AI-Sister raster asset inventory、checksum、授權與 brand review 狀態；未核准素材維持 blocked。
- local snapshot 與 cloud `IngestSnapshotV1` schema。
- threat model、privacy data map 與 contributor wording。
- 首發平台、單一 Worker hosting 架構與 Tier-1 adapter 決策。

退出條件：

- 沒有阻擋依賴／發布的 license 問題。
- 四條 Tier-1 fixture 可證明欄位投影、token semantics 與重算冪等。
- 實際要對外發布的角色已核准；任一候選資產未清權時它不進 artifact，placeholder roster 已通過完整流程。

### Phase 1：Local dogfood

交付：

- collector、local DB、支援矩陣與 dashboard。
- core-four character catalog；候選 WebP 仍為 `blocked` 時只使用 placeholder。
- identity／mood engine 與原因說明。
- 固定台詞、角色／圖表切換與本機 OpenAI Responses BYOK vertical slice。

退出條件：

- 同一 fixture 重掃、重啟 10 次仍無重複計數，向下修正也正確取代。
- local-only 模式沒有 usage upload 流量。
- BYOK request 固定 `store: false`，secret 只在 OS secret store 與 OpenAI Authorization header 出現。
- 內部使用者能理解主要 traits 的來源。

### Phase 2：Closed Alpha

交付：

- 30 位重度 AI coding 使用者測試。
- opt-in aggregate upload。
- contributor counter staging page。
- 分享卡、通知設定與 BYOK 錯誤／離線降級。
- 日間方差、身份共鳴與外部辨識測試。

退出條件：

- 達成第 13 節的 Alpha 指標，或完成明確的 cadence／positioning 調整。
- privacy、dedup、secret handling 與刪除流程通過驗收。

### Phase 3：Public MVP

交付：

- 公開 landing、contributors counter、下載與方法頁。
- 簽署／校驗的發布 artifacts。
- 正式支援矩陣、診斷工具、更新與 rollback。
- 隱私政策、OSS notices、角色授權資訊。
- 監控、告警、備份與 incident runbook。

退出條件：

- 所有 Must acceptance criteria 通過。
- 沒有 P0/P1 security issue。
- 公開文案不誤導統計代表性。

### Phase 4：上線後擴充

候選項目：

- 更多 BYOK providers。
- 語音包與角色音色。
- 純 cosmetic 的皮膚／收藏／發現式 evolution。
- 多裝置同步與可選帳號。
- 匿名怪物 gallery。
- Browser extension；必須先完成 ToS 與隱私審查。
- Live2D／3D 重製；必須另行製作 rig 與動畫資產。

## 13. 成功指標

### 13.1 指標定義

- Activated：collector 成功偵測至少一筆 usage，且使用者開啟過角色或 dashboard。
- D7 主動開啟：Activated 使用者在第 6 至第 8 天至少主動開啟一次角色或 dashboard；背景 process uptime 不算。
- Opt-in rate：Activated 使用者中開啟 Token aggregate contribution 的比例。
- Identity resonance：使用者能否說明「這隻角色為什麼像我的 AI workflow」。
- Archetype comprehension：陌生評審只看分享卡，能否把卡片分到合理的 usage archetype。
- Share generation：使用者是否主動產生分享卡。
- Share publication：使用者自願回報是否把卡片發到 X、Discord 或其他社群；不得暗中監控分享目的地。

### 13.2 Closed Alpha 目標

樣本：至少 30 位、過去 30 天使用過至少兩種 AI coding／CLI／IDE 工具的使用者，連續測試 7 天。

| 指標 | 目標 |
| --- | --- |
| Identity resonance | 至少 60% 能正確說明主要 traits 為何像自己 |
| Archetype comprehension | 陌生評審至少 50% 可分到合理 archetype |
| Opt-in rate | 至少 40% |
| D7 主動開啟 | 至少 35% |
| 主動分享卡 | 參考門檻至少 20%；以明確 share action 或使用者自報計算 |
| Collector detection success | 已宣告支援的環境至少 90% 成功偵測 |
| Crash-free active sessions | 至少 99% |

### 13.3 演化 cadence 判斷

以 content-blind 特徵計算每日相對前日的變化：

- 若每日中位數至少 30% 特徵跨越預設分箱，允許日更 identity 微調。
- 若低於 15%，identity 改為週級；日常只更新本機 mood 與結構變化里程碑，這些資料不進 wire。
- 若介於 15% 至 30%，採每週 identity 加每日 mood 的混合模式。

這是 cadence 決策，不是使用者價值的唯一 kill criterion。

### 13.4 Kill 與 pivot 條件

安全／隱私條件發生時立即停止，不等待產品迭代；角色價值指標只允許一次 trait mapping／copy 主要迭代，然後用第二個等規模 cohort 復驗：

1. 任何 forbidden data、provider credential、未經同意的 usage request 或 BYOK 內容進入 TokenMonster persistence、log、analytics、diagnostic 或 cloud：立即停止散佈與相關功能，完成 root cause、清除與 regression test 前不得恢復。
2. Replay／rescan 可重複增加總量，或 deletion 無法可靠扣除公開總量：停止 cloud Alpha；local-only 可繼續，但不得顯示未驗證 counter。
3. Identity resonance 低於 60%，或 Archetype comprehension 低於 50%：允許一次 trait mapping／copy 迭代。第二個等規模 cohort 仍未通過時，停止擴張角色、gallery 與抽卡，評估 pivot 為純 local usage companion。
4. D7 主動開啟低於 35%：不進 Beta；先修正 onboarding、提醒頻率與 local weekly／structural-change cadence，再做一次 cohort 驗證。
5. Opt-in rate 低於 40%，但 local D7 與歸因通過：不 kill local product；將 public counter 降為非主打或延後，改善信任與 payload preview，不得用獎勵或功能鎖強迫同意。
6. 每日 trait 維度跨箱比例低於 15% 不是 kill；將 evolution 改為本機週級與極端結構變化里程碑。若跨人資料仍無法形成至少四個可辨 archetype，才視為核心差異化失敗。

## 14. 詳細驗收條件

### AC-COL：Collector 與資料正確性

- AC-COL-01：安裝後可列出 Claude Code、Codex CLI、Gemini CLI、Grok Build 四個 Tier-1 adapters 與各自狀態；其他來源不得冒充 verified。
- AC-COL-02：只有通過 fixture 的 adapter 可以標成 verified。
- AC-COL-03：對同一份 fixture 重掃 10 次，同一 logical bucket 的 token totals 不變；cloud schema 必須拒絕 event/session count、hour 與 timezone。
- AC-COL-04：collector 在掃描中途終止並重啟後，結果與一次完成掃描相同。
- AC-COL-05：log rotate、追加與修正不造成重複；修正值能反映到本地 aggregate。
- AC-COL-06：不可得欄位顯示 unknown，不以 0 取代。
- AC-COL-07：使用者可看見最近成功掃描時間、來源錯誤與修復建議。
- AC-COL-08：停用某 adapter 後，不再讀取該來源，但既有本地歷史仍可查看或由使用者刪除。
- AC-COL-09：adapter 子程序使用 fixed argv、`shell: false`、sanitized environment、isolated config、timeout 與 output cap；raw upstream output 不落盤或上傳。
- AC-COL-10：若同時偵測 tokscale 與 TokenTracker bridge，UI 強制選一個資料來源，任何報表不得相加兩套 totals。
- AC-COL-11：所有 local／wire／public 計算都驗證 `reasoning <= output` 且 `total = input + output + cacheRead + cacheWrite + other`；圖表、修正與 recompute 均不再加 reasoning。

### AC-LOC：Local-first 與 dashboard

- AC-LOC-01：中央 API 完全離線時，collector、dashboard、角色與固定台詞仍可使用。
- AC-LOC-02：dashboard 可在今日、7 日、30 日與累積時間範圍切換。
- AC-LOC-03：本機 timezone 或 day boundary 改變後不重複計數，並清楚說明本機報表如何重分桶；cloud 仍只接受 UTC daily buckets。
- AC-LOC-04：圖表與角色視圖可以在兩次互動內互相切換。
- AC-LOC-05：使用者可匯出自己的本地 aggregate；匯出前顯示欄位與隱私提醒。

### AC-DEDUP：中央冪等

- AC-DEDUP-01：同一 snapshot 重送 10 次，公開 aggregate 只計算一次。
- AC-DEDUP-02：revision 2 先於 revision 1 到達時，較舊 revision 不得覆蓋較新值。
- AC-DEDUP-03：revision 修正總量後，公開 aggregate 只套用淨差額。
- AC-DEDUP-04：retry、offline queue 與 app restart 不改變最終 aggregate。
- AC-DEDUP-05：所有 counter 變動可由非敏感 ledger 追查，不需保存 prompt 或原始事件。

### AC-PRIV：Consent 與隱私

- AC-PRIV-01：新安裝的 Token contribution 預設為 off。
- AC-PRIV-02：啟用前 UI 顯示精確欄位與範例 payload。
- AC-PRIV-03：在 opt-out 狀態執行網路測試，不得出現 usage upload request。
- AC-PRIV-04：自動測試掃描 payload，不得出現 prompt、response、路徑、檔名、repo、email、API key 或 authorization header。
- AC-PRIV-05：關閉分享後，不再建立新 upload job；既有尚未送出的 queue 必須清除或明確詢問。
- AC-PRIV-06：使用者可用本地 contributor secret 刪除仍在 retention window 內的共享歷史。
- AC-PRIV-07：產品 analytics 與 Token contribution 是不同開關。
- AC-PRIV-08：所有傳輸使用 TLS；server logs 必須遮蔽 secrets 與 payload body。
- AC-PRIV-09：30 天 age-out 測試證明只有 `k >= 20` 的 cohort 會進入無 contributor／enrollment mapping 的 anonymous rollup，對應 identifiable rows 被刪除，未達門檻的過期 rows 不保留；opt-in UI 已揭露舊 rollup 無法個別移除。

### AC-WEB：公開網站與 counter

- AC-WEB-01：頁面固定顯示「只包含自願匿名分享者，不代表全球所有 AI 使用量」。
- AC-WEB-02：頁面顯示最近一次確認更新時間，不把動畫推到未確認值。
- AC-WEB-03：重送與 revision 測試不造成畫面 counter 重複增加。
- AC-WEB-04：低於匿名門檻的 breakdown 不公開。
- AC-WEB-05：網站提供支援來源、資料方法、隱私、刪除與下載頁。
- AC-WEB-06：公開頁在 p75 行動網路環境的 LCP 目標低於 2.5 秒，CLS 低於 0.1。
- AC-WEB-07：主要流程可用鍵盤操作，色彩與文字達 WCAG 2.2 AA；支援 reduced motion。

### AC-MON：AI 字母人

- AC-MON-01：core-four manifest 中每個 `approved` AI-Sister raster 都可在 catalog 正確顯示；`blocked` 資產不進入 artifact，對應 placeholder 可完成全流程。
- AC-MON-02：UI 不把 raster asset 稱為 Live2D 或 3D。
- AC-MON-03：同一標準化 footprint 重算 10 次，主 traits 與 identity 結果相同。
- AC-MON-04：每個主 trait、mood 與 evolution 變化都有可閱讀的原因。
- AC-MON-05：角色主身份不由亂數、總 Token 排名或付費狀態決定。
- AC-MON-06：表現層微變化不會讓兩個不同主 traits 顯示成相反的身份。
- AC-MON-07：若 source 沒有可信 task metadata，UI 不產生 debug、research 等未經支持的斷言。
- AC-MON-08：切換基礎角色不會改變相同 footprint 的 trait 分析，只改變視覺呈現。
- AC-MON-09：動態效果關閉後，所有狀態仍能透過文字、圖示或靜態畫面理解。

### AC-CHAT：BYOK 與固定台詞

- AC-CHAT-01：沒有 API key、沒有網路時，角色仍能顯示本地固定台詞。
- AC-CHAT-02：BYOK key 不出現在 TokenMonster backend request、server log、crash report 或分享卡。
- AC-CHAT-03：持久化 key 使用 OS keychain 或等價 secret store，不使用明文設定檔。
- AC-CHAT-04：錯誤 key、provider 429、timeout 與斷網都有清楚錯誤並降級到固定台詞。
- AC-CHAT-05：使用者可刪除 key，刪除後無法由 app storage 還原。
- AC-CHAT-06：OpenAI Responses request 明確帶 `store: false`；prompt、response 與有限 context 只在當前 UI session 記憶體，關閉即清除，TokenMonster backend 不收到任何一項。
- AC-CHAT-07：Electron 在 Linux `basic_text` backend 下不提供「記住 key」，renderer 也不能直接取得明文 secret。

### AC-REM：提醒

- AC-REM-01：通知預設關閉。
- AC-REM-02：quiet hours 期間不發一般提醒。
- AC-REM-03：相同本機通知 trigger 不重複提醒；trigger 不上傳。
- AC-REM-04：停用通知後不再排程新提醒。
- AC-REM-05：提醒不使用羞辱、競賽或鼓勵無意義 Token 消耗的文字。

### AC-SHARE：分享卡

- AC-SHARE-01：可在本地產生 PNG，不需先公開上傳個人 profile。
- AC-SHARE-02：卡片至少包含角色、時間範圍、traits 與歸因句。
- AC-SHARE-03：使用者可選擇隱藏個人 Token 總量與 tool/provider 細節。
- AC-SHARE-04：輸出掃描不得含 PII、secret、路徑、專案或 prompt。
- AC-SHARE-05：若顯示公共 counter，必須帶 contributor wording。

### AC-SEC：安全、發布與韌性

- AC-SEC-01：完成 collector、desktop bridge、BYOK、ingestion API 的 threat model。
- AC-SEC-02：所有外部 model/tool enum 經 allowlist 與 output encoding，避免 XSS／log injection。
- AC-SEC-03：ingestion 有 request size、frequency、revision 與 contributor rate limits。
- AC-SEC-04：依賴與發布 artifact 有 SBOM／lockfile；高風險漏洞阻擋公開發布。
- AC-SEC-05：可發布平台的 artifact 經簽署或 checksum 校驗，下載頁顯示驗證方式。
- AC-SEC-06：中央 counter 故障不造成 local data loss；服務恢復後 queue 可安全續傳。
- AC-SEC-07：有備份、aggregate rebuild、incident response 與 rollback 文件。

## 15. 待決策項目與建議預設

| 決策 | 建議預設 | 最晚決策點 |
| --- | --- | --- |
| 產品形態 | 公開 web + local collector/desktop companion；不要純網頁承擔本機掃描 | Phase 0 |
| 首發 OS | Electron companion 先完成 macOS；Windows 緊接。各平台未跑 CI、簽署與實機 smoke 前不宣稱 GA | Phase 0 |
| Collector 支援承諾 | exact-pinned tokscale 4.5.2 為目前唯一 runtime 路徑；0.79.8 TokenTracker bridge 是尚未交付的互斥 target。兩者都只能展示通過 TokenMonster fixtures 的來源 | Phase 0 |
| Tier-1 tools | MVP 固定驗證 Claude Code、Codex CLI、Gemini CLI 與 Grok Build；任何擴充先加對應 fixture、privacy projection 與 compatibility test | Phase 0 |
| 使用者帳號 | MVP 無使用者帳號；opt-in 時由 server 建立 enrollment，本機只保存隨機 bearer secret | Phase 0 |
| 上傳 cadence | contribution queue 保存 UTC daily absolute snapshots；當日改變或 app 正常關閉時可重送較高 revision，離線安全重試 | Phase 1 |
| Contributor auth | upload／deletion secrets 權限分離，只存本機 OS secret store，server 只存 verifier；request body 不帶 contributor ID、硬體指紋或 deletion secret | Phase 1 |
| Retention／刪除 | 可識別 contributor buckets 保留 30 天以支援刪除與修正，之後只在匿名門檻達成時壓成無 contributor mapping 的 rollup；舊 rollup 無法個別移除並須事前揭露 | Phase 1 |
| Breakdowns 匿名門檻 | 每一公開 bucket 至少 20 contributors | Phase 2 |
| Identity cadence | 28 日 identity、24 小時 mood、每週／本機結構變化 evolution；hourly 與類 session 特徵不進 wire | Phase 1 |
| 角色 roster | MVP 限 core-four 候選，四張 WebP 預設 `blocked`；只有 owner public-use grant 與 brand review 都通過才改為 `approved`，否則發布 placeholder | Phase 0 |
| Raster 呈現 | 圖片切換＋overlay＋CSS/canvas 微動畫；不做假 Live2D | Phase 1 |
| BYOK provider | OpenAI Responses API 直接由 companion 呼叫並設 `store: false`；其他 provider 後續以 adapter 擴充 | Phase 1 |
| BYOK 儲存 | Electron async `safeStorage`／OS secret store；Linux `basic_text` 不持久化，純 web 不持久化 | Phase 1 |
| 語音 | MVP 固定文字台詞；voice pack／TTS 後續，先完成素材與授權審查 | Phase 2 |
| 抽卡／收藏 | 後續改為純 cosmetic 或 style／seasonal discovery；不與無限 Token 總量掛鉤 | Post-MVP |
| 公開怪物牆 | 先驗證單張分享卡；只有辨識與分享指標通過才做 | Post-MVP |
| Product analytics | 最小化、獨立 opt-in；不用第三方 session replay | Phase 1 |
| Hosting 與區域 | React/Vite static assets 與 Hono API 併入單一 Cloudflare Worker，D1 存 aggregate；建立每日 logical export、rebuild drill 與 rate limit | Phase 0 |
| 品牌拼法 | UI 統一 TokenMonster；一般文案可寫 Token Monster，不混用 The Token Monster | Phase 0 |

## 16. 主要風險與緩解

### 16.1 變成 collector 換皮

風險：上游 collector 已提供用量彙整；如果角色只是一張可愛圖片，產品缺乏獨立價值。

緩解：

- 把可解釋的 style fingerprint、角色狀態與分享卡列為 MVP 核心。
- 以 Identity resonance 與 Archetype comprehension 作為生死指標。
- 不把大量時間花在重做一般 dashboard。

### 16.2 Collector 信任不足

風險：使用者懷疑 collector 會偷 API key、prompt 或程式碼。

緩解：

- 開源 collector、最小權限、payload preview、可驗證 artifact。
- opt-in 預設關閉。
- 提供 local-only 模式與網路活動說明。
- 診斷輸出預設 redact。

### 16.3 Token 定義與重複計數

風險：不同來源對 input、output、cache 與 total 的定義不同；重掃或多裝置會放大公開數字。

緩解：

- canonical schema 保留各類別與 quality，強制 `reasoning <= output` 且不在 total 中重複加總 reasoning。
- adapter fixture、aggregate logical bucket、revisioned absolute snapshots、server-computed hash 與淨差額計算。
- 公開方法頁說明跨裝置與估算限制。

### 16.4 Style 方差太低

風險：重度使用者的工作流高度相似，角色變成克隆或數日後不再變化。

緩解：

- 分離 identity、mood 與 evolution。
- 使用相對個人基準，而不是只看全域絕對量。
- 方差低時改為本機週級與結構變化里程碑，不進 wire，也不用黑箱亂數假造差異。
- 以真實 Alpha log 驗證，不從 prompt 補維度。

### 16.5 偽造與灌水

風險：本地資料可被竄改，公開 counter 不具審計級可信度。

緩解：

- 不設高量排行、稀有度或經濟獎勵。
- rate limit、異常標記與 aggregate method disclosure。
- 公開數字明確定位為 contributors 提供的娛樂性 aggregate。

### 16.6 素材與授權

風險：AI-Sister raster assets、voice、TTS 或 fork 依賴的授權不適合公開或商業發布。

緩解：

- Phase 0 完成 asset inventory、來源、作者、license、attribution 與可修改範圍。
- core-four 候選 WebP 在 owner public-use grant 與 brand review 完成前一律維持 `blocked`，不進對外 artifact；用 placeholder 完成產品流程。
- Voice pack 與 Live2D／3D 重製另立授權閘門。

### 16.7 BYOK secret 洩漏

風險：key 進入設定檔、server log、crash report 或前端 storage。

緩解：

- OS keychain、direct provider calls、redaction tests、secret scanning。
- 不由 TokenMonster backend 代理。
- 無法安全儲存的平台不提供「記住 key」。

### 16.8 效能與常駐負擔

風險：高頻掃描、WebView、動畫與通知造成 CPU、記憶體或電量消耗。

緩解：

- 增量讀取優先，避免高頻全檔 polling。
- collector 與角色 UI 分離；關閉 UI 不應停止追蹤。
- 提供 reduced motion 與 pause avatar。
- Phase 1 建立平台效能 budget，再作公開支援承諾。

## 17. 上線定義

TokenMonster 可以稱為「已好好上線」，必須同時滿足：

1. Product：
   - local tracking、角色、圖表、opt-in upload、contributors counter、固定台詞、分享卡都可用。
   - 公開文案清楚說明資料只來自 opt-in contributors。
2. Correctness：
   - 所有 Must dedup 與 revision acceptance tests 通過。
   - 支援矩陣與實際 adapter 行為一致。
3. Privacy／Security：
   - opt-in、payload preview、BYOK secret handling、刪除與 threat model 完成。
   - 沒有 P0/P1 security issue。
4. Assets／Legal：
   - tokscale、可選 TokenTracker bridge、實際使用時才需的最小 collector fork patch，以及其餘依賴的 license／attribution 全部完成。
   - 只有 `approved` AI-Sister raster assets 可進入發布物，其 owner public-use grant／attribution／brand review 均有證據；`blocked` 資產必須被 placeholder 取代。
5. Operations：
   - 有監控、備份、aggregate rebuild、rollback、incident contact 與狀態頁。
6. Validation：
   - Closed Alpha 已完成，若未達產品目標，已有明確 pivot 決策，不以背景 process uptime 假裝留存。

## 18. 需求追蹤摘要

| 使用者意圖 | MVP 對應 | 驗收群組 |
| --- | --- | --- |
| 記錄跨家 Token | Collector + dashboard + support matrix | AC-COL、AC-LOC |
| 避免重複 | Local absolute aggregate bucket + server revisioned daily snapshot | AC-COL、AC-DEDUP |
| 自願匿名分享 | Consent + payload preview + contributor upload | AC-PRIV |
| 公開數字持續成長 | Verified contributors counter | AC-WEB |
| AI 字母人依使用發展 | Identity／mood／evolution engine | AC-MON |
| 依 coding style 長特色 | Content-blind traits + reason labels | AC-MON、Alpha metrics |
| AI-Sister 角色設計重用 | Approved core-four raster／placeholder character catalog | AC-MON |
| 有 key 可互動、無 key 仍會說話 | BYOK + local fixed phrases | AC-CHAT |
| 定時提醒與圖表切換 | Local notifications + dashboard toggle | AC-REM、AC-LOC |
| 皮膚與語音包 | Post-MVP cosmetic roadmap | Phase 4 |
