# TokenMonster 部署與回復 Runbook

> Architecture update (2026-07-15): Electron/Tokscale packaging steps are
> legacy migration procedures. The supported target is the exact-pinned
> sidecar CLI/loopback path in
> [ADR 0005](adr/0005-permanent-tokentracker-sidecar-adapter.md).

> 狀態：**尚未具備 production 部署條件**。Public Web/API、local Companion、
> contribution source slice、D1 mutation/deletion、`day-all-v1` k=20 compaction、
> preserving retention/projection與Durable Object quota/suppression已完成本機測試；
> Worker按`deletion → compactor → preserving retention → projection`排程且每次最多
> compaction一個完整到期UTC日。Companion background sync已有本機scheduler／service
> tests，但cloud-off packet capture與wake soak、Cloudflare account/remote D1/domain/secrets/rehearsal/staging E2E、備份還原與suppression replay、macOS
> 簽章/DMG與native smoke、license／法律、可選 raster 圖包的證據轉錄及release owner gate仍未完成；
> raster 圖包不阻擋只使用 code-native letter fallback 的主程式發布。
> 此文件不授權部署，也不能取代
> [Alpha release checklist](ALPHA_RELEASE_CHECKLIST.md) 的 GO 簽核。

本 runbook 落實[技術規格](TECHNICAL_SPEC.md)、
[威脅模型](THREAT_MODEL.md)與
[ADR 0002](adr/0002-runtime-and-deployment.md)的單一 Cloudflare Worker 決策：
React/Vite Static Assets 與 Hono `/v1/*` 一起發布，D1 Paid 是規劃中的
contribution truth。公開數字只能來自已驗證投影；沒有投影就回 `503`，不得塞
示範值或讓 UI 自動跳數字。

## 1. 環境與目前邊界

| 環境 | Worker／hostname | D1 | 資料與 secrets | 允許用途 |
| --- | --- | --- | --- | --- |
| `dev` | 本機 `wrangler dev`；尚未固定 | 本機／preview，尚未配置 binding | 只用非敏感 fixture；`.dev.vars` 不提交 | 單元、合約與 fail-closed UI 測試 |
| `staging` | 獨立 Worker 與 hostname；**尚未建立** | 獨立 D1 Paid；**尚未建立** | 不複製 production 可識別資料或 secrets | migration rehearsal、smoke、隔離 restore drill、Closed Alpha |
| `production` | 獨立 Worker、custom domain；**尚未建立** | 獨立 D1 Paid；**尚未建立** | production-only secrets、最小權限、備份隔離 | 只有完整 GO 簽核後才可用 |

每個環境必須有不同的 Worker name、D1 UUID、domain、rate-limit state、backup
bucket 與 secret。`apps/web/wrangler.jsonc` 目前有 base Worker、Static Assets、
一分鐘 cron、兩個 Durable Object bindings及其SQLite migration；仍沒有
`env.staging`、`env.production`、route、D1 binding或 secrets。因此現在執行任何
staging／production deploy 都是 **STOP**；dry-run成功不等於可遠端部署。

目前實作的 HTTP surface 包含：

- `GET /healthz`；
- `GET /v1/compatibility`；
- `GET /v1/consent-documents/current?purpose=contribution`；
- `GET /v1/public/totals`，無新鮮投影時可靠地回 `503 /
  PUBLIC_TOTALS_UNAVAILABLE`；
- `POST /v1/enrollments`、`POST /v1/me/ingest-snapshots`、
  `POST /v1/me/pause`、`POST /v1/me/resume`、`DELETE /v1/me/data` 與
  `GET /v1/deletions/:jobId`。mutation 需要
  D1、exact enable flag、strict secret config 與兩個 Durable Object namespace
  同時存在，少任一項都回 sanitized `503`。

