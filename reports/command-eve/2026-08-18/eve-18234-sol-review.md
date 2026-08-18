Verdict: REJECT

The move toward Hermes’ native approval UI is directionally correct, but the current persistence key is incompatible with Command EVE’s revocable authority model, and managed artifacts still mix ID and path authority.

## Findings

No P0 finding was established within the frozen scope.

### P1 — Native session/always approvals survive same-rung authority revocation

- Failure path: a tool requires approval; the user chooses session/always; an effect seal, opaque-UI grant, or comparable authority dimension is later revoked without changing the ladder; Hermes receives the same `rule_key` and can reuse the stored approval.
- Preconditions: Hermes persists native approval choices by `rule_key`, as the implementation explicitly expects.
- Evidence: independent grants determine decisions in [eveAuthorityRuntimeCore.ts:370–421](/Users/mathiasheinke/Developer/.agent-sandboxes/aionui/eve-18230-18225-integration/packages/desktop/src/common/config/eveAuthorityRuntimeCore.ts:370), but the shim receives only decision and ladder at [runtimeBootstrapCore.ts:7353–7372](/Users/mathiasheinke/Developer/.agent-sandboxes/aionui/eve-18230-18225-integration/packages/desktop/src/process/commandEve/runtimeBootstrapCore.ts:7353). The persistent key contains only ladder/tool/action at [runtimeBootstrapCore.ts:7441–7445](/Users/mathiasheinke/Developer/.agent-sandboxes/aionui/eve-18230-18225-integration/packages/desktop/src/process/commandEve/runtimeBootstrapCore.ts:7441), while permanent choices are restored at [runtimeBootstrapCore.ts:7542–7547](/Users/mathiasheinke/Developer/.agent-sandboxes/aionui/eve-18230-18225-integration/packages/desktop/src/process/commandEve/runtimeBootstrapCore.ts:7542). The preceding comment already documents that session/always answers outlive their originating decision at [runtimeBootstrapCore.ts:7490–7495](/Users/mathiasheinke/Developer/.agent-sandboxes/aionui/eve-18230-18225-integration/packages/desktop/src/process/commandEve/runtimeBootstrapCore.ts:7490).
- Bounded remediation: keep structured approvals one-operation-only for 1.823.5, or add an opaque authority revision/fingerprint to the TypeScript response and native key. It must change for relevant seals, opaque authorization, permits and seat context—not only ladder changes. Policy should remain in TypeScript, not be duplicated in generated Python.

### P1 — Builtin MCP authority trusts a forgeable-looking name, not provenance

- Attack path: a user-configured MCP claims a reserved builtin server name and matching allowlisted tool name; the classifier returns `allow` at rung 0 and skips approval.
- Preconditions: Hermes permits a user server to claim/collide with `aionui_image_generation` or `aionui_eve_artifacts`. This namespace guarantee was not verified.
- Evidence: builtin identity is inferred entirely through prefix strings at [eveAuthorityRuntimeCore.ts:294–325](/Users/mathiasheinke/Developer/.agent-sandboxes/aionui/eve-18230-18225-integration/packages/desktop/src/common/config/eveAuthorityRuntimeCore.ts:294). Exact inner-tool matching correctly blocks prefix/suffix confusion, but tests only cover a distinctly named third-party server—not a builtin-name collision—at [eveHermesToolAuthority.test.ts:106–118](/Users/mathiasheinke/Developer/.agent-sandboxes/aionui/eve-18230-18225-integration/tests/unit/command-eve/eveHermesToolAuthority.test.ts:106).
- Bounded remediation: bind popup-free authority to trusted MCP registration provenance, or enforce reserved server IDs with fail-closed collision rejection. Until proven, these envelopes should remain one-operation approved.

### P1 — Managed-image preview is ID-based, but actions remain path-based

- Failure path: a managed image with a relative placement path in a temp conversation previews correctly by ID, yet Open/Reveal target the path under the Hermes workspace. Download tries that path and its path fallback before the verified bytes. It therefore fails despite a valid preview, or could act on an unrelated coincidental file.
- Preconditions: the conversation workspace differs from the canonical placement root, as the new comment says occurs for temp conversations.
- Evidence: path resolution remains workspace-based at [MessageGeneratedArtifact.tsx:360–387](/Users/mathiasheinke/Developer/.agent-sandboxes/aionui/eve-18230-18225-integration/packages/desktop/src/renderer/pages/conversation/Messages/components/MessageGeneratedArtifact.tsx:360). Preview switches to artifact ID at [MessageGeneratedArtifact.tsx:394–430](/Users/mathiasheinke/Developer/.agent-sandboxes/aionui/eve-18230-18225-integration/packages/desktop/src/renderer/pages/conversation/Messages/components/MessageGeneratedArtifact.tsx:394), but action availability and handlers still prioritize `openPath` at [MessageGeneratedArtifact.tsx:558–635](/Users/mathiasheinke/Developer/.agent-sandboxes/aionui/eve-18230-18225-integration/packages/desktop/src/renderer/pages/conversation/Messages/components/MessageGeneratedArtifact.tsx:558). The new path regression test verifies preview only; the download test uses no placement path at [managedImageArtifacts.dom.test.tsx:220–266](/Users/mathiasheinke/Developer/.agent-sandboxes/aionui/eve-18230-18225-integration/tests/unit/renderer/managedImageArtifacts.dom.test.tsx:220).
- Bounded remediation: download managed images from verified artifact-ID bytes first. Hide Open/Reveal for unresolved relative paths. Canonical placement resolution should be a Main-process artifact-ID operation, not renderer concatenation. Add temp/project tests for preview, download, open, reveal and edit.

