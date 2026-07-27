# Command EVE 1.820 C1 / COMPA-807 — Worker report

## Identity

- Outcome: isolated C1 implementation ready for Root review; no commit, push, Plane write or release action performed.
- Worktree: `/Users/mathiasheinke/Developer/.agent-sandboxes/aionui/eve-1820-rebuild`
- Branch: `codex/command-eve-1820-rebuild`
- Observed HEAD: `d71caecde32bea963c291fb3c34847f72c69a5fa`
- Contract live base: `242eb69486af584c8028932b933d9d60da8e6364`
- Patched Plane description SHA-256: `05494636304e2b8a25d413a471c91725319dd5fd8ab63a60f2618dd5f17575e1`
- Patched contract file SHA-256 read locally: `9ca0c525df30b6589928e2d680d341eaf833e88a5cbd104b15382c51b92f70a9`
- Fresh Plane receipts supplied by Root: Stage 0.5 `CONTRACT_PASS` comment `81e8d56b-88f0-41f5-8fe4-2dd4a08bad0a`; Stage 0.65 `RUNTIME_READY_PASS` comment `da484914-5b6b-41ea-8fa9-3f5c825ff423`.

## Delivered

1. Added a strict `command-eve-agent-usage/v1` SG-1 envelope to the existing seat-usage response. An actual is eligible only when the envelope is server-attested as `immutable:true` and `complete:true`, fresh, period-matching, and every row has a unique ledger event id, routing receipt id, displayed `agent_id`, canonical recorded route, timestamp and positive recorded call count.
2. Added fail-closed verification. Missing, malformed, stale, wrong-period, unknown-agent, duplicate-id and empty row sets yield `status: unavailable`, `total_calls: null`, `rows: []`. Seat aggregates are never used to infer agent usage or route.
3. Preserved seat isolation: non-owner seat partitioning removes the agent envelope because the current envelope has no seat-bound proof. Owner/all-seat behavior remains unchanged.
4. Split the team surface visibly into `Plan` and `Ist`. Plan remains the existing active-role salary-band planning value and is explicitly labelled as non-billing. Ist shows verified runs, period and the exact recorded `subscription`, `byok` or `local` route only when the strict proof passes.
5. Added ledger/routing receipt attributes to the rendered proof rows for live inspection: `data-agent-id`, `data-period`, `data-route`, `data-ledger-event-id`, `data-routing-receipt-id`.
6. Removed the unsupported meter/confirmation claim that the planning overage itself proves additional charges. The activation budget reducer remains behavior-compatible.
7. Added German and English copy plus generated i18n key types.
8. Root review found that Main dropped `scoped.agent_usage` while constructing IPC `data`. The patched contract authorized the missing bridge paths. Remediation adds one pure allowlist shaper, wires Main through it, and makes `agent_usage` a required typed IPC result field. Authorized owner envelopes survive unchanged; delegate, quiet and malformed paths remain null. Raw provider/body/authorization fields are not copied.

## C1 files

- `packages/desktop/src/common/config/eveTeamBudgetCore.ts`
- `packages/desktop/src/common/config/seatUsageCore.ts`
- `packages/desktop/src/common/adapter/ipcBridge.ts`
- `packages/desktop/src/process/bridge/commandEveBridge.ts`
- `packages/desktop/src/renderer/hooks/useSeatUsage.ts`
- `packages/desktop/src/renderer/components/team/ProjectedSpendMeter.tsx`
- `packages/desktop/src/renderer/components/team/DeinTeamPanel.tsx`
- `packages/desktop/src/renderer/services/i18n/i18n-keys.d.ts`
- `packages/desktop/src/renderer/services/i18n/locales/de-DE/deinTeam.json`
- `packages/desktop/src/renderer/services/i18n/locales/en-US/deinTeam.json`
- `tests/unit/command-eve/eveTeamBudgetCore.test.ts`
- `tests/unit/command-eve/seatUsageCore.test.ts`
- `tests/unit/command-eve/ProjectedSpendMeter.dom.test.tsx`
- `tests/unit/command-eve/seatUsageBridgeContract.test.ts`
- `reports/command-eve/2026-07-27/1820/c1/worker-report.md`

Sibling C7/C6 files already dirty in the shared worktree were not edited, staged, reset or included as C1 output.

## Verification

- Baseline before C1:
  - `pnpm vitest run tests/unit/command-eve/eveTeamBudgetCore.test.ts tests/unit/command-eve/seatUsageCore.test.ts` — PASS, 30/30.
  - `pnpm vitest run tests/unit/settings/BillingModalContent.dom.test.tsx` — PASS, 10/10.
