# TokenMonster Alpha Release Checklist

> Architecture update (2026-07-15): collector, local-runtime, and packaging
> gates that assume Tokscale/Electron are legacy migration evidence. The
> permanent target and cutover gates are defined by
> [ADR 0005](adr/0005-permanent-tokentracker-sidecar-adapter.md).

> 本表是 release evidence index，不是自動授權。**目前結論：STOP** — local
> companion contribution source slice、cloud mutation/deletion、`day-all-v1` k=20
> compaction、ordered scheduled maintenance與Companion background sync均已有本機測試，
> 但background packet capture／wake soak、signing/native smoke、Cloudflare account/D1/domain/secrets與remote rehearsal/staging
> E2E、backup/restore/suppression replay、project license／其餘法律決策及 voice
> technical evidence 仍未完成。AI-Sister image-only v2 authority／descriptor／allowlist
> 已非空，891-image fixed pack 也已公開；這項素材進展不會越過上述 installer、cloud、
> operations 與法律 gates。只可進行本機測試或經核准的 fail-closed staging Web 預覽；
> 不可 production deploy，也不可開始 30 人 External Alpha。

執行細節見[部署 runbook](DEPLOYMENT_RUNBOOK.md)。產品範圍與 kill criteria 以
[產品規格](PRODUCT_SPEC.md)、[實作計畫](IMPLEMENTATION_PLAN.md)、
[技術規格](TECHNICAL_SPEC.md)、[資料清冊](DATA_INVENTORY.md)、
[威脅模型](THREAT_MODEL.md)、[repository ADR](adr/0001-repository-boundaries.md)與
[runtime ADR](adr/0002-runtime-and-deployment.md)為準。

## 1. Release record

不得用口頭「已測過」代替連結或 hash。

| Evidence                                                | 必填值                                                                  |
| ------------------------------------------------------- | ----------------------------------------------------------------------- |
| Release scope                                           | `internal-dev` / `staging-web-preview` / `private-alpha` / `production` |
| Git commit / source tag                                 | `PENDING`                                                               |
| CI run、Node/npm/Wrangler versions                      | `PENDING`                                                               |
| Artifact SHA-256 / SBOM / secret scan                   | `PENDING`                                                               |
| Staging Worker version、hostname                        | `PENDING`                                                               |
| Staging D1 UUID、migration version、pre-change bookmark | `PENDING`                                                               |
| Production current/candidate Worker version             | `PENDING`                                                               |
| Smoke / security / privacy / restore drill reports      | `PENDING`                                                               |
| Release operator、reviewer、UTC decision time           | `PENDING`                                                               |
| Change / incident IDs and rollback target               | `PENDING`                                                               |

## 2. Automated evidence

每一格都要附 CI job 或不可變 artifact；`N/A` 需 owner 說明。

- [ ] Clean checkout：`test -z "$(git status --porcelain=v1)"`。
- [ ] Node 24.15.0、npm 11.12.1、`npm ci`、repository/format/secret checks、
      `npm run typecheck`、`npm test`、`npm run build`、artifact verification 全通過。
- [ ] `npm audit --audit-level=high` 與 dependency/license review 無 release blocker。
- [ ] Contract/privacy tests 拒絕 unknown fields、forbidden keys、overflow、錯誤 token
      公式與重複 logical key。
- [ ] tokscale `4.5.2` 四個 Tier-1 fixtures、fixed argv、sanitized env、timeout、
      output cap、reasoning/cache correctness 全通過；不得把 tokscale 與 optional bridge
      totals 相加。
- [ ] Usage authority/idempotency tests涵蓋 retry、replay、rescan、reorder、equal
      revision conflict、downward/zero correction；public truth 不 drift。
- [ ] TokenTracker starter tests證明 local model-breakdown只在 request memory中立即投影
      成 `openai`／`anthropic`／`google`／`xai` 四個 28-day totals；gateway只回 starter
      decision，不回 numeric totals、model IDs或raw source metadata。Breakdown／projection
      failure必須顯示manual choice且不影響aggregate metrics與daily series。
- [ ] Manual character choice只持久化在本機 strict
      `character-preferences-v1.json`／progression selection，reload／restart後保留；
      diagnostic、analytics、cloud wire與asset request均找不到該值或本機路徑。
- [ ] Monster engine deterministic/coverage/DST/explanation tests通過；無 volume
      strength ladder、rank 或核心功能同意誘因。
