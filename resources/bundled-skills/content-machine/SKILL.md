---
name: content-machine
description: >-
  Turn founder context, source material and market signals into a safe content operating system that feeds social, blog, video and campaign lanes — without defaulting to AI slop. Produces the shared CMO substrate before any format-specific content pack runs: source inventory → founder voice → vault → research → raw brief → anchor draft → writer council → derivatives → release packet → learning loop. Setup command creates the full local folder surface in draft-only mode. Use when the operator says "set up my marketing pipeline", "I want to produce content regularly", "build a founder content system", or needs a repeatable content workflow for themselves or a client.
linked_files:
  - references/folder-surface.md
---

# Content Machine

The Content Machine is the **shared CMO substrate** before any format-specific
content pack runs. It is not a social scheduler, blog engine, book writer or video
processor. It creates the context layer those packs read from:

```
marketing intent
→ source inventory
→ Founder Voice and Belief Model check
→ content vault
→ research dossier
→ founder interview / raw brief
→ anchor draft
→ writer council
→ derivative package
→ release packet
→ performance and lessons
```

The core rule: **Real founder context first. Public publishing remains gated.**

## When to use

- "Set up my marketing / content pipeline", "I want to produce content regularly"
- "Build a founder content system", "turn my ideas into posts, articles and campaigns"
- Before running blog-publishing-lane, video-first-content-engine, or any format-specific pack
- For a client seat (per-client install): run content-machine first to establish their voice, sources, and quality bar

## The method

### 0. Founder Intake

Ask only for missing fields; summarize after at most three questions.

**Required to start:** company, offer, buyer, primary audience, first channel intent
(LinkedIn, X, blog, newsletter, book, video or campaign), approval owner for
public voice/publishing, existing FVBM status (missing/M0/M1/M2/M3), allowed
source classes, off-limits topics/claims/customer data/private surfaces.

**Useful but optional:** 3–5 voice samples, one negative style sample, current
channels+cadence, lead source/revenue objective, existing content backlog, first
target market.

### 1. Check FVBM Status

Inspect the user's Founder Voice and Belief Model. If no confirmed model exists,
run the M0 seed interview before any strong-voice drafts.

### 2. Source Inventory

Record what may be read, where it lives, who approved it, sensitivity, allowed
action ceiling and freshness. Only inspect sources explicitly approved.

### 3. Vault Scout

Turn approved source signals into topic cards. Each card has: source, score,
audience value, proof potential and HumanGate level.

### 4. Founder Interview

Ask for real stories, numbers, tension, beliefs and concrete examples **before**
any strong founder-voice pieces are drafted. Store the raw material verbatim.

### 5. Raw Brief

Store the founder's words, examples and proof. This is sacred source material —
draft workers may quote or adapt it but must never erase its meaning.

### 6. Research Dossier

For selected anchor ideas, create a sourced dossier with: source table, claim
class, uncertainty, required citations.

### 7. Anchor Draft

Create one anchor draft and optional platform variants. Write in the captured
founder voice — **never in a generic AI voice**.

### 8. Writer Council

Review the draft through separate lenses: anti-slop, founder voice, buyer value,
claim safety, platform fit, business outcome. Each lens gives a score 1–10.

### 9. Revision Loop

Iterate until the quality threshold passes. Separate two classes of fixes:

- **Editorial fixes** — the machine may revise directly
- **Information gaps** — only the founder or an approved source can answer. Route
  back to intake/interview. Never hallucinate.

### 10. Derivatives

Create native platform derivatives only after the anchor draft passes council.
One anchor → one per platform (LinkedIn, X, blog, newsletter), each adapted to
that platform's format and audience.

### 11. Release Packet

Enter the existing blog/social/video release gates (blog-publishing-lane, etc.).
The Content Machine does not publish — it produces release packets for the
format-specific pack.

### 12. Learning Loop

Compare the first draft with the founder-approved final. Propose updates to
`content-lessons.md` and FVBM. Durable promotion remains gated.

## Quality Thresholds

- Daily social draft: council average ≥ 8/10
- Anchor post, newsletter, blog or campaign: council average ≥ 8.5/10
- Book chapter, strategic public stance or high-risk claim: council average ≥ 9/10
  + CAO/HumanGate review

## Folder Surface

See `references/folder-surface.md` for the exact local folder tree and setup
command. Keep this main file focused on when to run the skill and how to judge
its output.

## Output Shape

Deliver: the **intake summary** (what's confirmed, what's still missing), the
**folder surface** (created or planned), the **first vault/topic card** (if
sources exist), and the **next step** (which format pack to run next, or the
anchor draft if intake is complete).

For a full run: deliver the anchor draft + council scores + derivative packages
as local artifacts in the folder surface.

## Skill-Specific Safety Rules

Shared non-negotiables live in `eve-doctrine`; this section only lists skill-specific boundaries.

- **Real founder context before drafting.** No strong-voice piece without a
  captured FVBM or raw brief. Flag low confidence honestly.
- **Never invent.** No fabricated stories, numbers, customer examples, quotes or
  testimonials. Ground or cut — mark gaps `[needs founder input]`.
- **Never publish.** The Content Machine produces release packets. Publishing is
  a separate, human-gated step (→ blog-publishing-lane).
- **Per-client isolation.** If running for a client seat, use only that client's
  truth. Never bleed one client's sources, voice, or examples into another's.
- **Safe by default.** No broad private-source mining without explicit approval.
  No durable memory writes without confirmation.
- **HumanGates:** HG-1 (local intake/vault), HG-2 (draft-only anchor + council),
  HG-2.5 (CEO release card before any public connector write), HG-4 (founder
  voice identity / strategic positioning).
