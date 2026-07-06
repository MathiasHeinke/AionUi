# Command EVE 1.7.4 — Slice-Plan

**Datum:** 2026-07-06 · **Branch:** `houston/v16-onboarding` · **Status:** in Arbeit (reserviert in VERSIONS.md)

Vier weitgehend unabhängige Stränge. Jeder Slice: build → tsc 0 → Suite grün → finaler Codex-Audit (HARTER GATE) → dann erst gemeinsam Version-Bump + Notarize + R2 (founder-gated). Kein `Co-Authored-By`-Trailer.

## Geerdeter Ist-Stand (Sidebar-Map 2026-07-06)
**Existiert schon — NICHT neu bauen:** Volltext-Suche (Backend, Inhalt+Titel) · Live-Status-Dots (`sessionStatus.ts`: running/attention/error/done/idle) · Pin/Umbenennen/Löschen mit Bestätigung · Batch-Löschen · Per-Seat-Isolation (Epoch-Guard, `useConversationListSync.ts`) · Drag-Reorder (Pinned, `sortOrder`) · Auto-Titel (`useAutoTitle.ts` → `generateLocalTitle`, erste Nachricht, schützt manuelle Umbenennung — aber **lokal**).

## 1.7.4a — Chat-UX (Task #56)
- **Auto-Titel Cloud-Swap.** Heute `generateLocalTitle` (lokal Gemma, **unzuverlässig** — Founder bestätigt). Cloud-Pfad: **schlankes Server-Endpoint** (`eve-title` o.ä.) mit App-Key server-seitig → DeepSeek V4 Flash → kurzer Titel. **KEIN Entitlement-Draw** = app-cost, nicht Seat-Credit (Titel ≠ Kundenverbrauch; Founder-Entscheid (a) OpenRouter-direkt realisiert als Server-Endpoint, weil **kein Key in die DMG**). Renderer: `generateCloudTitle`-Bridge, Fallback cloud→lokal→truncated; manuelle-Umbenennung-Schutz bleibt. Nuance: Titel nach erstem **Austausch** (User+EVE) statt nur erster User-Nachricht. **Edge-fn-Deploy = FOUNDER-GATED.**
- **Archiv statt Hart-Löschen.** Löschen ist heute irreversibel (`conversation.remove`) → Kundenarbeit-Verlust-Risiko. `extra.archived`-Flag + `conversation.archive`-Bridge + Archiv-Filter/Section + Restore. Lokal (aioncore-DB), kein Deploy-Gate.
- **Last-Active-Zeit** in `ConversationRow` (Daten schon da via `time`/`updated_at`).

## 1.7.4b — Groups & Move (Task #57)
- Heute nur Auto-Gruppierung nach Workspace + Zeit-Buckets; Drag = nur Pinned-Reorder. Bauen: User-Ordner-Datenmodell (DB `extra.group_id`), „Neuer Ordner", „Verschieben nach…" (Kontextmenü), Drag zwischen Gruppen (`useDragAndDrop` über pinned hinaus), Batch-Move. **Entblockt kanban #14** (Batch-Move/Export deswegen deaktiviert).

## 1.7.4c — Skill-Härtung + Verästelung (Task #58)
31 Skills, alle model-invoked (0× `disable_model_invocation`), 1/31 nutzt `linked_files`, 23/31 duplizieren „For Command EVE"/„Hard Rules" (`eve-doctrine` existiert schon als Ziel).
- **2a** Doktrin-Sediment → Pointer auf `eve-doctrine` (Deletion-Test).
- **1c** `disable_model_invocation` auf Long-Tail (lead-magnet-pdf 20 KB, legal-enforcement-dach 15 KB, human-design-profile, voice-first-run).
- **1d** Beschreibungs-Diät (500–700 → ~150 Zeichen).
- **3a/3c** build-content-gate → generischer **Skill-Hygiene-Gate** (Größe ohne linked_files · Doktrin-Dup · fehlender Trigger). Verhindert das nächste 1.7.2-Drift-Desaster.
- **Verästelung** = Reference-Extraction (content-machine folder-struct, blog SEO/UWG-DSGVO → linked_files) + optional challenge-engine Split (grill-the-claim + verdict).

## 1.7.4d — Gemma Smoke-Test-Gate (Task #54)
Gemma lokal **unzuverlässig** (Founder). Post-pull streaming tool-call-Probe in `runtimeBootstrapCore.ts`; Tier-Readiness blocken + ehrlich in `localRuntimeStatusCore` melden bei Fail. Fasst runtimeBootstrap an → eigener Codex-Audit. Macht die Unzuverlässigkeit **sichtbar** statt still zu degradieren.

## Founder-Gates in 1.7.4
1. `eve-title` Edge-fn-Deploy (Supabase prod) — für Auto-Titel-Cloud.
2. Finaler Ganzrelease-Codex-Audit vor Version-Bump.
3. R2-Flip (yml zuletzt).
