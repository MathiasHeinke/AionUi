# Command EVE Typed Generative UI — Phase 2 gate

Status: `DEPENDENCY_REJECT` candidate. The resolver is implemented and the other two capabilities fail closed. No merge to `main`, release, signing, notarization, R2 upload, deployment, or production enablement is authorized.

Work item: `MAT-1776`

Release base: AionUI `a289ce2f077eb5c2bc7a568ab4c334f179a4c528` (Command EVE 1.822.2 release line)

Phase 1 feature commit: `455fa4407489144afd999dfcab2c130d084160e5`

## Gate decision

The 45-component catalog remains unchanged. Phase 2 adds the contracts required for provenance, pane-wide artifact resolution, and future durable-work controls without expanding the execution boundary.

The candidate is intentionally not a Phase 2 PASS:

1. the Main-owned provenance verifier is complete and rejects renderer-supplied evidence, but no production inference route currently emits the required trusted generation receipt with exact artifact/message correlation;
2. the pane-wide cross-artifact resolver is implemented and fail closed for chat, file, browser, goal, and worker artifacts;
3. `goal_control` and `worker_control` are typed in the declarative schema, but the runtime strips their bindings and renders a localized disabled reason. The durable transport has not received `REVIEW_PASS`; no lifecycle authority, receipt, state mutation, or mock completion is reachable.

## Provenance attestation

### Trust boundary

The renderer sends only:

- the already validated envelope;
- an opaque host artifact reference containing artifact ID, conversation ID, source message ID, creation time, seat ID, and seat-context revision.

It cannot submit provider evidence, model evidence, a route receipt, or a claimed attestation result. The Main provider loads a trusted generation receipt from its private ledger and verifies exact hashes for:

- artifact, conversation, and source-message correlation;
- provider, model, and request ID;
- envelope content;
- creation time;
- seat and seat-context revision.

The returned attestation contains only opaque IDs, timestamps, and hashes. Raw provider, model, base URL, route, or route-receipt data is neither returned nor displayed. The UI presents only the localized host assertion that generation was verified by Command EVE.

Attestations are revalidated when an action receipt is written. Content, artifact, conversation, attestation, seat, and revision therefore remain correlated at action time instead of being a render-only check.

### Producer API

`appendMainOwnedTypedUIProviderCompletionReceipt` in `packages/desktop/src/process/commandEve/typedUIProvenanceAttestationCore.ts` is the Main-only provider-terminal seam. It accepts the actual route evidence, writes only hashes plus an opaque completion ID, and is deliberately absent from IPC. No production route calls it yet.

`appendTrustedTypedUIGenerationReceipt` is the separate durable-artifact join. It accepts only that opaque completion ID plus required artifact, conversation, source-message, timestamp, and content-hash fields. It resolves provider/model/request/route/seat evidence from the private completion ledger, consumes a completion for at most one artifact, and rejects conflicting second receipts for the same artifact. It cannot accept a caller-supplied provider, model, request, or `{status: "completed"}` structure.

Until both callers exist, production Typed UI fails with `trusted_generation_receipt_missing`. `source_message_id` is required across the v2 AST, host artifact reference, generation join, and action receipt, so missing message correlation cannot pass as `undefined === undefined`. The E2E test seeds both private ledgers from Node test code only; it does not add a product fallback or accept renderer evidence.

The existing `command-eve-upstream-outcome/v1` file is not such a receipt. It is one overwritten, content-free transport outcome without route, session, request, seat, message, artifact, or model correlation; several streaming paths can also finish it as `completed` without proving a successful durable artifact. The shadow route record is pre-execution policy evidence, not a provider completion. Neither may be elevated into provenance authority.

The narrow production design is therefore a two-stage join:

1. each Main-owned provider terminal path creates a private, single-use pending completion record containing an opaque generation ID plus actual route/model, seat/revision, Hermes session, upstream request/tool-call correlation, and final success state;
2. after AionCore durably persists the Typed UI message and artifact, an authenticated backend-to-Main callback—or a renderer opaque notification followed by Main re-fetch—binds that generation ID to backend-owned conversation, message/turn, artifact, creation time, and canonical bytes. Only this join may append the trusted generation receipt.

