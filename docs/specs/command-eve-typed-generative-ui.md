# Command EVE Typed Generative UI v1

Status: integration candidate; no release, signing, notarization, R2 upload, production deployment, or main-branch merge is authorized by this document.

Work item: `MAT-1776`

Release base: AionUI `a289ce2f077eb5c2bc7a568ab4c334f179a4c528` (Command EVE 1.822.2 release line)

Feature branch: `codex/eve-typed-ui-runtime`

Integration branch: `codex/eve-typed-ui-integration`

## Decision

Command EVE accepts only a versioned declarative JSON AST. The model describes a UI; it never supplies React components, JavaScript, CSS, HTML, shell commands, IPC calls, network clients, module names, imports, callbacks, or executable expressions.

The renderer owns:

- the exact 45-component catalog;
- the component registry and Arco/React implementations;
- strict validation, size limits, graph validation and fail-safe rendering;
- the five allowed action handlers;
- EVE-MAIN authority evaluation and receipts;
- inline versus Workbench placement;
- accessible semantics, focus styling and theme tokens.

HTML remains a separate artifact type and continues through the existing empty-sandbox iframe. Typed UI never renders HTML or upgrades an HTML artifact into a registry component.

## Primary-source audit

Audit date: 2026-08-11.

### Atrium

Primary sources:

- <https://getatrium.dev/docs/quickstart>
- <https://getatrium.dev/faq>
- <https://getatrium.dev/>

Observed product principles:

1. Atrium presents durable work in panes beside an agent rather than creating another chat surface.
2. Its workspace/room/pane model and local journal make generated work inspectable and durable.
3. Its Notepad treats HTML as a sandboxed surface.
4. The Atrium desktop application is closed source. Its FAQ separately describes an MIT adapter SDK.

Adopted principle: a compact representation stays in the existing conversation; the complete artifact opens in the existing right Workbench pane.

Explicit exclusion: no Atrium application code, assets, private interfaces, or inferred closed-source implementation was copied. The implementation in this branch is native AionUI code.

### vercel-labs/json-render

Primary sources:

- <https://github.com/vercel-labs/json-render>
- <https://json-render.dev/docs>
- repository `LICENSE` and package manifests at audited commit `9d3dfc8917c1c6aa5568acbe0969523f3307376c`
- npm package metadata for `@json-render/core@0.19.0` and `@json-render/react@0.19.0`

Verified facts:

- repository and both selected packages declare Apache-2.0;
- audited upstream commit: `9d3dfc8917c1c6aa5568acbe0969523f3307376c` (`2026-07-08T20:20:54-03:00`);
- current selected package version: `0.19.0`;
- the upstream architecture separates catalog, registry, declarative spec and renderer;
- `@json-render/react` supports a flat element graph, state store, action bindings, progressive rendering and per-element error boundaries;
- the upstream shadcn catalog currently exports 36 component definitions, not 42.

Adoption:

- use the upstream Apache-2.0 `Renderer`, `JSONUIProvider`, `StateStore`, `Spec` and action-binding primitives;
- pin `@json-render/core` and `@json-render/react` to `0.19.0` in this release candidate;
- keep the AionUI/Arco component registry local and renderer-owned;
- wrap the upstream spec in a stricter Command EVE envelope with catalog version, actions and provenance.

Deliberate non-adoption:

- the upstream shadcn registry, because AionUI uses Arco and Command EVE semantic tokens;
- the upstream default model prompt/schema as the authority boundary, because upstream built-in state actions exceed the founder-approved five-action allowlist;
- arbitrary upstream examples, client navigation, remote image URLs and developer callbacks.

## Versioned envelope

MIME type: `application/vnd.command-eve.typed-ui+json`

