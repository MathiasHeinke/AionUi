---
name: office-studio
description: Create or edit professional Word documents (.docx) and Excel workbooks (.xlsx) with EVE's signed managed document runtime. Use when the operator explicitly selects the Word or Excel composer mode, asks for a new editable document or spreadsheet, or attaches an existing DOCX/XLSX artifact for a non-destructive revision.
---

# Office Studio

Create editable Word and Excel deliverables with the managed runtime already supplied by the app. Never ask the operator to install packages, run shell setup, or understand the underlying document toolchain.

## Bind the explicit mode

Read `[COMMAND_EVE_WORK_PRODUCT_CONTEXT]` before acting.

- `mode=word` means the output is a `.docx` document.
- `mode=excel` means the output is an `.xlsx` workbook.
- `action=create` starts a new artifact from the operator's request and attached source material.
- `action=edit` revises the exact Office artifact attached to this turn. Treat it as the sole source unless the operator explicitly supplies additional files.

If the explicit mode, action, and available source contradict each other, stop and explain the mismatch. Never guess another file or silently switch formats.

## Word branch

1. Use `python-docx` from the managed runtime.
2. Preserve the source structure, styles, headings, tables, headers, footers, page settings, and embedded media unless the requested change requires otherwise.
3. Keep content editable. Do not flatten pages into images.
4. Write a new clearly named `.docx`; never overwrite the source.
5. Reopen the result and verify paragraphs, tables, relationships, and package integrity before delivery.

## Excel branch

1. Use `openpyxl` when reading or revising an existing workbook. Use `XlsxWriter` for a new workbook when its write-only strengths are appropriate.
2. Preserve sheet names, formulas, number formats, merged cells, widths, heights, frozen panes, validations, tables, charts, and conditional formatting unless the requested change requires otherwise.
3. Never replace formulas with displayed values. Never fabricate missing data.
4. Write a new clearly named `.xlsx`; never overwrite the source.
5. Reopen the result with `openpyxl` in formula-preserving mode and verify sheet count, formulas, named ranges, and package integrity before delivery.

## Shared quality gate

- Read only the active workspace and files explicitly attached to the turn.
- Keep raw source material local unless the operator separately approves cloud processing.
- Use only the signed managed runtime. Never run or suggest package-manager installation commands.
- Return the finished file through the existing artifact/file lane so it appears in chat, the Elements rail, and the Office preview.
- Report the output name, format, source-preservation status, and QA performed.
- Do not publish, email, share, or replace files without a separate explicit operator action.
