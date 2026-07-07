---
name: video-first-content-engine
description: Turn raw video capture into gated YouTube, clips, social posts and article packages — without public publishing in the first release slice. Produces local draft-only packages: intake → media preflight → transcript + segmentation → risk/claim safety classification → editorial packager → publisher dry-run. Setup command creates the full local drop-folder structure. Use when the operator says "set up a video content engine", "turn raw videos into YouTube clips posts and articles", "create a publish package from this recording", or wants to run a video-first content operation for themselves or a client.
---

# Video-First Content Engine

The Video-First Content Engine supports founder-led and expert-led video content
as a reusable CMO department pack. It starts as draft-only and dry-run only: raw
videos may be processed into local packages, but **no upload, schedule, social
post, email send, spend, production write or Done transition** is allowed without
the relevant HumanGate release.

The operating rule: **Capture freely. Publishing is gated.**

## When to use

- "Set up a video content engine", "turn raw videos into YouTube clips posts and articles"
- "Start the video-first content department", "create a publish package from this recording"
- After content-machine has established source inventory and founder voice
- For a client seat (per-client install): run content-machine first, then video-engine

## The method

### 0. Founder Intake

Ask only for missing fields; summarize after at most three questions.

**Required to start:** company, offer, buyer, primary audience, approved capture
folder / local target root, allowed public channels (YouTube, LinkedIn, X, blog,
newsletter or internal), approval owner for HG-2/HG-2.5/HG-3/HG-4, claim classes
that are off-limits, privacy constraints (screens, customers, family, finance,
health, legal, partner data, secrets, private communications), publishing cadence
goal, success signal (watch time, clips, post quality, leads, community replies,
internal reuse).

### 1. Inbox — Operator Drops Raw Video

The operator places raw video into `01_inbox_raw/`. Nothing processes until the
operator puts it there.

### 2. Intake and Media Preflight

Create a run manifest without mutating the raw file. Verify file integrity,
duration, format, and that the source file exists and is readable.

### 3. Media Processor

Create local working copies, audio normalization notes and optional clip files.
Use ffmpeg for metadata, trim, normalize and clip commands after preflight.

### 4. Transcript and Segmenter

Create timestamped transcript, chapters, topics, hooks and clip candidates.
Each segment gets a topic label, hook potential score and clip viability.

### 5. Risk and Claim Safety

Classify every segment into HG-1/HG-2/HG-3/HG-4. Move unsafe packages to
`03_review_required/`. No editorial package without a completed risk report.

### 6. Editorial Packager

Create YouTube metadata (title, description, tags, thumbnail brief),
LinkedIn/X post drafts, blog/article draft, and thumbnail/frame brief.

### 7. Publisher Adapter Dry-Run

Validate payload shape only. Never upload, schedule or post. Produce a
dry-run report showing what would be sent, to which channel, with which
metadata.

### 8. CAO/Controller Evaluator

Check artifact truth, gates, risk routing and learning proposals. Produce
a PASS/REJECT/PARK report.

### 9. CEO/Codex Decision

Decide release, revise, park or escalate. Only at HG-2.5+ does anything
reach a real publisher.

## Folder Surface

The setup command creates:

```
content/video-engine/
  01_inbox_raw/
  02_processing/
  03_review_required/
  04_publish_ready/
  05_clips/
  06_reports/
  07_archive/
  RUNBOOK.md
  video-engine.config.json
```

`01_inbox_raw/` is the only folder where the operator drops raw videos. The
start command does not read or process videos — it only creates the safe working
surface and configuration.

Setup command (dry-run first):

```bash
node scripts/content/video-first-content-engine-start.mjs \
  --root ${CLIENT_ROOT} \
  --company "Client Name" \
  --approval-owner "Founder" \
  --write \
  --json
```

## Output Shape

Deliver: the **intake summary** (confirmed channels, privacy constraints,
approval chain), the **folder surface** (created or planned), a **first dry-run
package** (transcript + segments + risk report + editorial drafts), and the
**next step** (CAO review or CEO decision).

## Skill-Specific Safety Rules

Shared non-negotiables live in `eve-doctrine`; this section only lists skill-specific boundaries.

- **Media integrity.** Never mutate the raw file. All processing works on local
  copies inside `02_processing/`.
- **Transcript before editorial.** No YouTube metadata, social post or blog draft
  without a completed, timestamped transcript.
- **Risk before publish.** No segment reaches an editorial package without a
  completed risk/claim classification.
- **Dry-run only.** Publisher adapters validate payload shape only. Never upload,
  schedule or post.
- **Never publish.** Publishing is a separate human-gated step.
- **Per-client isolation.** If running for a client seat, use only that client's
  video assets, privacy constraints and channels. Never bleed across clients.
- **HumanGates:** HG-1 (normal build log, general commentary), HG-2 (mild product
  demo, business commentary — still draft/dry-run), HG-2.5 (CEO release card
  before any external upload), HG-3 (health, legal, financial, customer, private
  screen), HG-4 (medical recommendations, third-party private data, strategic
  channel decisions).
