# Command EVE 1.7.2 — „Erste Schritte" wird der echte Onboarding-Hub (Spec)

**Datum:** 2026-07-06
**Founder-GO:** „nimm in 1.7.2 alles rein, was Onboarding laut unserer Definition beinhalten sollte."
**Basis-Analyse:** Gap-Sweep 2026-07-06 (3-gleisig: aktueller Tab · Definition · verstreute Flächen).
**Reconcile:** Class-2-Kanban-Karten (aufklappbar/Provenienz) → 1.7.3 (getrennter Diff). 1.7.2 = Onboarding-Hub, fokussiert.

## Problem (FACT)

`ErsteSchritteModalContent.tsx` ist heute ein **reiner Status-Spiegel** — dieselbe Readiness-Karte wie Chat-Greeting + Waiting-Banner, gespeist aus `useOnboardingStatus`. Für den Normalfall (Cloud-ready) fast leer. Deep-linkt auf nur 2 Ziele (`/settings/billing`, `/runtime`). Das Status-Modell (`onboardingStatusCore.ts`) kennt nur 6 Items (registration · license · cloud-lane · local-lane · memory-lane · identity). Alle echten Day-0-Aktionen (Gemma-Download, Company-Brain, Seat, Connectors, Team, Skills, Privacy) liegen verstreut, nur per Suchen auffindbar.

## Ziel

„Erste Schritte" = **geführter Hub**: Readiness OBEN (unverändert, claim-free) + darunter eine **Checkliste antippbarer Schritt-Karten**, je eine pro Day-0-Aktion, jede deep-linkt auf die **schon existierende** Zielseite. Überwiegend Verkabelung, keine neuen Seiten.

## Design

### Layout

1. **Readiness-Block (bleibt):** die bestehende `greeting`-Karte (startklar / fast geschafft + Blocker-Liste). Unverändert.
2. **NEU: „Nächste Schritte"-Sektion** — Grid aus Schritt-Karten. Jede Karte: Icon · Titel · 1 Satz · Status-Chip · Klick → `navigate(route)` bzw. Web-Action.

### Die Schritt-Karten (Reihenfolge = First-Value-Reachability)

| #   | Karte                                         | Ziel                                      | Status-Quelle (ehrlich)                                                           |
| --- | --------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------- |
| 1   | KI-Spur wählen (Cloud + optional Smart-Local) | `/settings/model` (+ `/settings/runtime`) | `first_value_ready` → „aktiv"; lokal: installed-Flag → „geladen" sonst „optional" |
| 2   | Company-Brain seeden                          | `/settings/company-brain`                 | Brain-Seed-Status (falls erkennbar) → „geseedet" / „offen"                        |
| 3   | Ersten Kunden anlegen (Reseller)              | In-App `/settings/account`                | Seat-Count > 1 → „angelegt" sonst „optional"                                      |
| 4   | Integration verbinden                         | `/settings/connectors`                    | „optional/entdecken" (kein false todo)                                            |
| 5   | Dein Team / Belegschaft                       | `/settings/eve-runtime`                   | „optional/entdecken"                                                              |
| 6   | Was EVE kann (Skills)                         | `/settings/capabilities?tab=skills`       | informativ                                                                        |
| 7   | Datenschutz / Telemetrie                      | `/settings/privacy`                       | Preference, neutral „öffnen"                                                      |
| 8   | Budget & Guthaben                             | `/settings/billing`                       | neutral „öffnen"                                                                  |
| 9   | Sag EVE, wie sie dich nennen soll             | Identity-Confirm (bestehendes Item)       | `identity` blocked → „offen" sonst „erledigt"                                     |

### Ehrlichkeits-Doktrin (HART — nicht aufweichen)

- **„Erledigt ✓" nur wo real erkennbar** (first_value_ready, lokales Modell installed, Seat-Count, identity-confirmed, Brain-Seed-Flag). Wo NICHT billig erkennbar (Connectors/Team/Skills/Privacy): **neutraler „→ öffnen"-Zustand**, NIE ein rotes „todo/versäumt". Kein „alles erledigt", das wir nicht beweisen.
- Readiness-Karte bleibt claim-free; keine erfundenen Häkchen.
- Kein neuer Cloud-Call, keine neue Egress-Fläche.

### Wiring (die Zielseiten + Redirects existieren alle schon)

- **`targetToRoute`** (`OnboardingReadinessGreeting.tsx:47-62`) um Cases erweitern: `connectors`→`/settings/connectors`, `privacy`→`/settings/privacy`, `company-brain`→`/settings/company-brain`, `capabilities`→`/settings/capabilities?tab=skills`, `eve-runtime`→`/settings/eve-runtime`, `model`→`/settings/model`. Kunden-Seats werden kostenlos in `/settings/account` verwaltet.
- Die Schritt-Karten sind eine **neue Renderer-Sektion in `ErsteSchritteModalContent.tsx`** — eigene Liste (nicht die Blocker-Gap-Liste, die nur `blocked` zeigt). Sie liest bestehende Signale (`first_value_ready`, lokales-Modell-Status, Seat-Count, Brain-Seed) best-effort; wo kein billiges Signal → neutral.
- **Status-Detection minimal halten:** nur billige, schon vorhandene Reads wiederverwenden. Kein großer neuer Aggregator in 1.7.2 (Auto-Detect-alles = Follow-up). Lieber ehrlich-neutral als teuer-erraten.

### Cleanups (mitnehmen)

- Toter `error ? null : null`-Ausdruck (`ErsteSchritteModalContent.tsx:121`) raus.
- `identity`-Gap kriegt einen Link (heute `link_target:'none'`).

## Build-Slices

1. **Hub-Datenmodell (Renderer-seitig):** eine `ersteSchritteHubSteps(...)`-Core-Funktion (pure, testbar) die aus vorhandenen Signalen die 9 Karten + ehrliche Status-Chips ableitet.
2. **`targetToRoute`-Erweiterung** + Seat-Add-Web-Action.
3. **UI-Sektion** in `ErsteSchritteModalContent.tsx` (Grid, i18n DE+EN, claim-free) + Cleanups.
4. **Tests:** Core-Unit (ehrliche Status-Logik: erledigt nur wo beweisbar) + DOM-Smoke (Karten rendern, Klick navigiert).
5. **Codex-Audit** (Fokus: keine false „erledigt"-Claims) → Ship 1.7.2 (founder-gated R2).

## Scope-Guard

- NUR der Hub. Keine neuen Zielseiten (existieren). Keine neue Egress-/Cloud-Fläche.
- Ehrlichkeit über Vollständigkeit: neutral statt erfundenes Häkchen.
- Class-2-Kanban → 1.7.3. Hermes bleibt 0.17.0.
