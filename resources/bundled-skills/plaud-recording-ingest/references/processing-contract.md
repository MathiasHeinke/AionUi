# PLAUD Processing Contract

Use this contract for durable, inspectable output. Keep source audio, model
transcript, corrected text, synthesis, project projection, and connector action
as separate layers.

## Stable states

- `discovered`: recording metadata found
- `audio_pending`: official source found but verified audio is not yet available
- `downloaded`: audio downloaded and hashed
- `transcribed`: local transcript produced
- `speaker_partial`: neutral speaker labels exist but are not fully mapped
- `synthesized`: requested semantic artifacts produced
- `projected`: approved artifacts published into a selected project
- `actions_proposed`: external actions exist as unexecuted proposals
- `complete`: every requested output verified
- `blocked_auth`: official PLAUD authentication missing or expired
- `blocked_capability`: required local processor unavailable
- `blocked_connector`: requested destination tool unavailable
- `failed`: a processing step failed and evidence is retained

## Private storage

Use `0700` for every recording and project conversation directory. Use `0600`
for audio, manifest, transcript, summary, decision, action, receipt, and log
files. Write through an exclusive temporary file in the same directory, flush
it, validate it, and publish it atomically without overwriting a different
artifact. Reject symlinks and derive internal names from the validated PLAUD
file ID, never the recording title.

## Recording manifest

Write one `manifest.json` per private recording. Use ISO 8601 timestamps and
absolute private artifact paths. Never include credentials or signed URLs.

```json
{
  "schema_version": 2,
  "source": "plaud",
  "source_adapter": "official-cli",
  "source_file_id": "immutable-plaud-file-id",
  "title": "User-visible recording title",
  "captured_at": "2026-01-01T12:00:00Z",
  "duration_seconds": 0,
  "processing_state": "projected",
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
  "content_route": {
    "mode": "local",
    "approved_artifact": null,
    "destination": null,
    "approved_at": null
  },
  "transcription": {
    "provider": "mlx-whisper",
    "model": "mlx-community/whisper-large-v3-turbo",
    "language": "de",
    "raw_path": "/private/path/transcription/transcript.raw.json",
    "text_path": "/private/path/transcription/transcript.txt",
    "timestamps": true,
    "segments": 0
  },
  "speakers": {
    "status": "unmapped",
    "provider": "none",
    "labels": []
  },
  "synthesis": {
    "provider": "local",
    "model": "configured-local-model",
    "summary_path": "/private/path/summary.md",
    "decisions_path": "/private/path/decisions.md",
    "questions_path": "/private/path/open-questions.md",
    "actions_path": "/private/path/actions.json"
  },
  "project_projection": {
    "project_id": "selected-project",
    "project_root": "/selected/project",
    "destination": "/selected/project/docs/conversations/2026-01-01/id",
    "artifact_hashes": {}
  },
  "plaud_ai_minutes_consumed": 0,
  "created_at": "2026-01-01T12:05:00Z",
  "updated_at": "2026-01-01T12:10:00Z"
}
```

Omit unavailable optional paths instead of inventing values.

## Transcript layers

Keep these layers separate:

1. `transcript.raw.json`: exact model segments and timestamps.
2. `transcript.txt`: plain model text, not silently corrected.
3. `transcript.cleaned.md`: optional light corrections with provenance.
4. `transcript.speakers.md`: optional neutral speaker labels.
5. `summary.md`: derived interpretation with timestamp references.
6. `decisions.md`: decisions, evidence, confidence, and unresolved ambiguity.
7. `open-questions.md`: questions not resolved in the recording.
8. `actions.json`: proposals only.

Never silently rewrite the raw transcript. Mark uncertain words or regions
explicitly.

## Action proposal schema

```json
{
  "id": "stable-local-id",
  "kind": "task.create",
  "status": "proposed",
  "payload": {
    "title": "Proposed action in plain language",
    "owner": null,
    "due_at": null
  },
  "evidence": {
    "start_seconds": 0,
    "end_seconds": 0,
    "excerpt": "Short supporting paraphrase",
    "confidence": "high"
  },
  "external_write_status": "not_requested"
}
```

Do not infer an owner, recipient, or deadline when the recording did not
establish one. Do not execute a proposal without a separate explicit request.

## Model and context boundary

The local processor may read private content and write private artifacts. An
online agent tool result must contain only a redacted receipt with state,
hashes, counts, model provenance, and artifact references until the recording
specific content route is approved.

Never put transcript or synthesis content into logs, telemetry, Plane, Linear,
or an online model context by default.

## Dedupe and retention

- Treat PLAUD file ID plus audio SHA-256 as source identity.
- Treat destination path plus artifact SHA-256 as project projection identity.
- Reuse matching artifacts idempotently.
- If a file ID matches but audio SHA-256 differs, stop and surface the mismatch.
- Keep verified audio until all requested outputs pass inspection, then follow
  the user's retention policy.
- Never delete the PLAUD source automatically.
- Never copy source audio into a project unless explicitly requested.
