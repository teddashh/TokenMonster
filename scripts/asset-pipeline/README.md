# Character asset build pipeline

This local pipeline reads the external tachie bank, creates content-addressed
image objects, and emits a manifest validated by the built
`@tokenmonster/characters` package. It never writes to the source bank. Layered
`parts/` rigs are excluded. Optional, separately staged voice clips can be
ingested with `--voice-dir`.

## Usage

Set the read-only bank path and run the builder from the repository root:

```sh
export ASSET_BANK_DIR=<asset-bank-root>/tachie
node scripts/asset-pipeline/build-manifest.mjs --out /tmp/tokenmonster-assets
```

Useful selections:

```sh
node scripts/asset-pipeline/build-manifest.mjs --personas chatgpt,claude --themes tech,science
node scripts/asset-pipeline/build-manifest.mjs --personas chatgpt --sample --out ./.asset-sample-out
node scripts/asset-pipeline/build-manifest.mjs --personas glm --voice-dir /tmp/glm-reviewed-voice
```

- `--out <dir>` defaults to `~/.cache/tokenmonster-asset-build`.
- `--personas a,b` and `--themes x,y` accept IDs from the audited source map.
- `--voice-dir <dir>` scans every direct entry in a dedicated voice staging
  directory. `--personas` filters images, not that directory, so do not mix
  unrelated clips in a persona-specific build.
- `--sample` limits the selected themes to three.
- `SOURCE_DATE_EPOCH` optionally fixes `generatedAt`; otherwise the newest
  selected source mtime is used so unchanged inputs produce an identical
  manifest.

Voice filenames are `<persona>__<trigger>.wav`. The four starter aliases are
`openai`, `anthropic`, `google`, and `xai`; the remaining personas, including
`glm`, use their character ID. Allowed triggers are `greeting`, `unlock`,
`quiet`, `active`, and `error`. Clips must be regular, non-symlink RIFF/WAVE
PCM-format-1 files: 16-bit, mono, 22,050 Hz, at most 400,000 bytes, and between
1 and 6,000 ms. The builder does not verify locale, spoken content,
speaker/clone provenance, consent, rights, brand approval, or loudness; those
remain separate release gates.

The script first builds `@tokenmonster/characters`, probes `ffmpeg` for
`libwebp`, and encodes avatars to a maximum 256-pixel dimension and dolls to a
maximum height of 840 pixels at quality 82. If WebP encoding is unavailable the
build fails; `--allow-png-passthrough` is an explicit development-only fallback.
Missing
avatars, outfits, and reaction poses are listed in `report.json` without making
the build fail. Existing encoded objects are reused through the local
`.asset-pipeline-cache.json`; the source bank remains untouched.

The output directory contains `manifest.json`, `report.json`, `objects/`, and a
local cache file. The schema-v1 `manifest.json` and referenced objects are
inputs to the rights-aware release assembler only after they are paired with a
controlled-host build-provenance file; they are not a public release payload by
themselves. See [`ASSET_RELEASE_V2.md`](ASSET_RELEASE_V2.md) for the exact join
and evidence boundary. Do not commit generated image or audio objects to this
repository.

Prepare prompt-free source evidence from a fresh, exact source staging bank
before building provenance:

```sh
node scripts/asset-pipeline/prepare-source-evidence.mjs \
  --integrity /tmp/tokenmonster-assets/manifest.json \
  --asset-bank /private/exact-read-only-character-sources \
  --inventory-id ai-sister-reviewed-inventory \
  --repository-id ai-sister-source \
  --source-revision 77b317b95b6047f1de330d5d41e4edab38de3b44 \
  --receipt-root /private/new-ai-sister-import-receipts \
  --out /private/source-evidence-v1.json
```

