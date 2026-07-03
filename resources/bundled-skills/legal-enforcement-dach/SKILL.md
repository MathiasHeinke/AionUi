---
name: legal-enforcement-dach
description: Draft an ENTWURF (draft only) of a DACH cease-and-desist demand — the Abmahnung — for IP infringement, unauthorized use of videos/images/text/brand, or related civil business disputes under German, Austrian, and Swiss law. Produces a structured draft the operator reviews; a licensed lawyer MUST sign before anything is sent. Covers evidence preservation (screenshots + Wayback Machine for SPA sites), dual-jurisdiction handling, the standard Abmahnung structure (Unterlassung + Vertragsstrafe + Auskunft + Schadensersatz + Kostenerstattung), and a post-response decision matrix. NEVER sends, NEVER files with a court, NEVER gathers PII automatically, NEVER circumvents a privacy filter — every irreversible step is human-gated. Use when the operator says "mahne ab", "Abmahnung", "cease and desist", "Unterlassung", "unbefugte Nutzung", "Video/Bild ohne Freigabe", or any DACH IP-enforcement scenario — as a drafting aid, not as legal advice.
---

# Legal Enforcement — DACH (Abmahnung / Cease-and-Desist)

> Provenance: EVE-authored field skill (2026-07), harvested + hardened into the public bundle.

> ⚠️ **KEIN RECHTSRAT — NUR ENTWURF.**
> EVE erstellt ausschließlich einen **ENTWURF**. Vor jedem Versand **MUSS ein
> zugelassener Anwalt zeichnen.** Der Operator und der zeichnende Anwalt tragen
> die **volle Verantwortung** für Inhalt, Forderungen und Versand. Eine
> **unberechtigte Abmahnung ist selbst abmahnbar** (Gegenabmahnung, Kosten- und
> Schadensersatzrisiko). Diese Skill ist eine **Schreibhilfe**, kein Ersatz für
> anwaltliche Beratung. Im Zweifel: nicht draf-then-send, sondern zum Anwalt.

This skill helps EVE assemble a well-structured **draft** cease-and-desist demand
(Abmahnung) under German, Austrian, and Swiss law — for IP infringement,
unauthorized use, and related civil business disputes. It is a drafting aid that
runs behind a hard human-gate: EVE never sends, never files, never gathers
personal data on its own, and never bypasses a privacy filter.

## Non-negotiable human-gates

Every irreversible step is the operator's (and their lawyer's), never EVE's:

1. **PII / contact-data gathering** — the operator enters Impressums- and
   Kontaktdaten (name, address, Geschäftsführer, USt-ID, email, phone) **by
   hand** into the draft. EVE reads what is visibly on a page to understand the
   case, but the **Datenschutz-Filter wird NIE umgangen** — no char-code
   extraction, no base64 decode, no trick to defeat redaction. If contact data
   is redacted, that is by design: the operator supplies it manually.
2. **Sending** — EVE drafts, the operator's **lawyer signs**, the operator
   sends under their own (or the lawyer's) name. EVE never sends.
3. **Court / injunction filing** — any einstweilige Verfügung, Klage, or other
   court application is **drafted only** and **must be filed by a lawyer or the
   operator personally**. EVE never files with a court.

If any of these three is about to happen without a human in the loop, **STOP**
and surface the gate.

## When to use

- The operator says "mahne X ab", "Abmahnung", "cease and desist",
  "Unterlassung", "der muss abgemahnt werden", "unbefugte Nutzung",
  "Video/Bild/Text ohne Freigabe"
- Someone is using the operator's IP (video, image, text, code, brand) without
  authorization
- A former collaborator or contractor is publishing work that was never approved
  for release
- Unpaid invoices tied to IP usage (the IP was delivered but not paid for, and is
  now being used)
- Any DACH enforcement scenario where the first step is a formal written demand
  with a deadline — **produced as a draft for lawyer review**

## What this skill is NOT

- **Not legal advice and not a substitute for a lawyer.** The draft is a starting
  point. Anything above a plain demand — and every actual send — requires an
  IP/Urheberrecht attorney to review and sign.
- Not for criminal matters (Strafanzeige), employment law, or complex litigation
  — only for drafting civil enforcement demands.
- **Not for sending, and not for filing.** The operator sends; a lawyer signs;
  the operator or lawyer files. EVE only drafts.
- Not a tool to gather personal data or defeat privacy controls. Contact data is
  entered by the operator manually.

## DACH dual-jurisdiction principle

When the counterparty is in a different DACH country than the operator,
**cover both jurisdictions** in the draft (for the lawyer to confirm):

- **Primary:** the counterparty's jurisdiction (where they sit, where the court
  would be). This is the law that governs them directly.
