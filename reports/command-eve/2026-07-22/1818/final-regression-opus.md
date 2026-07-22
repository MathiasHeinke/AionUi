# Command EVE 1.818 — finaler Regression-/Security-Pass (Opus)

Datum: 2026-07-22
Scope: `8876ad81` bis 1.818-RC inklusive Founder-Auth/Brand/Identity/First-Run-Deltas
Worker: Claude Code Opus, read-only CLI-Adapter
Authority: Review בלבד; kein Commit, kein Plane-Done, kein Release

## Verdict

**SHIP-WITH-CAVEATS — keine P0/P1-Blocker.**

Der Audit konvergiert mit dem lokalen Integrator-Pass. Der aktuelle Delta ist
security-positiv: Provider-Row/Nonce-Reconcile, Loopback-Auth, Deep-Link-Grenze,
Context-Menu, Identity-Provenienz und Brand-Build-Gate sind kohärent und
zielgerichtet.

## Frische Reviewer-Evidenz

- fokussierte 1.818-Suite im Audit: 12 Dateien, 116 Tests, PASS
- Provider-Seed: fresh install, second boot, concurrent 409 race, failed read
  und fremde `base_url` abgedeckt
- Auth-Loopback: CSP/no-store/no-referrer/nosniff, state-first, Single-Use 410,
  focus-only `command-eve://auth/complete` ohne Auth-Material
- Identity: E-Mail-Local-Part bleibt unbestätigt; gleiche Session aktualisiert
  Shared Store und konsumierende Oberflächen
- First-Run: bestehende `onboardingStatus`-Wahrheit, keine zweite Checkliste,
  kein Auto-LLM oder erzwungenes Modal

## Nicht blockierende Follow-ups

1. `resolveInferenceProvider` führt vor jedem lokalen Send erneut den
   Provider-Readback aus. Bei einem bereits hängenden Backend kann dies die
   ehrliche Not-ready-Antwort um bis zu den begrenzten Request-Retries verzögern.
   Für 1.819 als beobachteter Performance-Child prüfen; keinen Session-Cache
   einführen, der Seat-/Nonce-Sicherheit schwächt.
2. Der Prozess-Nonce rotiert pro Boot und erzeugt dadurch genau einen
   Security-Reconcile-PUT. Das ist beabsichtigte Konvergenz, kein
   Wiederholungsfehler.
3. Ein Supabase-Anon-Key ist public-by-design, muss bei Projektrotation aber als
   Betriebswahrheit aktualisiert werden. Kein 1.818-Security-Defekt.

## Release-Grenze

Dieser Review ersetzt nicht:

- reale Provider-Integration mit gebundenem AionCore-Binary (RUN, kein Skip)
- egress-keystone Playwright-Receipt
- kompletter Comparator und Full Vitest
- kontinuierlicher Dev-App-Proof über 60 Sekunden
- Notarisierung, Stapling, Gatekeeper und R2 feed-last

Plane bleibt bis zum belegten Release-Closeout offen.
