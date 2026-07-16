# Character asset build pipeline

This local pipeline reads the external tachie bank, creates content-addressed
image objects, and emits a manifest validated by the built
`@tokenmonster/characters` package. It never writes to the source bank. Layered
`parts/` rigs and voice files are intentionally excluded from v1 builds.

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
```

- `--out <dir>` defaults to `~/.cache/tokenmonster-asset-build`.
- `--personas a,b` and `--themes x,y` accept IDs from the audited source map.
- `--sample` limits the selected themes to three.
- `SOURCE_DATE_EPOCH` optionally fixes `generatedAt`; otherwise the newest
  selected source mtime is used so unchanged inputs produce an identical
  manifest.

The script first builds `@tokenmonster/characters`, probes `ffmpeg` for
`libwebp`, and encodes avatars to a maximum 256-pixel dimension and dolls to a
maximum height of 840 pixels at quality 82. If WebP encoding is unavailable it
warns and copies PNG bytes into content-addressed `.png` objects. Missing
avatars, outfits, and reaction poses are listed in `report.json` without making
the build fail. Existing encoded objects are reused through the local
`.asset-pipeline-cache.json`; the source bank remains untouched.

The output directory contains `manifest.json`, `report.json`, `objects/`, and a
local cache file. Only `manifest.json` and referenced files under `objects/`
belong in a release payload. Do not commit generated image or audio objects to
this repository.

## Rights, privacy, and publishing boundary

The bank stays outside TokenMonster's repository and is read-only input. A
successful technical build is not a rights or brand approval. Only an owner-
approved manifest snapshot and its referenced objects may be published. The
pipeline does not upload anything and holds no cloud credentials.

Publishing runs on a separate credential-holding host. The handoff interface
is:

1. `rsync` the build output to that host over the approved channel.
2. Re-validate `manifest.json` and upload only it plus the objects it references
   beneath `tokenmonster/characters/v1`.
3. Use boto3 `put_object` with
   `CacheControl="public, max-age=31536000, immutable"` and the exact content
   type: `image/webp`, `image/png`, `audio/wav`, or `application/json`.

The credentialed publisher owns bucket selection, approval checks, and object
prefix enforcement. This repository intentionally documents only that
interface; it does not contain publishing code or credentials.