Matching the latest receipt by session is forbidden because parallel tool and auxiliary turns can misbind or replay it. The current renderer-only artifact projection is not durable evidence, so this join requires an AionCore/durable-artifact contract rather than another renderer claim.

## Cross-artifact Workbench resolver

`workbenchArtifactResolver.ts` owns one pane-wide registry. Resolution requires an exact tuple:

```text
artifact_kind + artifact_id + current_conversation_id
```

Resolvers register host-known artifacts and return an `open()` capability; the model never supplies a path, URL callback, React component, or renderer function. Duplicate matches at the same priority, unknown kinds, cross-conversation references, thrown resolvers, and malformed IDs fail closed.

Host integrations:

- chat Typed UI artifacts register from `MessageGeneratedArtifact`;
- current Preview tabs register from `PreviewContext`;
- conversation chat/file/browser/goal/worker artifacts register from `ShellElementsRail`;
- compact and full Typed UI hosts resolve through the same global resolver and open the existing right Workbench.

Security boundaries:

- browser artifacts accept only parsed HTTP(S) URLs without credentials;
- file artifacts accept path-free inline content, managed images, or safe workspace-relative paths;
- absolute paths, `file:` URLs, traversal, inline-content-plus-path ambiguity, and shell fallback are rejected for Typed UI actions;
- Typed UI previews do not receive writable file coordinates unless the host has resolved a safe file capability;
- `PreviewContext.saveContent` refuses every preview with `editable: false`.

## Durable lifecycle controls

The schema recognizes exact, revision-bound lifecycle parameters:

```json
{
  "goal_id": "goal-17",
  "action": "pause",
  "expected_revision": 3,
  "expected_sequence": 9
}
```

Worker controls use the same shape with `worker_id`. Bindings are accepted only on the matching Goal or WorkerRun identity and lifecycle event.

This is declaration, not runtime authority. The default host reports `durable_transport_unavailable`; `toRuntimeSpec` removes the binding; the registry shows disabled controls with a visible and screen-reader-associated reason; the handler exits before authority evaluation, receipt persistence, state mutation, or adapter invocation. Main continues to reject lifecycle action receipts because its action-receipt allowlist remains the original five types.

The only admissible future implementation is an adapter over the reviewed Hermes/AionCore contracts derived from `c8f3c0051`, `c72363fc5`, and `8a71ed7`. The current route-scoped candidate was independently rejected because a restored pending completion can arrive during restart/load before AionCore binds its session and be terminally dropped. Activation requires the real Restart+Pending+Load fix, a committed transport, and explicit `REVIEW_PASS`.

## Threat-model delta

| Threat                                      | Control                                                              | Failure mode                              |
| ------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------- |
| Renderer forges provider/model/receipt      | evidence loads only from Main-owned completion/generation ledgers    | reject attestation                        |
| Completion reused across artifacts          | opaque completion ID is single-use at durable-artifact join          | reject generation receipt                 |
| Artifact replay after AST mutation          | content hash rechecked at action time                                | reject receipt                            |
| Cross-seat or stale-revision replay         | seat and revision hashes are immutable and rechecked                 | reject attestation/receipt                |
| Raw provider details leak to user           | attestation returns hashes/opaque IDs only                           | generic verified/rejected copy            |
| Cross-conversation artifact open            | current conversation is host-bound                                   | resolver miss                             |
| Credential URL or path capability smuggling | strict URL parser and host-resolved file capability                  | resolver miss                             |
| Duplicate resolver ambiguity                | equal-priority duplicate matches are rejected                        | resolver miss                             |
| Lifecycle mock success                      | runtime binding stripped; Main receipt type rejected                 | disabled control, no side effect          |
| Authority after state mutation              | authorized intent receipt precedes every existing action side effect | no mutation on denial/persistence failure |

The original JSON AST depth, size, node-count, action-count, prototype-key, JSON-pointer, event/action compatibility, streaming-finality, HTML separation, and HTTP(S)-only action controls remain in force.

## Integration API

