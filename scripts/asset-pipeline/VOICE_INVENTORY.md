# Voice candidate inventory

Inventory date: 2026-07-16. This was a read-only scan of
`/home/ted-h/voice-lab/video-mvp/`. Counts describe candidates, not approved
TokenMonster voice assets. No audio was copied and no spoken text was recorded
here.

## Structured reaction bank

- `/home/ted-h/voice-lab/video-mvp/audio_react/host_reactions_manifest.json`
  has schema number `1`, 24 keyed rows, and persona/tag keys such as
  `chatgpt/intro0`. Rows include persona, audio object path, SHA-256, byte size,
  duration, route, policy fingerprints, and source/acceptance metadata. The
  row format also contains caption/spoken fields, which must not be copied into
  TokenMonster's content-blind telemetry or build reports.
- `/home/ted-h/voice-lab/video-mvp/audio_react/objects/` contains 29
  content-addressed WAV files named `<sha256>.wav`. The 24 rows reference 20
  unique objects, leaving nine objects outside the current manifest; repeated
  references and unreferenced objects need an owner-side disposition before
  selection.
- `/home/ted-h/voice-lab/video-mvp/audio_react/.staging/` contains an incomplete
  Claude-named candidate. Staging and lock files are not release candidates.

This is the closest format match for the planned TokenMonster voice manifest,
but its row schema is not directly compatible: TokenMonster still needs stable
line IDs, one of the three state triggers, and integer `durationMs` values.

## Persona-named audio banks

- `/home/ted-h/voice-lab/video-mvp/audio_peer_302/objects/` contains 55 WAV
  candidates with persona embedded in each filename: ChatGPT 11, Claude 1,
  Gemini 26, and Grok 17. Names include scene/turn and hash material but are not
  pure `<sha256>.wav` object names. No adjacent manifest was found at the first
  two levels.
- `/home/ted-h/voice-lab/video-mvp/audio_reel5_302/` contains 18 top-level WAV
  files: ChatGPT 5, Claude 5, Gemini 3, and Grok 5. Its `sent/` subdirectory
  contains another 46 segmented WAV files: ChatGPT 13, Claude 13, Gemini 9, and
  Grok 11. `spoken.json`, `swaps_302.json`, `timing_302.json`, and viseme JSON
  files provide reel-specific coordination metadata rather than a reusable,
  content-addressed voice manifest. Hidden `.turn-*` directories are generation
  workspaces and should be excluded.

The scan found no persona-named voice candidates for DeepSeek, Qwen, Mistral,
Venice, Sakana, or Perplexity at these top levels. Generic host, music, SFX,
slow-audio, probe, and reel output directories exist but are not mapped to the
ten-character roster and were not counted as v1 character lines.

## Selection notes

Before any voice line is adopted, the owner should confirm voice and content
rights, brand review, state-trigger semantics, the intended current object for
each row, and whether unreferenced or generated-workspace files are rejects.
The v1 asset builder therefore emits `voice: []`.