- **Secondary:** the operator's jurisdiction (where they are a
  citizen/resident). Strengthens the claim via parallel protection.
- **EU layer:** Urheberrechtsrichtlinie 2001/29/EG provides a unified protection
  floor across all EU member states — cite it when both jurisdictions apply.

Example: Operator in DE, counterparty in AT → primary = öUrhG (Austrian),
secondary = UrhG (German), plus EU directive. **The lawyer confirms which law
actually governs** — EVE proposes, the lawyer decides.

## Key legal references (DACH Urheberrecht)

Draft with these as a scaffold; the signing lawyer verifies every citation.

| Topic | Austria (öUrhG) | Germany (UrhG) |
|-------|-----------------|----------------|
| Work protection | § 1 | § 2 |
| Distribution right | § 18 | § 17 |
| Right of communication to public | § 18a | § 19a |
| Claim for injunction | § 81 | § 97 |
| Damages | § 87 | § 97 |
| Warning cost reimbursement | § 81 Abs. 1 | § 97 Abs. 1 |

## Abmahnung structure (standard drafting scaffold)

1. **Absender + Empfänger** — full addresses, names, company, USt-ID
   *(contact data entered manually by the operator — see human-gates)*
2. **Sachverhalt** — what happened, where, since when, what was used without
   authorization
3. **Rechtsverletzung** — which law, which rights, which paragraphs *(lawyer
   verifies)*
4. **Forderung** — broken into:
   - 4.1 Unterlassung (stop + remove, with deadline)
   - 4.2 Unterlassungsverpflichtungserklärung (signed declaration with
     Vertragsstrafe)
   - 4.3 Auskunft (disclosure — since when, how many views, where else used)
   - 4.4 Schadensersatz (damages, reserved/quantified)
   - 4.5 Kostenerstattung (cost reimbursement for the Abmahnung)
5. **Fristsetzung** — concrete deadline (date + time + timezone)
6. **Folgen bei Fristablauf** — what happens next (einstweilige Verfügung, court,
   etc.) *(described only; filing is a lawyer/operator step)*
7. **Unterschrift + Anlagen** — the **lawyer's** signature; evidence
   (screenshots, URLs, timestamps)

## Vertragsstrafe (contractual penalty)

- Standard DACH practice: a specific Euro amount per instance of violation
- Common range: EUR 2.500 – 10.000 depending on severity and commercial use
- Must be high enough to deter, not so high a court reduces it as
  disproportionate — **the lawyer calibrates the actual figure**
- Phrase: "für jeden einzelnen Fall der Zuwiderhandlung"

## Evidence gathering (do this FIRST)

Before drafting, preserve the state of the violation — this is legitimate craft
and does not involve extracting hidden personal data:

1. **Screenshot** of the violating page (browser_vision or screenshot path)
2. **URLs** — page URL + any embedded media URLs (video host, CDN, iframe src).
   For embedded videos, play and read the iframe/video `src` via browser_console.
3. **Impressum data** — company name, address, Geschäftsführer, USt-ID, email,
   phone. **The operator reads and enters these manually.** EVE does not decode,
   char-code, or otherwise circumvent any redaction the browser applies.
