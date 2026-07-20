# Character asset build pipeline

This local pipeline reads the external tachie bank, creates content-addressed
image objects, and emits a manifest validated by the built
`@tokenmonster/characters` package. It never writes to the source bank. Layered
`parts/` rigs are excluded. Optional, separately staged voice clips can be
ingested with `--voice-dir`.

## Usage

Set the read-only bank path and run the builder from the repository root:

```sh
export ASSET_BANK_DIR=/home/ted-h/voice-lab/video-mvp/tachie
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
schema-v2 set does not enable TokenMonster runtime transport. Shipping entry
points remain cache-only until an explicit, privacy-reviewed fixed-pack flow
proves that its network request set and order cannot reveal local character,
unlock, theme, pose, trigger, or usage state.
