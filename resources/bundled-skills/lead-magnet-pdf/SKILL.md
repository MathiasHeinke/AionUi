---
name: lead-magnet-pdf
description: Build a high-conversion lead magnet as a downloadable PDF — structured HTML rendered via Chrome headless. Produces a self-contained, brand-matched asset with a forced-yes diagnostic hook, euro-quantified cost framing ("stille Steuer"), a self-assessment with scoring bands, the client's REAL framework, a real before/after case study, real social proof, and one focused CTA. Real client data only — every euro figure, case-study number and framework name comes from the scraped/provided client material or is marked [needs client input]; no fabricated testimonials, no invented "real" numbers. The euro-hook must pass the content-machine Founder-Voice guard before render. Use when the operator says "build a lead magnet", "create a PDF for lead gen", "make this a downloadable asset", or wants to turn a client's positioning into a gated PDF. NOT a blog post (→ content-machine derivatives), NOT a landing page (→ landing-copy), NOT a strategy report to an existing client. Shares conversion logic with landing-copy (diagnostic hook, value frame, proof, CTA) but delivers as a PDF artifact. Invisible delivery: the PDF carries the client's brand, never EVE's.
disable_model_invocation: true
---

# Lead Magnet PDF

> Provenance: EVE-authored field skill (2026-07), harvested + hardened into the public bundle.

A lead magnet is **a gated PDF that earns the email** — not a sales deck, not a whitepaper, not a
brochure. The reader trades their contact for one thing: a specific, actionable insight about
THEIR situation they didn't have before. The discipline: diagnose before you pitch, show the cost
of inaction in euros, let them self-assess, THEN present the framework and proof. If it reads like
a pitch from page one, it's not a lead magnet — it's a sales deck masquerading as one.

## When to use
- "Build a lead magnet", "create a PDF for lead gen", "make this a downloadable asset"
- Turning a client's positioning/framework into a gated asset
- Converting a sales deck or pitch into something that earns the download first
- NOT: a blog post (→ content-machine derivatives), a landing page (→ landing-copy), a strategy
  report to an existing client

## The method

### 1. Lock the ICP + the ONE diagnostic
One buyer, one pain, one insight they'll pay attention to. The lead magnet's title and hook must
be a **forced-yes diagnostic** the ICP can only answer "yes, that's me" — not a benefit claim. If
the title is "How to grow your business" it's generic; if it's "Die stille Steuer: wie viel Umsatz
dein Marketing-System täglich verbrennt" it's specific and diagnostic.

### 2. Voice guard on the hook — REQUIRED before you render
The euro-hook is the single most load-bearing line in the whole asset. Before you build any
sections around it, run the hook (title + subtitle + the "stille Steuer" framing) through the
**content-machine Founder-Voice and anti-slop guard** — the same voice check content-machine's
writer council applies. This is a REQUIRED gate, not an optional polish pass.

- If the client seat has a confirmed Founder Voice and Belief Model (FVBM), check the hook against
  it. If not, use the client's real website language as the voice reference and match register,
  cadence, and vocabulary to the live site.
- The hook must survive the anti-slop lens: no generic B2B filler, no "unlock your potential",
  no hollow superlatives. A euro-hook that reads like template copy is slop — it fails the guard
  and gets rewritten before render, not after.
- If content-machine has not captured the client's voice/sources yet, run content-machine first;
  a strong-voice hook without a real voice reference is a guess.

A hook that hasn't passed the voice guard does not proceed to Section 3.

### 3. Structure — 7 sections in conversion order

1. **Cover** — title, subtitle (the diagnostic promise), ICP qualifier, author. Dark background
   with accent color (gold/navy/etc). Subtle radial-gradient overlay for depth, not flat.
2. **Diagnosis / Pain Cards** — 3 specific pain points with euro-quantified impact each. Not vague
   ("growth stagnates") but concrete ("12.000–18.000 €/Monat fehlen dir"). Every euro range here
   must trace to the client's real material or be marked `[needs client input]` — see Section 5.
   Match the client's real framework and language from their website.
3. **Cost Calculation** — the "stille Steuer" concept: multiply missed opportunities × LTV ×
   timeframe = annual cost of inaction. One big number, one formula line. This is the emotional
   anchor that makes the reader want to keep reading. Frame it as a **Schätzrahmen mit dem Client,
   keine garantierten Zahlen** — see the disclaimer requirement in Section 5.
4. **Self-Assessment** — 6–8 yes/no questions. Each one is a diagnostic signal. Scoring bands at
   the end (e.g. 0–2 = stabil, 3–5 = risiko, 6–8 = kritisch). This is the interactive element that
   makes the PDF feel personalized. **After the scoring bands, add a per-level explanation block**
   (2–3 sentences per band describing what the score means and what to do next) plus a transition
   paragraph leading into the framework section. Without this, `page-break-inside: avoid` on the
   scoring box can create a mostly-empty page with just the box "klebt oben" — always add
   supporting content to fill the page naturally.