### P2 — The native approval contract is asserted, not executed

The authority harness extracts selected emitted functions and substitutes Hermes/ACP modules at [permission_authority_patch_harness.py:23–127](/Users/mathiasheinke/Developer/.agent-sandboxes/aionui/eve-18230-18225-integration/tests/fixtures/command-eve/permission_authority_patch_harness.py:23). Its runtime test receives no bundled wheel at [runtimeBootstrapCore.test.ts:1750–1781](/Users/mathiasheinke/Developer/.agent-sandboxes/aionui/eve-18230-18225-integration/tests/unit/command-eve/runtimeBootstrapCore.test.ts:1750), while the bridge test checks emitted strings at [hermesDesktopBridge.test.ts:117–125](/Users/mathiasheinke/Developer/.agent-sandboxes/aionui/eve-18230-18225-integration/tests/unit/command-eve/hermesDesktopBridge.test.ts:117).

Consequently, no executable test proves that native `approve` reaches ACP with the expected callback shape, persists choices by the intended key, denies without a callback, or handles `tool_call` skipping as claimed.

The Hermes version and wheel hash are pinned, which limits drift, but health checks only inspect private markers, `_hooks`, and aliases at [runtimeBootstrapCore.ts:10057–10083](/Users/mathiasheinke/Developer/.agent-sandboxes/aionui/eve-18230-18225-integration/packages/desktop/src/process/commandEve/runtimeBootstrapCore.ts:10057). They cannot detect a semantically incompatible Hermes upgrade.

### P2 — Product-managed paid tools are unconditionally allowed without executable permit proof

Builtin image/video operations return `allow` based only on tool name at [eveAuthorityRuntimeCore.ts:294–318](/Users/mathiasheinke/Developer/.agent-sandboxes/aionui/eve-18230-18225-integration/packages/desktop/src/common/config/eveAuthorityRuntimeCore.ts:294). Permit and credit arguments never reach this authority decision. That is acceptable only if the downstream product seam independently rejects missing, expired and wrong-conversation permits. The frozen scope contains no executable proof of that invariant.

### P2 — `tool_call` normalization can disagree with execution

Malformed JSON arguments become `{}` at [runtimeBootstrapCore.ts:7393–7405](/Users/mathiasheinke/Developer/.agent-sandboxes/aionui/eve-18230-18225-integration/packages/desktop/src/process/commandEve/runtimeBootstrapCore.ts:7393); `todo` then defaults to a read classification at [runtimeBootstrapCore.ts:7407–7408](/Users/mathiasheinke/Developer/.agent-sandboxes/aionui/eve-18230-18225-integration/packages/desktop/src/process/commandEve/runtimeBootstrapCore.ts:7407). The harness covers valid JSON strings, not malformed/missing/non-object arguments. Parse failure should ask or block unless the exact downstream Hermes parser is proven equivalent.

No additional P3 finding materially changes the verdict.

## Safest bounded 1.823.5 split

| Boundary | Responsibility |
|---|---|
| `eveAuthorityRuntimeCore.ts` | Canonical policy classification and opaque authority revision/fingerprint |
| Small Hermes adapter seam | Normalize direct/`tool_call` identity, call AionCore, translate verdict to native directives |
| Hermes native approval plugin | Prompt UX and persistence, only when keys are revocation-safe |
| Generated shim | Version-bound installation/wiring, source assertions and deletion condition—no product policy |
| Main artifact API | Resolve artifact ID to verified bytes and, when authorized, canonical placement |

A broad runtime-bootstrap rewrite is unnecessary for 1.823.5. Extract only the authority adapter and its exact-wheel contract test. Longer-term removal of private Hermes monkey patches can wait for a supported extension point.

## Required release probes

Before local side-effect testing:

- Real bundled Hermes direct and `tool_call` dispatch for once/session/always/deny.
- Missing callback, timeout, malformed directive and partial-installer failure.
- Same-rung seal/opaque-grant revocation after session/always.
- Temp/project managed-image action matrix.

Before R2 dev publication:

- Ladder downgrade/upgrade, restart persistence, seat switching and conversation/session isolation.
- Third-party MCP using a builtin-like or colliding server name.
- Missing, expired and wrong-conversation paid-tool permits.
- Missing/string/object/malformed `tool_call.arguments`.
- Exact-wheel upgrade canary that executes plugin dispatch and ACP mapping, not merely emitted fragments.

## Unverifiable claims

Within the contract scope I could not verify:

- Hermes 0.20’s exact `approve` directive and fail-closed behavior.
- ACP option mapping and callback command shape.
- Native allowlist storage scope across sessions, seats and restarts.
- Whether MCP names carry trustworthy builtin provenance.
- Downstream `tool_call` parsing and hook-skipping semantics.
- Paid-tool preflight and permit enforcement.
- Actual temp/project placement roots and Main open/reveal validation.
- The full test suite or live runtime. Only the controller’s reported 19 focused passing tests is established.

EVE_18234_SOL_REVIEW_COMPLETE