---
name: crm-department
description: Local filesystem-based client pipeline and deal management for EVE's reseller operations. Tracks clients through deal stages (discovery → qualification → proposal → negotiation → won/lost), manages contacts per deal, reports pipeline value and revenue attribution. Local-only — no external CRM dependency in v0; optional sync to Plane, HubSpot or other CRM at HG-2.5. Use when the operator asks "show me my pipeline", "what's my deal status", "add a new client/lead", "what's the revenue forecast", "update deal stage", or any client pipeline question.
---

# CRM Department

The CRM Department is EVE's local client pipeline and deal management system.
It lives on the filesystem, tracks every contact and deal through defined stages,
and gives the operator a real-time answer to "what's in the pipeline" without
needing a SaaS CRM login.

The operating rule: **Every client starts as a deal. Every deal has a stage.**

## When to use

- "Show me my pipeline / what's my deal status / what's the revenue forecast"
- "Add a new client / lead / deal / contact"
- "Update deal stage — Client X said yes / no / send proposal"
- "Who are my contacts at Client Y?"
- "What's the average deal size / close rate this month?"
- After any client conversation that changes deal status
- Weekly pipeline review: run this to prepare the revenue report

## Deal Stages

```
discovery     → New lead, initial conversation, needs qualification
qualification → Need confirmed, budget known, decision-maker identified
proposal      → Proposal sent, waiting for response
negotiation   → Terms being discussed, close imminent
won           → Deal closed, client onboarded
lost          → Deal lost, reason captured
stalled       → Deal paused (operator chooses when to re-engage)
```

## Folder Surface

Setup creates the CRM surface in the operator's workspace:

```
crm/
  DEALS/
    active/                    ← currently active deals
      deal-client-x.md
      deal-client-y.md
    won/                       ← closed-won deals
      deal-client-z.md
    lost/                      ← closed-lost deals
      deal-client-failed.md
    stalled/                   ← paused deals
      deal-client-parked.md
  CONTACTS/                    ← contact records
    contact-john-smith.md
    contact-jane-doe.md
  REPORTS/                     ← generated reports
    2026-Q2-pipeline.md
    2026-06-weekly.md
  crm.config.json              ← configuration
  crm-index.json               ← auto-generated index
  RUNBOOK.md
```

## Deal Card Format

```markdown
---
id: deal-client-x
status: active
stage: proposal # discovery / qualification / proposal / negotiation / won / lost / stalled
priority: high # critical / high / medium / low
value: 24900 # monthly or one-time EUR
type: monthly # monthly / one-time / project
client: 'Client X GmbH'
contacts: ['contact-john-smith']
created: 2026-06-01
updated: 2026-06-29
expected_close: 2026-07-15
---
```

# Deal: Client X — Monthly Content Machine + Blog Pipeline

**Angebot:** Content Machine Setup + wöchentliche Blog-Publishing-Lane
**Wert:** €24.900/monatlich
**Stage:** Proposal (gesendet 2026-06-25)

## Timeline

| Datum      | Ereignis                                                         |
| ---------- | ---------------------------------------------------------------- |
| 2026-06-01 | Discovery Call — Bedarf bestätigt                                |
| 2026-06-10 | Qualifikation — Budget vorhanden, Entscheider: John Smith (CEO)  |
| 2026-06-20 | Proposal angefordert                                             |
| 2026-06-25 | Proposal gesendet — 3 Optionen (Starter/Professional/Enterprise) |
| 2026-06-29 | Follow-up: John prüft mit Team, Rückmeldung bis 2026-07-10       |

## Entscheider-Kontakt

- **Name:** John Smith
- **Rolle:** CEO
- **Email:** john@clientx.de
- **Notizen:** Entscheidet allein, mag kurze Mails, liest jeden Morgen LinkedIn

## Nächster Schritt

- 2026-07-05: Sanftes Follow-up (LinkedIn like/reblog + kurze Nachricht)
- 2026-07-10: Wenn keine Rückmeldung, Anruf vorschlagen

## Win-Bedingungen

- Content Machine ist Feature #1 auf ihrer Wunschliste
- Budget ist freigegeben (QS-Lauf 2026)
- Konkurrenz: Agentur-Monatsmodell (teurer, langsamer)
- **Risiko:** Entscheider ist im Juli 2 Wochen im Urlaub

## Notizen

