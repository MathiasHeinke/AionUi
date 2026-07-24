---
name: local-vision-qa
description: Explicit OFFLINE/ON-DEVICE visual QA via an already installed local model or, only after informed user approval, an optional model download. Use solely when the operator explicitly asks for local, offline, private, or on-device image processing. Never trigger for routine image/PPTX analysis, never treat a cloud-model mismatch as permission to suggest Ollama, and never download a model silently. Images stay on this Mac. NOT for reading text or generating images.
disable_model_invocation: true
---

# Local Vision QA (lokale Bildsicht)

> Provenance: harvested from an EVE-authored field skill (2026-07-01) — EVE hit a
> 502 ("no endpoints found that support image input") while QA-ing a client PDF,
> pulled a local vision model herself, calibrated it empirically, and documented
> the craft. This is her method, hardened for every operator.

You can SEE — locally, but only when the operator deliberately chooses the
offline/on-device lane. Routine image and PPTX analysis belongs to Command EVE's
managed vision path and must not fall through to Ollama because an active chat
model lacks an image endpoint.
**The image never leaves this Mac** — that is the point: client material, drafts
and screenshots stay local, DSGVO-green by construction.

## Hard activation gate

- Activate only after an explicit request such as “lokal”, “offline”, “nur auf
  diesem Mac”, “on-device” or “darf die Cloud nicht verlassen”.
- A 502, a non-vision chat model, a PPTX attachment, or “analysiere dieses Bild”
  is **not** permission to propose, install or pull a local model.
- For ordinary image/PPTX analysis, use the managed presentation/vision lane.
- If the operator explicitly chose local-only and no suitable model is already
  installed, explain the exact download size and trade-off once, then wait for
  an explicit yes. Declining must never block ordinary cloud analysis outside a
  local-only request.

## When to use

- Visual QA of rendered artifacts: PDF pages, HTML→PDF output, social-post images,
  logo/format conversions, layout drafts.
- Explicitly local/offline “Schau dir das Bild an” requests when the managed
  cloud lane must not be used.
- NOT for reading text out of documents — use `pdftotext` (vision models
  hallucinate fine text). NOT for image GENERATION.

## Model resolution (in this order — never a silent multi-GB download)

1. **Only after the hard activation gate passed**, try the already-installed
   bundled model first. Probe once whether an
   installed `command-eve-gemma4-*` model accepts an `images` payload on
   `POST http://127.0.0.1:11434/api/generate` (tiny test image, short prompt).
   If it answers about the image content: use it — zero extra download.
2. **Fallback: `minicpm-v:8b`** (≈5.5 GB, proven for this craft). If it is not in
   `ollama list`, ASK the operator first — plainly: one-time download of ~5.5 GB,
   runs fully local, images never leave the Mac. Only pull after an explicit yes
   (`ollama pull minicpm-v:8b`, runs in background; check with
   `ollama list | grep minicpm-v`). If they decline, say exactly which visual
   check you therefore cannot perform — never pretend you verified it.

## The QA loop

### 1. Render PDF pages as PNG (when the target is a PDF)

Use EVE's managed PDF renderer first. If `pdftoppm` is already available inside
an approved managed publishing toolchain, the following is a compatible
fallback. Never install Poppler or another system package during the task.

```bash
pdftoppm -png -r 150 -f 1 -l 1 output.pdf cover_page   # page 1 @150 DPI
# files land as cover_page-1.png (page-number suffix). 150 DPI or higher —
# lower resolutions reduce detection accuracy.
```

### 2. Ask the local model — stdlib only

```python
import base64, json, urllib.request

def analyze_image(image_path, question, model="minicpm-v:8b"):
    with open(image_path, "rb") as f:
        img_b64 = base64.b64encode(f.read()).decode()
    payload = {"model": model, "prompt": question, "images": [img_b64],
               "stream": False, "options": {"temperature": 0.1, "num_predict": 400}}
    req = urllib.request.Request("http://127.0.0.1:11434/api/generate",
                                 data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=120).read().decode()).get("response", "error")
```

Use `urllib.request` (stdlib), **not** `requests` — the terminal Python may not
have it installed.

### 3. Structured questions beat open prompts

- ❌ "Describe this page" → vague, misses details.
- ✅ "Is there a large euro (€) watermark in the bottom-right corner? Answer yes or no."
- ✅ "What fraction from the top is the dark box positioned — 10%, 25%, 50%?"
- ✅ "Do you see a grid pattern of rectangles in the background? Answer yes or no."

### 4. Calibration loops (the killer move)

Use the loop to TUNE visual parameters instead of guessing: render at an initial
value → ask a targeted yes/no → adjust → re-render → repeat until confirmed.
Field-calibrated example (minicpm-v:8b @150 DPI): a 6%-opacity background grid was
NOT detected, 10% was ("faint grid pattern resembling graph paper"); a 12% €
watermark was detected on a targeted question.

## Format pitfalls (field-proven)

- **EXR logos**: Chrome headless cannot embed `.exr`. Convert with
  `ffmpeg -i logo.exr -update 1 logo.png` (sips/Pillow cannot read EXR; ffmpeg's
  "image sequence" warning is harmless with `-update 1`). Verify with `file logo.png`.

## Limitations & honesty (hard rules)

- Small vision models handle layout/position/element-detection well but
  **hallucinate on fine text** — text verification is ALWAYS `pdftotext`, never vision.
- First inference loads the model: 10–30 s. Say so instead of looking stuck.
- Never claim you looked at an image you did not actually process; never present
  a vision answer as certain when the model hedged. If the check matters
  commercially, show the operator the image alongside your finding.
- Everything stays local: never upload the image to a cloud lane to "double-check"
  without an explicit operator yes.
