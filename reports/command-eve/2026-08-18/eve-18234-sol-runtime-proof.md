# GPT-5.6 Sol Pro runtime proof

- Checked at: 2026-08-18T17:40:52Z (smoke), 2026-08-18T17:52:31Z (review completion)
- Runtime: codex-cli 0.134.0 using a temporary xhigh-compatible model catalog
- Auth lane: OpenRouter API key from the local macOS keychain; key value never logged
- Model: `openai/gpt-5.6-sol-pro`
- Effort: `xhigh`
- Billing: variable API lane, explicitly selected by Mathias for this review
- Permission profile: `--sandbox read-only --ephemeral`
- Smoke sentinel observed: `GPT_SOL_XHIGH_REVIEW_RUNTIME_OK`
- Review sentinel observed: `EVE_18234_SOL_REVIEW_COMPLETE`
- CLI-reported token usage: 737.780 tokens (CLI did not split input/output/reasoning)
- Cost: invoice truth remains OpenRouter; local ledger row records the run and token count without fabricating a price
- Report: `reports/command-eve/2026-08-18/eve-18234-sol-review.md`
