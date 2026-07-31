# Command EVE Built-in Integration Contract

Use this contract before Command EVE claims native PLAUD support.

## Product shape

Build a project-aware conversation inbox. PLAUD is one official source
adapter. Download, local transcription, optional speaker processing,
synthesis, project projection, search, and action proposals remain reusable
processors.

```text
Official PLAUD MCP or CLI
  -> native content firewall
  -> private audio staging
  -> asynchronous local MLX speech processing
  -> optional local speaker processing
  -> local or explicitly approved synthesis
  -> active project conversation artifacts
  -> HumanGate action proposals
```

Do not build a separate PLAUD desktop clone. Direct iPhone attachment is not
required for the first product version.

## Managed official adapters

- Manage and pin `@plaud-ai/mcp` and `@plaud-ai/cli`; do not use `@latest` in
  a shipped runtime.
- Use the MCP for OAuth, account state, browse, search, and selection.
- Use the CLI downloader or an equivalent native boundary for audio so signed
  URLs never enter renderer, agent, telemetry, diagnostics, or crash logs.
- Do not expose raw MCP `get_file`, `get_note`, or `get_transcript` to an online
  chat model on the default path.
- Do not ship the official broad export or follow-up skills without an
  independent safety review. EVE's local-first skill controls the workflow.
- Treat MCP and CLI authentication as separate capabilities. Keep OAuth
  user-controlled and never bundle tokens.
- Set `PLAUD_TELEMETRY_DISABLED=1` and `DO_NOT_TRACK=1` on every non-login CLI
  subprocess.

## Privacy and filesystem invariants

- Keep source audio and transcripts local by default.
- Require a recording specific route decision before any cloud model receives
  audio or transcript content.
- Return only redacted status, hashes, counts, and approved artifact references
  through the content firewall.
- Keep every recording and project conversation directory `0700`; keep every
  file `0600`; use exclusive atomic writes and reject symlink targets.
- Use PLAUD file ID plus SHA-256 for idempotency.
- Treat consent as a visible HumanGate for recordings containing other people.
- Never invoke PLAUD transcript or summary automatically.
- Never delete a source recording automatically.

## Audio readiness

Do not rely on one metadata flag. The safe audio downloader is authoritative.
The verified field observation on 2026-07-29 was that `plaud file` could report
audio unavailable while Web playback and `plaud audio` both succeeded.

Expose these states:

- connect PLAUD;
- recording discovered;
- waiting for verified audio;
- downloading privately;
- transcribing locally;
- assigning speakers, optional;
- synthesizing locally or through an approved route;
- publishing into a selected project;
- waiting for action approval;
- ready;
- blocked with a concrete recovery action.

## MLX Whisper runtime

Use the native asynchronous speech bridge and prefer MLX Whisper on Apple
Silicon with `mlx-community/whisper-large-v3-turbo`. Persist progress across
navigation and restart. Preserve segments and timestamps. Never silently fall
back to CPU PyTorch Whisper.

The current Command EVE baseline uses `faster-whisper` for short local speech
and does not return timestamp segments. It is not equivalent to this long-form
contract. Until a main-process MLX bridge meets the contract, invoke the
bundled standalone wrapper behind the content firewall and report the managed
runtime capability honestly.

Feature-detect speaker processing. A transcript without reliable speaker
mapping is valid when the limitation is explicit.

## Project integration

Resolve the active seat and active project before projection. The main process
must derive and immediately revalidate the seat-scoped project root from the
trusted project runtime snapshot. Never accept a model-selected root or an
unattested renderer path. Pass only that trusted root to the publisher. Default
to:

```text
<project-root>/docs/conversations/<date>/<plaud-file-id>/
```

Render the project artifacts in EVE's ordinary project surface:

- recording identity and provenance;
- summary;
- decisions;
- open questions;
- action proposals;
- optional transcript.

Keep audio in application storage and connector receipts under
`.command-eve/receipts`. Never add a parallel `.eve` project namespace. A retry
must not duplicate project files or actions. Project selection may be proposed
locally but must not be guessed from private content by an online model.

## Connector integration

Treat `actions.json` as a proposal queue. Resolve capabilities through the
normal connector registry and HumanGate policy.

For Gmail:

1. produce a local evidence-grounded email artifact;
2. confirm recipients, subject, and body;
3. create a Gmail draft only after explicit approval;
4. send only after a separate explicit send instruction;
5. record a redacted connector receipt in the project.

The current Command EVE Google Workspace capability covers Calendar and Drive,
not Gmail. Until Gmail is actually registered and preflighted, retain the local
mail artifact and return `blocked_connector`; do not claim that a Gmail draft
was created.

Apply the same separation to tasks, calendar, CRM, Slack, Notion, and custom
webhooks. Missing connectors produce `blocked_connector`, not a data-route
fallback.

## Built-in skill packaging

- Bundle the complete `plaud-recording-ingest` tree in the default catalog.
- Preserve standard Agent Skills frontmatter with only `name` and
  `description`. Inject EVE specific invocation metadata only into the staged
  bundled copy. Keep required file checks in packager metadata and fail closed
  when any referenced file is absent.
- Resolve scripts from the installed skill directory, never the developer
  global path or current working directory.
- Pass a fixed Command EVE application data root to private processors.
- Keep user data outside the signed application bundle.
- Maintain a catalog-owned required-file list for the four references and four
  production scripts. Do not put non-standard `linked_files` frontmatter into
  the portable skill.
- Include the skill, references, scripts, managed dependency versions, and
  project projection in clean-install packaging tests.

## Acceptance checks

1. A clean install discovers and invokes the built-in skill.
2. Official MCP browse and login work through a scoped adapter.
3. Unauthenticated states recover without secret prompts or token logging.
4. An audio-ready fixture downloads through a redacted boundary and records
   SHA-256.
5. A false-negative metadata fixture still downloads when `plaud audio`
   succeeds.
6. An audio-pending fixture remains retryable without PLAUD AI processing.
7. Repeated imports are idempotent.
8. Apple Silicon uses MLX Whisper and creates timestamped artifacts.
9. Silence, noise-only, music, clean speech, and distant multi-speaker fixtures
   produce claim-correct outcomes.
10. Speaker status is truthful and never invents names.
11. Online chat models receive no content before explicit route approval.
12. The active project receives approved summary, decision, question, and
    action artifacts without source audio duplication.
13. A second project cannot read the first project's recording artifacts.
14. Gmail integration creates no draft without approval and never sends
    without a separate send instruction.
15. No signed URL, token, serial number, transcript, or recording content
    appears in logs, telemetry, receipts, Linear, or the package.
16. The completion receipt reports PLAUD AI minutes consumed; default is `0`.

Do not call the feature shipped merely because skill files exist. Require
packaging proof, clean-install smoke, real local transcription evidence,
project isolation evidence, and connector HumanGate evidence.
