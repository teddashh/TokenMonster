# Asset release v2 contract

The public asset gate has four deliberately different names:

- `AssetIntegrityManifestV1` is the existing generated association, path,
  dimensions, size, and hash inventory. It is not a rights decision.
- `AssetBuildProvenanceV1` is the prompt-free public audit sidecar. It binds
  every deterministic association ID to a reviewed source-inventory revision,
  relative source path and hash, exact output snapshot, upstream receipt chain,
  pipeline revision, encoder/tool version, resize/quality settings, and an
  affirmative metadata-strip record.
- `AssetRightsLedgerV2` is private assembler input. It may contain
  `pending`/`blocked` decisions and exact-hash approval records, but it must
  never be copied into a release.
- `AssetReleaseManifestV2` is the only public shape that can authorize a
  shippable set. Its schema has literal `approved` statuses and literal `true`
  public, commercial, modify, and redistribute scopes.

The contracts and pure fail-closed join live in
`packages/characters/src/asset-release.ts`. They intentionally add no provider
family. GLM is a valid character association but is optional, so image-only
GLM input can pass after its own evidence exists without making GLM art or
voice mandatory for another release.

## Assembly

Run from the repository root with fresh, owner-reviewed input files:

```sh
node scripts/asset-pipeline/assemble-release.mjs \
  --integrity /staging/manifest.json \
  --build-provenance /staging/build-provenance-v1.json \
  --rights-ledger /private/asset-rights-ledger-v2.json \
  --out /staging/asset-release-manifest-v2.json
```

The output path must not exist. The command reads bounded regular files,
rejects symlinks, assembles in memory, validates the strict v2 result, and only
then performs an atomic write. Any invalid JSON/schema, missing or extra row,
duplicate deterministic asset ID, association mismatch, stale integrity,
source or output hash, incomplete rights scope, non-approved decision, or
missing image/voice evidence produces no output.

Association IDs are derived, never owner-invented:

- avatar: `asset:<character>:avatar`
- outfit: `asset:<character>:theme:<theme>:outfit`
- pose: `asset:<character>:theme:<theme>:pose:<state>`
- voice: `asset:<character>:voice:<line-id>:<trigger>`

Both provenance and rights rows repeat the strict association tuple; the
assembler compares the tuple, ID, complete source snapshot, output hash, bytes,
media shape, v1 manifest hash, and the ledger-pinned hash of the complete build
provenance. It never performs a partial or subset join.

## Evidence boundary

Source provenance uses an opaque inventory ID, a SHA-256 inventory revision,
a repository-relative inventory path, and a source SHA-256. Each image entry
also pins a safe source-repository ID and 40/64-hex revision plus a bounded
upstream chain. A step contains only its operation, a receipt-relative path and
digest, exact tool/version, nullable model ID, input hashes, and output hash.
Absolute paths, Windows paths, traversal segments, URLs, credentials,
generation instructions, spoken text, and arbitrary evidence locations have no
fields in the public contract. Evidence is referenced by bounded safe IDs and
digests.

Every release entry requires written-grant, brand-review, content-review, and
disclosure reference IDs; a general-audience rating; bilingual alt text; and an
explicit transform allowlist. Voice additionally requires locale,
`human-original` consent or `synthetic-non-clone` provenance, and a separate
spoken-content-review reference. There is deliberately no cloned-voice source
type and no field for a transcript.

`build-manifest.mjs` does not invent upstream evidence. On the controlled build
host, `prepare-source-evidence.mjs` can derive the exact image source set from
the integrity manifest and its sibling report, require an otherwise empty
read-only staging bank, and create private mode-`0600` factual import receipts
plus a strict `AssetSourceEvidenceBundleV1`. It requires caller-supplied safe
inventory/repository IDs and an exact 40/64-hex source revision; it does not
infer a revision, copy prompts, or assert rights. `build-provenance.mjs` then
requires that exact evidence bundle and private receipt root, re-hashes every
receipt/source/output, proves the selected source set and step chains, and
emits `AssetBuildProvenanceV1`.
Receipt contents stay private and are never parsed or copied into public
provenance. Do not derive a fake Git revision for the untracked source bank: the
repository revision identifies the reviewed source workflow, while the
separate computed inventory revision identifies the exact staged bytes. Also,
the current optional WAV path copies source bytes verbatim; it cannot truthfully
set `metadataStripped: true`. Public voice assembly therefore remains blocked
until a reviewed build step strips metadata and records the resulting hash.

Publishing the audit sidecar does not grant rights and runtime does not need to
download it. The approved release manifest pins its canonical SHA-256, so an
auditor can verify the exact public provenance file independently while the
fixed runtime pack remains limited to approved objects.

Producing v2 does not enable runtime transport or authorize an upload by
itself. TokenMonster's separately reviewed runtime permits only one explicitly
consented fixed-pack request whose set and ordering are independent of
character, unlock, theme, pose, trigger, and local usage; it never performs
per-object fetches.

Release candidates also derive, rather than independently approve, an exact
starter subset with `prepare-embedded-starter-release.mjs`. It contains eight
WebPs／415,470 bytes: the avatar and `tech` outfit for each of ChatGPT, Claude,
Gemini, and Grok. Release assembly cross-binds those associations to the full v2
authority and verifies exact paths, byte lengths, SHA-256 digests, and WebP
signatures before injecting them into the candidate tarball. Installed clients
use those bytes with zero runtime GETs; a failed or revoked complete-pack state
falls back to this base, while other missing art still uses the letter renderer.
The four starters' 168 `zh-TW`/`en` fixed lines are compiled text rather than
voice assets. Neither the embedded base nor the current 891-image,
65,574,180-byte explicitly consented pack contains audio. These pipeline facts
do not mean an application release has been published.