5. **Framework** — the client's real methodology, NOT an invented one. 3 pillars/steps, each with
   a title and 2–3 sentences. Match the exact naming from the client's website (e.g. "3 Säulen"
   not "Jabads-OS" if the site says "Säulen").
6. **Case Study** — real before/after table with exact numbers from the client. Revenue, budget
   scaling, time saved. Then 3 intervention points (what was done) with the framework's pillar names.
7. **Social Proof + CTA** — real credentials (mandate count, budget range, revenue scaled), real
   client names/logos from the website. Then a **single, focused CTA** — one action, one button,
   linked to the client's website. Multi-tier CTAs (free audit → strategy session → full engagement)
   dilute focus; a lead magnet works best when it drives ONE next step. One quote from the founder
   about who they work with.

### 4. Render — HTML → Chrome headless → PDF

Write the content as a single HTML file with embedded CSS (print-optimized, A4, page breaks).
Render via Chrome headless — NOT WeasyPrint (unreliable on macOS due to native lib dependencies).

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu \
  --virtual-time-budget=5000 \
  --print-to-pdf="output.pdf" \
  --no-margins --no-pdf-header-footer \
  "file://$(pwd)/source.html"
```

The `--virtual-time-budget=5000` flag is **required when using Google Fonts** — without it,
Chrome may not finish loading web fonts (Playfair Display, Lato, etc.) before rendering,
producing a PDF with fallback system fonts instead of the client's brand fonts.

See `references/chrome-headless-pipeline.md` for full pipeline details, pitfalls, and alternatives.
See `templates/lead-magnet-scaffold.html` for a copy-ready HTML/CSS scaffold with all section
types and print-optimized styles (dark cover, pain cards, big number, case table, CTA grid).

### 5. Integrate real data — no fabrication (HARD RULE)

**Every euro figure, every case-study number, and every framework name must come from the
scraped or client-provided material, or be marked `[needs client input]`.** Inventing a "realistic"
number to fill a gap is a doctrine VIOLATION, not a style slip — round-number case studies and
plausible-sounding euro ranges are the #1 credibility killer and read as "AI-generated" to a B2B
buyer. When in doubt, leave the placeholder and flag it; a `[needs client input]` marker is always
correct, a fabricated number never is.

**Before writing any content, scrape the client's real website:**
- Use `browser_navigate` + `browser_console` with `document.body.innerText` to extract all text
- Collect: real framework names, real case study numbers, real client logos/names, founder bio,
  real pain points as described on the site
- Replace ALL placeholder content with real data — fake testimonials, invented framework names,
  round-number case studies are the #1 credibility killer

**Cost-framing disclaimer (Section 3 "stille Steuer"):** the cost-of-inaction number is a
**Schätzrahmen mit dem Client, keine garantierten Zahlen**. State this explicitly in the PDF near
the big number (a short line such as "Schätzrahmen auf Basis deiner Werte — keine garantierte
Zahl"). The inputs (missed opportunities, LTV, timeframe) must be the client's real figures or
`[needs client input]`; never present a modelled estimate as a guaranteed or measured result.

**Verify replacements via pdftotext:**
```bash
pdftotext output.pdf - | grep -c "OldPlaceholderString"  # must be 0
pdftotext output.pdf - | grep -c "RealDataString"        # must be >0
```

### 6. Brand alignment — match the client's visual identity

The PDF must look like it came from the same brand as the client's website. Do NOT guess
colors, fonts, or dark/light patterns — extract them from the live site.

**Extract the client's real brand CSS via `browser_console`:**
- Navigate to the client's site, then run a JS expression that pulls:
  - CSS custom properties (`--primary`, `--secondary`, `--accent`, etc.)
  - Computed styles on `h1`, `h2`, `h3`, `button` (fontFamily, color, bg, weight)
  - Section background colors (walk the DOM, sample 8–10 sections)
- Map: accent color → PDF accent; heading font → PDF headings (import via Google Fonts);
  body font → PDF body; dark/light pattern → PDF section rhythm

**Common mismatches** (all real findings):
- Gold/amber accent in the PDF when the brand uses wine red — instant "generic template" tell
- Sans-serif headings when the brand uses Playfair Display (serif/editorial) — tonal break
- System fonts instead of the client's web fonts — feels like a different company

See `references/brand-alignment-extraction.md` for the full JS extraction snippet and
CSS mapping table.

### 7. Contrast & readability pass

Check every text/background combination:
- Light sections: body text `#2a2a3e` or darker on `#f5f5f8` backgrounds
- Dark sections: body text `#d0d0e0` or brighter on `#0d0d1a` backgrounds
- Lead/subtitle text: one step lighter than body (e.g. `#3a3a50` on light, `#c0c0d8` on dark)
- Never use mid-gray on mid-gray — if unsure, increase contrast, don't soften it
- Cover: `z-index: 1` on text containers to layer above background graphics

