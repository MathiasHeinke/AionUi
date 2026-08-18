# HANDOFF 1.823.2 — Stand 2026-08-18 (vor Codex-Neustart)

## Ausgeliefert
- 1.823.1 dev LIVE (notarisiert, R2, deployed). Alois testet; Befunde unten = 1.823.2-Scope.
- Worktree: dieser hier (eve-18230-18225-integration), HEAD aa7e59636, ~71 uncommitted Dateien. NICHT verwerfen.
- Company.OS-Repo dirty (preserve). Edge-SSOT: supabase/functions/_shared/eve-inference-core.ts, credits-core.ts, eve-title-core.ts. _shared-Tests sind .mjs (node:test).
- Linear: Parent MAT-1624.

## Modell-Leiter FINAL (Founder-Entscheid 2026-08-18)
- standard = openai/gpt-5.6-luna (kein Reasoning-Default)
- high = Luna + effort "high"
- xhigh = moonshotai/kimi-k3 + effort "xhigh"
- max = Kimi K3 + effort "max"
- Grok 4.6: KEIN Slot. MAX-Eval 2026-08-18: Kimi 9.13 vs Qwen 8.79 vs Grok 8.21 (2 Blind-Judges), Kimi TTFT p50 13.6s, E2E p50/p90 15.8/53.5s, Vision 28/28, 0 Halluzinationen. Rohdaten /tmp/ceve-max-eval-20260818/ (fluechtig!).
- DeepSeek/Gemini/GLM komplett raus — auch KEINE Hintergrund-Tool-Kette mehr.
- Credit-Multiplikatoren UNVERAENDERT (standard 1.3, high 4, xhigh 2, max 2).
- Vision: Kimi K3 nimmt nativ text+image+video (live verifiziert) → Bild/Video in MAX bleibt auf Kimi.
- Dokumente: Kimi hat KEINE file-Modalitaet → Luna als Leseschicht extrahiert, Kimi reasoned ueber die Extraktion (KEIN stiller Full-Turn-Fallback auf Luna). Diese Doc-Leseschicht ist NOCH ZU BAUEN.

## Modell-Umbau — ABGESCHLOSSEN (Stand 2026-08-18, alle Gates gruen)
FERTIG:
- eve-inference-core.ts: FREE_LANE=luna; MODEL_BY_TIER luna/luna/kimi-k3/kimi-k3; REASONING none/high/xhigh/max; Kommentare auf Kimi+Eval-Evidenz. Behalten (kein Rename): glmTasteAttempted/Served, drawGlmTaste, RPC command_eve_draw_glm_taste.
- eve-title-core.ts: luna. credits-core.ts: Kommentar (nochmal pruefen: muss Kimi sagen, nicht Grok).
- eve-inference-ladder.test.mjs: auf Luna+Kimi aktualisiert — lief gruen VOR dem Kimi-Swap, RE-RUN noetig.

