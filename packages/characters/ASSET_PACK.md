# Fixed character asset pack boundary

Status: the acquisition primitive and player consent/revocation path are
implemented and tested. The embedded schema-v2 release, descriptor, and exact
origin/path authority are a non-null, strictly cross-bound generated set for
image-only release `ai-sister-images-11-2026.07.21`. Release staging also embeds
an exact 415,470-byte starter base: ChatGPT, Claude, Gemini, and Grok each have
one avatar and one `tech` outfit, for eight WebPs total. A clean install renders
that base with zero runtime asset requests; explicit enablement authorizes
exactly one GET for the separate complete fixed pack.

The starter base is derived only from the approved full-release associations.
The release policy checks its exact paths, sizes, SHA-256 digests, and WebP
signatures before placing it under the characters package. It is paired with
168 compiled `zh-TW`/`en` fixed text lines for the four starters and contains no
WAV or other voice binary. The build-time source ZIP is not a runtime endpoint:
installed clients already have the eight verified WebPs and never fetch them.

`@tokenmonster/characters/asset-pack` is the fail-closed acquisition primitive
for the public, rights-approved character image release. Its presence alone
does not authorize a download: the gateway requires a same-session player
choice and keeps the per-object `cdnBaseUrl` at `null`.

The runtime remains fail-closed unless all of these release inputs exist:

1. an embedded strict schema-v2 asset release manifest whose every association
   passed its image or voice rights, grant, brand, content, and disclosure gate;
2. an embedded pack descriptor and an independently configured exact HTTPS
   origin/path allowlist;
3. an immutable pack already published at the descriptor's hash-named path;
4. the existing disclosed, explicit complete-pack consent control remains in
   the release and passes its same-session transition tests;
5. installed-build packet-capture review proving that no character, unlock,
   theme, pose, voice trigger, or usage state affects the request.

The current image release supplies the first four inputs. Its public origin is
`https://cdn.ted-h.com`; its 891-entry, 65,574,180-byte ZIP has SHA-256
`b1bff7d70342006982f9a3dd5b06ecf9b86291fea01dd3caba8822a012e48bb7`, and
its embedded manifest has canonical SHA-256
`924c95cff70fac69f8622cecb499e7691a23e9d4c51e5a8c53dc9bbe2dd513e1`.
Installed-build packet-capture review remains a release-evidence gate; this
document does not declare the overall Alpha ready. Release staging accepts the
three slots only when they are either all null or all strictly validated and
cross-bound.

## Player consent lifecycle

The gateway exposes a session-gated, exact-key status DTO and one boolean-only
control. The UI discloses the descriptor's actual byte count, that the action
downloads one complete fixed pack, and that no usage, selected character,
unlock, wardrobe, pose, or voice state is sent. A clean install starts with the
four-starter base art and bilingual text and performs no asset request; other
unavailable art keeps the letter/silent fallback.

Enable first verifies whether the complete immutable pack is already cached.
Only a complete cache hit or one successful fixed-pack install activates the
complete 891-image projection over the starter base. Consent is then persisted
locally in a mode-0600 atomic
file. A partial or failed full-pack install stays on the embedded starter base.
On restart, a prior
consent verifies local cache bytes only; an incomplete cache becomes
`repair-needed` and never triggers an automatic network retry.

Disable switches the same running session back to the embedded starter manifest
before returning, persists revocation, and removes only the downloaded objects
named by the fixed release. It never removes the release-staged eight WebPs or
the bilingual text and never performs a network request. Re-enabling clears the
UI's image-failure memory and refreshes the roster in the same session so newly
verified full-pack art can render immediately.

## Immutable request contract

The descriptor contains one release ID, the canonical SHA-256 of the complete
schema-v2 manifest, and one ZIP record. The product specification requires a
production TokenMonster descriptor/allowlist to use exactly:

```text
/tokenmonster/characters/v1/packs/<release-id>/<pack-sha256>.zip
```

The primitive does not compile a publisher namespace; the embedded allowlist is
its authority. The current origin and exact path are kept separate so packaged
source never becomes an alternate combined-prefix authority:

```text
origin: https://cdn.ted-h.com
path: /tokenmonster/characters/v1/packs/ai-sister-images-11-2026.07.21/b1bff7d70342006982f9a3dd5b06ecf9b86291fea01dd3caba8822a012e48bb7.zip
```

The validator requires a canonical safe namespace ending in
`/packs/<release-id>/<pack-sha256>.zip`, then separately pins one
credential-free HTTPS origin and that same exact path. Queries, fragments,
credentials, alternate paths, and non-HTTPS origins fail before network I/O. A
consented invocation performs one `GET` with
`redirect: "error"`, `credentials: "omit"`, an empty referrer, `no-referrer`,
`no-store`, `Accept: application/zip`, and `Accept-Encoding: identity`. It
never retries, probes with `HEAD`, or requests individual objects.

The public API accepts no local presentation or usage state. Expected archive
entries are the unique schema-v2 `output.path` values sorted by Unicode code
point. The descriptor's entry count and extracted byte total must match that
complete set before the request starts.

## Controlled-host pack construction

After the rights-aware assembler has emitted an approved schema-v2 manifest,
the controlled build host can create the corresponding immutable archive and
descriptor with:

```sh
node scripts/asset-pipeline/build-fixed-pack.mjs \
  --release-manifest /tmp/tokenmonster-assets/asset-release-manifest-v2.json \
  --asset-root /tmp/tokenmonster-assets \
  --out /tmp/tokenmonster-assets-fixed-pack
```

The fresh output directory contains one `<pack-sha256>.zip` and
`asset-pack-descriptor-v1.json`. The builder uses stored entries, a fixed DOS
epoch, fixed mode metadata, Unicode-code-point path order, and no ZIP extras,
comments, descriptors, preamble, or trailing bytes. It verifies every input's
regular-file status, declared size, SHA-256, and media signature before that
input enters the archive. Duplicate release associations that reference the
same object create one pack entry, matching the installer plan.

This builder is not a publisher or runtime authorization. For the current image
release, the credentialed publisher uploaded the archive to the descriptor's
exact hash-named path and byte-verified both it and the release manifest through
the public CDN. Future releases must repeat that publication/readback step and
still require a separately reviewed embedded HTTPS allowlist and user-consent
flow before any product entry point may call the installer.

After publication, `npm run prepare:asset-release-slots -- --release-manifest
<path> --descriptor <path> --origin <exact-https-origin> --out <fresh-dir>`
derives the allowlist path from the descriptor, validates the complete
production plan, and atomically emits the three fixed runtime slot filenames.
The fresh directory is the only supported input for promoting non-null source
slots; do not hand-author or independently edit a hash, path, or URL.

The current ZIP contains 891 images for 11 characters and no voice files. The
historical 50 cloned WAV files are not silently appended: despite a privately
stored owner approval, they still lack the complete clone-consent/provenance,
per-clip content-review, and metadata-stripping evidence required by the voice
schema. They require a new combined immutable release. Image and audio binaries
from the complete pack remain outside the npm tarball; the only embedded raster
binaries are the exact eight starter WebPs, and no audio binary is embedded.

## Explicit limits and ZIP profile

- timeout: 120 seconds by default, caller may reduce it, hard maximum 300
  seconds;
- response and descriptor: at most 256 MiB compressed;
- extracted unique objects: at most 256 MiB;
- entries: 1–1,024;
- each object: additionally bounded by the schema-v2 4 MiB object cap;
- streamed transfer chunks: at most 262,144;
- streamed chunks per extracted entry: at most 65,536.

The complete response length and SHA-256 are verified before the archive parser
opens the file. Parsing uses exact production dependency `yauzl@3.4.0` with
`lazyEntries`, `validateEntrySizes`, `strictFileNames`, and explicit descriptor
decoding. TokenMonster accepts only a classic, single-disk, comment-free ZIP
whose local records and central directory are contiguous and describe the same
canonical entry order. Stored and Deflate entries are allowed.

The following are rejected:

- ZIP64, multi-disk ZIPs, data descriptors, encryption, strong encryption,
  unsupported compression/features, archive or file comments, and extra
  fields;
- directories, Unix symlinks or other non-regular types, DOS directory flags,
  absolute paths, drive paths, backslashes, empty/dot segments, traversal,
  duplicate entries, extras, omissions, reordered entries, overlapping local
  records, preambles, and trailing bytes;
- an entry whose declared or streamed bytes, SHA-256, path, extension, or
  PNG/WebP/WAV signature differs from the embedded schema-v2 manifest.

## Cache publication and failure behavior

The only accepted destination is an absolute normalized path whose leaf is
`asset-cache`; the normal product path is `~/.tokenmonster/asset-cache`. The
cache directory is mode `0700`. Download and extraction occur in a random
mode-`0700` child staging directory. Every staged object is created with
exclusive mode `0600`, hashed while streaming, synced, and rechecked before
publication.

Nothing is published until the whole archive passes. Each final cache entry is
an atomic same-filesystem hard link from its complete staged inode. Existing
regular entries are reverified; corrupt entries are replaced, symlinks and
non-files fail closed, and valid entries are tightened to mode `0600`.
Publication and rollback hold one atomic, mode-`0600` cache writer lock across
processes; this prevents a concurrent invocation from adopting an inode that
the creator can still roll back. The installer never reclaims a lock by
pathname because doing so can unlink a newer writer's inode after a check/use
race. A crashed writer's content-blind lock therefore fails closed: stop all
TokenMonster processes before manually removing that one lock file. Waiting
installers remain bounded by caller abort or the operation timeout. If a later
publication, timeout, or caller abort fails, every inode created by that
invocation is rolled back. ZIP and validation file descriptors are explicitly
closed before the staging tree is removed and the writer lock is released.
Cleanup failure is surfaced as a sanitized `cache-write-failed` error rather
than reported as success.

Errors contain only stable codes and generic messages. They never include the
configured origin, response text, a filesystem path, an asset association, or
local state.

## Dependency boundary

The production archive dependency closure is `yauzl@3.4.0 -> pend@1.2.0`.
Both packages are JavaScript-only MIT packages with no install scripts or native
build. Test ZIPs use dev-only `yazl@3.3.1` and `buffer-crc32@1.0.0`; neither is a
runtime dependency.
