---
name: presentation-studio
description: Analyze, improve, redesign, or create editable PowerPoint presentations (.pptx), pitch decks, slides, and presentation files. Use for slide analysis, visual cleanup, deck redesign, speaker-ready deliverables, or when a user asks EVE to turn an existing presentation into a polished, coherent deck.
---

# Presentation Studio

Create presentation work that is visually strong, structurally clear, editable, and verified slide by slide. Use EVE's managed presentation engine; never ask a consumer to install OfficeCLI, run shell commands, download Ollama, or understand the underlying toolchain.

The managed document runtime already provides the supported PowerPoint, Word,
spreadsheet, PDF-structure, PDF-generation, image, QR, XML, and text-decoding
libraries. Never install `python-pptx`, PyMuPDF, or any other Python package in a
consumer task. PDF rendering and visual inspection use EVE's managed PDF/vision
path; PyMuPDF is deliberately not a runtime dependency.

## Choose the path

- **Analyze:** inspect the source and report narrative, content, hierarchy, layout, accessibility, and visual-quality findings. Do not rewrite the file unless asked.
- **Targeted edit:** preserve the source design and change only the requested slides or elements.
- **Redesign or create:** establish a visual target first, then build the complete editable deck to that target.

If a redesign or new deck has no already approved visual target, invoke `visual-direction-gate` first. Present three genuinely different image-based directions in chat, label them 1, 2, and 3, and wait for the user's selection. Do not silently choose a direction or begin the complete deck before that Human Gate.

## Source intake

1. Inspect the actual `.pptx` package and every slide; do not infer the deck from filenames or a single preview.
2. Render every slide locally before judging visual quality.
3. Treat the original presentation as private source material. Raw files and extracted contents remain local.
4. Before sending rendered slide images or extracted content to a cloud vision model, explain what will leave the device and obtain explicit consent. A refusal keeps the workflow local and must not trigger an Ollama or installation prompt.
5. Preserve the original file. Write results to a new, clearly named `.pptx` unless the user explicitly approves replacement.

## Build standard

- Keep titles, body copy, diagrams, charts, tables, and meaningful graphic elements editable whenever the format supports it.
- Never flatten a complete slide into a screenshot merely to imitate a design.
- Use real source or generated image assets. Never fabricate visible assets with emoji, ASCII, placeholder boxes, handcrafted SVG approximations, or CSS-like drawings.
- Use a coherent grid, deliberate whitespace, strong alignment, and clear information hierarchy.
- Prefer one primary idea per slide. Split overloaded slides instead of shrinking text into illegibility.
- Use presentation-scale typography. Avoid tiny body text, excessive centered paragraphs, arbitrary bolding, and inconsistent type scales.
- Maintain sufficient color contrast and never rely on color alone for meaning.
- Keep charts truthful: preserve labels, units, time ranges, sources, and data relationships.
- Avoid generic AI visual tropes, ornamental gradients without purpose, random floating cards, unnecessary pills, fake dashboards, and repetitive hero-slide layouts.
- Use restrained motion only when the user asks for it; the static deck must remain complete.

## Redesign workflow

1. Extract the deck's purpose, audience, desired decision, factual claims, and non-negotiable content.
2. Identify narrative gaps and propose a slide sequence before changing content materially.
3. Run `visual-direction-gate` and obtain the user's explicit 1/2/3 selection unless an approved target already exists.
4. Convert the selected direction into deck-wide tokens: palette, typography, grid, spacing, image treatment, chart style, and recurring components.
5. Build the deck as editable PowerPoint content. Reuse source brand assets where available.
6. Render every finished slide and compare it with both the approved direction and the source requirements.
7. Fix clipping, overflow, accidental overlaps, weak contrast, bad crops, inconsistent margins, broken fonts, and visual drift.
8. Validate the final `.pptx` package and reopen it before delivery.

## Required QA

Do not call a deck complete until all of these pass:

- the file opens successfully and contains the expected slide count;
- every slide was rendered and visually inspected after the final change;
- no text, image, chart, or table is unintentionally clipped or outside the canvas;
- fonts and fallbacks render consistently;
- the narrative and factual claims still match the source or the user's approved rewrite;
- meaningful content remains editable;
- the output path is explicit and the source file is unchanged;
- for a redesign, the result visibly follows the user's selected direction.

If any check fails, repair and rerun the full affected-slide QA loop. Report limitations plainly; do not hide them behind a successful file export.

## Safety and permissions

- Read only the user-selected file or project folder and the temporary working directory created for this task.
- Do not request broad home-directory or disk access.
- Do not upload the raw presentation, embedded files, notes, or extracted text without the user's explicit cloud-processing consent.
- Do not install packages, binaries, models, or fonts through user-facing prompts. Route missing managed-runtime components through the application's signed, verified bootstrap path.
- Do not publish, email, share, or overwrite the result without a separate explicit user action.
