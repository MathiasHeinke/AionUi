---
name: plaud-recording-ingest
description: Import and process PLAUD recordings through the official PLAUD CLI with local-first transcription, optional speaker assignment, summaries, and action extraction. Use when a user asks to find, download, transcribe, diarize, summarize, archive, or extract tasks from a PLAUD Note recording, especially when they want to avoid consuming PLAUD AI transcription or summary minutes. German triggers include "PLAUD Aufnahme", "PLAUD Note Pro", "Gespräch transkribieren", "Sprecher zuweisen", and "Aufnahme zusammenfassen".
linked_files:
  - references/processing-contract.md
  - references/command-eve-integration.md
  - scripts/plaud-download-audio.mjs
  - scripts/plaud-ingest-guard.mjs
---

# PLAUD Recording Ingest

## Purpose

Turn a PLAUD recording into inspectable local artifacts while using PLAUD only as the recording source. Default to local speech processing and do not consume PLAUD AI transcription or summary minutes unless the user explicitly requests those services.

Use the official PLAUD CLI or a future official PLAUD SDK. Do not reverse engineer private endpoints, scrape app storage, or claim direct hardware access that has not been proven.

## Non-negotiable boundaries

- Treat recording consent as a human gate. Before processing conversations with other people, confirm that recording and processing are permitted for the intended context.
- Never print, quote, persist in logs, or send OAuth tokens, authorization headers, signed audio URLs, or CLI token files.
- Disable PLAUD CLI telemetry for every non-login subprocess with both `PLAUD_TELEMETRY_DISABLED=1` and `DO_NOT_TRACK=1`.
- Never invoke `plaud transcript` or `plaud summary` implicitly. Those commands may consume the user's PLAUD allowance.
- Default transcription, speaker processing, summarization, and action extraction to a local process boundary. When the active chat model is online, do not return audio, transcript, summary, or action content into its context without an explicit data-route approval for that recording.
- Route audio or transcripts to an online model only after explicit approval for that recording or an already active user policy that clearly permits it.
- Do not delete the PLAUD source recording. Do not send messages, create calendar events, update memory, or write task systems without a separate explicit instruction.
- Do not infer real speaker names from voice alone. Use neutral labels until the user maps them.

## Workflow

### 1. Resolve the requested recording

Clarify only when selection is genuinely ambiguous. Phrases such as "die neueste Aufnahme" or a unique title are sufficient.

1. Run the bundled guard before any source command:

   ```bash
   node "<absolute-skill-root>/scripts/plaud-ingest-guard.mjs" status
   ```

   `blocked_capability` means the pinned official CLI is unavailable; `blocked_auth` means the user must complete `plaud login`. Never request or handle their password.

2. Verify authentication only through the guard's captured subprocess. Do not run `plaud me` in a visible agent tool call because it prints user fields.
3. List candidates only through Command EVE's private local source adapter. Raw `plaud files`, `plaud recent`, `plaud search`, `plaud file`, and `plaud me` output must never enter a model tool result. If that adapter is unavailable, report `blocked_capability` instead of running the raw command through chat.
4. Show recording metadata only in the private local UI; do not put the raw CLI table into cloud-model context or telemetry.
5. Record the immutable PLAUD file ID, title, capture time, and duration inside the private recording manifest.

The iPhone does not need to be attached when the recording has already synchronized to the user's PLAUD account. If it has not synchronized, report that state instead of guessing at direct iPhone access.

### 2. Check audio readiness

Inspect the selected item with a captured local `plaud file <file_id>` subprocess. Its raw output contains private recording metadata and must remain outside telemetry and cloud-model context.

- If audio is ready, continue.
- If the recording exists but audio is not ready, classify it as `audio_pending`. Ask the user to let the PLAUD app finish synchronization or retry later.
- Do not treat `audio_pending` as a missing or corrupt recording.
- Do not trigger PLAUD's transcription service as a workaround.

### 3. Download without exposing the signed URL

Never run `plaud audio <file_id>` directly in a visible tool call because its output is a signed download URL.

Use the bundled safe wrapper:

```bash
node "<absolute-skill-root>/scripts/plaud-download-audio.mjs" \
  --file-id "<file_id>" \
  --data-root "<absolute-existing-private-data-root>"
```

Resolve the script path relative to this `SKILL.md`; do not assume the current working directory is the skill directory. Create the trusted data root through the local application storage API before invocation and set it to `0700`. The wrapper rejects a symlink root, creates contained private recording directories, derives the filename only from the validated PLAUD file ID, reuses an existing verified artifact idempotently, writes atomically as `0600`, disables CLI telemetry, pins each public HTTPS request to the DNS address it validated, checks audio magic bytes, returns only redacted metadata, and never prints the signed URL.

After download:

1. Verify the byte count is nonzero.
2. Preserve the returned SHA-256 digest.
3. Detect the real media type with `ffprobe` or `file`; do not trust the extension.
4. Dedupe by PLAUD file ID plus SHA-256 before processing again.

### 4. Transcribe locally

In Command EVE, use its native local speech-to-text bridge behind the content firewall. Outside Command EVE, use the installed local `faster-whisper` or Whisper runtime.

- Select the configured long-form quality profile. Do not silently fall back to a tiny model when accuracy matters.
- Preserve segment timestamps and detected language whenever the runtime exposes them.
- Keep the raw model transcript separate from corrected or formatted text.
- If no local runtime is available, report the missing capability and ask before using an online service. Do not read the transcript into an online agent merely to ask that question.
- If transcription fails, preserve the verified audio and set a failure state. Never fabricate transcript text.

### 5. Assign speakers only when supported

Speaker assignment is optional and must remain evidence-based.

- Prefer a local diarization runtime when available.
- Otherwise keep `SPEAKER_00`, `SPEAKER_01`, and similar neutral labels.
- Ask the user to map labels to names when useful.
- Keep uncertain or overlapping segments marked as uncertain.
- A transcript without reliable speaker assignment is still a valid result; state the limitation plainly.

### 6. Produce derived artifacts

Read [references/processing-contract.md](references/processing-contract.md) before writing artifacts.

Produce only the artifacts requested by the user. Supported outputs include:

- timestamped raw transcript
- cleaned transcript
- speaker-labelled transcript
- concise summary
- decisions and open questions
- proposed actions with owner and due date only when evidenced
- searchable recording manifest

Use a local model by default. When the user permits cloud inference, record the exact approved artifact and destination, then send the minimum necessary text rather than raw audio whenever possible.

### 7. Finalize safely

1. Write the processing manifest and model provenance.
2. Confirm which steps were local and which, if any, used a cloud service.
3. Report whether any PLAUD AI minutes were consumed.
4. Remove partial files and signed URL material from temporary state.
5. Retain or remove the local raw audio according to the user's retention policy; never delete the PLAUD source.
6. Offer proposed next actions without executing external side effects.

## Command EVE product integration

When packaging this capability as a built-in Command EVE skill, read [references/command-eve-integration.md](references/command-eve-integration.md). The user-facing abstraction is a conversation inbox with PLAUD as one source adapter, not a separate PLAUD clone.

## Completion report

Return a compact report containing:

- selected recording and PLAUD file ID
- audio readiness and local artifact paths
- transcript, speaker, summary, and action status
- local and online models used
- SHA-256 and dedupe result
- PLAUD AI minutes consumed, normally `0`
- unresolved limitations or explicit next approval needed
