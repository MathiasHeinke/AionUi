---
name: plaud-recording-ingest
description: Import PLAUD recordings through the official PLAUD MCP or CLI, download audio through a redacted process boundary, transcribe locally with MLX Whisper, create summaries, decisions and action proposals, and publish approved artifacts into a selected project. Use for PLAUD Note or Note Pro recordings, meeting transcripts, conversation summaries, speaker labels, project notes, follow-up drafts, Gmail draft proposals, and requests to avoid PLAUD AI minutes. German triggers include "PLAUD Aufnahme", "PLAUD Note Pro", "Gespräch transkribieren", "Aufnahme zusammenfassen", "ins Projekt ablegen", and "Mail daraus entwerfen".
---

# PLAUD Recording Ingest

## Outcome

Turn a PLAUD recording into a private, inspectable conversation record:

```text
PLAUD account
  -> official MCP metadata or official CLI
  -> private audio download
  -> local MLX Whisper transcript
  -> approved local or cloud synthesis
  -> selected project artifacts
  -> proposed connector actions
```

Treat PLAUD as the recording source, not as the mandatory transcription or
summary provider. Consume `0` PLAUD AI minutes on the default path.

## Hard boundaries

- Confirm that recording and processing are permitted before processing a
  conversation with other people.
- Use only the official PLAUD MCP, CLI, or SDK. Never reverse engineer private
  endpoints, scrape application storage, or inspect token files.
- Never print or return OAuth tokens, authorization headers, signed audio URLs,
  device serial numbers, or raw private CLI output.
- Never invoke `plaud transcript`, `plaud summary`, MCP `get_transcript`, or MCP
  `get_note` on the default path. Use them only after explicit approval to use
  existing PLAUD generated content.
- Never call MCP `get_file` directly from an online chat model. It returns a
  signed URL plus recording content. Obtain audio through the bundled downloader.
- Keep audio, transcript, speaker processing, synthesis, and project routing
  local by default. Return only redacted receipts to an online chat model until
  the user approves a recording specific content route.
- Never infer real speaker names from voice alone. Keep neutral labels until
  the user maps them.
- Never delete the PLAUD source. Never send mail, publish, create calendar
  events, or write task systems without a separate explicit instruction.

## Workflow

### 1. Preflight the official adapters

Read [references/official-plaud-adapters.md](references/official-plaud-adapters.md).
Run the bundled guard before source access:

```bash
node "<absolute-skill-root>/scripts/plaud-ingest-guard.mjs" status
```

Use these adapter roles:

- official MCP: OAuth, account check, recording browse, search, and selection;
- official CLI: redacted audio acquisition through the bundled downloader;
- PLAUD transcript and note tools: explicit opt-in only, never the local-first
  default.

If the MCP is absent, continue through the captured CLI adapter. If both are
unavailable, report `blocked_capability`. If authentication is missing, ask the
user to complete the official browser login; never request credentials.

### 2. Resolve the recording and project

Treat a unique name, immutable file ID, or phrase such as "the two newest" as
sufficient selection. Avoid repeated confirmation.

Capture only the minimum selection metadata in the redacted receipt:

- immutable PLAUD file ID;
- user-visible name;
- capture time;
- duration.

Resolve the destination independently from recording content:

1. Use the active Command EVE project when one is already selected.
2. Otherwise use an existing saved project mapping.
3. If no mapping exists, ask the user to select an existing project or choose
   local inbox only.

Do not guess a project from private conversation content with an online model.
Read [references/project-and-tool-routing.md](references/project-and-tool-routing.md)
before publishing project artifacts or proposing connector actions.

### 3. Download audio through the safe boundary

Treat `plaud file <id>` and MCP availability flags as hints, not authoritative
proof. A recording is audio-ready when the Web player works or the safe
`plaud audio` wrapper returns and verifies a file. This avoids the observed case
where `plaud file` reported audio unavailable while `plaud audio` succeeded.

Never run `plaud audio <id>` directly in a visible tool call. Run:

```bash
node "<absolute-skill-root>/scripts/plaud-download-audio.mjs" \
  --file-id "<file-id>" \
  --data-root "<fixed-private-data-root>"
```