```json
{
  "schema_version": "command-eve.typed-ui/v1",
  "catalog_version": "command-eve.typed-ui.catalog/v1",
  "root": "root",
  "elements": {
    "root": {
      "type": "Stack",
      "props": { "direction": "vertical", "gap": 12 },
      "children": ["goal", "decision"]
    },
    "goal": {
      "type": "Goal",
      "props": {
        "id": "goal-17",
        "title": "Ship typed UI",
        "status": "active",
        "progress": 62
      },
      "children": []
    },
    "decision": {
      "type": "DecisionCard",
      "props": {
        "id": "decision-9",
        "title": "Prepare integration PR?",
        "status": "open",
        "humanGate": "HG-2.5",
        "statePath": "/decision"
      },
      "children": [],
      "on": { "approve": "requestApproval" }
    }
  },
  "state": { "decision": null },
  "actions": {
    "requestApproval": {
      "type": "request_approval",
      "params": {
        "gate_action": "prepare_pr",
        "summary": "Prepare the bounded integration PR."
      }
    }
  },
  "provenance": {
    "provider": "provider-id",
    "model": "model-id",
    "request_id": "request-id",
    "generated_at": "2026-08-11T12:00:00.000Z",
    "source_message_id": "message-id"
  }
}
```

Strictness:

- top-level fields are exact; unknown fields fail;
- component props and events are exact per catalog entry;
- maximum 512 KiB serialized input, 200 elements, 50 actions, 40 children per element;
- bounded depth, collection sizes and strings;
- element/action IDs use a bounded identifier grammar;
- root, child and action references must resolve;
- cycles, unreachable elements and unreferenced actions fail;
- prototype keys fail;
- invalid or partial AST is never rendered;
- streaming accumulates off-screen and promotes only one fully parsed, fully validated envelope.

## Catalog v1

The upstream-compatible names form the first 36 entries. Six neutral, safe AionUI display primitives extend that list to the founder-contract baseline of 42. Three EVE-native read models complete the 45.

### 42 safe base components

1. Card
2. Stack
3. Grid
4. Separator
5. Tabs
6. Accordion
7. Collapsible
8. Dialog
9. Drawer
10. Carousel
11. Table
12. Heading
13. Text
14. Image
15. Avatar
16. Badge
17. Alert
18. Progress
19. Skeleton
20. Spinner
21. Tooltip
22. Popover
23. Input
24. Textarea
25. Select
26. Checkbox
27. Radio
28. Switch
29. Slider
30. Button
31. Link
32. DropdownMenu
33. Toggle
34. ToggleGroup
35. ButtonGroup
36. Pagination
37. Metric
38. KeyValue
39. Code
40. Markdown
41. List
42. Timeline

Safety adaptations:

- `Image` accepts an artifact reference and accessible alternative text, never a model URL;
- `Link` has no `href`; it is an action-bound, button-backed affordance;
- `Code` is a non-executable viewer limited to text, JSON, Markdown and log labels; JavaScript and CSS language labels are absent;
- `Markdown` disables HTML and replaces links with inert text; images are omitted;
- `Dialog` and `Drawer` are bounded inline disclosures and own no authority;
- interactive fields bind only to validated local JSON-pointer state paths.

### Three EVE-native components

43. Goal — read-only goal identity, status, progress, owner and summary.
44. WorkerRun — read-only run identity, worker, status, time, summary and receipt reference.
45. DecisionCard — decision identity, state, rationale, HumanGate and bounded options. It can request approval but cannot approve itself.

`goal_control` and `worker_control` are not catalog actions. They remain rejected until canonical Goal and WorkerRun lifecycle contracts exist and have their own authority mapping.

## Action contract

Allowed model-declared actions:

| Action             | Effect                                                                                             | Authority path                                            |
| ------------------ | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `reply_with_state` | Copies bounded selected state into the existing composer; never sends.                             | `truth_gate`, then renderer host adapter                  |
| `open_artifact`    | Opens/reveals a host-resolved bound artifact; no arbitrary path.                                   | `truth_gate`, then renderer host adapter                  |
| `open_url`         | Opens a credential-free `http:` or `https:` URL after an explicit UI action.                       | `truth_gate`, strict URL recheck, then Main shell adapter |
| `select_option`    | Updates a validated local state path only.                                                         | `truth_gate`, then local StateStore                       |
| `request_approval` | Records the current EVE gate decision for a declared gate action; performs no requested operation. | `evaluateGateDecision(gate_action)`                       |