- [ ] Character catalog與 release-artifact scan 證明 binaries、blocked candidate、
      secret/source map 不在 artifact；schema-v1 integrity manifest 不被當成 public rights
      approval；default-mode（不靠 compatibility flag）CLI／Electron packet capture沒有
      AI-Sister asset GET，artifact 也不含舊 CDN origin／override marker／downloader
      capability signature或symbolic link。
- [ ] Public asset runtime只能以release內嵌schema-v2 rights-approved manifest為唯一
      rights authority，並與固定 descriptor／HTTPS allowlist 共同授權 transport。目前
      三個 generated JSON slots 已非空且 cross-bind 到 image-only release
      `ai-sister-images-11-2026.07.21`：891 images／11 characters／0 voice、origin
      `https://cdn.ted-h.com`、65,574,180-byte ZIP SHA-256
      `b1bff7d70342006982f9a3dd5b06ecf9b86291fea01dd3caba8822a012e48bb7`。明確同意的
      fixed-pack runtime 已涵蓋
      SHA-256／bytes／MIME、content-addressed cache corruption、offline restart、repair 與
      removal，且 request set/order 不隨 character、unlock、theme、pose、trigger 或 usage
      改變。候選 tarball 另須精確內嵌四位元祖各一張 avatar 與 `tech` 基本服裝，共
      8 WebP／415,470 bytes，搭配 168 條 `zh-TW`／`en` 文字且不含語音；default／
      no-consent／offline-without-cache／failed／revoked 以 zero runtime GET 回到這組 base，
      其他缺圖狀態才 letter/silent fallback，也沒有逐物件 downloader。Immutable R2
      publication 與 public byte readback
      已完成；仍須把 clean installed-candidate packet capture 與本 checklist 其餘 gate 的
      evidence 附齊，不得把「圖片包可啟用」誤寫成整個 Alpha 已上線。
- [ ] Public API tests驗證 fail-closed `503`、fixed contributor wording、decimal strings、
      ETag/304、narrow CORS、Problem Details 與 security headers。
- [ ] Web tests驗證 API unavailable 時不 fake counter、download 不冒充可用、zh-TW
      copy、keyboard/a11y 與 reduced-motion baseline。
- [ ] Worker dry-run 與 staging deploy 使用同一 commit/build；Static Assets 和 Hono
      API 為同一 deployment unit。
- [ ] D1 migrations、prepared reader/writer、authoritative projection、queued deletion、
      `day-all-v1` k=19/20與capacity-drop compaction、10類TTL hard-retention，以及
      `deletion → compactor → preserving retention → projection` Worker integration已有
      本機tests；**仍 PENDING：** clean commit的immutable CI evidence、environment binding、
      real Wrangler D1 rehearsal、production monitoring/alert與quarantine staging E2E。
- [ ] Enrollment／ingest／delete/status domain、credential scope、HTTP mutation、D1
      adapter、bounded deletion worker與Durable rate/suppression ports，以及Companion實際
      payload preview、enrollment、OS-backed scoped secrets、非重疊background sync、
      no-due zero-egress、手動retry、local stop/delete/status已有unit/SQLite/dry-run tests；
      server pause/resume 已有domain/HTTP/D1/Worker整合、冪等與paused-ingest tests；
      **仍 PENDING：** cloud-off packet-capture與sleep/wake E2E、
      backup/restore/suppression replay與
      staging E2E。Checked-in mutation gate不得在上述完成前開啟。
- [ ] Electron sandbox/CSP/main-frame IPC/navigation/download denial、single-instance、
      async safeStorage、Linux `basic_text` fail-closed、BYOK `store:false`、local insights/
      export/reset與packaged native collector fixed-path/integrity tests已完成；
      **仍 PENDING：** sandbox-enabled packaged E2E、cloud-off egress capture與支援平台
      實機smoke。
- [ ] Internal Electron ASAR/ZIP 的 exact inventory、runtime bare-import、blocked asset/
      secret/source-map、raw 9-fuse wire、Tokscale package-lock/SHA/mode/MIT notice、fixed
      `process.resourcesPath` wiring與final ZIP full byte/mode inventory gate已建立；
      **它明確不是 signed artifact。仍 PENDING：** macOS nested-code signing/notarization、
      Team ID/ticket、mounted DMG與packaged smoke。
- [ ] Signed companion artifact inventory、notarization/signature/updater verification與
      crash-free telemetry的 privacy allowlist 全通過。Signed mode目前 fail closed。

## 3. External owner decisions

這些不是 CI 可以替代的判斷；每項要有姓名、日期與文件連結。

- [ ] Cloudflare owner 核准 account、D1 Paid、development/staging/production 隔離、
      custom domain、WAF/rate-limit、backup bucket、least-privilege CI identity 與 MFA。