2026-06-01 — Erstgespräch. Client X braucht dringend Content-Pipeline.
2026-06-25 — Proposal versendet. Option 2 (Professional) scheint der Sweet Spot.

````

## Contact Card Format

```markdown
---
id: contact-john-smith
name: John Smith
company: Client X GmbH
role: CEO
email: john@clientx.de
phone: "+49 123 456789"
linkedin: https://linkedin.com/in/johnsmith
deals: ["deal-client-x"]
source: "LinkedIn Outreach"
created: 2026-06-01
updated: 2026-06-29
---
````

## The method

### 1. Pipeline Overview

Read the CRM index and report:

- **Pipeline value:** Sum of active deal values (by stage)
- **Deal count:** Stage breakdown (discovery / qualification / proposal / negotiation / stalled)
- **Win rate:** Won / (Won + Lost) this quarter
- **Average deal size:** By type (monthly / one-time / project)
- **Aging:** Deals in stage >14 days (stale deals)
- **Next actions:** Deals with approaching follow-up dates

Output as a compact table:

```
Pipeline (2026-Q2)
─────────────────────────────────────────────
Stage           Count   Value (monatlich)
─────────────────────────────────────────────
Discovery        2       €0 (noch nicht qualifiziert)
Qualification    1       €5.900
Proposal         2       €49.800
Negotiation      0       €0
─────────────────────────────────────────────
Won this Q       3       €74.700
Lost this Q      1       €24.900
Win rate:        75%
─────────────────────────────────────────────
Stale ( >14d):   1 (Client Y — Qualification seit 01.06.)
Follow-up today: Client X Proposal
```

### 2. Add a Deal

When the operator says "new client / deal":

- Create `DEALS/active/deal-{client-slug}.md`
- Assign ID + created date
- Ask for: client name, stage, value, contact info
- Add to crm-index.json

### 3. Update Stage

When stage changes:

- Move the deal file to the corresponding folder (active → won, etc.)
- Update `stage` and `updated` in YAML frontmatter
- Add a dated note to the Timeline section
- For lost deals: always capture the reason (price, timing, competitor, no decision, other)
- For won deals: always capture the deal value + type + start date
- Rebuild crm-index.json

### 4. Add / Update Contact

When the operator mentions a person:

- Create or update `CONTACTS/contact-{slug}.md`
- Link to the deal(s) via the `deals` field
- Add to crm-index.json

### 5. Weekly Pipeline Report

Every Monday (or on request), generate:

```
CRM Weekly — KW 27 (29.06. – 05.07.2026)
────────────────────────────────────────────
Pipeline Value:       €55.700 monatlich
Active Deals:         5
Expected Close (Jul): €49.800 (2 Deals)
Win Rate:             75%

This Week's Focus:
→ Client X: Proposal Follow-up (Rückmeldung erwartet)
→ Client Y: Second Meeting vereinbaren oder auf Eis legen

New This Week:
→ Discovery mit Client Z (AI Tooling, 05.07.)
```

### 6. Revenue Tracking

Track won deals with their start date and value. Report monthly recurring
revenue (MRR) and total contract value (TCV) when asked.

## Output Shape

**On "show me pipeline":** The pipeline table (stages × count × value) +
follow-up notifications for any deal with approaching dates.

**On "add a deal":** Confirmation with deal ID + next recommended stage action.

**On "update stage":** Stage change confirmation + what changed in the pipeline value.

**Weekly report:** Pipeline value, active deals, expected closes, stale deals,
this week's focus items.

## Skill-Specific Safety Rules

Shared non-negotiables live in `eve-doctrine`; this section only lists skill-specific boundaries.

- **Local-first.** No external CRM dependency in v0. Filesystem is source of truth.
  Optional sync to external CRM (Plane, HubSpot, etc.) requires HG-2.5 approval.
- **Per-client isolation.** Each client deal is a separate file. Never confuse
  one client's deal data with another's.
- **Invisible delivery.** CRM content is EVE's internal tooling. Never share
  CRM data with clients or in client-facing reports. Never mention EVE or Command
  EVE in CRM records.
- **Lost deals have reasons.** Every lost deal captures why. "No decision" is a
  valid reason; missing reason is not.
- **Pipeline is always current.** Every operator interaction that changes deal
  status updates the deal file immediately. Stale pipeline is a failure.
- **HumanGates:** HG-1 for local reads/writes. HG-2 for generated reports shared
  outside EVE. HG-2.5 for any external CRM sync or API write.