- C1 focused current core/UI:
  - `pnpm vitest run tests/unit/command-eve/eveTeamBudgetCore.test.ts tests/unit/command-eve/seatUsageCore.test.ts tests/unit/command-eve/ProjectedSpendMeter.dom.test.tsx tests/unit/command-eve/seatUsageBridgeContract.test.ts` — PASS, 43/43 on final V2 code.
  - `pnpm vitest run tests/unit/settings/BillingModalContent.dom.test.tsx` — PASS, 10/10 on final V2 code.
  - `pnpm tsc` — PASS on the final C1 tree.
  - `pnpm i18n:types` — PASS; generated key declarations updated.
  - `pnpm exec oxfmt <14 C1 files>` — PASS.
  - `pnpm exec oxfmt --check <14 C1 files>` — PASS.
  - `git diff --check` — PASS.
- `pnpm test:unit` — not run by this leaf after Root stopped broad gates to avoid shared-worktree contention. Therefore this worker does not self-assert the contract's full >90 PASS.

## GitNexus

- Pre-edit upstream impact:
  - `projectMonthlySpend`: LOW, 3 direct dependents.
  - `parseSeatUsageResponse`: LOW, 1 direct dependent.
  - `useSeatUsage`: LOW, 1 direct dependent.
  - `ProjectedSpendMeter`: LOW, no indexed upstream dependents.
  - `DeinTeamPanel`: LOW, no indexed upstream dependents.
  - V2 `initCommandEveBridge`: MEDIUM, 8 direct bridge-test dependents.
  - V2 `ICommandEveSeatUsageResult`: GitNexus CRITICAL/424 because the graph treats every importer of monolithic `ipcBridge.ts` as an interface dependent. Root was warned before edit and explicitly authorized the narrow additive field under the fresh patched contract. Semantic scope is one required typed field; focused bridge and TSC gates are green.
- Final `detect_changes(scope=unstaged)`: HIGH for the shared worktree as a whole (25 dirty files / 124 changed symbols), driven by concurrently present permission, message-recovery, runtime-bootstrap and onboarding changes outside C1 plus this bounded bridge seam. C1 did not edit the sibling paths. Root must review/integrate by the explicit C1 file list above, not the aggregate dirty-worktree risk label.

## Live-proof boundary and blockers

- The current seat-usage server may omit `agent_usage`; Main and typed IPC now preserve a valid envelope end-to-end when present, while omission correctly renders Ist as unavailable. C1 deliberately does not fabricate a bridge from seat totals.
- A live available Ist proof requires the authoritative producer/server to return the exact strict SG-1 envelope. C2/routing production and deployment are outside this leaf.
- No full unit suite, packaged app, live ledger row, install, updater, notarization or R2 proof is claimed.
- No Plane `worker.reported` write was performed per Root instruction. Proposed status: `ROOT_REVIEW_READY`, not Done.

## Rollback

Revert only the C1 file set above and restore the pre-C1 projected meter. Do not modify SG-1 ledger history, C7/C6 sibling changes, release artifacts or public state.

## Reflection

- What worked: preserving the existing plan reducer while adding a separate strict actual model prevented billing semantics from leaking into route provenance. Atomic envelope validation and the explicit IPC allowlist shaper make malformed/partial or secret-adjacent payloads mechanically claim-free.
- What needed correction during the run: the first timestamp-hardening patch placed the `as_of` local in the row parser; focused tests caught the ReferenceError immediately. It was corrected before final verification.
- Root-review remediation: the first report proved core and renderer behavior but missed that Main reconstructed the IPC payload without `agent_usage`. Root caught the gap. V2 adds a testable Main→IPC shaper and an exact bridge contract test so future reconstruction cannot silently drop the proof.
- Remaining learning proposal: the producer contract should version and document this envelope beside the SG-1/C2 routing receipt schema, including seat binding. Until seat binding exists, delegate partitions must continue dropping agent-ledger data.

## Self-assessment

- Provenance: 35/35
- No fabrication: 30/30
- Regression safety: 18/20 (focused bridge/core/UI + Billing + TSC + Oxfmt green; full unit gate deferred by Root)
- UX clarity: 14/15
- Total: 97/100 by rubric, but **not self-PASS** because the mandatory full `pnpm test:unit` gate and live producer proof are not complete.

```yaml
reflection:
  outcome: strict plan/actual split implemented with null-valued unavailable state
  strongest_property: actual usage cannot render without a complete fresh immutable agent-period-route proof
  correction: focused tests caught one parser mistake; Root review caught and V2 closed the Main-to-IPC field drop
  learning_proposal: version the SG-1 producer envelope and add seat-bound provenance before delegate visibility
subagents: []
```
