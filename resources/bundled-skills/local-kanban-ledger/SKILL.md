---
name: local-kanban-ledger
description: Local filesystem-based work-item tracking for EVE's per-client and per-project work. Replaces the need for an external kanban tool for EVE's internal workflow: each client seat gets its own ledger directory with kanban-style columns (TODO/DOING/BLOCKED/DONE/ARCHIVED), per-item metadata cards, daily work logs and weekly summaries. Use when the operator asks "what's on my plate", "show me my pipeline", "track this task", "what's blocked", "what did we do this week", or as the persistent work surface for any multi-step EVE task.
---

# Local Kanban Ledger

The Local Kanban Ledger is EVE's persistent work surface — a filesystem-based
task board that lives per-client, per-project. No external service, no API, no
login. Every item has a card with metadata, every transition is logged, and
EVE can answer "what's on my plate" from the files.

The operating rule: **If it's not in the ledger, it's not tracked.**

## When to use

- "What's on my plate / show me my pipeline / what's blocked"
- "Track this task / add this to the board / put this on my list"
- As the persistent work surface for any multi-step EVE task (every step writes
  to the ledger)
- After completing a task: archive it in the ledger with a completion note
- For recurring workflows: daily check-in reads from the DOING and BLOCKED columns
- Per-client: each client seat gets its own ledger — never mixed

## Folder Surface

Setup creates the ledger in the client's workspace root:

```
local-kanban/
  TODO/            ← items that are queued but not started
    ticket-001.md
    ticket-002.md
  DOING/           ← items actively being worked
    ticket-003.md
  BLOCKED/         ← items that cannot proceed
    ticket-004.md
  DONE/            ← finished items
    ticket-005.md
  ARCHIVED/        ← closed items older than 30 days
    ticket-006.md
  DAILY_LOG/       ← daily work logs
    2026-06-29.md
  WEEKLY_LOG/      ← weekly summaries
    2026-w26.md
  ledger.json      ← machine-readable index (auto-generated)
  RUNBOOK.md
```

If no explicit client workspace exists, use `local-kanban/` in the current
working directory. The operator can relocate it later.

## Item Card Format

Each item is a Markdown file:

```markdown
---
id: ticket-003
status: doing
priority: high # critical / high / medium / low
client: client-name # or "internal" for EVE's own work
project: content-machine # which skill or project area
type: task # task / bug / request / decision / milestone
created: 2026-06-29T08:00
updated: 2026-06-29T10:30
deadline: 2026-07-06
depends_on: [ticket-001] # optional blockers
---

# Title: Set up content-machine for Client X

**What:** Initialize the Content Machine pipeline for Client X, including
source inventory, voice capture and first vault cards.

**Why:** Client X needs a repeatable content workflow before we start producing
blog posts.

**How:** Run content-machine intake, capture FVBM, create folder surface,
first council review.

## Progress

- [x] Founder intake completed
- [x] Approved sources identified
- [ ] FVBM captured
- [ ] Folder surface created
- [ ] First vault card drafted

## Notes

2026-06-29 08:00 — Created from operator request.
2026-06-29 10:30 — Waiting on operator to send voice samples.
```

## The method

### 1. Find or Create the Ledger

Check if a `local-kanban/` directory exists in the client workspace. If not,
offer to create it. Never create without asking — the operator chooses the root.

### 2. Read the Board

Read all columns and report: count per column, items in DOING (active work),
items in BLOCKED (impediments). For "what's on my plate", show the DOING and
BLOCKED items with their titles, priorities and deadlines.

### 3. Add an Item

When the operator says "track this X":

- Create a new ticket-NNN.md file in TODO/
- Assign the next sequential ID
- Fill in what you know (title, type, priority, client, project)
- Mark the rest as `[TBD]` — better incomplete than wrong
- Add it to ledger.json

### 4. Move an Item

When status changes:

- Move the file to the corresponding column
- Update the `status` and `updated` fields in the YAML frontmatter
- Add a dated note in the Progress section
- Rebuild ledger.json

### 5. Log Daily Work

At the end of a work session (or when asked), write a brief daily log:

```markdown
# 2026-06-29

## Done

- ticket-003: Created content-machine intake for Client X
- ticket-002: Completed voice capture — FVBM at M1

## In Progress

- ticket-005: Blog post draft for Client X (blocked on voice approval)

## Blocked

- ticket-004: Client X pipeline setup — waiting on source inventory list

## Decisions

- Client X starts with LinkedIn-only, blog comes in week 2
```

### 6. Weekly Summary

Every Friday (or on request), summarize the week:

- Items completed
- Items still in DOING + BLOCKED
- Velocity (items per day average)
- Blockers trending up or down
- Recommendation for next week's focus

### 7. Archive

Items in DONE for >30 days move to ARCHIVED. The operator can adjust the
threshold. Archived items stay readable but don't appear in daily summaries.

## Output Shape

**On "what's on my plate":** A compact status: `3 DOING · 2 BLOCKED · 5 TODO · 12 DONE this week`. If BLOCKED > 0, name the blockers with what's needed.

**On "add this":** Confirmation: "ticket-007 added to TODO — [title], [priority]".

**On "show me the board":** The kanban columns as formatted lists with priority badges.

**Weekly summary:** Items completed, blockers resolved, velocity, focus recommendation.

## Skill-Specific Safety Rules

Shared non-negotiables live in `eve-doctrine`; this section only lists skill-specific boundaries.

- **Per-client isolation.** Each client seat gets its own `local-kanban/`. Never
  mix. If no client context, use `internal` as the client name.
- **Never create without asking.** The operator chooses the root directory. EVE
  does not decide where the ledger lives.
- **File-based, always.** No external CRM, kanban tool or API dependency. The
  filesystem IS the source of truth.
- **Incomplete is better than wrong.** Use `[TBD]` for unknown fields rather
  than guessing. The operator fills them in later.
- **Every transition is logged.** Moving an item always adds a dated note. No
  silent status changes.
- **Blockers are surfaced immediately.** If an item is BLOCKED >24h, flag it in
  the next operator interaction unprompted.
- **HumanGates:** HG-1 for local ledger reads/writes. HG-2 for any automated
  move or archiving. Ledger data is internal — never shared with clients or in
  client-facing reports.