`packages/cloud-d1` 已提供固定 prepared query 的 public projection reader；Worker
也會在有 `TOKENMONSTER_DB` binding 時使用它，但目前 Wrangler config 沒有該
binding，因此仍會
fail closed。Pause/resume 已有 upload-scope auth、獨立 lifecycle rate bucket、
atomic D1 transition 與 paused-ingest regression；share 與受保護的 `/readyz` 仍只是
[技術規格第 9 節](TECHNICAL_SPEC.md#9-http-api-contracts)的 target contract，
不可對外宣稱可用。Companion目前已有preview/enrollment/background sync與冪等retry/
local stop/delete/status的source slice；沒有due payload時scheduler不發request，
但尚未取得staging packet capture與sleep/wake soak證據。Scheduled D1 path已實作
`deletion → compactor → preserving retention → projection`：compactor每次最多處理
最舊的一個完整結束且到期UTC日，k<20或capacity不安全即整日drop；retention不會先
刪除下一個待compact日的usage/bindings。Mutation即使source tests綠燈，在backup/
restore、remote rehearsal與staging E2E完成前仍不得開啟production flag。

## 2. 不可越過的 prerequisites

Release operator 在執行遠端命令前逐項取得證據：

1. 固定 release commit，工作樹乾淨，CI 在 Node 24 與 lockfile 上全綠。
2. Cloudflare owner 核准 account、D1 Paid、三環境資源、custom domain、最小權限
   CI identity 與 MFA；production credential 不可沿用個人登入。
3. D1 schema／reader/writer、projection rebuild、runtime mutation/deletion、
   `day-all-v1` k=20 compactor、ordered scheduler、Durable Object suppression與10類TTL
   hard-retention source tests已完成；仍須完成suppression-aware backup/restore、
   真實Wrangler D1 rehearsal、監控及staging E2E。目前不滿足此gate。
4. 專案 license、TokenMonster 名稱／商標、隱私政策、服務條款、資料處理與事件
   通知責任已有 owner 書面決策；release owner／legal 也已書面核准再散布
   `@mongodb-js/zstd@2.0.1` 的 Apache-2.0 native package 與 statically linked
   Zstandard 1.5.6 BSD binary，且兩份 notice 均存在於 exact candidate inventory。
5. External Alpha 需要可驗證簽章的 companion；Apple/Windows signing identities、
   notarization/updater 與 Electron hardening 現在未完成。
6. Legacy `asset-manifest.json` 的四張 raster candidate 仍為 `blocked`；另有
   runtime schema-v1 integrity manifest 含 810 image 與 50 voice refs，但它缺少
   normative structured rights evidence。全部既有與新增 image/voice association
   都只有在 manifest schema v2、可稽核的書面 public/commercial/modify/
   redistribute grant、voice consent/content evidence，以及 rights/brand review
   核准後才可公開發布；在可執行的 strict rights verifier 落地前此 gate 是 STOP，
   不能把 v1 檔名或 runtime 可載入性當核准。否則只准 code-native letter
   placeholders。詳見
   [資料清冊](DATA_INVENTORY.md)與[產品規格 10.6](PRODUCT_SPEC.md#106-ai-sister-raster-角色呈現)。
7. Asset transport 是獨立 STOP：CLI 與桌面版預設 cache-only，不能接受舊 CDN
   環境變數；default-mode artifact／packet capture須證明零 AI-Sister GET。
   唯一的 transport 是明確同意後下載 request set/order 與本機用量、角色、解鎖、
   theme、pose、voice trigger 全無關的 fixed pack；兩個進入點共用同一個
   embedded fail-closed pack authority。Schema-v2 rights核准本身不會開啟 transport。
8. Production 前已完成 staging restore/rebuild drill、incident drill、容量與安全
   gate；任何缺證據都視為未通過，不能口頭豁免。

## 3. Clean verification 與 release artifact

從 repository root 執行。release 必須從新的 clean checkout 建立，不能沿用本機
`dist` 或 `node_modules`。

```sh
set -eu
git status --porcelain=v1
test -z "$(git status --porcelain=v1)"
test "$(node --version)" = "v24.15.0"
test "$(npm --version)" = "11.12.1"
npm ci
npm run lint
npm run format:check
npm run verify:secrets
npm run typecheck
npm test
npm run build
npm run verify:artifacts
npm run verify:packaging-toolchain
npm audit --audit-level=high
npm ls --depth=0
test -f apps/web/dist/client/index.html
: "${TOKENMONSTER_NEXT_RELEASE_VERSION:?設定全新且未使用的 SemVer prerelease}"
candidate_dir="dist-release/$TOKENMONSTER_NEXT_RELEASE_VERSION"
test ! -e "$candidate_dir"
zstd_parent="$(cd "$(mktemp -d)" && pwd -P)"
zstd_prebuilds="$zstd_parent/prebuilds"
node scripts/release/audit-zstd-native-prebuild.mjs \
  --all \
  --output "$zstd_prebuilds"
node scripts/release/build-release.mjs \
  --version "$TOKENMONSTER_NEXT_RELEASE_VERSION" \
  --out "$candidate_dir" \
  --zstd-prebuilds "$zstd_prebuilds"
node scripts/release/verify-release-digest.mjs \
  "$candidate_dir" \
  --expected-version "$TOKENMONSTER_NEXT_RELEASE_VERSION"
release_install_dir="$(mktemp -d)"
npm install --prefix "$release_install_dir" \
  "$candidate_dir/tokenmonster-$TOKENMONSTER_NEXT_RELEASE_VERSION.tgz"
node scripts/release/smoke-installed.mjs "$release_install_dir"
```

Linux 還必須對同一個 installed smoke 執行系統 network trace；不得只依賴應用層
mock：

```sh
trace_dir="$(mktemp -d)"
trace_path="$trace_dir/tokenmonster-installed-network.strace"
strace -f -s 256 -e trace=network -o "$trace_path" \
  node scripts/release/smoke-installed.mjs "$release_install_dir"
node scripts/release/assert-loopback-network-trace.mjs "$trace_path"
```

Public CLI assembler 必須從 repository `package-lock.json` 產生可發布的
`npm-shrinkwrap.json`，把 exact sidecar 的完整 npm registry closure 固定到
`resolved` + SHA-512 integrity。Installed smoke 在啟動前會把 consumer lock 與實體
package name/version逐筆對回該 shrinkwrap；缺 entry、版本漂移、非 registry來源或
integrity替換都必須 fail closed。

Assembler 只接受 fresh directory 內三個已通過官方 MongoDB detached signature、
固定 signer fingerprint、archive/binding SHA-256 與 single-entry tar layout 的
zstd prebuild。三個 archive 會放入 bundled `@mongodb-js/zstd`，但不寫入 Git；
release smoke 使用 fresh npm cache 與不可達 binary host，證明安裝只使用 candidate
內 bytes。Candidate 必須同時保留 dependency 的 Apache-2.0 `LICENSE.md` 與
`THIRD_PARTY_LICENSES/Zstandard-1.5.6-BSD.txt`，否則 digest verifier fail closed。

Internal companion bundle review可另外執行：

```sh
: "${TOKENMONSTER_NEXT_RELEASE_VERSION:?設定全新且未使用的 SemVer prerelease}"
TOKENMONSTER_RELEASE_VERSION="$TOKENMONSTER_NEXT_RELEASE_VERSION" npm run make:companion:internal
test -f release-evidence/companion-package.json
```

此命令只產生並驗證 unsigned ASAR/ZIP，不能改寫成 Alpha 或 production artifact。
Verifier 會確認 ASAR exact inventory與header/block integrity、無 runtime
`node_modules`／source／source map／blocked media／secret、bare imports只剩
`electron` 與 `node:*`，直接核對 Electron 43 的 9 個 fuse wire及browser V8
snapshot，並驗證 exact Tokscale package-lock identity、SHA-256、mode、version及
`process.resourcesPath` inventory。它也拒絕舊角色 CDN literal、
`TOKENMONSTER_CHARACTER_CDN` override marker與已移除 downloader 的能力簽章。最終 ZIP 的每個 file/directory byte與mode
也必須與 staged app一致。這仍是 unsigned internal artifact；signed macOS／DMG因 nested
Mach-O re-sign、Team ID、ticket與mounted-image verifier未完成而fail closed。完整決策
見[ADR 0004](adr/0004-electron-packaging-and-signing.md)。

`apps/web` build 會執行 release-artifact guard；任何 blocked candidate marker 或
`.webp` 進入 client build 都必須 fail。再做一次不修改遠端的 Worker dry run：

```sh
cd apps/web
npx wrangler deploy --dry-run --outdir .wrangler/dry-run
cd ../..
```

保存 commit SHA、CI URL、Node/npm/Wrangler version、測試摘要、audit 結果與 build
artifact hash。不得保存環境、header、request body、credential 或原始 usage 值。

## 4. Wrangler account、binding 與 secret 設定

### 4.1 人工作業與 CI auth

以下各 Wrangler command block 都假設從 repository root 開始。本機一次性設定只
允許具 MFA 的 release operator；先檢查身份與 account，不能在共用 terminal 貼
token：

```sh
cd apps/web
npx wrangler login
npx wrangler whoami
cd ../..
```

CI 應使用 owner 核准的 OIDC／短期 identity；若 Cloudflare integration 必須使用
API token，將它放 CI secret store 並限制到單一 account/Worker/D1。不要寫入
`.env`、shell history、Wrangler config、PR、log，或把 token 當 CLI argument。

### 4.2 建立隔離 D1 與提交 binding config

下列命令會建立遠端資源，只能在 owner 核准後執行；字串是無敏感性的名稱
placeholder，執行前必須換成審核過且不含 `REPLACE` 的值：

```sh
cd apps/web
STAGING_D1_NAME='REPLACE-tokenmonster-staging'
PRODUCTION_D1_NAME='REPLACE-tokenmonster-production'
D1_LOCATION='REPLACE_REVIEWED_LOCATION'
case "$STAGING_D1_NAME$PRODUCTION_D1_NAME$D1_LOCATION" in *REPLACE*) exit 64;; esac
npx wrangler d1 create "$STAGING_D1_NAME" --location "$D1_LOCATION"
npx wrangler d1 create "$PRODUCTION_D1_NAME" --location "$D1_LOCATION"
cd ../..
```

不要使用 `--update-config`。把輸出的 UUID 透過一般 PR 加入
`apps/web/wrangler.jsonc` 的環境特定 `d1_databases`，固定 reviewed binding 名稱
（以下 runbook 使用 `TOKENMONSTER_DB`），並加入不同 Worker names、routes、
`PUBLIC_ORIGIN` 與 migrations directory。UUID 不是 secret，但仍須審查以免綁錯
production。Web client 不可直接取得 D1 binding；只有 Worker adapter 可用。

Reader 與 initial migration 位於 `packages/cloud-d1`；config PR 必須把 reviewed
binding（Worker code 使用 `TOKENMONSTER_DB`）及
`../../packages/cloud-d1/migrations` 明確接入。
在該 PR 合併且 staging 驗證前不得建立 production route。合併後逐環境核對：

```sh
cd apps/web
npx wrangler d1 migrations list TOKENMONSTER_DB --env staging --remote
npx wrangler d1 migrations list TOKENMONSTER_DB --env production --remote
cd ../..
```

### 4.3 Secret 以互動式 stdin 寫入

先在 adapter/config PR 固定並審查 secret binding 名稱。以 server HMAC pepper
為例，只把**名稱**放 argument；Wrangler 顯示 prompt 後由批准的 secret manager
提供值，不能把值放在 command line、環境變數、檔案或文件：

```sh
cd apps/web
SECRET_BINDING_NAME='REPLACE_WITH_REVIEWED_SECRET_BINDING_NAME'
case "$SECRET_BINDING_NAME" in *REPLACE*) exit 64;; esac
npx wrangler secret put "$SECRET_BINDING_NAME" --env staging
npx wrangler secret put "$SECRET_BINDING_NAME" --env production
cd ../..
```

Production 使用獨立值。Pepper rotation 需 current/previous 雙 key window、撤銷
記錄與 verifier migration；不可覆寫唯一 pepper 後才發現舊 credential 全失效。
列出 binding 名稱可以，任何檢查不得輸出 secret value。

### 4.4 Windows release CDN 與下載 CTA promotion

下載 CTA 只讀一個 Worker binding：`TOKENMONSTER_PUBLIC_RELEASE_JSON`。不可手填
version、URL、hash、bytes 四個欄位，也不可直接以 Wrangler 開啟 CTA。Tag workflow
在 protected `release-promotion` environment 中從已通過 Authenticode/Squirrel gate
的 exact `TokenMonsterSetup.exe` 生成 canonical JSON，將安裝檔寫入不可變 key
`tokenmonster/releases/windows/v<version>/TokenMonsterSetup.exe`，再由公開 CDN 做
完整 GET 回讀並核對 SHA-256 與 bytes。只有回讀成功後，workflow 才會用 repo-pinned
Wrangler 將該 JSON 寫入指定 Worker，並從公開 `/v1/releases/current` 回讀 exact JSON。

同一個 signed artifact 的 `RELEASES` 與唯一 full `.nupkg` 會先在無 credential
階段由 `prepare-windows-promotion.mjs`／
`verify-windows-squirrel-candidate.mjs` 嚴格驗證。stable 與 prerelease 分別只可產生
`tokenmonster/releases/windows/squirrel/latest/` 與 `.../next/`，另有
`.../squirrel/v<version>/` 不可變 keys；full package 必須先於 `RELEASES` 切換。
`plan-windows-squirrel-promotion.mjs` 對 authoritative current candidate 產生
monotonic plan：相同 version／bytes 為 idempotent、相同 version 不同 bytes、降版或
channel drift 一律失敗。protected tag workflow 的 credential-scoped executor 會先從
R2 authoritative GET current `RELEASES`；只有 pinned Wrangler 的 exact missing
diagnostic 可判定不存在，其他錯誤都是 unknown 並停止。present 時還必須 GET 並驗證
其引用的 full package，且在 channel write 前後重新確認 current state 未變。

promotion 順序固定為 create-or-verify exact immutable full package、immutable
`RELEASES`、channel full package，最後才 commit channel `RELEASES`。每個 candidate
object 都要從 R2 與公開 CDN 以 bytes／SHA-256 exact 回讀；mutable `RELEASES` 必須是
`no-store, no-cache, must-revalidate`，version-named package 必須是 immutable。若
metadata commit 後公開回讀持續 stale，executor 只以 exact prior `RELEASES` rollback；
first publish 則刪除 candidate metadata 並等公開 CDN 收斂為 missing。candidate full
package 始終保留。正常 advance 也保留 prior full package，避免已取得舊 `RELEASES`
的 client 隨即失去下載；清理必須由未來另行核准、有 retention window 的 GC policy
處理，promotion 不立即刪除。

每個 Wrangler child 有 180 秒 kill fence，executor 有 60 分鐘 aggregate deadline；
剩餘少於 30 分鐘時不得進入 mutable metadata commit。promotion job timeout 為 90
分鐘，保留 recovery headroom。repo-pinned Wrangler 4.111.0 的本機 help／version 已
確認：put 支援 `--file --cache-control --force --remote`，delete 支援
`--force --remote`，version stdout 必須 exact `4.111.0`；substring 不算通過。

只宣告下列 environment 設定名稱；值由 Cloudflare/release owner 在 GitHub protected
environment 設定，不能提交到 Wrangler config、文件、PR 或 log：

- secret：`TOKENMONSTER_CLOUDFLARE_RELEASE_API_TOKEN`；
- variables：`TOKENMONSTER_CLOUDFLARE_ACCOUNT_ID`、
  `TOKENMONSTER_WINDOWS_RELEASE_R2_BUCKET`、`TOKENMONSTER_WEB_WORKER_NAME`、
  `TOKENMONSTER_PUBLIC_RELEASE_ENDPOINT_URL`。

API token 必須只允許目標 account 的 release R2 object 與目標 Worker secret
binding。只能由 protected tag workflow 執行遠端 `r2 object put`／rollback delete 或
`secret put`；本 runbook 不授權人工執行。實際 promotion 還受 rights、signing、npm
與 GO checklist gate 約束。相同版本重跑只接受已存在且 hash/bytes 完全一致的 CDN
object；只有 bytes 已 exact、公開 cache metadata 不符時，single-writer executor 可用
相同 bytes 修復 metadata，任何 byte drift 都停止且不可覆寫。

## 5. D1 migration：expand、verify、forward-fix

`packages/cloud-d1/migrations/0001_initial.sql`、
`0002_compaction_audit.sql`與additive `0003_lifecycle.sql`已通過Node SQLite與
fake-D1 adapter tests；`0002`鎖定`day-all-v1` output形狀、completed run audit與
closed-day immutable/late-input邊界，`0003`鎖定consent replay index、pause-state
triggers及既有guard enum相容性。
但尚未完成真實`wrangler d1 migrations apply --local` rehearsal，也未配置或套用任何
staging／production D1。Runtime writers、compactor與rebuild已實作；環境、restore及
staging evidence仍缺，因此狀態必須保持STOP。

1. 每個變更用 `expand → optional dual read/write → backfill → verify → contract`。
   先讓舊 Worker 與新 Worker 都能讀 schema；contract migration 延後一個 release。
2. Migration 禁止記錄 prompt、response、path、API key、hour/timezone、event/session
   count。Schema 必須符合[技術規格 8.2](TECHNICAL_SPEC.md#82-cloud-d1)。
3. 在 local D1 與 staging production-size rehearsal 通過後，才可碰 production。
4. Apply 前記錄 row counts/checksum、logical encrypted export 與 Time Travel
   bookmark；apply 後重新核對 totals、indexes、retention 與 deletion suppression。

Migration 產生與 rehearsal：

```sh
cd apps/web
MIGRATION_MESSAGE='expand_REPLACE_DESCRIPTION'
case "$MIGRATION_MESSAGE" in *REPLACE*) exit 64;; esac
npx wrangler d1 migrations create TOKENMONSTER_DB "$MIGRATION_MESSAGE"
npx wrangler d1 migrations apply TOKENMONSTER_DB --env staging --local
npx wrangler d1 migrations list TOKENMONSTER_DB --env staging --remote
npx wrangler d1 migrations apply TOKENMONSTER_DB --env staging --remote
cd ../..
```

Production 由第二位 operator 核對環境與 bookmark 後執行：

```sh
cd apps/web
CHANGE_TIMESTAMP='REPLACE_RFC3339_UTC'
case "$CHANGE_TIMESTAMP" in *REPLACE*) exit 64;; esac
npx wrangler d1 time-travel info TOKENMONSTER_DB --env production \
  --timestamp "$CHANGE_TIMESTAMP" --json
npx wrangler d1 migrations list TOKENMONSTER_DB --env production --remote
npx wrangler d1 migrations apply TOKENMONSTER_DB --env production --remote
cd ../..
```

Migration failure 先停止 rollout；已成功寫入新 schema 後不用 destructive down
migration，也不以 Time Travel 覆蓋正常的新寫入。回退 Worker 必須因 expand 設計而
仍相容，DB 問題以 forward-fix migration 修正。只有確認資料損毀、已隔離流量、
incident commander 核准，且先 replay deletion suppression ledger 時，才可依
bookmark 做 D1 restore。

## 6. Staging deploy 與 smoke

前提是 `env.staging`、route、D1 binding、migration remote rehearsal 與 origin 已
完成；目前不成立。成立後從已驗證的同一 commit 執行：

```sh
RELEASE_SHA="$(git rev-parse HEAD)"
cd apps/web
npx wrangler deploy --env staging --message "staging $RELEASE_SHA"
npx wrangler deployments list --env staging
cd ../..
```

設定 smoke 變數。只能使用 staging hostname；值仍含 `REPLACE` 就停止：

```sh
BASE_URL='https://REPLACE_STAGING_HOST'
ALLOWED_ORIGIN='https://REPLACE_STAGING_WEB_ORIGIN'
ATTACKER_ORIGIN='https://attacker.invalid'
case "$BASE_URL$ALLOWED_ORIGIN" in *REPLACE*) exit 64;; esac
```

基礎與 fail-closed smoke：

```sh
curl --fail-with-body --silent --show-error "$BASE_URL/" >/dev/null
curl --fail-with-body --silent --show-error "$BASE_URL/healthz" |
  jq -e '.status == "ok" and .contractVersion == 1'
curl --fail-with-body --silent --show-error "$BASE_URL/v1/compatibility" |
  jq -e '.contractVersion == 1 and .acceptedSnapshotSchemaVersions == ["1"]'
curl --fail-with-body --silent --show-error \
  "$BASE_URL/v1/consent-documents/current?purpose=contribution&locale=zh-TW" |
  jq -e '.controls.defaultEnabled == false and (.forbidden | index("prompt")) != null'

body_file="$(mktemp)"
header_file="$(mktemp)"
trap 'rm -f "$body_file" "$header_file"' EXIT
status="$(curl --silent --show-error --output "$body_file" \
  --dump-header "$header_file" --write-out '%{http_code}' \
  "$BASE_URL/v1/public/totals")"
test "$status" = 503
jq -e '.code == "PUBLIC_TOTALS_UNAVAILABLE" and
  (has("allTimeTokens") | not) and (has("contributors") | not)' "$body_file"
test -z "$(awk 'BEGIN{IGNORECASE=1} /^ETag:/{print}' "$header_file")"
```

`503` 是目前正確結果；瀏覽器必須顯示「目前無法顯示經驗證總量」，不得為了讓
smoke 綠燈而注入 fixture。D1 binding 已配置、rebuild 已完成且 truth 非空後，改跑
verified counter smoke：

```sh
status="$(curl --silent --show-error --output "$body_file" \
  --dump-header "$header_file" --write-out '%{http_code}' \
  "$BASE_URL/v1/public/totals")"
test "$status" = 200
jq -e '.contractVersion == 1 and
  (.allTimeTokens | test("^(0|[1-9][0-9]{0,18})$")) and
  (.todayUtcTokens | test("^(0|[1-9][0-9]{0,18})$")) and
  (.contributors | test("^(0|[1-9][0-9]{0,18})$")) and
  .disclaimer == "只包含自願匿名分享者，不代表全球所有 AI 使用量。"' "$body_file"
etag="$(awk 'BEGIN{IGNORECASE=1} /^ETag:/{sub(/^[^:]+:[ ]*/,""); sub(/\r$/,""); print; exit}' "$header_file")"
test -n "$etag"
test "$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --header "If-None-Match: $etag" "$BASE_URL/v1/public/totals")" = 304
```

Security headers 與 CORS：

```sh
curl --silent --show-error --dump-header "$header_file" --output /dev/null \
  "$BASE_URL/v1/compatibility"
grep -iq '^x-content-type-options: nosniff' "$header_file"
grep -iq '^x-frame-options: DENY' "$header_file"
grep -iq '^referrer-policy: no-referrer' "$header_file"
grep -iq '^content-security-policy:' "$header_file"
grep -iq '^strict-transport-security:' "$header_file"

curl --silent --show-error --dump-header "$header_file" --output /dev/null \
  "$BASE_URL/"
grep -iq '^x-content-type-options: nosniff' "$header_file"
grep -iq '^x-frame-options: DENY' "$header_file"
grep -iq '^referrer-policy: no-referrer' "$header_file"
grep -iq '^content-security-policy:' "$header_file"
grep -iq '^strict-transport-security:' "$header_file"

curl --silent --show-error --dump-header "$header_file" --output /dev/null \
  --header "Origin: $ATTACKER_ORIGIN" "$BASE_URL/v1/public/totals"
test -z "$(awk 'BEGIN{IGNORECASE=1} /^Access-Control-Allow-Origin:/{print}' "$header_file")"
```

目前 Worker entry 沒有注入 `allowedPublicOrigin`，所以 allowlisted cross-origin
preflight smoke 是 **pending**；same-origin site 不需 CORS。若日後真的需要跨 origin
public reads，adapter 接線與測試合併後才執行下列 smoke；絕不為 companion bearer
mutation 開 `*`：

```sh
status="$(curl --silent --show-error --output /dev/null \
  --dump-header "$header_file" --write-out '%{http_code}' \
  --request OPTIONS --header "Origin: $ALLOWED_ORIGIN" \
  --header 'Access-Control-Request-Method: GET' \
  --header 'Access-Control-Request-Headers: If-None-Match' \
  "$BASE_URL/v1/public/totals")"
test "$status" = 204
grep -iq "^access-control-allow-origin: $ALLOWED_ORIGIN" "$header_file"

status="$(curl --silent --show-error --output /dev/null \
  --write-out '%{http_code}' --request OPTIONS \
  --header "Origin: $ALLOWED_ORIGIN" \
  --header 'Access-Control-Request-Method: POST' \
  "$BASE_URL/v1/public/totals")"
test "$status" = 400
```

## 7. Production canary、custom domain 與 rollback

Production deploy 只有 checklist 的 `GO-PRODUCTION` 可啟動。先確認 custom domain
TLS、route 只指向 production Worker、staging hostname 未共用 cookie/secret，且舊
Worker 可讀 expand 後 schema。上傳版本不等於導流：

```sh
RELEASE_SHA="$(git rev-parse HEAD)"
cd apps/web
npx wrangler deployments list --env production
npx wrangler versions upload --env production --tag "$RELEASE_SHA" \
  --message "production candidate $RELEASE_SHA"
cd ../..
```

從輸出人工抄錄並由第二人核對 IDs；placeholder 未替換即停止：

```sh
cd apps/web
OLD_VERSION_ID='REPLACE_CURRENT_VERSION_ID'
NEW_VERSION_ID='REPLACE_NEW_VERSION_ID'
case "$OLD_VERSION_ID$NEW_VERSION_ID" in *REPLACE*) exit 64;; esac
npx wrangler versions deploy "$OLD_VERSION_ID@95%" "$NEW_VERSION_ID@5%" \
  --env production
cd ../..
```

每階段至少觀察兩個完整 aggregate refresh windows，跑第 6 節 smoke，核對 5xx、
latency、projection age、D1 errors、quarantine、deletion age 與 forbidden-data
canary；通過才升 25%、50%、100%。Counter 修正下降本身不是事故；與 authoritative
rebuild 不一致才是。

Code rollback：

```sh
cd apps/web
ROLLBACK_REASON='REPLACE_INCIDENT_OR_CHANGE_ID'
case "$ROLLBACK_REASON" in *REPLACE*) exit 64;; esac
npx wrangler rollback "$OLD_VERSION_ID" --env production \
  --message "$ROLLBACK_REASON" --yes
cd ../..
```

Rollback 後重跑 smoke。不要 rollback 到會輸出假 counter 或讀不到新 schema 的
版本。Schema 問題遵循 forward-fix；不可在有新寫入時任意 Time Travel。若 verified
projection 不可信，安全狀態是讓 `/v1/public/totals` 回 `503`，local companion
功能保持可用。

## 8. Daily encrypted export 與 monthly restore/rebuild drill

此流程目前仍 **不可在遠端執行**：Durable suppression、projection rebuild、bounded
deletion、`day-all-v1` anonymous compaction、hard-retention與本機隔離
suppression-aware restore runner source paths已實作，但backup bucket、加密key custody、
suppression ledger安全export、owner-owned無route隔離D1 binding與真實restore drill尚未完成。
Initial D1 schema與單元測試不能取代這些營運能力，因此仍是 production STOP gate。
完成後由隔離的 ops identity 每日：

1. `umask 077`，在 ephemeral encrypted runner 將 production D1 logical export 寫入
   暫存檔；禁止 stdout、artifact preview 或一般 CI log。
2. 立即使用 owner 核准且固定版本的 encryption tool 加密；encryption key 與 R2
   credential 分離，plaintext 在上傳前刪除。
3. 上傳到獨立 backup bucket，記錄 encrypted object checksum、schema version、
   export timestamp 與 row-count/checksum（不記錄 row values），保留 30 天。
4. 失敗或超過 24 小時沒有有效 export 立即告警；Time Travel 不是唯一備份。

Wrangler export 的安全骨架如下；`age` 與 R2 bucket 需先由 security owner 核准：

```sh
cd apps/web
umask 077
BACKUP_BUCKET='REPLACE_APPROVED_BACKUP_BUCKET'
BACKUP_KEY="d1/$(date -u +%Y/%m/%d)/tokenmonster-$(date -u +%FT%H%M%SZ).sql.age"
RECIPIENTS_FILE='REPLACE_EPHEMERAL_RECIPIENTS_FILE'
case "$BACKUP_BUCKET$RECIPIENTS_FILE" in *REPLACE*) exit 64;; esac
plain="$(mktemp)"
encrypted="$(mktemp)"
trap 'rm -f "$plain" "$encrypted"' EXIT
npx wrangler d1 export TOKENMONSTER_DB --env production --remote \
  --output "$plain" --skip-confirmation
age --recipients-file "$RECIPIENTS_FILE" --output "$encrypted" "$plain"
rm -f "$plain"
npx wrangler r2 object put "$BACKUP_BUCKET/$BACKUP_KEY" --file "$encrypted" \
  --remote
cd ../..
```

每月 restore drill 只能進新建、無 public route 的隔離 staging DB：解密到 ephemeral
檔案，`wrangler d1 execute <isolated-db> --remote --file <plain.sql>`，接著**先** replay
獨立 deletion suppression ledger，才執行已提交的 protected rebuild command。核對：

- schema/migration version、table row counts 與 checksum；
- 已刪 current rows、credentials、shares 沒有復活；
- queued/running deletion-job verifier與`mutation_guard_*` credential shadow
  已清空；隔離restore不可能有合法in-flight writer；
- `anonymous_rollups + usage_daily_current` 重建值與預期相符，counter 可下降；
- projection 刪除後可完整 rebuild，且沒有 contributor mapping 進 anonymous rollup；
- backup、logs 與 drill evidence 沒有 forbidden field/secret；
- RTO、RPO 與失敗原因已記錄。

Repository現在有`createD1SuppressionAwareRestoreDrill`，會先鎖定active suppression
snapshot與count manifest、bounded replay/purge、驗證credential/attributable row/share
皆無殘留（含未過期queued/running deletion-job status/replay verifier與 abandoned
`mutation_guard_*` token/deletion shadow），清除所有離線guard後再rebuild並核對
count-only checksum；本機真SQLite fixture命令為：

```sh
npm run test:restore-drill --workspace @tokenmonster/cloud-d1
```

這不是遠端成功證據。真實drill仍須owner提供新建且無public route的restore D1
binding、獨立suppression Durable Object reader、suppression-key derivation binding與核准的
counts/checksum manifest；任何一步失敗都要銷毀該隔離DB，絕不可掛route或移作
staging。未提供前不得新增公開admin endpoint或以臨時SQL取代。

## 9. Incident gates

任何一項成立立即 `STOP` 新 rollout，保存最小非敏感 evidence，指定 incident
commander：

- prompt、response、source/path、API/OAuth/provider key、authorization header、
  local hourly/event/session data 到達 cloud、log、backup、analytics 或 diagnostic；
- retry/rescan/replay 增加 public truth，equal-revision conflict 未隔離，或 decimal /
  int64 invariant 失守；
- deletion/pause/credential invalidation 不可靠，restore 讓已刪 current data 復活；
- public projection 無法由 canonical rows + anonymous rollups重建，或 UI 顯示未驗證
  數字；
- blocked raster、無授權素材、secret、source map 或未預期 artifact 進 release；
- D1 migration、backup、CORS/auth、custom domain 或 signing identity 綁到錯誤環境。

目前沒有 ingestion route；新增時必須同時提供可稽核的 contribution kill switch。
Cloud incident 要能讓 contribution/public projection fail closed並回 `503`；不得
關閉或扣住 local-only 核心功能作為補救。依
[威脅模型第 9 節](THREAT_MODEL.md#9-security-testing-and-incident-response)
完成停用、撤銷、清除、通知評估、regression fixture 與 security/privacy review 後，
才可重新 GO。
