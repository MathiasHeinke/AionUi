# Kimi K3 independent security review

Read `reports/command-eve/2026-08-18/eve-18234-review-contract.md` and the frozen diff `/tmp/eve-18234-review-diff.patch` in the repository named there. Follow that contract exactly.

Your primary job is adversarial security and regression review of the Hermes tool-approval and builtin-MCP authority changes. Trace the actual control flow, not just the diff shape. Pay special attention to:

- bypass or privilege confusion through `mcp__aionui_*` prefix matching;
- malformed/JSON-string arguments in the Tool-Search `tool_call` unwrap;
- allowlist persistence and authority-ladder downgrade behavior;
- whether product-managed paid calls retain their credit/permit seam;
- whether native `approve` can accidentally become non-interactive or fail open;
- preview leakage or path confusion through managed image payloads;
- missing negative tests that would let a future refactor fail open.

Finish with a final line containing exactly:

`EVE_18234_KIMI_REVIEW_COMPLETE`
