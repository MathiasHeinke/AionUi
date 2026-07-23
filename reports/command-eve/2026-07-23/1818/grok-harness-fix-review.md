# Grok 4.5 review — Command EVE 1.818 E2E harness fix

Scope: read-only review of the uncommitted working-tree change to
`tests/e2e/fixtures.ts` on branch `codex/command-eve-1818-integration`
(HEAD `78b55281`). No edits, no network, no release actions.

Diff under review (exactly one file):

1. Introduces `E2E_ELECTRON_LAUNCH_TIMEOUT_MS = 180_000` and applies it to both
   Playwright `electron.launch()` calls (packaged + dev).
2. Adds a dev-mode fail-fast preflight: if `out/main/index.js` or
   `out/renderer/index.html` is missing, throw with remedy
   `Run \`bun run package\` before the release E2E gate.`

---

## 1) Fail-fast correctness

**Verdict: sound for the real failure mode; preload is a nice-to-have, not a
blocker.**

- FACT(`package.json:14`): `"main": "./out/main/index.js"`.
- FACT(`package.json:25`): `"package": "electron-vite build --config packages/desktop/electron.vite.config.ts"`.
- FACT(`justfile:367-369`): `e2e-test` already runs `bun run package` before
  Playwright. The error message naming `bun run package` is therefore the
  accurate local/CI remedy for the shared fixtures path.
- FACT(`tests/e2e/fixtures.ts:154-168`, working tree): the check runs only when
  `!usePackaged`, immediately before binary resolve / launch — right place and
  time to stop a missing-bundle cascade.
- FACT(`packages/desktop/src/index.ts:1454`): main window loads
  `path.join(__dirname, '../preload/index.js')`.
- FACT(`packages/desktop/electron.vite.config.ts:152-174`): preload emits
  `out/preload/index.js` (+ pet* variants) as part of the same electron-vite
  package build.
- INFERENCE(`packages/desktop/src/index.ts:1454` + Electron sandbox preload
  semantics): if main+renderer exist but preload is missing, Electron can still
  attach/launch while IPC bridge is dead → later mysterious UI/fixture fails
  rather than a clean launch error.
- FACT(workspace): current `out/{main,preload,renderer}` are all present after
  the 01:54 package build.

**Answer:** Yes — the fail-fast catches the real “`electron .` against a missing
build” mode at the right moment. `bun run package` is the correct remedy for
this harness. Checking only main+renderer is **sufficient for 1.818 release
scope**; preload would tighten diagnosis but is not required for correctness of
this bounded fix. Preload absence is a secondary failure class (app process up,
bridge down), not the launch-attach hang this patch targets.

Sibling note (out of diff, non-blocking):
`command-eve-registration-gate.e2e.ts:144-151` already fail-fasts on
`out/main/index.js` with an electron-vite rebuild hint. The fixtures message is
consistent in intent and better aligned with the just/package script.

---

## 2) Coherence of 180_000

**Verdict: sound; constant reuse would be cleaner but is not a reject.**

- FACT(`playwright.config.ts:6-9`): suite timeout is `240_000` with explicit
  comment that a fresh sandbox may spend up to three minutes installing Hermes
  before the first window, plus another minute for the assertion body.
- FACT(`tests/e2e/fixtures.ts:95-98`): `resolveMainWindow()` already uses a
  literal `Date.now() + 180_000` budget for cold runtime install before first
  non-DevTools window.
- FACT(`tests/e2e/fixtures.ts:40`, working tree): launch timeout is now the same
  180s number, with comment tying it to that cold window.
- INFERENCE(fixtures + playwright config): raising launch-attach from 60s → 180s
  aligns process-attach with the already-documented window-resolution budget and
  the suite timeout design. The old 60s launch bound was the inconsistent
  outlier relative to config + resolveMainWindow comments.

**Answer:** Yes — 180s is coherent with the documented cold install window.
Reusing `E2E_ELECTRON_LAUNCH_TIMEOUT_MS` inside `resolveMainWindow()` would be a
small single-source-of-truth improvement; leaving the literal is acceptable for
this bounded patch and does not justify REJECT.

