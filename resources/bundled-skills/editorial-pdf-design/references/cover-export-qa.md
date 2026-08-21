# Cover export and QA

Use an editable HTML/CSS source and an already available signed or app-managed
browser PDF engine. Never install a browser or renderer during a user task.

When the managed environment exposes Google Chrome as the signed local renderer,
the compatible export shape is:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --virtual-time-budget=5000 \
  --no-pdf-header-footer --print-to-pdf="/absolute/output.pdf" \
  "file:///absolute/source.html"
```

Use the renderer already provided by the environment when that exact path is not
available. Do not convert its absence into an installation request.

Clean-install QA for the final output is mandatory. Run the structural probe
through the existing Hermes `execute_code` capability, using its managed
`pypdf` runtime; do not invoke generic host `python`:

```python
from pypdf import PdfReader

pdf = PdfReader("/absolute/output.pdf")
print({
    "path": "/absolute/output.pdf",
    "page_count": len(pdf.pages),
    "page_boxes": [
        [float(page.mediabox.width), float(page.mediabox.height)]
        for page in pdf.pages
    ],
})
```

This existing managed `pypdf` structural receipt proves that the final file
opens and records its page count and page boxes. It does not prove visual
quality.

Next, on macOS always render every page of the final PDF to one PNG per page
with the skill's native PDFKit helper. Keep the user's working directory
unchanged. Use the exact non-destructive pattern below: `mktemp` creates a fresh
task directory and the helper creates its unused `pages` child. Never prefix the
renderer with `rm`, `mkdir`, or another cleanup command:

```bash
eve_pdf_qa_root="$(mktemp -d /tmp/eve-pdf-qa.XXXXXX)"
/usr/bin/osascript -l JavaScript \
  "${HERMES_HOME}/skills-command-eve/editorial-pdf-design/scripts/render_pdf_pages_macos.jxa" \
  "/absolute/final.pdf" \
  "${eve_pdf_qa_root}/pages" \
  2
```

The final scale argument is optional and defaults to `2`. The helper uses only
macOS PDFKit/AppKit, creates the output directory, verifies every page write,
and emits one JSON receipt. Its `page_count` and page-numbered PNG list must
match the structural receipt. Then invoke Hermes' native `vision_analyze`
separately for every rendered PNG. Begin each question with the exact label
`Page N of M` and require the answer shape
`Page N: PASS/FAIL — concrete observation`; never submit unlabeled page images.
Inspect the full page: omit `region`, or use the rendered receipt's exact
`[0, 0, width, height]`; never send a zero-area crop such as `[0, 0, 0, 0]`.
Use this explicit defect checklist:

- clipped, cut-off, overlapping, or overflowing text and images;
- unreadable contrast, text, or labels;
- broken, missing, distorted, or badly cropped images;
- orphan headings, broken tables, accidental blank pages, bad page breaks,
  inconsistent margins, or misplaced footers;
- app-internal placeholders, temporary paths, or artifact notices in visible
  copy.

Record PASS or FAIL plus concrete findings for each page. Hermes chooses the
available vision route; a local model is optional, never a prerequisite, and
must not be installed or downloaded during the task. The final answer must list
every page separately as `Page N: PASS/FAIL —` followed by one concrete
page-specific observation. A range summary such as “pages 1–6 checked” is not
page-by-page evidence. If `vision_analyze` is
unavailable, any invocation fails, or evidence for even one expected page is
missing, stop with the exact sentinel `NEEDS_HUMAN`; do not deliver the PDF or
claim visual PASS.

On another platform, use a renderer only when it is already available and can
produce one verified PNG per page without an install. If no such renderer
exists, or the macOS helper fails, stop with the same `NEEDS_HUMAN` sentinel;
do not invent a managed renderer, deliver the PDF, or claim visual PASS.

Hermes `open_preview` plus `computer_use` may be used as an optional second
visual check when available. They neither replace nor gate the required
every-page `vision_analyze` pass.

For a designed report, page 1 should contain only cover-level text. Poppler
commands (`pdfinfo`, `pdftotext`, `pdfimages -list`) are optional diagnostics
only. On macOS, never use `pdftoppm` instead of the bundled PDFKit helper. On
another platform, an already-available renderer may be used as the fallback
described above; never install Poppler.