Require the application or local runtime to provide the existing `0700` data
root. The model must not invent an arbitrary root. Preserve the returned byte
count, SHA-256, detected format, and dedupe result.

Classify `audio_pending` only when the safe downloader cannot obtain audio and
neither Web playback nor another official readiness signal succeeds. Do not use
PLAUD transcription as a workaround.

### 4. Transcribe locally with MLX Whisper

On Apple Silicon outside Command EVE, run the bundled wrapper:

```bash
node "<absolute-skill-root>/scripts/plaud-local-transcribe.mjs" \
  --file-id "<file-id>" \
  --data-root "<fixed-private-data-root>" \
  --language de
```

The wrapper uses `mlx-community/whisper-large-v3-turbo`, produces timestamped
JSON, TXT, SRT, TSV, and VTT artifacts, and returns only a redacted receipt.
It prefers an offline cached package and model. Use `--allow-model-download`
only after the user approves the first local model download.

In Command EVE, prefer the native local speech bridge when it provides equal
or stronger privacy, timestamps, idempotency, and honesty receipts. The bridge
may use the same MLX backend. Never silently fall back to CPU PyTorch Whisper.

Preserve the raw transcript separately from corrected text. Treat diarization
as optional. Silence, noise, music, or uncertain speech must never become a
fabricated transcript claim.

### 5. Create derived artifacts through an approved content route

Read [references/processing-contract.md](references/processing-contract.md)
before writing transcript, summary, decision, question, or action artifacts.

Choose exactly one route for each recording:

- `local`: Command EVE local model or another approved local runtime;
- `cloud_approved`: the user explicitly approves the minimum necessary
  transcript text for a named online model and destination;
- `receipt_only`: create no semantic artifact until a content route is chosen.

Create only requested outputs:

- `summary.md` with timestamp references;
- `decisions.md` with evidence and confidence;
- `open-questions.md`;
- `actions.json` containing proposals, not executed actions;
- optional cleaned or speaker-labelled transcript.

Do not infer owners, recipients, deadlines, or commitments that the recording
did not establish.

### 6. Publish into the selected project

After synthesis, publish only approved artifacts:

```bash
node "<absolute-skill-root>/scripts/plaud-project-publish.mjs" \
  --file-id "<file-id>" \
  --data-root "<fixed-private-data-root>" \
  --project-root "<resolved-project-root>" \
  --captured-at "<ISO-8601>"
```

The default project location is `docs/conversations/<date>/<file-id>/`. It is
inside the selected project and makes approved conversation knowledge visible
through the existing project documentation surface. Command EVE stores its
machine receipts under `.command-eve/receipts`; never introduce a parallel
`.eve` namespace. Use `--relative-dir` only for an existing user-approved
project convention. Use `--include-transcript` only when the user wants the
transcript copied into the project; private source audio remains in application
storage.

Publish idempotently by PLAUD file ID plus artifact SHA-256. A retry must not
duplicate project notes or action proposals.

### 7. Route follow-up tools through proposals and HumanGates

Treat `actions.json` as a proposal queue. Examples include:

- `task.create` for a project task;
- `gmail.draft` for a proposed email draft;
- `calendar.draft` for a proposed event;
- `project.note` for another project artifact.

Use a connected tool only after the user requests that action. For Gmail,
create a draft first, show recipient, subject, and body for approval, and never
send implicitly. Pass only the minimum approved artifact to the connector.

### 8. Finish with a redacted receipt

Report:

- selected recording and immutable file ID;
- audio readiness, bytes, SHA-256, and dedupe result;
- transcription provider, model, language, segment count, and artifact paths;
- speaker status;
- synthesis route and produced project artifacts;
- proposed connector actions and their approval state;
- PLAUD AI minutes consumed, normally `0`;
- explicit blockers or next approval.

Never include transcript or summary content in the completion receipt unless
the selected content route authorizes it.

## Command EVE packaging

Read [references/command-eve-integration.md](references/command-eve-integration.md)
before claiming native product support. Package the complete skill tree and
fail closed when a catalog-required file is absent. A source adapter alone is
not the product: the product is a project-aware conversation inbox with local
processing and gated follow-up actions.
