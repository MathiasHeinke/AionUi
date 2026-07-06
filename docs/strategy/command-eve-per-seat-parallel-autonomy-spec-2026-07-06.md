# Command EVE — Parallele autonome Agents pro Seat (Richtungs-Spec)

**Datum:** 2026-07-06
**Founder-Bedarf:** „In jedem Seat sollen autonom Aufgaben laufen — die Agents müssen separat laufen können." Heute killt ein Seat-Wechsel den laufenden Agent.
**Status:** SPEC / Richtungs-Entscheidung. **NICHT 1.7.x** (Wochen-Arbeit) — eigener 1.8-Strang. Der 1.7.3-Guard (kein Kill mitten im Stream) ist die getrennte Sofort-Entschärfung.

## Warum es heute nicht geht (FACT, code-verankert)
- **Ein aioncore-Backend pro App-Instanz**, an **einen** aktiven Seat gebunden. `activeSeatId` ist ein globaler Prozess-Holder (`seatContextCore.ts:342`).
- `HERMES_HOME` (Seat-Speicher) wird beim **Spawn eingefroren** (`runtimeBootstrapCore.ts:1144`). Man kann es einem laufenden Prozess nicht umhängen.
- Ein echter Seat-Wechsel MUSS daher das Backend **stoppen + neu starten** (`index.ts:1652` `backendManager.stop()` → respawn) — ISO-1-Contract. Das ist die **Isolationsschicht** (verhindert, dass Seat-A-State in Seat-B leakt = Cross-Client-Kontamination). **Kein Bug — load-bearing.**
- Folge: **Single-Active-Agent.** Parallele autonome Agents über mehrere Seats gleichzeitig sind so unmöglich.

## Drei Wege (mit Aufwand/Trade-off)
| Weg | Was | Aufwand | Trade-off |
|---|---|---|---|
| **A) Multi-Instanz** (`AIONUI_MULTI_INSTANCE=1`) | Eine App-Instanz **pro Seat**, jede mit eigenem Backend/HOME | **Tage** | N× RAM (Hermes+Gemma); 8 GB eng, 16 GB M1 Pro trägt ein paar Seats. Kein Rewrite. Schnellster Weg zu ECHTER Parallelität. |
| **B) Per-Seat-Worker-Detach** (empfohlen) | Autonome/Hintergrund-Arbeit läuft als **separate per-Seat-Worker-Prozesse** über den bestehenden **`eve-acp-launcher`-Seam** (per-Seat status/token/HOME, SG-1). Sie überleben einen Vordergrund-Seat-Wechsel. Der interaktive Vordergrund-Chat bleibt Single (killt on switch — ok, du chattest eh mit einem Seat). | **Wochen** | Sauberste Architektur; baut direkt auf SG-1/codex-image. Autonomie ≠ Vordergrund. |
| **C) Voller Multi-Agent-Pool** | Mehrere **Foreground**-Agents parallel im selben Fenster (per-Agent HOME-Binding, Agent↔Seat-Registry, Backend-Multi-DB-Routing, per-Agent Config-Cache, kein globaler Lock) | **~6-8 Wochen** | Größte Re-Architektur. Nur nötig, wenn du mehrere Live-Chats nebeneinander sehen willst. |

## Empfehlung: B (+ A als Sofort-Stopgap)
Der Founder-Bedarf ist „**autonome Tasks laufen pro Seat parallel weiter**" — das ist **Background-Autonomie**, nicht „mehrere Live-Chats nebeneinander". Dafür ist **B** der richtige Kern: autonome Arbeit gehört als **per-Seat-Worker-Prozess** (der einen Vordergrund-Switch überlebt), nicht als der eine Vordergrund-Backend-Chat. Das nutzt exakt die Naht, die SG-1 + codex-image (`eve-acp-launcher`, per-Seat status/token/HOME) schon gebaut haben. **A** (Multi-Instanz) als schneller Zwischenschritt, wenn JETZT Parallelität gebraucht wird.

**C nur**, wenn der Founder wirklich mehrere Foreground-Chats gleichzeitig in einem Fenster will.

## B — Bau-Skizze (wenn gewählt)
1. **Autonome Arbeit vom Vordergrund-Backend entkoppeln:** per-Seat Worker-Prozess via `eve-acp-launcher` (existiert), eigener HERMES_HOME + Lease/Attribution + Pause/Kill-Gate (SG-1), eigenes Log/Status-File.
2. **Worker-Registry** `{ seatId → workerPid, home, status }` (main-process) — überlebt Vordergrund-Switches; der globale `activeSeatId` steuert nur noch den VORDERGRUND-Chat.
3. **Isolation-Gate-Null** pro Worker (Cross-Seat-Denial-Test wie GATE-NULL) — jeder Worker schreibt nur in seinen Seat.
4. **UI:** „läuft gerade autonom" pro Seat sichtbar (Rail-Badge), Pause/Stop pro Seat.
5. **Perf/RAM-Gate:** N paralleler Worker × RAM — Cap + Warnung (8-GB-Air-Realität).

## ⭐ Forward-Kompatibilität — B darf C NICHT abschneiden (Founder-Entscheidung 2026-07-06)
**Founder: „Background-Autonomie reicht fürs Erste; parallele Foreground-Arbeit später nicht abschneiden."** Das ist umsetzbar, weil B und C **denselben Kern** brauchen: eine **Agent↔Seat-Registry** (`{ agentId → seatId, HERMES_HOME, port/pid, status }`) + **per-Agent-HOME-Binding** statt des heute globalen `activeSeatId`-Holders. Harte Bau-Vorgabe für B:
- Der Worker-Layer (B) führt die **Registry + per-Agent-HOME-Binding** ein — und trifft **keine** „genau ein aktiver Seat"-Annahme mehr auf Worker-Ebene.
- Damit ist **C = dieselbe Registry auf Foreground-Agents erweitert** (mehrere Foreground-Backends/Ports statt einem), kein Rewrite. B ist das Fundament, C der additive Schritt.
- Der globale `activeSeatId` steuert dann nur noch, welcher **Vordergrund-Seat sichtbar** ist — nicht mehr, welche Agents überhaupt laufen dürfen.
- Isolation bleibt in BEIDEN Stufen pro Agent hart (ISO-1/GATE-NULL je Registry-Eintrag).

## Scope-Guard
- **Nicht 1.7.x.** 1.8-Strang. **Founder-Entscheidung: B jetzt** (Background-Autonomie), C-Tür bleibt offen (siehe Forward-Kompatibilität). A optional als Sofort-Stopgap.
- Isolation (ISO-1, GATE-NULL) bleibt hart pro Worker — Parallelität darf die Cross-Seat-Trennung NIE aufweichen.
- 1.7.3-Guard (kein Kill mitten im Stream) ist die getrennte Sofort-Entschärfung, unabhängig davon.