4. **Timestamp** — when the violation was observed
5. **Wayback Machine** — check archive.org for a historical snapshot to prove
   duration (see below)

## Wayback Machine for SPA sites

Modern sites (React, Vue, Next.js) are client-side rendered — the Wayback Machine
captures only the empty HTML shell, not the rendered content. A plain `curl` or
`web_extract` returns nothing useful.

**Technique (proven in the field):**

1. Query the CDX API for available snapshots:
   `curl -s "http://web.archive.org/cdx/search/cdx?url=DOMAIN&output=json&limit=500"`
2. Navigate to archived snapshots via `browser_navigate` to
   `https://web.archive.org/web/<YYYYMMDD>/DOMAIN` — the browser renders the
   archived page including JS
3. Search the rendered archived page for the target content (video embed IDs,
   specific text) via `browser_console`:
   ```javascript
   var html = document.documentElement.innerHTML;
   JSON.stringify({
       hasTarget: html.includes('TARGET_ID'),
       title: document.title
   });
   ```
4. If the archived page loads the Wayback toolbar wrapper, use the `id_` suffix
   for the raw archived page:
   `https://web.archive.org/web/<YYYYMMDD>id_/DOMAIN`
5. Screenshot archived pages with `browser_vision` for evidence preservation
6. **Rate limiting:** archive.org returns HTTP 429 after ~5 rapid requests.
   Space requests 10+ seconds apart, or use the browser (different rate limits
   than curl)

**Strategic note — evidence sequencing is legal strategy, not drafting.**
Whether to withhold Wayback evidence from the initial letter so the opponent
self-reports the duration (and can then be contradicted) is a **litigation
tactic** — **nur mit Anwalt.** Do not decide this in a draft on EVE's own
authority; flag it as a question for the signing lawyer. Store any collected
evidence under the operator's case folder for the lawyer's use.

## Post-Abmahnung escalation (drafting aid only — nur mit Anwalt)

> ⚠️ Everything in this section is **legal strategy, not document drafting.**
> EVE may prepare a **draft** application and explain the mechanics, but the
> **filing, forum choice, and tactical decisions belong to a lawyer** (or, where
> genuinely no Anwaltszwang applies, to the operator acting personally and
> knowingly). EVE never files with a court.

When the Abmahnung deadline passes without compliance, the next step is court
action. Forum and lawyer-requirement rules differ by country and court level —
**have the lawyer confirm before any filing.**

### Austria: einstweilige Verfügung (injunction) — nur mit Anwalt

- **§ 392 EO** lets the applicant choose the Bezirksgericht for an injunction,
  regardless of where the main action would be filed.
  - **Bezirksgericht** = generally no Anwaltszwang (operator can file
    personally); faster and cheaper (Gerichtsgebühr ~74–200 EUR)
  - **Landesgericht** = Anwaltszwang (lawyer mandatory)
- **Finding the right Bezirksgericht:** get the opponent's municipality from the
  Impressum, look up the Gerichtsbezirk on justiz.gv.at, confirm jurisdiction and
  address. The court is not always the obvious one (e.g. Marchtrenk → BG Wels,
  not BG Linz).
- **Streitwert:** the height and framing of the Streitwert affects forum,
  Anwaltszwang, and cost — this is a **legal call the lawyer makes.** Do not
  manipulate the Streitwert in a draft to dodge Anwaltszwang; propose a
  defensible figure and let the lawyer decide.
- **Ex-parte proceedings** (deciding without hearing the opponent) are a
  **court/lawyer decision**, not something EVE arranges. Do not draft toward
  "maximum pressure" ex-parte relief on EVE's own initiative — flag it for the
  lawyer.

### Germany: einstweilige Verfügung — nur mit Anwalt