Both output paths must be absent. The receipt root is created mode `0700` and
every factual import receipt is mode `0600`; the public evidence file is also
mode `0600` while staged. The command accepts only a complete image-only WebP
manifest/report pair and an exact bank containing precisely the selected root
avatar or documented first-outfit fallback, every selected outfit, and every
manifest-listed pose. It recursively rejects extra or missing files, symlinks,
non-files, path escape, voice rows, unsafe IDs, and any revision other than
exactly 40 or 64 lowercase hexadecimal characters. It reads but never modifies
the bank.

The generated `AssetSourceEvidenceBundleV1` contains only safe relative source
and receipt paths, hashes, the caller-supplied repository snapshot, and one
`import` step per unique source. Private receipts record those same factual
relative-path/hash bindings plus byte counts. Neither output contains prompts,
URLs, absolute paths, license scopes, review decisions, or approval. This
preparation step proves source identity only; it is not a rights grant and does
not make an asset publishable.

For a complete image-only WebP build, emit the strict provenance input from the
same immutable source staging directory and build output:

```sh
node scripts/asset-pipeline/build-provenance.mjs \
  --integrity /tmp/tokenmonster-assets/manifest.json \
  --asset-bank /tmp/reviewed-character-staging \
  --inventory-id ai-sister-reviewed-inventory \
  --source-evidence /private/source-evidence-v1.json \
  --receipt-root /private/ai-sister-receipts \
  --out /tmp/tokenmonster-assets/build-provenance-v1.json
```

The emitter re-hashes every source and output, reconstructs the pipeline's
avatar/outfit/pose mapping and resize dimensions, computes one inventory
revision from the exact selected source set, and pins the byte hash of
`build-manifest.mjs`. It accepts only the metadata-stripped WebP path and writes
no output for a missing asset, stale object, PNG passthrough, incomplete source
evidence, stale receipt, or voice build. Voice needs a separately reviewed
metadata-stripping step before it can produce truthful schema-v2 provenance.

`--source-evidence` is controlled-host input, validated by
`AssetSourceEvidenceBundleV1Schema`. Its `inventoryId` must match the CLI flag
and its entries must be the exact selected staging-source set. Each entry binds
the source-relative path and hash to a pinned safe repository ID/revision and
one to eight upstream `generate`, `edit`, `normalize`, or `import` steps. Every
step records a private receipt's path relative to `--receipt-root`, receipt
digest, exact tool/version, nullable model ID, at most 16 input hashes, and one
output hash. A later step must consume the preceding output and the last output
must equal the staged source hash.

Raw receipts remain private. They may retain internal generation metadata, but
the emitter treats their bytes as opaque and publishes only their bounded
relative path and SHA-256. The strict evidence schema has no free-form text,
filesystem, URL, or generation-instruction field; unknown fields and absolute,
Windows, URI, or traversal paths are rejected. The complete public provenance
therefore permits an authorized reviewer to recover and audit the exact private
receipt without copying sensitive generation inputs into a release artifact.
It is a public audit sidecar, not a rights grant or runtime payload; the
approved release manifest pins its canonical hash.

Create the private owner-review input without fabricating approval:

```sh
node scripts/asset-pipeline/prepare-rights-ledger.mjs \
  --build-provenance /tmp/tokenmonster-assets/build-provenance-v1.json \
  --release-id characters-2026.07.18 \
  --out /tmp/tokenmonster-assets/private-rights-ledger-v2.json
```

Every generated row is `pending`, all scopes are false, and presentation and
review evidence are empty. The release assembler must reject this template.
Only the owner-controlled review process may add grant/review reference IDs,
affirm all four rights scopes, supply bilingual alt text and allowed transforms,
and set the release and every row to `approved`.

Convert that untouched template only after the owner has created a private,
explicit grant receipt:

```sh
node scripts/asset-pipeline/approve-rights-ledger.mjs \
  --pending-ledger /private/private-rights-ledger-v2.json \
  --build-provenance /staging/build-provenance-v1.json \
  --grant-receipt /private/owner-image-grant-receipt-v1.json \
  --out /private/approved-rights-ledger-v2.json
```