Every handler verifies at execution time that the action ID and action type match the validated envelope. Every executable path calls the existing `commandEve.evaluateGateDecision` Main provider. Main appends its canonical gate-decision audit record and owns a separate private `typed-ui-actions.jsonl` ledger. For reversible actions, Main must persist an `authorized` intent before any state, composer, browser or artifact side effect; the later `completed` or `failed` record is accepted only when its intent exists, matches action, host-bound request context and authority exactly, and has no prior terminal record. `request_approval` records one `approval_recorded` or `blocked` decision and performs no requested operation.

The model has no handle to `ipcBridge`, `shell`, `fetch`, React callbacks or the registry. Unknown action names, including upstream built-ins, fail schema validation.

## Placement and integration API

### Artifact producer

Use the existing generated conversation-artifact lane:

- artifact kind: `file`;
- payload MIME: `application/vnd.command-eve.typed-ui+json`;
- payload `typed_ui` may be the envelope object or its JSON serialization;
- alternatively, with the MIME set, payload `content` may contain the JSON serialization.

No new model-to-renderer IPC is introduced.

### Renderer consumer

```tsx
<TypedUIRenderer
  content={validatedArtifactContent}
  mode='compact'
  host={typedUIActionHost}
  receiptContext={{ requestId: hostOwnedArtifactId }}
  onOpenWorkbench={openExistingWorkbenchPane}
/>
```

The host adapter is the only capability seam:

```ts
interface TypedUIActionHost {
  evaluateAuthority(action: ICommandEveGateAction): Promise<ICommandEveGateDecision>;
  recordReceipt(receipt: TypedUIActionReceipt): Promise<{ receipt_id: string }>;
  supportsAction?(action: TypedUIActionType): boolean;
  openArtifact(artifactId: string): Promise<void> | void;
  openUrl(url: string): Promise<void> | void;
  replyWithState(text: string): Promise<void> | void;
}
```

The chat card emits the existing `preview.open` event with content type `typed-ui`. `PreviewPanel` renders the full representation in the existing right Workbench pane. It does not create a second conversation, webview, browser pane or chat runtime. Receipt correlation uses the durable conversation-artifact ID inline and the host-created Workbench tab ID in the full pane; neither comes from the model. A host surface advertises only capabilities it can actually execute: because the first full-pane adapter has no cross-artifact resolver, `open_artifact` bindings are omitted there rather than rendered as inert or falsely completed controls. Typed UI tabs are intentionally not persisted to localStorage because an action-bearing artifact can become stale.

### Model/schema integration

Provider adapters should receive a JSON Schema generated from the authoritative catalog metadata or an equivalent structured-output contract, plus these hard instructions:

1. output only one `command-eve.typed-ui/v1` envelope;
2. use only catalog v1 component names, props and events;
3. use only the five action names;
4. include provenance from the trusted host, not model-invented values;
5. never emit HTML, JavaScript, CSS, URLs outside an `open_url` action, imports, callbacks or executable expressions.

The artifact envelope retains model provenance for display and audit input, and the client validator treats every field as untrusted. Independently, action receipts use the host-owned conversation artifact ID supplied through `receiptContext`; model-provided `request_id` and `source_message_id` cannot choose durable receipt correlation. Provider-specific provenance attestation before storage remains a later adapter task.

## Threat model