Pre-existing interaction to name, not introduced by the diff:
launch (≤180s) + first window resolve (≤180s) can still hit the 240s test
timeout if both budgets are nearly exhausted. That risk already existed once
window resolve was 180s under a 240s test timeout; the launch raise does not
create a new structural hole, it removes the false-fail at 60s.

---

## 3) Comment accuracy (worker / pristine HOME)

**Verdict: causal claim is directionally right; wording is slightly imprecise
but the fix still follows.**

Facts in tree:

- FACT(`tests/e2e/fixtures.ts:32-36`): module-scope `mkdtemp` sandbox →
  `e2eHomeDir` used as `HOME` / XDG_* for every launch in that worker.
- FACT(`playwright.config.ts:10-13`): `fullyParallel: false`, `workers: 1`,
  `retries: CI ? 1 : 0`.
- FACT(`tests/e2e/fixtures.ts:53-68`, `329-332`):
  `closeSharedElectronAppForIsolatedSpec()` closes the singleton app **in the
  same worker** and does **not** recreate HOME.
- FACT(`tests/e2e/fixtures.ts:268-273`): crash relaunch also stays in the same
  worker / same HOME.

Accurate mechanism:

1. **First launch in a fresh worker process** → pristine module-scope HOME →
   cold Hermes/runtime install (~60s verified, slower under load) before first
   window. FACT(comment in fixtures + playwright config).
2. **After a failed test, Playwright discards the worker and starts a new one**
   (Playwright documented worker isolation on failure). INFERENCE(Playwright
   worker lifecycle docs; no local doc file in-repo proving the quote). That new
   worker re-runs module top-level → new mkdtemp HOME → another cold install.
3. **Retries in CI** therefore also pay cold install again when they land in a
   new worker. INFERENCE(same lifecycle).
4. **Not every relaunch is a new worker:**
   - `closeSharedElectronAppForIsolatedSpec()` + subsequent fixtures relaunch =
     same worker, same HOME → warm runtime.
   - “App process lost – relaunching” = same worker, same HOME → warm.
   - Connector-catalog’s own isolated HOME is a separate, intentional cold path
     outside fixtures’ HOME.

So the comment “After any failed test Playwright starts a new worker with a
pristine HOME” is **mostly accurate for the cascade failure mode** that the
timeout raise targets, but overstates “any” if read as “any app relaunch.” The
precise claim is: **worker-process restart (failure / retry / new worker) ⇒
pristine HOME ⇒ cold install; in-worker relaunch ⇒ warm HOME.**

**Does the fix still follow?** Yes. A 60s launch-attach timeout under cold
install (>60s under load) fails the first launch, forces a new worker, forces
another cold install, and cascades unrelated launch failures. Raising to 180s
directly addresses that cascade. Comment polish is optional, not a reject.

---

## 4) Masking risk

**Verdict: acceptable; packaged path is justified.**

- FACT(`playwright.config.ts:9`): test timeout 240s remains the hard ceiling.
- FACT(working tree): launch timeout 180s < 240s, so a true hang still fails
  inside the test budget rather than hanging the suite indefinitely.
- INFERENCE: worst case cold path spends most of the 240s in setup; assertion
  body then has little headroom. That is already the design stated in
  playwright.config (“three minutes install + one minute body”). Locally and in
  CI this is a known cost of cold Hermes install, not a new mask of product
  hangs.
- FACT(`tests/e2e/fixtures.ts:178-186`): packaged launches also set
  `HOME: e2eHomeDir` and the same XDG_* sandbox.
- INFERENCE(runtimeBootstrapCore + fixtures HOME contract): packaged first
  launch in a pristine sandbox HOME also cold-installs runtime into that HOME.
  Therefore packaged mode needs the same attach budget as dev mode.
- FACT(working tree): both launch sites now share the constant — consistent.

**Answer:** 180s does not unacceptably mask genuine hangs under a 240s test
timeout. Packaged mode is equally justified because it uses the same pristine
HOME sandbox and therefore the same cold install path.