The receipt must be a single-link regular file owned by the current OS user at
mode `0600`, directly inside a non-symlink private directory. Its exact v1 shape
is shown below. Angle-bracket values are deliberately invalid placeholders, not
a grant; the owner must supply the actual safe reference IDs, canonical UTC
approval time, release ID, and actual provenance hash.

```json
{
  "schemaVersion": "1",
  "receiptType": "tokenmonster-image-rights-grant",
  "ownerStatement": "I am the owner or an authorized rights holder for every image asset bound by this receipt. I grant TokenMonster public use, commercial use, modification, and redistribution rights for only that bound release and provenance hash, and I approve its general-audience brand, content, disclosure, allowed-transform, and deterministic bilingual-alt-text records.",
  "release": {
    "releaseId": "<safe-release-id>",
    "approvedAt": "<YYYY-MM-DDTHH:mm:ss.sssZ>",
    "expectedBuildProvenanceSha256": "<64-lowercase-hex>"
  },
  "references": {
    "grantReferenceId": "<safe-grant-reference-id>",
    "brandReviewReferenceId": "<safe-brand-review-reference-id>",
    "contentReviewReferenceId": "<safe-content-review-reference-id>",
    "disclosureId": "<safe-disclosure-reference-id>"
  },
  "rights": {
    "licenseStatus": "approved",
    "scopes": {
      "publicUse": true,
      "commercialUse": true,
      "modify": true,
      "redistribute": true
    }
  },
  "review": {
    "brandStatus": "approved",
    "contentStatus": "approved",
    "contentRating": "general"
  },
  "presentation": {
    "allowedTransforms": ["scale-down"],
    "bilingualAltTextPolicy": {
      "mode": "deterministic-tokenmonster-catalog-v1",
      "locales": ["zh-TW", "en"],
      "associationKinds": ["avatar", "outfit", "pose"],
      "privateReceiptContentUsed": false
    }
  }
}
```

The approver accepts no voice row and no partially edited pending ledger. It
recomputes the actual build-provenance hash, compares every pending row to that
provenance, requires the receipt to bind the same hash and release ID, and
rejects an approval time earlier than provenance creation. It only transcribes
the receipt's explicit safe authority references: it does not verify the legal
identity behind them and never creates a receipt or reference ID. The ledger
schema does not pin the private receipt's digest, so every reference ID must
remain externally resolvable to that exact receipt or review record.
Character, theme, and state catalogs determine the bilingual avatar, outfit,
and pose alt text; no owner statement or other private receipt text is copied
into the approved ledger. The output is still private assembler input and is
not a public release artifact.

After `assemble-release.mjs` has produced an approved schema-v2 release
manifest, construct its immutable fixed pack in a fresh output directory:

```sh
node scripts/asset-pipeline/build-fixed-pack.mjs \
  --release-manifest /tmp/tokenmonster-assets/asset-release-manifest-v2.json \
  --asset-root /tmp/tokenmonster-assets \
  --out /tmp/tokenmonster-assets-fixed-pack
```

The builder re-hashes every referenced object, rejects missing, symlinked,
stale, or media-mismatched inputs, de-duplicates shared content-addressed
outputs, and writes a deterministic stored classic ZIP plus
`asset-pack-descriptor-v1.json`. Its entry order and ZIP profile are accepted
by the production `@tokenmonster/characters/asset-pack` verifier. It creates
only the fixed pack and descriptor; it neither creates an HTTPS allowlist nor
publishes or enables a runtime download. The `--out` directory must not exist,
and a failed build removes it rather than leaving a partial release set.

For the lightweight release-only starter baseline, derive the exact approved
subset and then run the same fixed-pack builder against that derived manifest:

```sh
node scripts/asset-pipeline/prepare-embedded-starter-release.mjs \
  --release-manifest /tmp/tokenmonster-assets/asset-release-manifest-v2.json \
  --out /tmp/tokenmonster-embedded-starter-release

node scripts/asset-pipeline/build-fixed-pack.mjs \
  --release-manifest /tmp/tokenmonster-embedded-starter-release/asset-release-manifest-v2.json \
  --asset-root /tmp/tokenmonster-assets \
  --out /tmp/tokenmonster-embedded-starter-pack
```