1. A trusted Main generation route appends one immutable generation receipt after final bytes and host artifact correlation exist.
2. `commandEve.typedUIProvenanceAttestation` resolves that receipt and returns only a verified or rejected attestation.
3. `TypedUIRenderer` renders no registry component until verification succeeds.
4. Every action uses the existing `commandEve.evaluateGateDecision` authority broker, persists an authorized intent, performs the bounded host side effect, then persists one terminal receipt correlated to the active attestation.
5. `open_artifact` calls the global Workbench resolver with exact kind and ID; it never interprets model-supplied paths or callbacks.
6. Lifecycle controls remain unavailable until a reviewed Main capability handshake exposes the canonical transport. No renderer-injected adapter is accepted.

## Verification evidence

Provider-free commands:

```bash
pnpm exec tsc --noEmit -p tsconfig.json
pnpm exec vitest run tests/unit/command-eve/typed-ui --reporter=dot
pnpm exec vitest run \
  tests/unit/previews/PreviewContext.dom.test.tsx \
  tests/unit/renderer/pages/conversation/ShellElementsRail.dom.test.tsx \
  tests/unit/renderer/ShellWorkbenchTabs.dom.test.tsx --reporter=dot
node scripts/check-i18n.js
bun run format:check
bun run lint
bun run package
AIONUI_BACKEND_BINARY="/Applications/Command EVE.app/Contents/Resources/bundled-aioncore/darwin-arm64/aioncore" \
  E2E_DEV=1 bunx playwright test --config playwright.config.ts \
  tests/e2e/specs/command-eve-typed-ui.e2e.ts --workers=1 --reporter=list
```

Focused evidence at candidate freeze:

- Typed UI: 10 files, 91 tests passed;
- related Preview/Shell: 3 files, 42 tests passed;
- TypeScript: passed;
- i18n key types: regenerated and in sync; repository-wide validator passed with pre-existing warnings;
- formatter: passed;
- lint: 0 errors (repository-wide warnings remain pre-existing);
- Electron package build: passed;
- Electron integration/visual path: 1 passed, provider-free.

Security/property coverage includes forged renderer evidence, missing producer, immutable-generation conflict, provider/model/request/content/source/seat/revision/time mismatch, action-time replay, credential URLs, absolute/traversal/file paths, inline-plus-path ambiguity, cross-conversation and duplicate resolvers, schema depth/size/node/action bounds, forbidden JSON keys/pointers, event/action substitution, lifecycle no-authority/no-receipt, and direct Main rejection of lifecycle receipt types.

Accessibility coverage includes semantic region names, native keyboard controls, Enter-key Workbench activation, live polite action status, visible disabled reasons associated with lifecycle controls, focus styling, reduced motion, and AAA small-text token contrast checks. This is a technical gate, not an assertion of exhaustive legal WCAG conformance.

### Visual matrix

| Surface        | Width  | Theme | Evidence                                                |
| -------------- | ------ | ----- | ------------------------------------------------------- |
| compact chat   | wide   | light | `tests/e2e/results/typed-ui-compact-light.png`          |
| compact chat   | wide   | dark  | `tests/e2e/results/typed-ui-compact-dark.png`           |
| compact chat   | narrow | light | `tests/e2e/results/typed-ui-compact-narrow-light.png`   |
| compact chat   | narrow | dark  | `tests/e2e/results/typed-ui-compact-narrow-dark.png`    |
| full Workbench | wide   | light | `tests/e2e/results/typed-ui-workbench-light.png`        |
| full Workbench | wide   | dark  | `tests/e2e/results/typed-ui-workbench-dark.png`         |
| full Workbench | narrow | light | `tests/e2e/results/typed-ui-workbench-narrow-light.png` |
| full Workbench | narrow | dark  | `tests/e2e/results/typed-ui-workbench-narrow-dark.png`  |

Manual inspection found no clipping, horizontal overflow, theme leakage, raw provider/model display, second chat surface, or active lifecycle affordance in the captured states.

## Remaining gates

Phase 2 remains `DEPENDENCY_REJECT` until both conditions hold:

1. every production provider route can emit a Main-owned completed generation receipt correlated to the exact persisted Typed UI artifact/message before renderer attestation;
2. the Durable-Work transport has a committed Restart+Pending+Load fix and an independent `REVIEW_PASS`, after which a separate change may wire the canonical adapter and terminal lifecycle receipts.

Passing tests prove the fail-closed candidate and resolver; they do not turn either missing dependency into a production capability.
