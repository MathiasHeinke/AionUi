---
name: blog-publishing-lane
description: The human-gated publishing pipeline that takes approved content from content-machine (anchor drafts, derivatives, release packets) and distributes it through upload-post.com to blog, LinkedIn, X and newsletter channels. Produces: content audit → quality gate → Upload-Post payload → remote preflight → review queue → metrics harvest. NEVER publishes without explicit operator approval. Use when the operator says "publish this article", "schedule this post", "put this into the content calendar", "run the morning-after audit", or after content-machine or video-engine produced a release packet.
---

# Blog Publishing Lane

The Blog Publishing Lane is the **distribution layer** that connects content
production (content-machine, video-first-content-engine, blog-writer) to real
publishing channels via upload-post.com. It does not write content — it gates,
packages, distributes and audits it.

The operating rule: **Produce freely. Publish only on explicit approval.**

## When to use

- "Publish this article", "schedule this LinkedIn post", "put this into the calendar"
- "Run the morning-after audit" on yesterday's published content
- After content-machine or blog-writer produced a release packet that needs distribution
- For recurring daily/weekly publishing cadence
- For a client seat: this is the lane that makes content real — always gated

## Prerequisites

Before running this lane, confirm:

1. **Content is ready.** An anchor draft or derivative exists and has passed
   council review (≥8.5/10 for blog, ≥8/10 for social).
2. **Operator has approved the release.** Explicit yes — not implied.
3. **Upload-Post profile is configured.** Profile name, timezone, channels and
   review-queue settings are set in the content-pipeline config.
4. **Claim safety pass completed.** No unverified claims, no regulated-domain
   statements without disclaimer, no competitor disparagement.

## The method

### 1. Content Audit

Before any distribution, audit the incoming content artifact:

- Does it have a clear single takeaway?
- Are all load-bearing claims grounded (source cited or `[operator to fill]`)?
- Is the voice consistent with the captured founder voice profile?
- Are there any internal routing notes, placeholder text or generic AI phrases?
- For blog: is the SEO scaffold complete (title tag, meta, slug, keyword)?
- For social: is there a platform-native version, not a copy-paste?

### 2. Quality Gate

Run the deterministic checks:

```
source_inventory_passed:     ✓ if source claims are traceable
claim_copy_lint_passed:      ✓ if no unsupported superlatives or invented facts
visual_qa_passed:            ✓ if image exists, no placeholder text, no non-allowlist labels
artifact_truth_passed:       ✓ if no fabricated data, no hallucinated citations
release_gate_passed:         ✓ if council score ≥ threshold for this format
approval_owner_confirmed:    ✓ if operator explicitly approved
```

Blockers (any one blocks distribution):

- Missing writer runtime auth
- Missing image for image-required social lane
- Generated image contains placeholder or non-allowlist text
- Social post has unsupported claim
- Standing approval expired

### 3. Distribution Plan

Create the distribution plan as a local artifact:

```json
{
  "artifact": "article-slug-or-post-id",
  "channels": ["blog", "linkedin", "x"],
  "schedule": {
    "type": "queue",
    "timezone": "Europe/Berlin",
    "preferred_time": "08:00"
  },
  "upload_post_profile": "client-profile-name",
  "payloads": {
    "blog": { "title": "...", "body_md": "...", "slug": "...", "tags": [...] },
    "linkedin": { "text": "...", "image_url": "..." },
    "x": { "text": "...", "image_url": "..." }
  },
  "approval": {
    "owner": "Operator",
    "gate_level": "HG-2.5",
    "confirmed_at": null
  }
}
```

### 4. Upload-Post Remote Preflight

Before sending anything to the review queue, run a remote preflight:

- Verify the Upload-Post API is reachable and authenticates
- Verify the target profile exists and has the expected channels configured
- Verify the payload shape matches the profile's expected format
- Report the result as PASS or list blocker details

**Never skip the preflight.** A preflight that fails means the distribution plan
must be revised before resubmission.

### 5. Review Queue Submission

Only after:

- All quality gates pass
- Remote preflight passes
- Operator explicitly confirms "yes, publish this"

Submit to the Upload-Post review queue. The operator still sees it in the
upload-post.com dashboard and can cancel before the scheduled time.

### 6. Morning-After Audit

After a post goes live, run the morning-after audit:

- Is the live URL accessible and rendering correctly?
- Is the title, meta description and slug as expected?
- Did the CMS import succeed (for blog posts)?
- Is the post indexed / visible on the target platform?
- Are there any unexpected redirects, 404s or formatting issues?

Report findings as a local artifact. If the audit reveals blockers, flag them
immediately — do not assume they'll be caught later.

### 7. Metrics Harvest

After the audit, harvest available metrics:

- Blog: page views, time on page, bounce rate (from GSC or platform export)
- LinkedIn: impressions, reactions, comments, shares, saves
- X: impressions, likes, reposts, replies, bookmarks

**Keep unknown metrics as blockers.** Missing data is not zero — mark it as
`blocked: no_export_available` and report the gap.

## Pipeline Folder Structure

When running for a client, create:

```
content/ops/
  content-pipeline.config.json
  source-inventory.md
  backlog.json

marketing/
  daily-editorial/YYYY-MM-DD/
    01-research/
    02-drafts/
    03-visual-briefs/
    04-images/
    05-copy-gate/
    06-quality-gate/
    07-final/
    08-distribution-plan/
    09-upload-post/
    10-eval-gate/
  publishing-calendar/
    calendar.json
    upload-post-submissions.json
    upload-post-scheduled.json
  performance/YYYY-MM-DD/
    report.md
    post-metrics-harvester.md
```

## Output Shape

Deliver:

1. **Content audit** — what's ready, what's blocking
2. **Distribution plan** — which channels, when, with what payloads
3. **Preflight result** — PASS or blocker details
4. **After operator approval:** submission confirmation + review queue link
5. **Morning-after audit** — live URL check + formatting + indexing status
6. **Metrics report** — known numbers + blocked-metric ledger

## Skill-Specific Safety Rules

Shared non-negotiables live in `eve-doctrine`; this section only lists skill-specific boundaries.

- **Never publish without explicit operator approval.** A "we should publish this"
  is not approval. Wait for "yes, publish" or a release card.
- **Never skip the preflight.** Every distribution starts with a remote preflight.
  A silent skip is a failure.
- **Unknown metrics are blockers, not zeros.** Report the gap honestly.
- **Per-client isolation.** One client's content, calendar, metrics and
  upload-post profile never mix with another's.
- **Invisible delivery.** EVE never appears as the publisher. The operator's brand
  is on every post. Never mention EVE, Hermes or Command EVE in post content,
  metadata or upload-post profile names.
- **HumanGates:** HG-2.5 for any review-queue submission, CMS import or schedule
  write. HG-3 for regulated claims. HG-4 for founder-voice strategic positioning
  or irreversible public commitments.