The derivation is not a new rights authority. It accepts only the eight exact
associations already approved by the full release: one avatar and one `tech`
outfit for each of ChatGPT, Claude, Gemini, and Grok. Their extracted bytes total
415,470. Two builds from independent approved inputs must produce the same ZIP;
the pinned current build-only ZIP is 417,332 bytes with SHA-256
`99301d903406a5c800a0e6a258fc83ed48af522b3014e09fa1ff100fa6a6269b`.

`scripts/release/build-release.mjs` fetches that exact immutable bootstrap ZIP
by default, without credentials, redirects, or retries, then verifies its hash,
strict ZIP inventory, every object hash/size, and WebP signature before staging
the eight files. `--embedded-starter-pack <zip>` supplies a local copy of those
same exact bytes for controlled or offline builds; it cannot substitute another
pack. The bootstrap URL is build input only. Installed TokenMonster clients
already contain the eight WebPs and make zero runtime GETs for them. The four
starters' 168 `zh-TW`/`en` fixed lines are compiled project text, not files in
this derived image pack, and neither the starter pack nor the full 891-image,
65,574,180-byte pack contains voice.

After the archive exists at its immutable path, generate the three runtime
slots without hand-authoring a hash, pack path, or allowlist path:

```sh
npm run prepare:asset-release-slots -- \
  --release-manifest /tmp/tokenmonster-assets/asset-release-manifest-v2.json \
  --descriptor /tmp/tokenmonster-assets-fixed-pack/asset-pack-descriptor-v1.json \
  --origin https://reviewed-assets.example \
  --out /tmp/tokenmonster-generated-release-slots
```

The command strict-validates both generated inputs, derives the allowlist path
only from the descriptor, cross-validates the complete production pack plan,
and atomically publishes one fresh directory containing the three exact
`approved-*.json` source-slot names. The release integrator copies those three
files byte-for-byte into `packages/characters/src`; never edit their hashes or
substitute a different URL. Release staging rejects a partial set and accepts
only all three null slots or a strictly validated, cross-bound non-null set.

## Rights, privacy, and publishing boundary

The bank stays outside TokenMonster's repository and is read-only input. A
successful technical build is not a rights or brand approval. Its schema-v1
manifest proves object integrity but does not contain the structured provenance,
grant/license scopes, brand/disclosure review, alt text/transforms, or release
status required by `docs/TECHNICAL_SPEC.md`. It cannot authorize public upload.
The pipeline does not upload anything and holds no cloud credentials.

The pipeline also does not split sprite sheets. Extract approved cells into a
writable staging bank before running it, using the documented avatar,
`outfits_v2_norm/doll_<persona>__<theme>`, and pose filenames.

After a schema-v2 release assembler has combined generated integrity metadata
with an owner-approved rights ledger, publishing runs on a separate
credential-holding host. The conditional handoff interface is:

1. `rsync` the build output to that host over the approved channel.
2. Re-validate the assembler-produced schema-v2 release manifest and upload
   only it plus the objects it references beneath the reviewed versioned prefix.
3. Use boto3 `put_object` with
   `CacheControl="public, max-age=31536000, immutable"` and the exact content
   type: `image/webp`, `image/png`, `audio/wav`, or `application/json`.

The credentialed publisher owns bucket selection, approval checks, and object
prefix enforcement. This repository intentionally documents only that
interface; it does not contain publishing code or credentials. Publishing a
schema-v2 set does not by itself enable TokenMonster runtime transport. The
implemented product path separately requires explicit player consent and one
privacy-reviewed, usage-independent fixed-pack request; it never performs
per-object fetches. Default, failed, and revoked states use the release-embedded
four-starter base with zero runtime GETs. This describes candidate behavior and
does not declare an application release published.
