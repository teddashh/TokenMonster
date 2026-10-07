# TokenMonster

[English](README.en.md) · **繁體中文**

在你自己的電腦上追蹤 Claude Code、Codex、Gemini CLI 與 Grok Build 的 token 用量，11 位陪伴角色隨真實的使用里程碑解鎖。

**專案介紹頁：** https://teddashh.github.io/TokenMonster/?lang=zh-TW

[![CI](https://github.com/teddashh/TokenMonster/actions/workflows/ci.yml/badge.svg)](https://github.com/teddashh/TokenMonster/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/teddashh/TokenMonster?include_prereleases&label=release)](https://github.com/teddashh/TokenMonster/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**你每天用掉多少 token？讓 AI 姊妹們陪你一起看。**

TokenMonster 透過鎖定版本的 [TokenTracker](https://github.com/mm7894215/TokenTracker) sidecar，在本機讀取各家 CLI 留下的用量紀錄，整理成即時儀表板，再讓陪伴角色依你真實的使用里程碑成長、解鎖。不用帳號，沒有遙測，資料都留在你的裝置上。

目前是公開測試版（v0.1.0-rc.22，2026 年 7 月）：Windows 有桌面版安裝檔，CLI 支援 Windows、macOS、Linux。

## 它能做什麼

- **一眼看懂 AI 用量**：今天、近 7 天、近 28 天的合計，UTC 每日趨勢、各家 provider 分析、Top 10 模型排行，以及依你選的方案估算的剩餘額度（社群估計值，不是官方上限）。收集與去重由鎖定版本的 TokenTracker（`tokentracker-cli@0.80.0`）在本機完成，它會跟著 TokenMonster 一起安裝。
- **會長大的陪伴角色**：第一位姊妹可以抽卡決定，也可以從 ChatGPT、Claude、Gemini、Grok 自己挑，之後隨時換人，不需要多用 token。DeepSeek、Qwen、Mistral、Llama、Sakana、Perplexity、GLM 七位朋友依各家累積量、總用量、連續活躍天數與用過幾家 provider 解鎖。每位角色有 20 套服裝主題與姿勢圖。進度只能用出來，不能買。
- **今日默契與夥伴卡**：每天依近 28 天的使用節奏給一段側寫；還在認識你的時候會直接說明，並提醒你不需要刻意多用。角色、今日默契與收藏可以在本機畫成一張 PNG，存檔前可以隱藏 28 天 token 總量。
- **本機優先**：收集、圖表與角色進度都在你的電腦上完成，離線也能用。只有你主動操作時才會連外，見下方「隱私設計」。
- **桌面版與 CLI**：Windows 桌面版有系統匣寵物與完整儀表板；CLI 在瀏覽器開啟同一個儀表板。介面有繁體中文與英文。

## 實機畫面

以下畫面擷取自 Windows 桌面版；角色、用量統計與模型排行都由本機資料產生。

<p align="center">
  <img src="docs/screenshots/windows-dashboard-companion-roster.png" alt="TokenMonster Windows 桌面儀表板，顯示 Claude 角色、今日默契、陪伴名冊與分享卡" width="100%">
  <br>
  <sub>完整桌面儀表板：角色舞台、今日默契、已解鎖名冊與本機分享卡。</sub>
</p>

<table>
  <tr>
    <td align="center" width="50%">
      <img src="docs/screenshots/windows-pet-claude.png" alt="TokenMonster 寵物視窗中的 Claude 角色" width="100%">
      <br>
      <sub>Claude 桌面寵物</sub>
    </td>
    <td align="center" width="50%">
      <img src="docs/screenshots/windows-pet-usage-summary.png" alt="TokenMonster 寵物視窗中的今日、近 7 日與近 28 日 token 用量" width="100%">
      <br>
      <sub>今日、近 7 日與近 28 日用量</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="docs/screenshots/windows-model-ranking-detail.png" alt="TokenMonster Top 10 模型排行細節" width="100%">
      <br>
      <sub>Top 10 模型排行細節</sub>
    </td>
    <td align="center" width="50%">
      <img src="docs/screenshots/windows-pet-model-ranking.png" alt="TokenMonster 寵物視窗中的 Top 10 模型排行" width="100%">
      <br>
      <sub>寵物視窗內的模型排行</sub>
    </td>
  </tr>
</table>

## 快速開始

### Windows：桌面版安裝檔

1. 從 [Releases](https://github.com/teddashh/TokenMonster/releases) 下載最新的 `TokenMonsterSetup.exe`（目前是 v0.1.0-rc.22），雙擊安裝。
2. 目前是未簽章的公開測試版，SmartScreen 會跳出警告，請按「其他資訊」，再按「仍要執行」。取得程式碼簽章憑證後會改發簽章版。
3. 安裝完成後 TokenMonster 會出現在系統匣，之後從「開始」功能表啟動；要移除，請到「設定 → 應用程式 → TokenMonster」。
4. 自動檢查更新預設關閉。2026-10-01 查核時，程式內建的更新來源還沒有內容（回應 404），新版本請到 Releases 手動下載。

### CLI（Windows / macOS / Linux）

需求：Node.js `24.15.0` 與 npm `11.12.1`，必須是這組版本。套件用 `engines` 宣告這兩個版本，其他版本不在支援範圍內。

1. 從 [Releases](https://github.com/teddashh/TokenMonster/releases) 下載 `tokenmonster-0.1.0-rc.22.tgz`，並用同一個 release 的 `TokenMonster-cli-SHA256SUMS.txt` 核對。
2. 安裝到獨立的資料夾並啟動（Windows 在 PowerShell 執行同樣的指令）：

   ```sh
   mkdir tokenmonster-app
   cd tokenmonster-app
   npm install /path/to/tokenmonster-0.1.0-rc.22.tgz
   npx tokenmonster
   ```

   請不要用 `npm install -g` 安裝這個 tarball：npm 全域安裝 bundled dependency 時，sidecar 需要的 `@mongodb-js/zstd` 安裝腳本會失敗。安裝時只會從 npm registry 取得 `tokentracker-cli` 與它的相依套件，版本由 release 內附的 shrinkwrap 鎖定。

3. CLI 會印出一次性的本機網址並開啟瀏覽器。在 SSH 或遠端機器上請加 `--no-open`，CLI 會印出對應的 `ssh -L` 通道指令；在你自己的電腦執行它，再用印出的網址開啟。加上 `--no-character-downloads` 的話，這次執行不會提供角色素材包的下載選項。

TokenMonster 還沒有上架 npm registry。

### 從原始碼執行

需求同上：根目錄的 `package.json` 以 `engine-strict` 鎖定 Node.js 24.15.0 與 npm 11.12.1，`npm ci` 會拒絕其他版本。

```sh
git clone https://github.com/teddashh/TokenMonster.git
cd TokenMonster
npm ci
npm run build
npm exec -- tokenmonster
```

在 Windows 上，請不要在根目錄跑完整的 `npm run build`：Electron app 的 vite build 目前在 Windows 會失敗。改用 `node scripts/run-workspaces.mjs build tokenmonster`，只建置 CLI 需要的 workspace。

### 用 Codex 或 Claude Code 從 repo 啟動桌面版

如果你已經安裝並登入 Codex 或 Claude Code，可以直接從 clone 下來的 repo 啟動桌面版。先關掉可能正在執行的已安裝版 TokenMonster，再把這個 repo 開在 agent 裡，明確下指令：

- Codex：`$launch-tokenmonster start`
- Claude Code：`/launch-tokenmonster start`

兩個入口走同一套流程：啟動前後各做一次 audit、先跑 doctor 檢查，再啟動。同一個 skill 也提供 `status` 與 `stop`。它不會安裝或修改 agent CLI、登入憑證、全域套件或系統工具；如果缺少 Electron 執行檔，只會依鎖定的 checksum 取得官方的 Electron 43.7.7。這樣跑起來的是原始碼開發版：程式、本機資料與語音設定都和正式版相同，但它不是安裝版，沒有捷徑、不會出現在「新增/移除程式」，也沒有自動更新。完整規範見 [Agent-ready source-development launch](docs/AGENT_READY_SOURCE_RELEASE.md)。

## 陪伴角色

| 角色 | 類型 | 解鎖條件 |
| --- | --- | --- |
| ChatGPT | 姊妹 | Codex 的第一個 token，或第一次相遇時選她 |
| Claude | 姊妹 | Claude Code 的第一個 token，或第一次相遇時選她 |
| Gemini | 姊妹 | Gemini CLI 的第一個 token，或第一次相遇時選她 |
| Grok | 姊妹 | Grok Build 的第一個 token，或第一次相遇時選她 |
| DeepSeek | 朋友 | DeepSeek 累積 100,000 tokens |
| Qwen | 朋友 | Qwen 累積 250,000 tokens |
| Mistral | 朋友 | 連續活躍 3 天 |
| Llama | 朋友 | 總用量 500,000 tokens |
| Sakana | 朋友 | 用過 4 家不同的 provider |
| Perplexity | 朋友 | 連續活躍 7 天 |
| GLM | 朋友 | 總用量 5,000,000 tokens |

角色解鎖後，20 套服裝主題會隨對應 provider 的累積量逐步開放；GLM 例外，它的服裝依總用量開放（5,000,000 到 30,000,000 tokens），因為 TokenTracker 0.80.0 沒有把 GLM 的用量分開回報。連續活躍天數也會開放勝利姿勢與動作。

安裝包內建四位姊妹的初始立繪（8 張 WebP）與 168 條 `zh-TW`／`en` 固定文字台詞，不含音訊，開箱就能離線使用。完整角色素材包（`ai-sister-media-11-voice55-2026.07.23`：11 位角色、891 張圖與 55 段預錄語音，共 946 個項目，約 73 MB）只會在你於程式內明確同意後，從 `cdn.ted-h.com` 下載一次，逐一比對 SHA-256 後存進本機快取，之後完全離線運作，隨時可以修復或移除。語音播放預設關閉；移除素材包後會回到內建立繪與靜音。

所有解鎖都來自可解釋的本機里程碑，解鎖後不會收回，也只存在你的電腦上。Token 是量測值，不是遊戲貨幣：沒有付費抽卡、沒有內購、沒有 pay-to-win，台詞也不會鼓勵你浪費 token。

角色美術與語音不在 MIT 授權範圍內，授權依據見 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 隱私設計

- 收集、圖表與角色進度都在本機完成，不需要帳號或雲端服務。TokenTracker sidecar 以 `TOKENTRACKER_NO_TELEMETRY=1` 與 `DO_NOT_TRACK=1` 啟動，只帶白名單內的環境變數，並預載一個模組，擋下對外連線，也不讓它啟動其他程式。
- TokenMonster 只保存彙總後的數字。原始用量 JSON 只在記憶體中解析，用完就丟掉。prompt、回應、原始碼、檔名、路徑、原始 model ID、API key 與 cookie 都不會進入 log、分享卡、診斷包或任何貢獻資料；模型名稱只會出現在本機儀表板的 Top 10 排行。
- 預設不對外連線。只有你主動操作時才會連外：
  - 同意後下載一次角色素材包（`cdn.ted-h.com`）；
  - 桌面版的 BYOK 聊天：直接從你的電腦送到 OpenAI（`https://api.openai.com/v1/responses`，並設定 `store: false`），中間沒有 TokenMonster 的伺服器；
  - Windows 桌面版的更新檢查：只有按下手動檢查或自己開啟自動檢查時，才會連到程式內固定的更新來源。
- 程式碼裡有「匿名貢獻公開計數器」，預設關閉，服務端也還沒部署，目前版本不會送出任何用量資料。

詳細的資料生命週期見 [Data inventory](docs/DATA_INVENTORY.md) 與 [Threat model](docs/THREAT_MODEL.md)。

## 桌面寵物

Electron 43.7.7 桌面版（目前只有 Windows）：一個可以拖曳、置頂或收進系統匣的寵物視窗，用量與 Top 10 模型排行收在角色下方；系統匣選單可以開啟完整儀表板。

BYOK 聊天目前只支援 OpenAI（模型 `gpt-5.6-luna`）。API key 用 Electron `safeStorage` 加密保存，也可以選擇只放在記憶體；對話內容只存在記憶體，關閉就清除。

Windows 安裝檔 `TokenMonsterSetup.exe` 由 Squirrel.Windows 打包，可以從 [Releases](https://github.com/teddashh/TokenMonster/releases) 下載。它是未簽章的公開測試版；內嵌的更新元件在同一個 CI run 裡從原始碼重建並逐位元比對。macOS／Linux 桌面版與簽章版安裝檔還在路線圖上。

## 開發

```sh
npm ci
npm run build
npm test
```

`npm test` 會先跑 `npm run agent:verify`，再執行每個 workspace 的測試。Windows 請改用上面「從原始碼執行」提到的建置方式。完整的提交前檢查（lint、typecheck、packaging 驗證等）見 [docs/RELEASE.md](docs/RELEASE.md)；架構決策見 [docs/adr/](docs/adr/)。資料形狀、收集指令、角色資產或網路目的地的任何變更，都必須同步更新 contracts、隱私回歸測試與 [Data inventory](docs/DATA_INVENTORY.md)。

在沒有真實用量的機器上，儀表板會如實顯示沒有資料，角色也都維持鎖定。想試解鎖、服裝與語音，可以在建置完成、第一次啟動之前執行 `node scripts/qa/seed-demo-store.mjs` 寫入示範進度（它不會覆蓋既有資料）；刪除 `~/.tokenmonster` 就能重設。

## 狀態與路線圖

已完成：

- CLI 公開測試版（v0.1.0-rc.22）：從 [Releases](https://github.com/teddashh/TokenMonster/releases) 安裝；rc.22 的發行冒煙測試在 Linux、macOS、Windows 都通過。
- Windows 桌面安裝檔：未簽章公開測試版，CI 會實際安裝、啟動再移除。

尚未完成：

- 程式碼簽章（簽章後 SmartScreen 就不會再警告）
- 上架 npm registry
- macOS 與 Linux 桌面版
- 上線 Windows 自動更新來源
- 公開的匿名貢獻計數器（服務端已實作，尚未部署）

2026-10-07 實測，Verify 裡的完整相依套件稽核沒有發現。macOS 的 DMG 改用系統內建的 `hdiutil` 製作，`electron-installer-dmg` 和 `appdmg` 都拿掉了，`image-size` 那則漏洞也跟著消失。`@electron/packager` 精確鎖定在 `20.3.0`，公開的 `extract-zip` 已經不在相依套件裡，packager 18 透過 `got` 帶進來的 `http-cache-semantics` 4.2.0 也跟著不在了。出貨相依套件的稽核（`npm audit --omit=dev`）同樣沒有發現。Windows 沒有 POSIX 模式，Node 會把檔案回報成 0666、目錄回報成 0777，所以 Unix 模式檢查在 Windows 上略過。保險庫依賴它所在資料夾的權限。桌面版預設放在 `%APPDATA%\TokenMonster\secrets`，也就是使用者設定檔裡 Roaming 資料夾下的 TokenMonster 目錄。Electron 的 `--user-data-dir` 可以改這個位置，自訂資料夾必須只有該使用者能讀寫。CLI 的聊天金鑰只放在記憶體。只有另外接上 credential host 時，才會把貢獻憑證寫進 `HOME` 底下的 `.tokenmonster/contribution-v2`；沒有設定 `HOME` 時則寫在使用者主目錄。那個目錄也必須只有該使用者能讀寫。

## 文件

- [產品規格](docs/PRODUCT_SPEC.md) · [技術規格](docs/TECHNICAL_SPEC.md)
- [資料清冊](docs/DATA_INVENTORY.md) · [威脅模型](docs/THREAT_MODEL.md)
- [發行說明與流程](docs/RELEASE.md) · [部署手冊](docs/DEPLOYMENT_RUNBOOK.md)
- [Agent-ready source-development launch](docs/AGENT_READY_SOURCE_RELEASE.md)
- [角色與服裝對照](docs/CHARACTER_WARDROBE_MAP.md) · [ADRs](docs/adr/)

## 致謝

- [TokenTracker](https://github.com/mm7894215/TokenTracker)（MIT）：TokenMonster 的收集引擎。以 `tokentracker-cli@0.80.0` 精確鎖定版本、作為 sidecar 執行，沒有 fork 也沒有修改，見 [ADR 0005](docs/adr/0005-permanent-tokentracker-sidecar-adapter.md)。
- [tokscale](https://github.com/junhoyeo/tokscale)（MIT）：早期的收集器，現在只用於舊資料遷移。
- [Squirrel.Windows](https://github.com/Squirrel/Squirrel.Windows)：Windows 安裝與更新元件。
- `@mongodb-js/zstd`（Apache-2.0）與 Zstandard（BSD）、`yauzl` 與 `pend`（MIT）。
- [token-monitor](https://github.com/Javis603/token-monitor) 與 [ai-avatar-bot](https://github.com/YuriCrystal/ai-avatar-bot)：只作為架構與互動設計的參考，沒有引入任何程式碼。

完整清單與授權條款見 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

相關專案：[AI-Sister](https://teddashh.github.io/AI-Sister/) 是後來的本機桌面陪伴程式，沿用了 TokenMonster 的寵物視窗做法與同一套角色素材包。

## License

[MIT](LICENSE) © 2026 Ted Huang。角色美術與語音不在 MIT 授權範圍內；第三方元件與角色素材的授權見 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