**Design harmony rule:** every interactive element (box, card, callout, table) must match the
color scheme of the section it lives in. A dark card on a light page is a design break that
immediately signals "template mismatch" to a design-conscious reader. Light section → light card
with accent border. Dark section → dark card with subtle fill. No exceptions.

### 8. Verify & deliver

**Text verification:**
```bash
pdfinfo output.pdf | grep Pages    # confirm page count
pdftotext output.pdf - | head -80   # scan first pages for content
pdffonts output.pdf                 # confirm web fonts are embedded
open output.pdf                     # visual check
```

**Visual verification (when active model has no vision):** for visual PDF QA — logo placement,
background-pattern/watermark visibility, opacity calibration, element positioning, page balance —
use the **`local-vision-qa` skill** (render pages to PNG, ask targeted yes/no questions via the
local Ollama vision model; images never leave the machine, DSGVO-green).

Deliver the PDF + the HTML source. The operator approves before any distribution.

## Pitfalls (learned the hard way)

- **write_file timeout on large HTML** — files >8K tokens time out on write_file. Use the `patch`
  tool for targeted edits, or `execute_code` with `terminal('cat ...')` + Python string
  manipulation for bulk replacements. Never retry the same large write_file call.
- **patch tool ACP denial** — some patch calls are silently denied by the ACP client. Fallback:
  `execute_code` running `sed -i ''` or Python `str.replace()` via terminal. Always verify the
  change took effect with `grep`.
- **Mixed encoding in HTML** — files may contain both raw Unicode (ä, €, —) and HTML entities
  (&uuml;, &euro;). Exact string matching fails silently when you guess wrong. Always `grep -n`
  the actual file content before attempting replacement to see which encoding is in play.
- **WeasyPrint is unreliable on macOS** — native library issues (pango, glib) persist even after
  `brew install pango glib`. Chrome headless is the reliable path. Don't waste time on WeasyPrint.
- **Dark elements on light pages = design break** — a dark card (e.g. `background: #1A1A1A`)
  placed inside a light `.section` looks like a foreign object. The operator's reaction:
  "das sieht scheisse aus." Fix: match the element's color scheme to the section it lives in.
  Light section → light card with accent border (`background: #FAFAFA; border: 1px solid #8B1E3F`).
  Dark section → dark card. The element should feel native to its page, not dropped in from
  another template. Verify with the `local-vision-qa` skill — ask "does this box look like it
  belongs on this page or does it look out of place?"
- **page-break-inside:avoid creates orphan pages** — when a protected block (score-box, case
  table) gets pushed to the next page, it leaves the previous page half-empty AND arrives at the
  top of the next page with no supporting content — a mostly-blank page with one box "klebt oben."
  Fix: DON'T just reposition the box — add contextual content around it to fill the page
  naturally: explanatory text per score level, transition paragraphs, a lead-in heading.
  The box should be ONE element among several, not the only thing on the page. Also reduce
  `margin-top` from 25mm to 8–10mm — the box doesn't need artificial push-down if it has
  content around it. The operator's reaction to an empty page: "seite 5 ist komplett leer bis
  auf den kasten und der klebt oben an der seite dran, das sieht scheisse aus."
