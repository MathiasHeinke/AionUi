# Command EVE Built-in Integration Contract

This file defines the minimum product behavior required before Command EVE claims native PLAUD recording support.

## Product shape

Implement a general conversation inbox. PLAUD is the first source adapter; local transcription, speaker processing, synthesis, search, and action proposals remain reusable processors. Do not build a separate PLAUD desktop application.

The default path is:

```text
PLAUD cloud sync
  -> official OAuth source adapter
  -> private audio staging
  -> local speech-to-text
  -> optional local speaker assignment
  -> local or explicitly approved synthesis
  -> Command EVE conversation artifacts
```

Direct iPhone attachment or direct device transport is not required for the first version. A future official embedded SDK may add a device-local adapter behind the same source interface.

## Security and privacy invariants

- Use the official PLAUD CLI or official SDK. Do not ship a reverse-engineered API client.
- Pin and verify the managed official CLI version. Disable its telemetry with `PLAUD_TELEMETRY_DISABLED=1` and `DO_NOT_TRACK=1` for every non-login subprocess.
- Keep OAuth user-controlled. Never bundle PLAUD tokens, model provider keys, or signed audio URLs in the application artifact.
- Never surface the output of `plaud audio` in renderer logs, diagnostics, telemetry, crash reports, or chat history.
- Keep source audio and transcripts local by default.
- Require an explicit route decision before any cloud model receives audio or transcript content.
- Keep the connector, download, local speech-to-text, diarization, and local synthesis behind a native content firewall. If EVE's active chat model is online, its tool result may contain only redacted status, hashes, counts, and approved artifact references until the user grants a recording-specific route approval.
- Keep raw `plaud me`, `plaud files`, and `plaud file` output out of renderer logs, telemetry, crash reports, and cloud-model context. Render selection metadata through the private local UI.
- Store every recording directory as `0700` and every audio, transcript, manifest, summary, action, and receipt file as `0600`; use exclusive atomic writes and reject symlink targets.
- Treat consent as a visible human gate for recordings containing other people.
- Never call PLAUD transcript or summary endpoints automatically.
- Never delete a source recording automatically.

## Runtime behavior

Expose these states in the UI and runtime receipt:

- connect PLAUD
- recording discovered
- waiting for audio synchronization
- downloading privately
- transcribing locally
- assigning speakers, optional
- summarizing locally or through an approved route
- ready
- blocked with a concrete recovery action

Use PLAUD file ID plus SHA-256 for idempotency. A retry must not create duplicate recordings or duplicate proposed actions.

Use Command EVE's native local speech-to-text bridge rather than adding a second transcription stack. Extend that bridge to retain segments and timestamps where needed. Speaker assignment must be feature-detected and may remain explicitly unavailable in the first build.

## Built-in skill packaging

- Bundle `plaud-recording-ingest` in the default skill catalog.
- The portable source follows the standard Agent Skills frontmatter. In the Company.OS authoring copy, add EVE's package-specific `linked_files` entries for both references and the downloader, or extend the EVE hygiene parser to read equivalent metadata; packaging must fail closed if any of the three files is missing.
- Make it discoverable from German and English requests about PLAUD recordings, meeting transcription, conversation summaries, speaker labels, and action extraction.
- Preserve this skill's safe download wrapper or implement an equivalent native process boundary that never logs the signed URL.
- Resolve bundled scripts from the installed skill directory. Never depend on the current working directory or the developer-global skill path.
- Pass a fixed Command EVE application-data root to the downloader. The model must never choose an arbitrary filesystem root.
- Treat the official CLI as a managed or first-use dependency with a clear authentication state. Do not assume the developer's global installation exists on a clean customer machine.
- Keep user data outside the signed application bundle and set private filesystem permissions.
- Include the skill and its references in clean-install packaging tests, not only development mode.

## Acceptance checks

1. A clean install discovers and can invoke the built-in skill.
2. An unauthenticated user receives a bounded connect flow without secret prompts or token logging.
3. An audio-ready fixture downloads through a redacted process boundary and records SHA-256.
4. An audio-pending fixture remains retryable and does not start PLAUD AI processing.
5. A repeated import is idempotent.
6. Local speech-to-text produces a timestamped artifact or a truthful capability blocker.
7. Speaker assignment is truthful: local labels when supported, an explicit limitation when not.
8. Cloud routing is denied by default and requires an explicit approved policy.
9. No signed URL, OAuth token, or provider key appears in renderer logs, telemetry, receipts, or the packaged application.
10. The completion receipt reports PLAUD AI minutes consumed; the default path reports `0`.
11. With an online chat model active, audio and transcript can be processed locally without any content entering model context before explicit route approval.
12. PLAUD CLI subprocesses prove telemetry opt-out and receive a sanitized environment rather than the application's complete secret-bearing environment.

Do not call the feature shipped merely because the skill files exist. The release claim requires packaging proof plus a clean-install smoke run.