| Threat                                 | Control                                                                     | Failure behavior            |
| -------------------------------------- | --------------------------------------------------------------------------- | --------------------------- |
| Arbitrary React/component injection    | closed 45-name catalog; renderer-owned registry                             | reject envelope             |
| JS/CSS/HTML injection                  | exact props; no style/class/callback/html props; HTML-disabled Markdown     | reject or render inert text |
| Shell/IPC/network execution            | no such actions or model callbacks                                          | reject envelope             |
| URL scheme/credential abuse            | parse with `URL`; allow only credential-free HTTP(S); recheck at execution  | reject or failed receipt    |
| Authority bypass/action substitution   | ID/type match, Main gate, durable intent and exact terminal correlation     | block before side effect    |
| Pre-authority state mutation           | bound selection emits first; StateStore changes only inside allowed handler | preserve prior state        |
| Hidden payloads                        | reachability and unreferenced-action checks                                 | reject envelope             |
| Graph/resource exhaustion              | byte, node, child, depth, string and collection limits                      | reject envelope             |
| Prototype pollution                    | forbidden key checks at every JSON layer                                    | reject envelope             |
| Partial/invalid streaming              | atomic accumulator; render only after final validation                      | inert loading or warning    |
| Remote tracking through Image/Markdown | artifact reference placeholder; remote Markdown images omitted              | no request                  |
| Stale workbench action                 | no localStorage persistence for `typed-ui` tabs                             | artifact must be reopened   |
| HTML boundary confusion                | existing HTML type/empty-sandbox iframe remains separate                    | no type promotion           |

## Accessibility and visual contract

- semantic region and heading structure;
- Arco controls for interactive elements;
- labels for fields and accessible names for icon-free actions;
- keyboard-native buttons, checkboxes, select, radio, switch, slider, tabs and disclosures;
- live polite receipt status; warning alert for invalid AST;
- explicit two-pixel focus ring using the Command EVE semantic focus token;
- light/dark semantic tokens, responsive single-column fallback and reduced-motion override;
- primary small-text tokens are gated at WCAG AAA contrast (`>= 7:1`) in both shipped solid themes.

This is a technical accessibility gate, not a claim that every possible model-composed screen is legally or exhaustively WCAG AAA conformant. Integration visual QA must cover both themes, compact and full layouts, keyboard order, zoom and screen-reader announcements.

## Verification contract

```bash
bunx tsc --noEmit -p tsconfig.json
bunx vitest run tests/unit/command-eve/typed-ui --reporter=verbose
bun run package
AIONUI_BACKEND_BINARY="/Applications/Command EVE.app/Contents/Resources/bundled-aioncore/darwin-arm64/aioncore" \
  E2E_DEV=1 bunx playwright test tests/e2e/specs/command-eve-typed-ui.e2e.ts
```

The focused suite covers:

- exact catalog count and structural snapshot;
- graph/property boundaries and prototype pollution;
- action allowlist, action substitution, pre-authority state denial and durable intent/terminal receipt correlation;
- credential-free HTTP(S)-only navigation;
- compact/full/partial/invalid rendering;
- inert Markdown HTML/link/image behavior;
- keyboard operation, labels, regions and live status;
- light/dark AAA primary-text token contrast and focus/reduced-motion CSS.

The deterministic Electron visual path enters through the real conversation artifact store, opens the same validated AST through EVE-MAIN authority into the existing Workbench, and writes this matrix:

| Surface        | Theme | Evidence output                                  |
| -------------- | ----- | ------------------------------------------------ |
| compact chat   | light | `tests/e2e/results/typed-ui-compact-light.png`   |
| compact chat   | dark  | `tests/e2e/results/typed-ui-compact-dark.png`    |
| full Workbench | light | `tests/e2e/results/typed-ui-workbench-light.png` |
| full Workbench | dark  | `tests/e2e/results/typed-ui-workbench-dark.png`  |

The test uses the installed, release-matched local `aioncore` binary only as the disposable E2E backend. It performs no model call, external network action, signing, notarization, upload or deployment.

## Integration gate

Pass requires all of the following:

1. focused tests green;
2. TypeScript and package build green;
3. no formatter or lint errors in changed files;
4. real visual QA artifacts for light/dark compact/full surfaces;
5. GitNexus `detect_changes` matches the intended message/preview/type additions;
6. feature commit is integrated only into `codex/eve-typed-ui-integration`;
7. no main merge, signing, notarization, R2 upload or production deployment;
8. independent CAO/release review remains outside this worker branch.

## Known deferred work

- provider-specific structured-output wiring and display-provenance attestation;
- cross-artifact resolver beyond the currently bound conversation artifact;
- canonical `goal_control` and `worker_control` lifecycle contracts;
- release packaging, CAO review and controller decision;
- any production or distribution action.