- **Visual brand mismatch destroys trust** — a PDF with gold accents and sans-serif headings
  for a brand whose site uses wine red (#8B1E3F) and Playfair Display feels like a different
  company made it. Always extract the client's real CSS (colors, fonts, backgrounds) from their
  live site before finalizing the PDF design. See `references/brand-alignment-extraction.md`.
- **Fake data is the #1 credibility killer** — placeholder testimonials with initial-only names,
  round-number case studies, invented framework names all signal "AI-generated" to a B2B buyer.
  Always scrape real data first, then build around it. A `[needs client input]` marker is always
  safer than an invented number.
- **Framework name must match the real site** — if the client's website says "3 Säulen" but the
  PDF says "Jabads-OS", the mismatch destroys credibility. Always align naming to the live site.
- **Page-break splitting interactive elements** — Chrome headless will happily split a scoring
  table or evaluation block across two pages, leaving the first 2 rows dangling at the bottom of
  one page and the rest on the next. Fix: add `page-break-inside: avoid; break-inside: avoid;` to
  any block element that must stay together (score-box, case-study table, CTA grid, pullquote).
  ALSO move associated content (e.g. the "Tipp" note under a scoring table) INSIDE the
  break-protected `<div>`, not after it — otherwise the note floats to the wrong page while the
  table stays put. Verify by checking page boundaries with `pdftotext -layout -f N -l N` after
  every structural change.
- **CSS pseudo-elements don't render reliably in Chrome headless PDF** — `::after` with
  `content: "€"` (or any text content) may not appear in the rendered PDF at all. If you need a
  watermark glyph, decorative character, or any text-based visual element, use a **real HTML
  element** (`<div class="cover-euro">&euro;</div>`) instead of a CSS pseudo-element. Same rule
  applies to `::before` with text content.
- **Flexbox centering + margin-top conflict** — when a flex container uses
  `justify-content: space-between`, a child with `margin-top: 50mm` gets pushed to the top instead
  of being distributed evenly. Remove the `margin-top` and let the flex distribution handle
  vertical positioning. Verify centering via `browser_console` checking `getBoundingClientRect()`
  on each section — top and bottom gaps should be roughly equal.
- **Clickable links require real `<a href>` tags** — Chrome headless renders `<a href="...">` as
  clickable link annotations in the PDF by default. Plain `<div>` elements with link-like text
  are NOT clickable. To verify links are embedded, scan the raw PDF bytes:
  `data.count(b"/Link")` and `data.count(b"/URI")` — both must be > 0.
- **Font embedding verification** — after rendering with Google Fonts, run `pdffonts output.pdf`
  to confirm the web fonts (e.g. PlayfairDisplay, Lato) are embedded as subsets. If only system
  fonts appear, the `--virtual-time-budget` flag is missing or too low.
- **EXR logo files can't be embedded directly** — design-savvy clients may provide logos in
  OpenEXR format (`.exr`). Chrome headless cannot render EXR images in PDFs. Convert to PNG first
  via `ffmpeg -i logo.exr -update 1 logo.png`. Pillow and `sips` cannot read EXR.
- **Visual QA requires vision — don't retry non-vision tools** — when the active model lacks
  vision capability, `vision_analyze` and `browser_vision` return 502 errors. Retrying them
  wastes turns and frustrates the operator. Immediately use the `local-vision-qa` skill
  (local Ollama vision fallback) instead.
- **Background pattern opacity may be too subtle** — grid patterns or watermarks below ~8%
  opacity may be invisible in the rendered PDF. Use the `local-vision-qa` skill to verify
  visibility and bump opacity until the model confirms detection. Observed: 6% invisible,
  10% visible for grid patterns at 150 DPI.

## Output shape
Deliver: the **PDF artifact** (ready for the operator to review and gate), the **HTML source**
(for future edits), and a **change log** of what was integrated from real data vs. what was
written from the client's positioning vs. what is still `[needs client input]`. The operator
approves before distribution.

## Hard rules (EVE doctrine)
- **Real data only — fabrication is a violation, not a style slip.** Every euro figure,
  case-study number and framework name must come from the scraped/provided client material or be
  marked `[needs client input]`. Never fabricate testimonials, case study numbers, or framework
  names. Inventing a "realistic" number to fill a gap is a doctrine violation.
- **Voice guard before render.** The euro-hook must pass the content-machine Founder-Voice /
  anti-slop guard before any sections are built. A hook that reads like template copy is slop and
  gets rewritten first.
- **Cost framing is an estimate, not a promise.** The "stille Steuer" number is a Schätzrahmen mit
  dem Client — label it as such in the PDF; never present it as a guaranteed or measured result.
- **Never publish or distribute.** The PDF is a draft for the operator to approve. Distribution
  (email, landing page, gated download) is a separate human-gated step.
- **Per-client isolation.** One client's data, framework, and case studies never bleed into
  another's. Each lead magnet is built from that client's real truth only.
- **Invisible delivery.** The PDF carries the client's brand, never EVE's. No mention of the
  engine in the artifact.
- **Match the client's language.** If the client's site is German, the PDF is German. If the
  framework has a specific name on the site, use that exact name.

## Related skills
- `landing-copy` — shares the conversion logic (diagnostic hook, value frame, proof, CTA) but for
  web pages, not PDFs. Lock the ICP + diagnostic here, then build the PDF.
- `content-machine` — the substrate that feeds format-specific outputs and owns the Founder-Voice
  and anti-slop guard the euro-hook must pass. Run content-machine first if the client's
  voice/sources aren't captured yet; a lead magnet PDF is one such format output.
- `local-vision-qa` — the local (DSGVO-green) vision fallback for all visual PDF QA: logo
  placement, watermark/background opacity, layout balance, out-of-place elements.