- [ ] `apps/web/wrangler.jsonc` 的 environment names、D1 UUID、routes、origin 與 secret
      binding names 經雙人核對；沒有共用 production secret。
- [ ] Security owner 核准 pepper rotation、secret custody、encrypted backup、30-day
      retention、deletion suppression ledger與 incident access。
- [ ] Legal owner 決定並發布 project license、TokenMonster 名稱／商標、隱私政策、
      服務條款、資料保留／刪除／匿名歷史不可抽出 disclosure 與 breach notification。
- [ ] Release owner 核准支援 OS/tool matrix、Apple/Windows signing identities、
      notarization、updater key custody 與 rollback channel。
- [x] AI-Sister image release `ai-sister-images-11-2026.07.21`：manifest schema v2、
      immutable provenance/hash、written public/commercial/modify/redistribute grant、
      rights/brand/content review與 unofficial/unaffiliated disclosure均已核准；私有證據
      references 為 `owner-chat-image-grant-2026.07.21`、
      `owner-chat-brand-review-2026.07.21` 與
      `owner-chat-content-review-2026.07.21`，disclosure ID 為
      `tokenmonster-unaffiliated-v1`，允許的 transform 僅為 scale-down。此核准不包含
      目前 pack 之外的素材。
- [ ] AI-Sister CDN delivery：release owner與privacy owner核准唯一 exact origin、
      immutable fixed-pack version、release-embedded manifest、使用者明確
      同意、cache/eviction/fallback policy與edge-log retention；packet capture證明完整
      request set/order與所有本機 usage／selection／progression／pose／voice trigger無關。
- [ ] Release artifact scan確認 npm tarball 只有三個 cross-bound JSON authority slots與
      精確 8 個 approved starter WebP／415,470 bytes；每個 association、path、bytes、
      SHA-256 與 media signature 都符合 release policy，沒有額外 raster 且完全不含 audio。
      沒有同意、離線缺完整 cache、下載失敗或撤銷時，四位 starter base 與 168 條雙語
      文字仍以 zero runtime GET 使用，其他缺圖狀態才 code-native letter/silent fallback。
- [ ] Alpha research owner 核准 30 位參與者招募、7 天 protocol、同意文案、support/
      withdrawal流程與資料最小化量測方式。

## 4. Staging operational gate

- [ ] `env.staging` 為獨立 Worker/domain/D1/secret/backup state；不含 production user
      copy 或可識別資料。
- [ ] Migration 在 local 與 production-size staging 依 expand/backfill/verify 演練；
      有 row count/checksum、Time Travel bookmark、forward-fix 與 old Worker compatibility。
- [ ] `/`, `/healthz`, compatibility與 consent document smoke通過。
- [ ] Projection 未接線時 `/v1/public/totals` 是 `503 /
PUBLIC_TOTALS_UNAVAILABLE`、沒有 totals/ETag；瀏覽器顯示 unavailable，沒有假值。
- [ ] Projection 接線後才允許 200 smoke；decimal totals、固定 disclaimer、ETag/304、
      cache policy、downward correction與 authoritative rebuild完全一致。
- [ ] Attacker origin沒有 ACAO；只有確有跨 origin需求且 adapter已接線時，核准
      public GET origin/preflight才可回 CORS。Bearer mutation永不開 wildcard CORS。
- [ ] API與 static response 的 CSP、HSTS、nosniff、DENY、Referrer-Policy、
      Permissions-Policy、cache headers已由真實 hostname核對。
- [ ] 每日 encrypted logical export成功；隔離 staging restore先 replay deletion
      suppression、再 rebuild totals，已刪 current data/credential/share不復活。
- [ ] Incident drill證明可讓 ingestion／public projection fail closed而保留 local-only
      功能；operator知道可回到哪個 Worker version。

## 5. Private Alpha entry（30 人／7 天）

全部通過才可邀請外部參與者：

- [ ] 具簽章且可驗證來源的 companion已實作；unsupported平台清楚標示，沒有未簽
      preview冒充正式 Alpha。
- [ ] Local collector/dashboard/monster/fixed lines在完全斷 cloud時仍可使用；匿名分享
      預設關閉。
- [ ] Opt-in 前顯示實際 daily payload preview、30-day identifiable retention、
      `k >= 20`匿名 rollup與較舊資料無法個別抽出的限制。
- [ ] Contribution/deletion credentials只進 OS-backed secret store；Linux
      `basic_text` 阻擋 persistent opt-in，provider key永不進 TokenMonster cloud。
