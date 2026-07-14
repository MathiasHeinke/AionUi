# 1.7.1 — Board-UX + Kanban/CRM-Sichtbarkeit (OFFEN, Founder legt nach)

**Stand 2026-07-05.** Founder-Feedback nach dem 1.7.0-Live-Test. Bewusst OFFEN gehalten
("da kommt noch bissl was") — das hier ist der Sammel-Spec, nicht der finale Bauauftrag.

## Founder-Kern

Die Boards (Lokales Board · CRM Overlay · Marketing Board) sind heute **read-first + gate-schwer**.
Das ist für 1.7.0 OK (EVE/Hermes kann darüber Worker/Aufgaben/Deals **spawnen** + parent/child —
das funktioniert und ist der eigentliche aktuelle Wert). ABER: der **User** sieht/versteht kaum,
was angelegt wurde, kann nichts aufklappen/analysieren, und zwei Aktionen sind **kaputt**. Ziel
1.7.1+: sichtbarer + analysierbar machen, ohne die Governance aufzuweichen. Langfristig
"Software-in-der-Software" (echtes Trello/Asana-artiges Board inkl. Worker-Items).

## Klasse 1 — BUGS (müssen funktionieren — "wenn, dann muss es funktionieren")

1. **Marketing Board „initialisieren" schlägt fehl** → `KANBAN_MARKETING_BOARD_MISSING`
   ("Hermes marketing board has not been initialized yet"). Root cause (Diagnose): der Button
   erzeugt das native Hermes-Marketing-Board NICHT selbst — es existiert erst, nachdem Hermes/EVE
   nativ Kanban-Arbeit gemacht hat (die `kanban.db` unter `.../hermes/home/kanban/boards/marketing/`).
   _Fix-Richtung:_ „initialisieren" muss das Board real seeden ODER die Precondition ehrlich zeigen
   - einen echten Init-Pfad anbieten (nicht ein toter Button).
2. **„Proof-Karte anlegen" schlug fehl** → `KANBAN_GOVERNANCE_NOT_LOCKED`. **✅ GEFIXT (1.7.1, Codex-verifiziert).**
   Root cause war eine 1-Zeilen-Regression (`3d2a51b3b`, 2026-06-21): der Bootstrap setzt
   `kanban_auto_decompose:true` (ABSICHT — EVE baut den Work-Item-Baum vision→child), aber das
   Write-Governance-Prädikat verlangte an 15 Stellen weiter `auto_decompose_disabled` → immer false →
   jeder Kanban-Write blockiert. **Founder-Entscheidung 2026-07-05: auto-decompose bleibt AN**
   (Baum-Bauen ≠ Ausführungs-Autonomie). Fix: Helper `isKanbanWriteGovernanceLocked` = dispatcher-aus +
   externes-MCP-aus; Dispatcher/Cron/Worker-Spawn + das COMPA-626-Toolset-Gate bleiben hart aus. Codex
   bestätigte: Correctness-Fix, kein Gate-Softening (auto-decompose AN gewährt keine Dispatch/Spawn/MCP/
   Delete/Cross-Seat-Fähigkeit).
3. **Dispatch-Gate-Sicht: nicht vorhanden / funktioniert nicht.** Nur i18n-Strings da, keine echte
   Ansicht. _Fix-Richtung:_ die Dispatch-Gate-Ansicht bauen/verdrahten (NL-5-Preflight sichtbar
   machen: was würde ein Dispatch prüfen, was ist geblockt, warum).

## Klasse 2 — UX-EVOLUTION (Sichtbarkeit + Analyse, dann Interaktion)

