# Controller review synthesis — 1.823.4 authority slice

## Frozen input

- Code commit: `96efee4c2`
- Review-contract commit: `97e7576e7`
- Review diff SHA-256: `45b8b36fd98c01b88b8c1cd19948e3997eab37b883f7549f21af4b3c45a816b5`
- Contract SHA-256: `6beffaea1a81f9bc67a270b5bb47c6193982ff665eae944cbbe8ec6b526a1c51`

## Independent verdicts

| Arm | Runtime/model | Verdict | Report SHA-256 |
|---|---|---:|---|
| Kimi K3 | Kimi CLI 0.36.1 / `kimi-code/k3` | REJECT | `e16a00b6a80afdcf07d2d4f44be4a4154706aeef095e3a534e8f782e663efd7b` |
| GPT-5.6 Sol Pro | Codex CLI 0.134.0 / `openai/gpt-5.6-sol-pro`, xhigh | REJECT | `efc9e87b8c2bd6abe3c6005a54ffcd0bd4b7452fbdac8d8257948496513ff256` |

No reviewer found a P0. Both reviews reject the current slice before local side-effect testing/R2.

## Convergence

1. **Confirmed P1: authority outage grants can become persistent L0 grants.** Kimi found the concrete collapse to `command-eve:L0:<tool>` on authority timeout/unavailable; Sol independently found the broader same-rung revocation problem for native session/always keys. Controller disposition: confirmed; repair before any further approval-gate testing.
2. **Confirmed P1: native Hermes approval behavior is asserted, not runtime-proved.** Kimi found the removed explicit no-callback fail-closed path and possible callback-shape mismatch/fail-open. Sol found the same missing wheel-backed contract. Controller disposition: confirmed; load the exact Hermes 0.20 wheel and prove interactivity, no-callback denial, timeout denial, allowlist key semantics, and callback command shape.
3. **Confirmed P1/P2: builtin MCP identity is a name, not provenance.** Both arms found the same collision risk. Controller treats it as a release-blocking P1 until Hermes namespace behavior is proven or reserved names are rejected.
4. **Confirmed P1/P2: managed image preview is ID-based but actions remain path-based.** Both arms found preview/download/open/reveal split authority. Controller treats the broken user actions as P1 for the current product workflow.
5. **Confirmed P2: paid-tool permit/credit enforcement is outside the reviewed evidence.** Product authority may only auto-allow these calls if the downstream product seam is executable-proved.
6. **Confirmed P2: malformed `tool_call` normalization needs fail-closed probes.** Malformed/non-object arguments must not classify as a read or diverge from the bridge's actual parser.
7. **Architecture direction preserved.** Both arms agree the move toward Hermes' native approval plugin is directionally correct, but not with the current persistence key and without a wheel-backed contract test. Sol's bounded 1.823.5 split (policy core, small adapter, native plugin, version-bound installer, Main artifact API) is the preferred structure.

## Controller requirements before further live testing

1. Make authority-outage asks non-persistable or keep one-operation-only for unverified authority.
2. Add an exact-Hermes-wheel approval-contract test (interactive ACP, no-callback, timeout, exact key matching, callback shape).
3. Reject or prove builtin MCP namespace collisions.
4. Force managed-image preview/download/open/reveal through verified artifact-ID authority; hide path actions that cannot be resolved by Main.
5. Add malformed `tool_call.arguments` and ask-classified bridge negative tests.
6. Re-run both independent arms against a new frozen diff after remediation.

## Live dev boot note

The first source-run bootstrap failed because Electron dev's generic Resources tree shadowed the checkout bundles. A scoped dev-only bootstrap fix now passes:

- Runtime receipt: `status: ready`, all required stages pass (Hermes, presentation Python, Ollama, model).
- Active Hermes patch contains the Tool-Search unwrap and `command-eve:L<ladder>:` key.
- `bunx tsc --noEmit -p tsconfig.json`: exit 0.
- GitNexus scope check: one file/two `handleAppReady` symbols, high graph risk due the central boot symbol; actual code delta is a single dev/packaged resources-path branch.

This live boot is for local testing only. It does not refute the two REJECT verdicts and does not authorize R2.