### VERIFIZIERT am 2026-08-18 (gelesen, nicht erinnert)
- eve-inference-core.ts:51 FREE_LANE_MODEL="openai/gpt-5.6-luna"; :94-103 MODEL_BY_TIER standard/high=luna, xhigh/max=moonshotai/kimi-k3; :116-120 REASONING high/xhigh/max. KORREKT, nichts zu tun.
- eve-title-core.ts:15 EVE_TITLE_MODEL="openai/gpt-5.6-luna" (Zeile 15, nicht 13). KORREKT.
- credits-core.ts NOCH FALSCH (nur Kommentare, Faktoren bleiben): :30 "Gemini Flash (standard, 1.3x)" -> Luna; :61 "xhigh/max (Grok 4.6) 2x" -> Kimi K3; :62 "SAME model (Grok 4.6)" -> Kimi K3; :65 "Luna/Grok ladder switch" -> Luna/Kimi.
- cloudModelIdentifiers.ts NOCH FALSCH: :56 'x-ai/grok-4.6' aktiv gelistet, Header :41-42 sagt "xhigh/max use x-ai/grok-4.6". 'moonshotai/kimi-k3' steht schon auf :69, aber im RETIRED-Block -> aktiv hochziehen, grok-4.6 nach retired, Header umschreiben.
- Alte Modell-IDs in Tests (rg -c "deepseek|gemini-3.7|glm-5.2|grok-4"): eve-inference-credits.test.mjs 10, eve-inference-stream-usage.test.mjs 11, credits-core.test.mjs 3, buy-spend-invariance-core.test.mjs 1, eve-inference-seat-attribution.test.mjs 1.
- Version steht auf 1.823.1: package.json + runtimeBootstrapCore.ts:1092 + :1651 (plus public/*.json wie beim letzten Bump) = die Stellen fuer 1.823.2.
- Worktree HEAD aa7e59636 "test(command-eve): keep partial bootstrap receipts non-authoritative", 72 uncommittete Eintraege. Company.OS dirty (u.a. AGENTS.md, docs/releases/VERSIONS.md) — beides erhalten.

### DANACH GEBAUT UND VERIFIZIERT (gleiche Session)
- credits-core.ts: Kommentare auf Luna/Kimi K3 korrigiert (Gemini- und Grok-Reste raus). Faktoren unveraendert.
- cloudModelIdentifiers.ts: 'moonshotai/kimi-k3' ist jetzt die AKTIVE xhigh/max-Route, 'x-ai/grok-4.6' als retired-Eintrag in der Scrub-Liste behalten, Header neu. Abgedeckt durch modelIdentifierScrub.test.ts:658 (namentlich!) und eveCloudContextWindow.test.ts:38.
- eve-inference-credits.test.mjs: alle Modell-IDs auf Luna/Kimi. INHALTLICHE Aenderung, nicht nur Umbenennung: der Test "high stays Pro" konnte standard und high nicht mehr ueber den Modellnamen trennen (beide Luna) — er prueft jetzt Geld (high-Faktor 4) + server-injizierten Effort "high" + unberuehrten Free-Counter. Stale Kommentare Faktor 5->4 (125->100, 150->120) korrigiert.
- eve-inference-stream-usage.test.mjs: Preistabellen neu abgeleitet statt umbenannt — Luna 0.20/1.20, Kimi 3.00/15.00 USD/M; makeCost() Reserve-Raten 0.11 / 1.38 €ct pro 1k out. Erwartungswerte nachgerechnet: max-Reconcile 4 statt 1 Credit, Reserve-Fallback 114 statt 23 Credits, kleine Standard-Zeile bleibt 1 Credit. PER_TIER_CASES hat jetzt standard UND high auf Luna — der Unterschied ist der Faktor, nicht das Modell.
- credits-core.test.mjs, buy-spend-invariance-core.test.mjs, eve-inference-seat-attribution.test.mjs: Fixture-Labels auf Luna.
- eve-inference-core.test.mjs (c2): Der Leak-Sentinel war "gpt-5" — der matcht jetzt unser EIGENES Standardmodell gpt-5.6-luna und wurde faelschlich rot. Sentinel auf 'mistralai/mistral-large-2512' geaendert (teilt bewusst keinen Praefix mit einer kuratierten ID). Das war KEINE Regression, aber eine echte Falle des Modellwechsels.

### GATES GELAUFEN (alle gruen)
- node --test ueber ALLE 28 _shared-Suiten: 0 Fehlschlaege (u.a. inference-core 33, credits 22, stream-usage 14, ladder 5, max-parity 16).
- bunx vitest run tests/unit/command-eve: 380 Dateien, 5343 pass, 5 skipped, 0 fail.
- bunx vitest run tests/unit/renderer: 160 Dateien, 1550 pass, 0 fail.
- bunx tsc --noEmit: Exit 0. (Hinweis: Exit-Code ueber Logdatei holen, ${PIPESTATUS[0]} ist in zsh leer.)
- Worktree danach unveraendert: HEAD aa7e59636, 72 Eintraege, nichts committet/gestasht.

### DOKTRIN NACHGEZOGEN
- AGENTS.md "Command EVE Modell-Routing": komplett neu. Vier Sprossen/zwei Modelle, DeepSeek-Toolkette ersatzlos gestrichen, Bild+Video nativ auf beiden Sprossen, Dokumente = Luna-Leseschicht + Kimi-Reasoning (kein stiller Voll-Fallback), MAX-Messwerte, Regel 5 neu (Multiplikatoren haengen nicht am Modellnamen). Abgrenzung zur "Modell Rollen Doktrin" (Codex-Lane) ausdruecklich hingeschrieben.
- docs/operations/command-eve-model-routing-evidence.md: Ueberholt-Hinweis oben, Dokument sonst unveraendert (traegt weiter die Standard-Entscheidung + die Messfehler-Tabelle).
- MAX-Eval-Rohdaten aus dem fluechtigen /tmp gesichert nach docs/operations/evidence/command-eve-max-eval-2026-08-18/ inkl. README mit aus den jsonl NACHGERECHNETEN Tabellen (nicht aus dem Bericht uebernommen): Kimi 9.13 / Qwen 8.79 / Grok 8.21, erste ANTWORT p50 13.2s vs 18.8s vs 22.9s, e2e p90 34.3/50.2/84.3s, Kimi 5 Provider 0 Fehler, Vision alle 8/8, Gesamtkosten 1.26 USD.

### OFFEN AUS DIESEM BLOCK
- Doc-Leseschicht (Luna liest, Kimi denkt) ist DOKTRIN, aber NOCH NICHT GEBAUT. Das ist der naechste Code-Schritt der Modell-Lane.

OFFEN (Reihenfolge):
1. packages/desktop/src/common/config/cloudModelIdentifiers.ts (Achtung: src/common/config/, NICHT src/process/...): x-ai/grok-4.6 → moonshotai/kimi-k3, Header-Kommentar.
2. credits-core.ts Kommentar Kimi statt Grok.
3. eve-inference-credits.test.mjs: ~217-230 Gemini→Luna; ~244/253 Wording; ~257-276 free-lane deepseek→luna; ~309/324 FREE-seat→luna; ~367-391 M6-A gemini→luna; ~431 deepseek→luna; ~440-458/484 "high stays Pro"→Luna, deepseek-v4-pro→luna, stale Kommentare Faktor 4→100/1000; ~659-716 GLM-Kostprobe: Testnamen/glmTasteCount-Fixtures behalten, z-ai/glm-5.2→kimi-k3 (~672,~715), Kommentar Faktor 2→80.
4. eve-inference-stream-usage.test.mjs: USD_PER_MTOK luna {0.20/1.20}, kimi-k3 {3.00/15.00} (~131-134, ~317-319); PER_TIER_CASES (~325-327); Kommentar ~247; Testname "PAID(max/GLM)" ~228; Assertion ~268; small-Gemini-row ~389-417→Luna.
5. Fixture-Labels: buy-spend-invariance-core.test.mjs:181, credits-core.test.mjs:190/200/223(+~218), eve-inference-seat-attribution.test.mjs:83.
6. NICHT anfassen: supabase/functions/eve-multimodal/image-model-registry.ts (eigene Image-Lane).
7. Gates: node --test auf allen _shared-Tests; im Worktree bunx vitest run tests/unit/command-eve + tests/unit/renderer, bunx tsc --noEmit; deno test in eve-multimodal.

## Alois-Befunde 1.823.1 → 1.823.2
1. 504 nach ~6-7 Nachrichten (150s idle, msgs=59, ~116k Tokens): v60 puffert komplettes SSE (await upstream.text(), Debit vor erstem Byte) + Tool-Search-Bridge-Extrarunde + chat_completion_helpers.py "if not tool_calls_acc:" friert Text bei Toolcalls ein (= Berichtspflicht-Blocker). Fix-Plan: Status-Delta an der Werkzeuggrenze durchlassen; Hermes-Wheel-Aenderung via runtimeBootstrapCore.ts Shim-Patch + shimPatchLedger.test.ts. Echtes Streaming = Escrow-Ledger-Migration (groesser, erst besprechen).
2. Image-Edit Approval-Dialog erscheint nicht (Commit 825de4818 ACP-Callback-Routing — verifizieren).
3. Artefakt-Kontinuitaet: kanonische Projektordner-Ablage + private Retention-Kopie (30d Sweep) IMPLEMENTIERT; noch offen: Download-Button, Anzeige im rechten Browser-Pane, Folge-Bearbeitung ohne Verlust.
4. Edit-Modus Modell-Lock: nur zuvor gewaehltes Modell waehlbar.
5. Web-Search-Provider fehlt in Alois' Seat.
6. Auto-Projekt-Karte haesslich → AAA-Dialog mit Auswahlbox.
7. Sticky Tool-Modus + X-Exit an Tool-Pills: im Worktree, 31/31 gruen.

## Doktrin (dieser Turn)
- AGENTS.md "Command EVE Modell-Routing" neu: DeepSeek raus, Luna Standard, Kimi K3 MAX (native Vision), Dokumente via Luna-Leseschicht. Evidenz-Addendum in docs/operations/command-eve-model-routing-evidence.md.
- Berichtspflicht-/Ruhezeit- und Streaming-Doktrin: unveraendert gueltig.

## Danach
Edge-Functions deployen → Bump 1.823.2 → Notarisierung → R2 → Deploy → Fable 5 (tmux, claude-code-tmux-delegation) + Kimi K3 (CLI) Re-Review → Paid E2E (Budget 20 EUR, ~0 verbraucht).
Deferred: Seat-Self-Service-Bug → 1.823.3. Hermes-Gesamtverkabelung → 1.824.0.

## paid_e2e_proof_18231 Erkenntnisse (fuer E2E wiederverwenden)
- Computer Use funktioniert (Rolle "HTML-Inhalte", nicht AXWebArea).
- Kaltstart-Race: erster Chat nach Frischinstallation schlaegt fehl (USER_AGENT_STARTUP_FAILED, bare "hermes" in Registry bis Shim geschrieben; runtimeBootstrapCore.ts:12713; heilt nach Neustart).
- Bundle-Diagnostik nur mit PYTHONDONTWRITEBYTECODE=1 (.pyc bricht codesign).
- Projekt-Bindungsmenü listete frisch erstelltes Projekt nicht.
- 8-Prompt-Espresso-Suite + /tmp/eve-18231-verify-artifacts.sh liegen bereit.