---

## 5) Regression scan

**No product-spec regression from the fixtures change. Sibling launch sites
remain on 60s (pre-existing inconsistency, out of this diff’s must-fix set).**

| Path | Launch timeout | Fail-fast on missing `out/` | HOME |
|---|---|---|---|
| `tests/e2e/fixtures.ts` (shared) | **180s (new)** | **main+renderer (new)** | module mkdtemp |
| `command-eve-registration-gate.e2e.ts` | 60s | main only (existing) | process env / own userData; closes shared app first |
| `command-eve-connector-catalog.e2e.ts` isolated relaunch | 60s | none | own mkdtemp HOME after `closeSharedElectronAppForIsolatedSpec` |
| `ext-no-extensions.e2e.ts` | 60s | none | own sandbox |

- FACT: no other shared-fixtures consumer hard-codes the old 60s launch bound.
- FACT: `shouldUsePackagedMode()` only keys on `E2E_PACKAGED=1`; default/CI
  `E2E_DEV=1` remains dev mode. Fail-fast correctly applies there.
- FACT: specs that never launch Electron are untouched.
- FACT: `closeSharedElectronAppForIsolatedSpec()` still only nulls app/page; next
  fixtures launch reuses same HOME (warm). Timeout raise does not break that.
- INFERENCE: connector-catalog / registration-gate / ext-no-extensions can still
  false-fail under heavy cold load at 60s. That is **pre-existing** and outside
  the single-file diff. Mention as follow-up, not as REJECT for this patch.
- FACT(`justfile:367-369` vs `package.json:65`): `just e2e-test` packages first;
  bare `bun run test:e2e` does not. The new fail-fast makes bare `test:e2e`
  without a prior package **fail loud and early** — a behavior improvement, not
  a regression of any intended green path.

---

## 6) Bounded alternatives (suggest only)

Within 1.818 release scope, the current fix is the right bounded change.

Optional later improvements (do not block ship):

1. Reuse `E2E_ELECTRON_LAUNCH_TIMEOUT_MS` in `resolveMainWindow()` (and ideally
   export it for registration-gate’s 180s window loop).
2. Optionally assert `out/preload/index.js` in the same fail-fast list for
   sharper diagnosis.
3. Align isolated launch sites (registration-gate, connector-catalog,
   ext-no-extensions) to the same launch timeout constant if cold cascades
   reappear there.
4. Global-setup pre-warm or shared warm HOME across workers would reduce cost
   but is a larger harness redesign (HOME isolation / leak risk) and is **out of
   1.818 scope**.

Global pre-warm / shared HOME are **not** strictly better for this release;
they trade isolation for speed and expand blast radius. Constant reuse is a
tiny pure-cleanup if someone touches the file again.

---

## Cross-check vs release posture

- This is a harness reliability fix, not a product behavior change.
- It directly supports remaining 1.818 E2E / egress / comparator work by
  stopping false launch cascades after the first real failure or under cold
  load.
- It does **not** claim or prove egress-keystone RUN+PASS, aggregator 3/3,
  notarization, or R2. Those remain separate gates.

---

## Findings summary

| ID | Sev | Finding | Action |
|---|---|---|---|
| G1 | note | Comment slightly overstates “any failed test → new worker” vs in-worker relaunch | optional wording polish |
| G2 | note | `resolveMainWindow` still duplicates magic `180_000` | optional constant reuse |
| G3 | note | Preload not in fail-fast list | optional tighten; not required |
| G4 | note | Sibling isolated launches still at 60s | follow-up if cascades seen there |
| — | — | No P0/P1 defect in the reviewed diff | ship-eligible |

No REJECT findings. No security surface change. No product path change.

VERDICT: PASS — Bounded fixtures harness fix is correct, coherent with the documented 180s cold-install budget, and safe to land for 1.818 without blocking follow-up polish.
SENTINEL: EVE_1818_HARNESS_FIX_GROK_OK_7C3E91A2