- [ ] Upload/delete credential scope分離；pause、resume、stop/delete、retry與離線
      spool E2E通過。
- [ ] Collector detection與修復訊息可支援 cohort；support與incident on-call已排班。
- [ ] Alpha candidate build只嵌入已核准的 891-image authority／descriptor／allowlist、
      從中 cross-bind 的精確 8 個 starter WebP／415,470 bytes，以及 168 條雙語文字；
      不含任何語音 binary。歷史 50 條 cloned WAV 仍排除，且不得以 owner approval 取代
      欠缺的 clone-consent/provenance、逐條 content review 與 metadata-stripping evidence。
- [ ] Cloud-off／asset packet capture證明 default、no-consent、offline-without-cache及
      revoked 狀態沒有AI-Sister asset GET；明確啟用時只能看見一個固定 pack/version及
      client IP，不得含或由 object set推得
      token/provider totals、starter rationale、character/theme/unlock/pose/trigger、
      user/install ID或filesystem/project path。
      內建 8 個 WebP 在安裝後不得觸發任何 bootstrap 或 CDN runtime GET；完整包失敗或
      revoked 必須回到 base，而不是自動重試。
- [ ] 招募名單、consent revision、退出/刪除流程與每日 safety review已確認。

## 6. Alpha exit metrics 與決策

以 30 位使用者連續 7 天的 cohort 計算，原始 prompt/path等 forbidden data 永不拿來
量測。門檻來自[產品規格 13.2](PRODUCT_SPEC.md#132-closed-alpha-目標)：

| 指標                               |       Exit target | Evidence / result |
| ---------------------------------- | ----------------: | ----------------- |
| Identity resonance                 |          `>= 60%` | `PENDING`         |
| Archetype comprehension            |          `>= 50%` | `PENDING`         |
| 自願 opt-in rate                   |          `>= 40%` | `PENDING`         |
| D7 主動開啟                        |          `>= 35%` | `PENDING`         |
| 主動分享卡                         | 參考門檻 `>= 20%` | `PENDING`         |
| 已宣告支援環境 collector detection |          `>= 90%` | `PENDING`         |
| Crash-free active sessions         |          `>= 99%` | `PENDING`         |

安全／隱私 gate 沒有平均或容忍門檻。角色 resonance/comprehension 未達標只允許一次
trait/copy主要迭代與等規模復驗；D7未達標不進 Beta。Opt-in未達 40% 但 local價值
通過時，降低或延後 public counter，不得用功能鎖或獎勵強迫同意。完整 pivot規則見
[產品規格 13.4](PRODUCT_SPEC.md#134-kill-與-pivot-條件)。

## 7. Explicit STOP / GO

### 任何 release 的立即 STOP

- 任一 forbidden content/credential進入 persistence、wire、log、analytics、backup、
  diagnostic或 artifact。
- Replay/rescan可增加 truth、revision conflict未 fail closed、deletion無法可靠移除
  current window，或 restore讓已刪資料復活。
- Counter沒有 verified projection卻顯示數字，或 public copy宣稱全球／代表性 usage。
- Numeric starter provider totals、upstream model IDs或raw source metadata穿過gateway；
  或model-breakdown失敗連帶讓aggregate metrics不可用。
- Blocked/unlicensed raster、secret、provider-branded asset未通過 rights/brand gate卻
  進 artifact。
- AI-Sister cloud asset runtime在沒有release-embedded schema-v2 rights-approved
  manifest、使用者明確同意、fixed pack/version、exact-origin與
  SHA-256/bytes/MIME/extraction/cache/fallback驗證前被啟用；packet capture還必須證明
  request set/order不隨character、unlock、theme、pose、trigger或usage改變。
- Release commit不乾淨、CI/audit/security evidence缺失、環境或 rollback target不明。

### `GO-STAGING-WEB-PREVIEW`

只在 automated public slice全綠、staging資源隔離、owner核准 hostname且 smoke顯示
fail-closed counter時成立。它不代表 cloud contribution、companion、Alpha或
production ready。

### `GO-PRIVATE-ALPHA`

需 automated、external-owner、staging operational與Private Alpha entry全部打勾；
signed companion、consent/delete、restore/rebuild任何一項 pending即 STOP。

### `GO-PRODUCTION`

除上述全部通過外，還要 Alpha exit、安全/隱私 review、legal文件、production
Cloudflare credentials/domain/D1 Paid、signing identities、容量/restore drill、
canary與rollback雙人簽核。**缺 credentials 或 legal gates 時絕不 deploy。**

目前判定維持：`STOP`。
