# Kimi K3 review — Command EVE 1.818 exact skip roster

Runtime proof: Kimi Code CLI `0.28.1`, model alias `kimi-code/k3`, authenticated
CLI lane. The stream-json canary returned exactly
`KIMI_1818_SKIP_REVIEW_CANARY_2_4D90B7E1`. Review mode was read-only; the
reviewer changed no repository, Git, Plane, or release state.

Frozen discovery candidate:
`ce7ceba867e511956d8e18d99b1a3db1415a7c74`.

## Verdict

**PASS** for the candidate-gate roster. No P0 finding.

The full Playwright inventory contains 466 tests: 256 expected, 19 historical
baseline failures, 0 flaky, and 191 skipped. The approved-skip roster has an
exact 191/191 title bijection with that report: no missing title, stale title,
duplicate, or newly hidden skip. The official comparator returns `PASS` with
`new_failures: []`.

## Classification

- 156 public-product-boundary titles: upstream assistant CRUD, raw agent and
  backend selectors, founder-only Command Center, and upstream-only Skills Hub.
- 26 environment or explicit opt-in titles: raw team/agent lanes, BYOK aionrs,
  absent CLI pills, and extension WebUI native-module availability.
- 5 packaged or isolated negative-path titles: four auto-update cases and one
  intentionally unavailable-backend recovery case.
- 4 pinned upstream aionrs runtime-debt titles with the hang documented at the
  source guard.

All 52 empty-description annotations were traced to source. They result from
Playwright alias/bare-skip mechanics rather than missing intent. Representative
guards include:

- `features/assistants-user-data/assistant-user-data.e2e.ts:51`
- `features/settings/skills/core-ui.e2e.ts:53`
- `specs/acp-agent.e2e.ts:23`
- `specs/guid-agent-selection.e2e.ts:18`
- `features/conversations/aionrs/model-selection.e2e.ts:66`
- `cases/teams/team-member-ops.e2e.ts:82`

The 19 failures are all in the effective historical allowlist (38 historical
minus 11 explicitly retired). No retired failure reappeared and no new failure
was found.

## Conditions before the release claim

1. Run the four auto-update cases against the notarized electron-builder app.
2. Run the deliberately unavailable-backend recovery case in its isolated
   broken-backend sandbox.
3. Keep the three `ext-webui-contrib` native-module skips explicitly visible as
   environment debt; they are not evidence that the public extension path ran.
4. Repeat the public Dev-App proof and egress proof on the final committed SHA.
5. Do not count an approved skipped historical failure as "resolved".

Controller remediation after this review: the comparator now reports skipped
historical failures separately as `baseline_skips`; its focused suite is
22/22 green and the preserved full report now states four genuinely resolved
failures rather than eight.

## Regression judgment

The roster cannot silently hide a new public Command EVE regression: unknown
titles and new failures still fail closed. It can only defer the explicitly
named non-public, packaged, opt-in, or environment lanes, whose separate proofs
remain mandatory where the release card requires them.

`EVE_1818_EXACT_SKIP_ROSTER_KIMI_DONE`
