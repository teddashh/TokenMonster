# TokenMonster

[English](README.en.md) · 繁體中文

[![CI](https://github.com/teddashh/TokenMonster/actions/workflows/ci.yml/badge.svg)](https://github.com/teddashh/TokenMonster/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/teddashh/TokenMonster?include_prereleases&label=release)](https://github.com/teddashh/TokenMonster/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**你每天用掉多少 token?讓 AI 姊妹們陪你一起看。**

TokenMonster 在你的電腦本機追蹤 Claude Code、Codex、Gemini CLI、Grok CLI 的 token 用量,開一個即時瀏覽器儀表板,並讓 11 位陪伴角色隨著你真實的使用里程碑成長解鎖。所有資料都留在你的裝置上。

## 它能做什麼

- ** 一眼看懂你的 AI 用量** — 今日 / 7 日 / 28 日總量與每日趨勢,跨四家工具自動彙整。收集與去重由 exact-pinned 的 [TokenTracker](docs/adr/0005-permanent-tokentracker-sidecar-adapter.md) 引擎在本機完成,一個指令啟動,不用另外裝任何東西。
- ** 會長大的陪伴角色** — 從 ChatGPT、Claude、Gemini、Grok 四位姊妹選一位開始;累積用量、連續活躍天數與使用廣度會解鎖 DeepSeek、Qwen、Mistral、Llama、Sakana、Perplexity、GLM 七位朋友,以及每位角色 20 套衣裝與 pose。進度只能用出來,不能買。
- ** Local-first 隱私** — 沒有帳號、沒有遙測。prompt、程式碼、檔名、API key 從不離開你的裝置;離線也能完整使用。
- ** 跨平台** — Windows、macOS、Linux。每個 release 候選都通過三平台 CI 冒煙測試。
￼￼￼￼
## 快速開始

### Windows:桌面版安裝檔

1. 從 [Releases](https://github.com/teddashh/TokenMonster/releases) 下載最新的 `TokenMonsterSetup.exe`,雙擊安裝。
2. 目前是未簽章的公開測試版,SmartScreen 會出現警告 — 按「其他資訊 → 仍要執行」即可;簽章版會在取得程式碼簽章憑證後推出。
3. 安裝完成後 TokenMonster 會出現在系統匣,之後從開始選單啟動;移除走 設定 → 應用程式 → TokenMonster。

### CLI(Windows / macOS / Linux)

需求:Node.js `24.15.0` 與 npm `11.12.1`(CLI 精確檢查版本,避免未驗證的 runtime 漂移)。

1. 從 [Releases](https://github.com/teddashh/TokenMonster/releases) 下載最新的 `tokenmonster-*.tgz`(可用旁邊的 `SHA256SUMS` 檔驗證)。
2. 安裝並啟動:

   ```sh
   npm install /path/to/tokenmonster-0.1.0-rc.20.tgz
   npx tokenmonster
   ```

   Windows 在 PowerShell 執行相同指令即可。

3. 用瀏覽器開啟畫面印出的儀表板網址。在 SSH / 遠端機器上加 `--no-open`,CLI 會印出對應的 `ssh -L` 通道指令。

尚未上 npm registry;上架後就是一行 `npx tokenmonster`。

想從原始碼跑:

```sh
git clone https://github.com/teddashh/TokenMonster.git tokenmonster
cd tokenmonster
npm ci
npm run build
npm exec -- tokenmonster
```

### 用 Codex / Claude Code 從 repo 啟動桌面版

如果你已安裝並登入 Codex 或 Claude Code,先關閉可能正在執行的已安裝版
TokenMonster,再把這個 repo 開在 agent 裡並明確呼叫:

- Codex:`$launch-tokenmonster start`
- Claude Code:`/launch-tokenmonster start`

兩個入口都會走同一條受審核的 doctor、啟動與前後 audit 流程,不會安裝或修改
agent CLI、credentials、全域套件或 host tools；若 Electron native executable
尚未存在，只會以鎖定的 installer/checksums 取得官方、checksum-verified 的
Electron 43.1.1 artifact。這會啟動與產品相同
app/runtime、一般本機資料與語音 authority 的 source-development Electron,但不是
安裝檔:沒有捷徑、「新增/移除程式」或 installed auto-update parity。Status 與
stop 也由同一個 skill 的 `status` / `stop` 操作提供。完整邊界與指令見
[Agent-ready source-development launch](docs/AGENT_READY_SOURCE_RELEASE.md)。

## 陪伴角色

安裝包內建四位姊妹的啟動立繪與 168 條 `zh-TW`/`en` 固定文字台詞,不含音訊,開箱離線可用。完整角色媒體包(11 位角色、891 張圖與 55 條預錄語音,共 946 個項目)只會在程式內明確同意後從 `cdn.ted-h.com` 下載一次,之後完全從本機驗證過的快取運作,隨時可以修復或移除;語音播放預設關閉,移除後回到內建立繪與靜音。

解鎖規則全部來自可解釋的本機里程碑(某家族累積量、總用量、連續活躍日、使用廣度),單向保留、只存在你的電腦。產品不獎勵浪費 token — 沒有轉蛋、沒有內購、沒有 pay-to-win。

## 隱私設計

- 收集、圖表、角色進度全部在本機完成,不需要任何雲端服務。
- TokenMonster 不會保存或傳送 prompt、回應、原始碼、檔名、專案路徑、API key 或 model ID。
- 預設零對外連線。僅有的例外:你明確同意後下載一次角色圖包,以及桌面寵物的 BYOK 聊天由本機直接連到你選的 provider。
- 程式碼裡有「匿名貢獻公開計數器」功能,但預設關閉且雲端尚未上線 — 目前版本不會送出任何用量資料。

詳細資料生命週期見 [Data inventory](docs/DATA_INVENTORY.md) 與 [Threat model](docs/THREAT_MODEL.md)。

## 桌面寵物

Electron 桌面版:系統匣寵物、拖曳互動,以及 BYOK 聊天(API key 存在 OS 金鑰圈,對話只留在記憶體、直連 provider)。Windows 安裝檔 `TokenMonsterSetup.exe` 已可從 [Releases](https://github.com/teddashh/TokenMonster/releases) 下載(未簽章公開測試版,內嵌的更新元件在同一個 CI run 由原始碼可重現重建並逐位元驗證);macOS / Linux 桌面版與簽章版安裝檔在路線圖上。

## 開發

```sh
npm ci
npm run build
npm test
```

完整的提交前檢查(lint、typecheck、packaging 驗證等)見 [docs/RELEASE.md](docs/RELEASE.md);架構決策見 [docs/adr/](docs/adr/)。資料形狀、收集指令、角色資產或網路目的地的任何變更,都必須同步更新 contracts、隱私回歸測試與 [Data inventory](docs/DATA_INVENTORY.md)。

## 狀態與路線圖

- ✅ CLI 公開測試版 — 從 [Releases](https://github.com/teddashh/TokenMonster/releases) 安裝,三平台 CI 冒煙
- ✅ Windows 桌面安裝檔 — 未簽章公開測試版,CI 內完成原生安裝/啟動/移除冒煙
- 🚧 程式碼簽章(移除 SmartScreen 警告)
- 🚧 上架 npm registry(之後直接 `npx tokenmonster`)
- 🚧 公開 opt-in 貢獻計數器(cloud 端已實作、尚未部署)

## 文件

- [Product specification](docs/PRODUCT_SPEC.md) · [Technical specification](docs/TECHNICAL_SPEC.md)
- [Data inventory](docs/DATA_INVENTORY.md) · [Threat model](docs/THREAT_MODEL.md)
- [Release notes 與流程](docs/RELEASE.md) · [Deployment runbook](docs/DEPLOYMENT_RUNBOOK.md)
- [Agent-ready source-development launch](docs/AGENT_READY_SOURCE_RELEASE.md)
- [Character wardrobe map](docs/CHARACTER_WARDROBE_MAP.md) · [ADRs](docs/adr/)

## License

[MIT](LICENSE)。第三方元件見 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
