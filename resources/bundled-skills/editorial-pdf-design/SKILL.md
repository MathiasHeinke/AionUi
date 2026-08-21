---
name: editorial-pdf-design
description: Create, export, redesign, edit, review, or visually QA polished PDFs and reports with deliberate layout, embedded real images, an editable source, and rendered-page QA. Use for existing PDFs, general PDF documents, covers, brochures, and reports; use lead-magnet-pdf only for an actual lead-generation asset.
---

# Editorial PDF Design

Build PDFs as designed publications, not as raw Markdown or office-printer exports.
Preserve the user's facts and requested document type; do not turn every PDF into a
lead magnet or force a long report structure onto a short document.

> Provenance: EVE-authored field skill, captured from a real Command EVE PDF QA
> turn on 2026-08-20 and narrowed into the general PDF production owner.

## Workflow

1. Inspect the source text, selected artifact, real image files, output folder,
   and project context before choosing a layout.
2. Decide the document architecture from the request. For a designed report,
   keep page 1 as a real standalone cover and begin body content on page 2. A
   short memo, form, or utility PDF does not need an invented cover.
3. If the user requests a redesign without supplying a visual target, invoke
   `visual-direction-gate` before implementation. A supplied screenshot,
   template, brand guide, or accepted direction is already the target.
4. Build an editable source in HTML/CSS or another layout-capable format. Use
   real text and real image files. Do not use visible placeholders, app-internal
   artifact notices, or Markdown styling as a substitute for a designed cover.
5. Search the active project first, then approved user locations such as
   Downloads, before claiming an image is unavailable. Prefer the project's
   `bilder/` folder and keep PDF plus editable source in `dokumente/`.
6. Export through an available signed or app-managed browser/PDF path. Do not
   install browsers, renderers, packages, or provider tooling during the task.
7. Verify the latest PDF, not an earlier draft:
   - run the structural probe through the existing Hermes `execute_code`
     capability, using its managed `pypdf` runtime; do not invoke generic host
     `python` and do not call `terminal` from inside `execute_code`. Pass Python
     beginning with `from pypdf import PdfReader` directly as `execute_code`'s
     `code`; record that the final file opens, its page count and page boxes
     match the export;
   - on macOS, always render every page of the final PDF to one PNG per page
     with the skill's native PDFKit helper. Keep the user's working directory
     unchanged. Use the exact non-destructive pattern below: `mktemp` creates a
     fresh task directory and the helper creates its unused `pages` child. Never
     prefix the renderer with `rm`, `mkdir`, or another cleanup command:

     ```bash
     eve_pdf_qa_root="$(mktemp -d /tmp/eve-pdf-qa.XXXXXX)"
     /usr/bin/osascript -l JavaScript \
       "${HERMES_HOME}/skills-command-eve/editorial-pdf-design/scripts/render_pdf_pages_macos.jxa" \
       "/absolute/final.pdf" \
       "${eve_pdf_qa_root}/pages" \
       2
     ```

     The final scale argument is optional and defaults to `2`. The helper uses
     only macOS PDFKit/AppKit, creates the output directory, verifies every
     page write, and returns one JSON receipt. Require its `page_count` and
     page-numbered PNG list to match the structural receipt;

   - on another platform, use a renderer only when it is already available in
     the environment and can produce one verified PNG per page without an
     install. If no such renderer exists, or the macOS helper fails, stop with
     the exact sentinel `NEEDS_HUMAN`; do not invent a managed renderer,
     deliver the PDF, or claim visual PASS;
   - invoke Hermes' native `vision_analyze` separately on every rendered PNG.
     Begin each question with the exact label `Page N of M` and require the
     answer shape `Page N: PASS/FAIL — concrete observation`; never submit
     unlabeled page images. Inspect the full page: omit `region`, or use the
     rendered receipt's exact `[0, 0, width, height]`; never send a zero-area
     crop such as `[0, 0, 0, 0]`.
     For each page, require an explicit PASS/FAIL check for clipped or
     overlapping content, unreadable contrast or text, broken or missing
     images, bad crops, overflow, orphan headings, broken tables, accidental
     blank pages, inconsistent margins, footers, and page breaks, plus any
     app-internal placeholder or temporary-path copy;
   - retain page-by-page evidence that maps every expected page number to its
     rendered PNG and `vision_analyze` result. Hermes chooses the available
     vision route; a local model is optional, never a prerequisite, and must
     not be installed or downloaded during the task;
   - the final answer must list every page separately as `Page N: PASS/FAIL —`
     followed by one concrete page-specific observation. A range summary such
     as “pages 1–6 checked” is not page-by-page evidence;
   - if `vision_analyze` is unavailable, any invocation fails, or evidence for
     even one page is missing, stop with the exact sentinel `NEEDS_HUMAN`; do
     not deliver the PDF or claim visual PASS;
   - Hermes `open_preview` plus `computer_use` may be used as an optional second
     visual check when available, but they neither replace nor gate the
     required every-page `vision_analyze` pass;
   - Poppler commands such as `pdfinfo`, `pdftotext`, and `pdfimages -list` are
     optional diagnostics only. On macOS, never use `pdftoppm` instead of the
     bundled PDFKit helper. On another platform, an already-available renderer
     may be used as the fallback described above; never install Poppler;
   - reopen the PDF before delivery.

8. Deliver the PDF and editable source with clear paths and a short result
   summary. Never claim an image is embedded or a redesign is complete without
   the corresponding verification evidence.

## Editing an existing PDF

- Treat the selected PDF as source material and create a new version; never
  overwrite the original.
- Use the file actually attached by Command EVE. Do not infer a path from chat
  prose or from an opaque artifact id.
- Preserve confirmed facts, links, accessibility, and useful document structure.
- When the original source format is unavailable, rebuild only what is needed
  in an editable source and state that honestly.

## Visual standard

- Use deliberate typography roles, spacing rhythm, section hierarchy, and image
  treatment instead of decorative card grids or generic AI gradients.
- A report cover is a complete composition, not a title followed immediately by
  the first chapter. Keep cover copy restrained and readable.
- Use the user's brand assets and visual language when available. Do not invent
  logos, testimonials, proof, statistics, or brand claims.
- Keep real text selectable and links functional; do not rasterize every page.

## Common failure modes

- Exporting raw Markdown and calling the existing file a polished PDF.
- Reporting success because a file exists without rendering the pages.
- Writing "Titelbild" while failing to embed the actual image.
- Leaking temporary-path or app-artifact wording into the delivered document.
- Applying lead-magnet hooks, euro framing, proof, or CTAs to a neutral report.
- Asking the user to install Chrome, Poppler, Python packages, or Office tooling.

Read [references/cover-export-qa.md](references/cover-export-qa.md) when the
task needs a designed cover or browser-based PDF export.
