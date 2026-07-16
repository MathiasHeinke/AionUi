# PLAUD Processing Contract

Use this contract for durable, inspectable output. Keep source audio, transcript, corrected text, and synthesis as distinct layers so later model changes never overwrite source truth.

## Processing states

Use one of these stable states:

- `discovered`: recording metadata found
- `audio_pending`: recording exists but synchronized audio is not ready
- `downloaded`: audio downloaded and hashed
- `transcribed`: local transcript produced
- `speaker_partial`: speaker labels exist but are not fully mapped or reliable
- `synthesized`: requested summaries or actions produced
- `complete`: all requested outputs verified
- `blocked_auth`: official PLAUD authentication missing or expired
- `blocked_capability`: required local processor unavailable
- `failed`: a processing step failed and evidence is retained

## Manifest

Write one JSON manifest per recording. Use ISO 8601 timestamps and absolute artifact paths.

Every recording directory must be `0700`. Every manifest, transcript, summary, action file, receipt, and audio file must be `0600`. Write to an exclusive temporary file inside the same private directory, flush it, validate it, and publish it atomically without overwriting an existing path. Reject symlinks and derive internal filenames from the validated PLAUD file ID, not from recording titles.

```json
{
  "schema_version": 1,
  "source": "plaud",
  "source_file_id": "immutable-plaud-file-id",
  "title": "User-visible recording title",
  "captured_at": "2026-01-01T12:00:00Z",
  "duration_seconds": 0,
  "processing_state": "complete",
  "audio": {
    "path": "/private/path/recording.audio",
    "sha256": "hex-digest",
    "bytes": 0,
    "detected_format": "audio/mpeg",
    "retention": "retain"
  },
  "consent": {
    "status": "confirmed",
    "note": "User-confirmed basis without private details"
  },
  "transcription": {
    "provider": "local",
    "model": "configured-model",
    "language": "de",
    "raw_path": "/private/path/transcript.raw.json",
    "clean_path": "/private/path/transcript.md",
    "timestamps": true
  },
  "speakers": {
    "status": "unmapped",
    "provider": "local-or-none",
    "labels": ["SPEAKER_00"]
  },
  "synthesis": {
    "provider": "local",
    "model": "configured-model",
    "summary_path": "/private/path/summary.md",
    "actions_path": "/private/path/actions.json"
  },
  "plaud_ai_minutes_consumed": 0,
  "created_at": "2026-01-01T12:05:00Z",
  "updated_at": "2026-01-01T12:10:00Z"
}
```

Omit unavailable optional paths rather than inventing values. Never put tokens, authorization headers, signed URLs, or raw credentials in the manifest.

Do not put transcript or synthesis content into a tool result by default. The local processor should return a redacted receipt containing state, hashes, counts, and private artifact references. Content may enter an online model context only after a recorded, recording-specific data-route approval.

## Transcript layers

Keep these layers separate:

1. `transcript.raw.json`: exact model segments, timestamps, confidence when available, and neutral speaker labels.
2. `transcript.md`: light formatting and obvious punctuation corrections only.
3. `summary.md`: derived interpretation with links back to timestamps.
4. `actions.json`: proposals only, each with evidence and confidence.

Never silently rewrite the raw transcript. Mark uncertain words with an explicit uncertainty token or timestamped note.

## Action proposal schema

```json
{
  "action": "Proposed action in plain language",
  "owner": null,
  "due_at": null,
  "evidence": {
    "start_seconds": 0,
    "end_seconds": 0,
    "excerpt": "Short supporting paraphrase"
  },
  "confidence": "high",
  "external_write_status": "not_requested"
}
```

Do not infer an owner or deadline when the conversation did not establish one. Do not execute the proposal unless the user separately asks for that external write.

## Dedupe and retention

- Treat PLAUD file ID plus SHA-256 as the recording identity.
- If both match an existing complete manifest, reuse the artifacts unless the user asks for reprocessing with a new model.
- If the file ID matches but SHA-256 differs, stop and surface the mismatch.
- Keep partial downloads only until failure handling completes, then remove them.
- Keep verified raw audio until all requested outputs pass inspection, then follow the user's retention policy.
- Never delete the source recording from PLAUD as part of this workflow.