Stufe A (1.7.1, „sichtbar + analysierbar", read-first bleibt):

- **Karten aufklappbar** — Detail-Ansicht pro Karte/Deal: Inhalt, zugewiesener Worker/Rolle,
  HumanGate-Level, Events/Audit-Trail, parent/child-Verknüpfung. (Heute: nur Titel + 2 Buttons.)
- **Provenienz sichtbar** — „von EVE/Hermes angelegt", wann, welcher Worker, welche Aufgabe. Der
  User sieht ehrlich, DASS + WAS angelegt wurde (Task/Deal/Assignment).
- **Qualität analysierbar** — Audit-Events pro Karte einsehbar; erkennen, ob Zuweisungen/Stufen
  stimmen. (Die Dinge, die EVE/Hermes zur Aufgabenerfüllung SEHEN muss, sauber angelegt + dem User
  gezeigt.)

Stufe B (später, „Software-in-der-Software", explizit NICHT 1.7.1):

- Echte Kanban-Interaktion: Karten anklicken/verschieben/bearbeiten (drag zwischen Spalten),
  Worker-Items darstellen + steuern — Trello/Asana-artig. Governance-Gates bleiben (Moves nur mit
  Audit-Receipt, Dispatch nur nach NL-5, kein Auto-Decompose ohne Freigabe).

## Leitplanken (dürfen NICHT aufgeweicht werden)

- Local-only bleibt, keine Cloud-Sync/Bulk-Import/Outreach-Automation.
- HG-Gates bleiben: Kundendaten HG-4, Dispatch HG-2.5, Moves nur mit Audit-Receipt, **dispatcher/
  cron/worker-spawn/externes-MCP bleiben aus** (der Write-Governance-Lock = dispatcher-aus + externes-
  MCP-aus + COMPA-626-Toolset-Gate IST das Sicherheitsversprechen). **auto-decompose ist bewusst AN**
  (EVE baut den Work-Item-Baum) — das ist Baum-Bauen, keine Ausführungs-Autonomie, und gehört NICHT
  zum Write-Gate (Founder-Entscheidung 2026-07-05).
- „Sichtbarer machen" heißt READ-Tiefe + ehrliche Provenienz — NICHT die Schreib-/Dispatch-Gates
  lockern. Interaktion (Stufe B) kommt mit denselben Gates, nicht ohne.

## Offen für Founder-Nachtrag

Founder legt nach ("da kommt noch bissl was"). Vor dem Bau: Founder-Additions einsammeln, dann
Klasse-1-Bugs zuerst (müssen funktionieren), dann Stufe-A-Sichtbarkeit. Ship als 1.7.1
(Desktop, eigener Notarize/R2 — oder gebündelt mit weiteren 1.7.1-Findings aus dem 8GB-Test).

## Nachtrag Connector-Katalog (Founder-Fund 2026-07-05 — „bei MCP läuft noch nicht alles sauber")

Diagnose (code-verankert, `renderer/pages/connectorCatalog/index.tsx`): **kein Logik-Defekt, gewolltes Gating** — aber zwei UX-Weichstellen derselben Klasse wie die Board-Dead-Buttons:

- **Klasse-1 (tote Buttons):** der Karten-Button (`:419-434`) ist nur aktiv für `primary_action ∈ {run_read_only_preflight, guided_auth_setup}` (`:421` `disabled={(!canRunPreflight && !isGuidedAuth) || running}`). Für `request_humangate` / `inspect_blocker` / `view_receipt` rendert er das Label („HumanGate anfordern") **disabled** → sieht kaputt aus. Fix: entweder `request_humangate` verdrahten (öffnet HG-Request-Flow) oder als Status-Chip statt Button rendern (kein klickbar-aussehendes Dead-Control).
- **Klasse-2 (ehrlichere Zustände):** „Auth nötig" auf der Kern-Hermes-Runtime + „Gated" auf 10 Connectoren ist Day-0 (State kommt NUR aus Preflight-Result-Files, es liegen erst 2 vor). Wirkt wie Ausfall, ist keiner. Freundlicheres „noch nicht verbunden / Preflight ausstehend" statt „Auth nötig" auf Kern-Komponenten.
- **Unangetastet (Absicht, NICHT lockern):** `mcp_enable_allowed:false`, http/sse/streamable_http blockiert, kein raw MCP-add, Write nur nach CEO/Codex + HumanGate. Das IST das Sicherheitsversprechen.
