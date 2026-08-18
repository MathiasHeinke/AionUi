# EVE 1.823.4 frozen review contract

## Frozen evidence

- Repository: `/Users/mathiasheinke/Developer/.agent-sandboxes/aionui/eve-18230-18225-integration`
- Code commit under review: `96efee4c2`
- Documentation-only follow-up commit: `9cb1fdb82`
- Frozen review diff: `/tmp/eve-18234-review-diff.patch`
- Diff SHA-256: `45b8b36fd98c01b88b8c1cd19948e3997eab37b883f7549f21af4b3c45a816b5`
- Focused tests already run by the controller: `bunx vitest run tests/unit/command-eve/eveHermesToolAuthority.test.ts tests/unit/command-eve/hermesDesktopBridge.test.ts` → 2 files, 19 tests, 19 passed.

## Sanitized scope

Review only the frozen diff and these repository files at commit `96efee4c2`:

- `packages/desktop/src/common/config/eveAuthorityRuntimeCore.ts`
- `packages/desktop/src/process/commandEve/runtimeBootstrapCore.ts`
- `packages/desktop/src/renderer/pages/conversation/Messages/components/MessageGeneratedArtifact.tsx`
- `packages/desktop/src/renderer/pages/registrationGate/RegistrationGatePage.css`
- `tests/fixtures/command-eve/permission_authority_patch_harness.py`
- `tests/unit/command-eve/eveHermesToolAuthority.test.ts`
- `tests/unit/command-eve/hermesDesktopBridge.test.ts`
- `tests/unit/command-eve/runtimeBootstrapCore.test.ts`
- `tests/unit/renderer/managedImageArtifacts.dom.test.tsx`

Do not read unrelated reports, user chat transcripts, screenshots, credentials, customer data, or private founder notes. Do not write files. Do not spawn agents. Do not run state-changing commands.

## Review dimensions

1. **Authorization/security:** exact builtin-MCP allowlists, prefix confusion, inner-tool normalization, third-party MCP behavior, unknown tools on known servers, `tool_call` bridge unwrapping, replay/persistence/ladder-downgrade semantics, paid tool permits, and fail-open/fail-closed behavior.
2. **Runtime correctness:** generated Hermes shim patch semantics, native `approve` directive behavior, ACP callback mapping, malformed `tool_call` arguments, partial bootstrap, and upgrade fragility.
3. **Product behavior:** managed image preview by artifact ID, temp/project path resolution, download/open/edit action implications, and visual regression risk.
4. **Code quality:** duplication, boundary clarity, maintainability of the generated patch, test sufficiency, and missing executable gates.
5. **Release risk:** what must be fixed before local live testing, before R2 dev publication, and what can be deferred.

## Required output

Return:

1. Verdict: exactly one of `PASS`, `REJECT`, or `PARK`.
2. Findings ordered P0/P1/P2/P3 with file and line references.
3. For every P0/P1: attack path or user-visible failure, preconditions, evidence, and bounded remediation.
4. Tests or runtime probes that should be added before release.
5. Explicit list of claims you could not verify.

An empty, truncated, or sentinel-free answer is not a review. Do not turn the absence of a finding into a broad security guarantee.
