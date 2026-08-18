# Kimi K3 runtime proof

- Checked at: 2026-08-18T17:39:15Z (smoke), 2026-08-18T17:58:35Z (review completion)
- Runtime: kimi-cli 0.36.1
- Auth lane: managed Kimi Code OAuth (`managed:kimi-code`, source `oauth`)
- Model: `kimi-code/k3`, fresh prompt-mode session
- Effort: Kimi default `high` for `kimi-code/k3`
- Billing: fixed Kimi Code subscription lane; marginal cost verified-current for this lane
- Permission profile: read-only reviewer, prompt mode, no `--yolo`/`--auto`
- Environment keys unset: `MOONSHOT_API_KEY`, `KIMI_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`
- Smoke sentinel observed: `KIMI_K3_REVIEW_RUNTIME_OK`
- Review sentinel observed: `EVE_18234_KIMI_REVIEW_COMPLETE`
- Report: `reports/command-eve/2026-08-18/eve-18234-kimi-review.md`
- Controller note: the older `~/.kimi-code/bin/kimi-k3` wrapper rejected the current provider because it requires exactly one advertised model; the provider now advertises four. Direct `kimi --model kimi-code/k3` preserved the intended fresh K3-only policy and is the proof recorded here.