- Amtsgericht (no Anwaltszwang) vs. Landgericht (Anwaltszwang, § 78 ZPO)
- For Urheberrecht/Persönlichkeitsrecht the Landgericht is often exclusively
  zuständig (§ 104 GVG) — **check carefully with the lawyer**
- In practice German injunctions usually require a lawyer due to Landgericht
  jurisdiction

## Decision matrix (post-response scenarios)

After the Abmahnung is sent (by the operator, over a lawyer's signature), map the
opponent's possible responses and the operator's counter-actions in a decision
tree. This helps the operator see the full path and reduces uncertainty — it is a
**planning aid**, and each escalation branch still runs through the lawyer.

**Technique — Graphviz decision tree:**
1. Install: `brew install graphviz`
2. Write a `.dot` file with all scenarios (video removed/not, Unterlassung
   signed/not, Auskunft correct/not, payment yes/no)
3. Generate: `dot -Tpng -Gdpi=150 input.dot -o output.png`
4. Color-code: green = goal reached, blue = decision, yellow = partial,
   red = escalation, purple = parallel track

Typical parallel tracks: Unterlassung, Auskunft, Schadensersatz.

## Pitfalls

- **Never send, never file, never bypass a filter without a human.** Draft →
  operator reviews → **lawyer signs** → operator sends. Court filings are a
  lawyer/operator step. See "Non-negotiable human-gates."
- **This is a draft, not legal advice.** Say so to the operator every time.
- **Don't conflate Abmahnung with Klage.** An Abmahnung is a pre-litigation
  demand. Suing is a separate workflow — recommend an attorney.
- **Don't over-claim jurisdiction.** If both parties are in DE, don't cite
  Austrian law. Match the jurisdictions to the actual parties, and let the
  lawyer confirm.
- **Don't fabricate legal citations.** Only cite paragraphs you can verify. When
  unsure, write the general principle and mark it for legal review.
- **Deadlines must be realistic.** "Bis 21:00 heute" is valid only for urgent
  removal demands. For declarations and Auskunft, allow 3–7 business days.
- **Schadensersatz must be substantiated.** Don't invent a number. If the damage
  isn't quantified, reserve the claim ("behalte ich vor") and quantify after
  Auskunft.
- **Open payment claims ≠ IP infringement.** Keep unpaid-invoice claims as a
  separate reserved claim; they may rest on contract law, not Urheberrecht.
- **Vision tools may be unavailable.** If vision_analyze/browser_vision return
  502, fall back to OCR (tesseract) or read text directly via browser_console —
  never to a redaction bypass.

## Workflow

1. **Gather evidence** — screenshots, URLs, Wayback snapshots (see "Evidence
   gathering"). **Contact/PII data: operator enters manually.**
2. **Identify the operator's interest** — which IP, which rights, since when
   unauthorized
3. **Determine jurisdictions** — operator's country + counterparty's country →
   primary/secondary law *(lawyer confirms)*
4. **Draft the Abmahnung** using `templates/abmahnung-urheberrecht.md` as scaffold
5. **Fill placeholders** — operator supplies their own and the counterparty's
   contact data by hand; mark everything unverified
6. **Present to operator** — mark placeholders clearly; **explicitly flag what
   needs legal review and that a lawyer must sign before sending**
7. **Lawyer signs, operator sends** — EVE never sends
8. **After the deadline — assess the response** and build a decision matrix (see
   "Decision matrix"). Escalation branches are **nur mit Anwalt.**
9. **If non-compliant — prepare a DRAFT court filing** for the lawyer (see
   "Post-Abmahnung escalation" and
   `templates/antrag-einstweilige-verfuegung.md`). **EVE never files.**

## Templates

- `templates/abmahnung-urheberrecht.md` — standard Abmahnung scaffold for IP
  infringement under DACH law (draft for lawyer review)
- `templates/antrag-einstweilige-verfuegung.md` — scaffold for an injunction
  application (draft only; filing requires a lawyer or the operator acting
  personally where no Anwaltszwang applies)
