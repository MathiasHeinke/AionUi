# Grok 4.6 runtime proof

- checked_at: 2026-08-14T21:17:02Z
- runtime: Grok CLI 1.0.3
- requested_model: grok-4.6
- resolved_model: grok-4.6
- auth_lane: grok.com subscription
- permission_mode: plan/read-only
- reasoning_effort: xhigh
- billing_class: fixed-subscription
- environment_keys_unset: ANTHROPIC_API_KEY, OPENROUTER_API_KEY
- sentinel: `GROK46_RUNTIME_OK`
- result: PASS
- note: the CLI accepts xhigh as its highest exposed effort; an initial `max` probe was rejected before inference and was not relabeled.
