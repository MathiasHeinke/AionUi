---
name: voice-first-run
description: >-
  Structured onboarding interview that captures the operator's (or their client's) Founder Voice and Belief Model (FVBM) before any content is produced. Walks through M0 → M1 → M2 → M3 progression: core beliefs → audience intuition → writing style → voice samples → content principles. Produces a structured FVBM profile that feeds content-machine (step 1 checks FVBM status) and founder-voice (creates the voice profile from interview + samples). Use when the operator says "I'm new, set me up", "capture my voice from scratch", "I don't have writing samples yet", or when content-machine reports FVBM status = missing or M0.
disable_model_invocation: true
---

# Voice First Run (FVBM Onboarding)

The Voice First Run is the **structured onboarding** that establishes a founder's
(or client's) writing voice and belief model before any content is produced.
It is the M0 → M1 → M2 → M3 progression that feeds both content-machine and
founder-voice.

The operating rule: **No strong-voice content without a completed FVBM.**

## When to use

- "I'm new, set me up" / "capture my voice from scratch"
- Content-machine reports FVBM status = missing or M0
- The operator has no writing samples yet (not even LinkedIn posts)
- Before the first content run for a new client seat
- The operator says "I don't know what my voice is" — that's exactly when to run this

## FVBM Maturity Levels

| Level  | Meaning                 | What's captured                                       |
| ------ | ----------------------- | ----------------------------------------------------- |
| **M0** | Seed interview complete | Core beliefs, audience, what they stand for/against   |
| **M1** | Voice samples exist     | 2–5 real writing samples captured                     |
| **M2** | Voice profile written   | Structured voice profile in USER.md                   |
| **M3** | Field-tested            | Content produced, feedback incorporated, voice stable |

Voice-first-run takes the operator from M0 → M1 (it stops at M1; founder-voice
handles M1 → M2 → M3).

## The method

### M0 — Seed Interview (Core Beliefs)

Ask 5–7 questions, one at a time. Never dump them all at once — keep it a
conversation. Capture each answer verbatim in the FVBM profile.

**Core questions** (ask all, in this order):

1. **What do you do?** — One sentence. The business, the offer, the buyer.
   If they give a paragraph, ask for the one-sentence version.

2. **What do you believe that other people in your space don't?** — This is
   the single most important question. Their contrarian take IS their voice.

3. **Who are you writing for?** — Name one person. Their job, their problem,
   their reading habit. "Everyone" is not an answer — ask them to pick one.

4. **What should the reader feel after reading your content?** — One emotion.
   Inspired, informed, challenged, understood, amused, provoked. Write it down.

5. **What would you NEVER say in public?** — Topics, claims, tones, phrases
   that feel wrong. This is as important as what they would say.

6. **Du oder Sie?** — German only. Critical for tone.

7. **Who writes like you wish you did?** — One person, publication or account
   they admire. "Nobody" is fine too.

**Optional follow-ups** (ask only if the answers above feel thin):

- What's a topic you could talk about for 30 minutes without preparation?
- What's a take you had that surprised people?
- What's a piece of content you consumed recently that made you think "yes, that"?

### M0 → Capture FVBM Profile

After the interview, distill into a structured FVBM profile:

```yaml
fvbm:
  status: M0
  operator: "Name / Client Name"
  offer: "One-sentence offer"
  buyer: "One person, one problem"
  core_beliefs:
    - "What they believe that others don't"
    - "Second core belief (if emerged)"
  desired_reader_feeling: "inspired / challenged / informed / …"
  never_says:
    - "Topic or claim they avoid"
    - "Tone they avoid"
  anrede: "Du" / "Sie"        # German only
  admired_voices:
    - "Person or publication (optional)"
  interview_confidence: high   # or medium/low if answers were thin
  interview_date: "2026-06-29"
```

Write this to the client's workspace as `fvbm/fvbm-profile.yaml`.

### M1 — Gather Voice Samples

Now that beliefs are anchored, ask for samples:

**Lowest friction** (prefer these):

- "Schick mir einen Link zu deinem letzten LinkedIn Post" (if they've posted)
- "Schick mir eine Email die du geschrieben hast und die sich gut anfühlt"
- "Sag mir einen Satz den du oft sagst — ich schreib ihn auf"

**If they have nothing:**

- Ask them to write 2–3 sentences about WHY they started their business, in
  their own words, right now. Type it, don't polish it.
- Ask for a voice memo (recorded on phone, 1–2 minutes: "erzähl mir woran du
  gerade arbeitest und warum es dich antreibt")
- Transcribe the voice memo and use it as sample material

**Rule:** If they have zero writing samples after this, flag the profile as
`sample_confidence: interview_only` and move on. Content production can start,
but every draft must go through the tone-check step until samples arrive.

### M1 → Ready for founder-voice

At this point, the FVBM profile + samples are ready. The next step is to
run **founder-voice** (which reads the FVBM profile and writes the structured
voice profile into USER.md).

Content-machine checks: before any strong-voice anchor draft, it confirms
FVBM ≥ M1. If not, it routes here first.

## Folder Surface

```
fvbm/
  fvbm-profile.yaml          ← structured profile (M0 interview output)
  samples/                    ← writing samples (M1)
    01-linkedin-post.md
    02-email.md
    03-voice-memo-transcript.md
  README.md
```

## Output Shape

**On first run:** Deliver the FVBM profile + the next step ("ready for founder-voice
— I can capture your voice profile from these samples now, or we start producing
with the caveat that everything needs a tone-check").

**On later check-ins:** Report current FVBM level and what's needed to advance
(e.g. "M0 → M1 needs 2–3 writing samples").

## Skill-Specific Safety Rules

Shared non-negotiables live in `eve-doctrine`; this section only lists skill-specific boundaries.

- **Never invent a voice.** Without M0 interview + M1 samples, flag
  `sample_confidence: interview_only`. Content can still be produced with this
  flag, but only with explicit tone-check on every piece.
- **One question at a time.** The interview is a conversation, not a form.
  Never dump all 7 questions in one message.
- **Capture verbatim.** Store the operator's actual words in the FVBM profile,
  not AI paraphrases. If you must summarise, mark it `[paraphrased]`.
- **Per-client isolation.** Each client seat gets its own FVBM. Never bleed.
- **M0 → M1 → M2 → M3 is linear.** Don't skip levels. If the operator says
  "just write it, you know my voice" but FVBM is M0, say "I hear you — let's
  do a 2-minute interview first so I don't guess wrong."
- **HumanGates:** HG-1 for interview and profile capture. HG-2 for any
  automated tone-check that's used in production drafts.
