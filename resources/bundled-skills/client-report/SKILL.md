---
name: client-report
description: Produce the operator's client-facing marketing/strategy REPORT — a structured, deliverable document (exec summary · findings · recommendations · next steps) — assembled from ONLY the active seat's truth (the client/company set up in that seat via the Company-Brain seed + the seat's MEMORY and workspace). Use when the operator asks for a client report, a monthly/period update, a strategy deliverable, an audit write-up, or "write the report for <client>". The report is built for the operator to REVIEW and then DELIVER OUT under their own brand (the client never logs in) and is shaped to feed the report EXPORT (PDF / Word / Markdown). It carries the OPERATOR's brand, never names Command EVE / EVE / Hermes, fabricates no numbers, and refuses to emit if it cannot confirm it is running inside one real client seat.
---

# Client Report

This is the seam where the operator's seat-of-work becomes a **finished document a client pays for**. The operator
set up one client inside one isolated seat — its company truth came in through the **Company-Brain seed** and accreted
in the seat's **MEMORY** and **workspace** as the work was done. This skill assembles that on-disk truth into a clean,
client-facing **marketing/strategy report** the operator can read once, approve, and hand out under their own brand.

It is a **deliverable**, not a chat reply: a structured document with an exec summary up front, the findings, the
recommendation, and the next steps — sized to be exported to PDF/Word/Markdown and sent to a client who never logs in.

## When to use
- The operator asks for a **client report**, a **monthly / period update**, a **strategy deliverable**, or an **audit write-up**.
- The operator says "write the report for <client>", "give me the client deliverable", "package this for the client".
- **After** a deep-research, gtm-strategy, icp-persona-panel, pre-mortem, or plan-system run inside the seat — to turn the work performed into the document the client receives.

## Read fence — active seat ONLY (hard rule)
This report is built from **one seat's truth and nothing else**. The seat you are running in IS the client.

1. **Read ONLY the active seat's own context** — this seat's `MEMORY` / Company-Brain seed and this seat's workspace
   artifacts (the documents, research, plans, and notes produced *in this seat*). Everything you need is already on
   disk under the seat you are running in; you do not need to go looking elsewhere.
2. **Never read across seats and never read a global/operator-wide profile.** Do not look for "other clients", a
   master client list, a shared knowledge base, or any path outside this seat. There is exactly one client in scope:
   the one this seat belongs to. If a fact about the client is not in this seat, it is **not in scope** — treat it as
   unknown, do not import it from memory or from another client.
3. **Refuse to emit if you cannot confirm a single real client seat.** If you cannot establish which client this seat
   is for — the seat is unresolved, empty, or looks like a default/legacy placeholder rather than a provisioned client
   seat — **do not fabricate a client and do not emit a report**. Say plainly that the seat has no client truth to
   report on yet and stop. A blank or wrong-client report is worse than no report.

This fence is what makes per-client isolation real in the artifact: a seat-A report can only ever contain seat-A truth,
because seat-A truth is the only thing in scope when you run here.

## Honesty wall (no false claims)
- **Assemble, do not invent.** You are *assembling* a report from what is on disk in this seat. You do **not** "learn",
  "remember across sessions", or "know" anything beyond the seat's recorded truth — make no such claim in the document
  or to the operator. If the work to back a section was not done in this seat, say so; do not imply it was.
- **Never fabricate a number.** Every KPI / result you show must be **traceable to a seat artifact**. If a metric is not
  recorded in this seat, mark it **`unknown`** (or "not yet measured") — never estimate it, round a guess, or borrow a
  vendor's aspirational figure to fill the table. Flag any number whose source is a vendor claim, a projection, or an
  assumption, and label it as such (not as a measured result).
- **Grade the load-bearing claims.** For anything the client would act on, carry its grounding — `FACT(seat artifact)`,
  `INFERENCE(from …)`, or `HYPOTHESIS(no evidence yet)` — the same evidence discipline as `decision-brief` and
  `eve-doctrine`. A confident sentence is not evidence.
- **No autonomy / process boasts.** Do not claim the system ran unattended, self-improved, or did more than the seat
  artifacts show. Describe the work that was actually performed, cited to the seat.

## Brand & invisible delivery
- The report carries the **OPERATOR's brand only** — their logo, their name, their footer. Leave the brand header and
  footer as a clearly-marked **brand slot** (see the template) for the operator's brand to fill; default to a neutral
  placeholder, never to Command EVE branding.
- **Never name the underlying engine.** The document must not mention Command EVE, EVE, Hermes, the model, or "AI agent"
  as the author. To the client this is the operator's own work product. Write in the operator's voice, about the
  client's business — invisible delivery is preserved inside the artifact itself.

## Structure (exec-summary-first)
Follow `report-template.md`. Lead with the bottom line; a client reads the first half-page and skims the rest.

1. **Brand header** — operator brand slot (logo / operator name) + report title + client name + period. (Operator/seat
   data only; never the engine's name.)
2. **Executive summary** — 3–6 sentences, the bottom line up front: the situation, the single most important finding,
   and the headline recommendation. Readable before anything else.
3. **Situation / context** — where the client is right now, drawn from this seat's Company-Brain seed and MEMORY: their
   business, market, and the goal this period's work served.
4. **What was done this period** — the work actually performed in this seat, each item cited to the seat artifact that
   produced it (the research, the plan, the campaign, the page). No work that isn't in the seat.
5. **Findings / results** — what the work surfaced, including a **results / KPI block**: each number SHOWN and traceable
   to a seat source; unknowns marked `unknown`, never invented; vendor/projected figures flagged as such.
6. **Recommendations** — decisive next moves for the client (a recommendation, not a menu). Where a real fork exists,
   name the default and the one condition that would switch it.
7. **Next steps** — the concrete actions for the coming period, owner and sequence clear.
8. **Honest residual** — one short paragraph: the risk that remains even if everything is executed well, and anything
   that is still unknown / unmeasured. Honesty over smoothing.
9. **Brand footer** — operator brand slot (operator name / contact / footer line). Operator brand only.

## Output contract
- Write a **single report artifact** into the **active seat's workspace** — `report.md` (and/or `report.html` when an
  HTML body is wanted) — following the template's section order and brand slots.
- The artifact is **for review and export, not auto-delivery.** Producing it does NOT send it. The operator reviews it,
  and delivery OUT (email / read-only link) is a separate, human-gated step. Do not email, publish, or "deliver" the
  report from this skill.
- Keep the body **self-contained and export-ready** (clean Markdown / simple HTML, no remote assets) so it feeds the
  report PDF / Word / Markdown export cleanly.

## Key discipline
- **One seat, one client, on-disk truth only** — the read fence is the whole game; never reach outside the seat.
- **Exec summary first; a recommendation, not a survey of options.**
- **Every number traceable or marked unknown** — fabrication is the one unforgivable error in a client deliverable.
- **Operator brand only; engine never named** — invisible delivery lives or dies in this document.

## For Command EVE
This is where the operator's invisible-delivery promise becomes a thing they can send. Inside an isolated client seat,
EVE has done the marketing/strategy work; this skill turns that seat's accumulated truth into the **client-facing
deliverable** — the document the operator reviews and hands out under their own brand, to a client who never logs in.

- **Seat-fenced by construction.** The report is assembled from the active seat's own MEMORY / Company-Brain seed and
  workspace — the only client in scope is the one this seat belongs to — so seat-A's report can only carry seat-A truth.
- **EVE assembles, the operator delivers.** EVE produces the structured document and stops; the operator reviews it and
  the human-gated deliver-out step sends it. EVE never auto-publishes a client deliverable.
- **Honest by default.** The report assembles from what is on disk — no learning claim, no fabricated KPI, every
  load-bearing number traceable or marked unknown — so the operator can stand behind every line they send.
