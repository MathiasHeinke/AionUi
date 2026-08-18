• I'll start by reading the review contract and the frozen diff.

• The diff SHA matches the contract. Now I'll read the scoped repository files, starting with the authority core.

• Working tree matches the review commit for the scoped paths. Now I'll read the shim-generation code in `runtimeBootstrapCore.ts`.

• Now let me check the shim's imports and surrounding context, plus the in-scope test fixture harness.

• Let me look at the second hook-registration site and the tool-approval HTTP endpoint.

• The endpoint handler lives outside the sanitized scope; I'll note that. Now the remaining scoped files.

• Let me check the diff's file list and read the remaining scoped files.

• I have everything I need from the scoped evidence. Writing the review now.

• # EVE 1.823.4 — Kimi K3 independent security review

  Diff SHA-256 verified against the contract (`45b8b36f…a816b5`). Working-tree code for all scoped paths is byte-identical to `96efee4c2`. I traced the emitted Python shim, the TS authority function, the fixture harness, and the renderer component as actually wired — not just the diff hunks.

  ## Verdict: `REJECT`

  Not for a confirmed exploit, but because this diff deletes an executable fail-closed control (the explicit "no callback → block" path and the `allow_permanent`/`smart_denied` clamps) and replaces it with an unverified external contract on Hermes' `request_tool_approval`, while no in-scope executable test pins that contract. Two fail-open paths and one concrete persistence hole must be closed or disproven before release.

  ## Findings

  ### P1 — Authority-outage "always" grants collapse to rung L0 and then ride future outages (and genuine rung 0)

  `runtimeBootstrapCore.ts:7353-7364` — on any authority error, `_command_eve_ask_tool_authority` returns `{"decision": "ask", "ladder": 0, "reason": …}`. At `runtimeBootstrapCore.ts:7441-7446` the hook then mints `rule_key = f"command-eve:L{ladder}:{label}"`, i.e. **`command-eve:L0:…` for every ask issued while the shim is unreachable** (both `authority_timeout` and `authority_unavailable`).

  Attack path / failure: shim down or slow → user gets "could not confirm the current authority grant within 2 seconds" cards → user clicks **always** to stop the noise → per the patch's own stated semantics (`runtimeBootstrapCore.ts:7433-7440`: "persists the answer in Hermes' own allowlists"), a permanent allowlist entry `L0:<tool>` is written. From then on, (a) every future authority outage auto-approves that tool with the seat's real rung unknown, and (b) a seat genuinely parked at rung 0 — the "change nothing" off-switch — runs that tool unattended. The ladder-in-the-key downgrade protection (`eveAuthorityRuntimeCore.ts` doctrine; harness case 7) is defeated precisely when it matters most, because outages collapse all rungs to L0.

  Preconditions: user selects "always" during one outage; Hermes keys its permanent allowlist by exact `rule_key` (the patch's own claim).

  Evidence: `runtimeBootstrapCore.ts:7356-7364`, `7429-7431`, `7441-7446`; the removed one-operation clamp at diff lines 139-167 (old code blocked without a callback and never offered permanence).

  Bounded remediation: for `reason in {authority_timeout, authority_unavailable}`, make the rule key non-persistable (e.g. suffix a per-boot nonce: `command-eve:L0:{label}:unverified-{boot_id}`), or keep the old direct-callback, `allow_permanent=False` path for unverified-authority asks only. Add a harness case asserting a timeout ask never yields a reusable rule key.

  ### P1 — Native `approve` gate's ACP behavior is asserted in comments, proven nowhere executable

  The diff routes every structured-tool "ask" through `{"action": "approve", …}` (`runtimeBootstrapCore.ts:7442-7446`), relying on Hermes' `tools.approval.request_tool_approval` to (a) be interactive in the ACP desktop, (b) deny safely when no human/callback answers, (c) never fall back to a non-interactive default. The harness's stub `tools.approval` module (`tests/fixtures/command-eve/permission_authority_patch_harness.py:104-111`) **does not even define `request_tool_approval`** — case 8's claim "the fail-closed ownership now lives in the native gate, which denies safely when no human can answer" is prose, not evidence; the old executable `if not callable(approval_callback): return block` was deleted. Unlike the browser-use harness, this harness never loads the bundled wheel (`runtimeBootstrapCore.test.ts:1750-1758` passes only the provider path).

  Compounding this, the approval-callback wrapper decides "structured gate vs shell command" with `re.match(r"^<[a-z][a-z0-9_:-]*>", command_text)` (`runtimeBootstrapCore.ts:7530`). The old code called the callback itself with `f"<{tool}> {action}"`, so the match was by construction. Now the command string is whatever `request_tool_approval` passes. **If that format ever stops matching the regex, the wrapper reclassifies the gate as a shell command, and at rung ≥3 (`workspace_command`) `_command_eve_ask_authority` returns allow for any path-free string → the wrapper returns `"once"` → a tool the hook explicitly said to ask about runs silently** (`runtimeBootstrapCore.ts:7531-7536`). That is a fail-open one Hermes-side formatting change away.

  Preconditions: (i) Hermes 0.20's gate is non-interactive or fail-open without a callback — unverified; or (ii) its callback command format mismatches the regex — unverified.

  Bounded remediation: extend `permission_authority_patch_harness.py` to load `resources/bundled-hermes/hermes_agent-0.20.0-py3-none-any.whl` (as `browser_use_uvx_receipt_patch_harness.py` already does) and drive the real `request_tool_approval`: assert interactivity, deny-on-timeout, no-callback behavior, exact-match allowlist semantics, and the exact callback command string against the regex. Pin the contract to `HERMES_VERSION == "0.20.0"` the way the clarify patch already does (`hermesDesktopBridge.test.ts:235`).

  ### P2 — Builtin-MCP allowlist keys on the server *name string*, not server identity

  `eveAuthorityRuntimeCore.ts:312-325`: any server whose envelope starts with `mcp__aionui_eve_artifacts__` gets the builtin policy. A user-configured or maliciously suggested third-party MCP server **named** `aionui_eve_artifacts` with a tool named `eve_image_edit` would inherit popup-free authority (and the paid-call cover story) without being the bundled server. The trailing `__` in the prefixes correctly blocks near-miss names (`aionui_eve_artifacts_evil`, `aionui_image_generation_2` fail closed — verified by reading the prefix arithmetic), so this is purely a name-identity gap. Preconditions: an MCP server config carrying that name reaches Hermes (user config import, or a config write approved in an earlier turn). Remediation: bind the policy to a bundled-server marker (config source or command path) rather than the name, or document the name as reserved and reject user servers colliding with it.

  ### P2 — Managed-image "verified bytes only" doctrine is not fully enforced in the component

  `MessageGeneratedArtifact.tsx:558`: `previewSource = managedImagePreviewSource ?? (source?.startsWith('file:') ? localFilePreviewSource : source)`. The new marker-only detection (`:403`) correctly kills the workspace path confusion, and the local-file fallback is properly suppressed for managed images (`:480-484`). But a managed payload that also carries a URL key (`SOURCE_URL_KEYS`, `:47-62`) yields a non-`file:` `source`, which renders **while the bridge is pending and permanently if it fails** — contradicting the new comment's claim that "the verified bytes are the only preview source" (`:394-402`). A crafted/tampered managed payload could thus pull a remote image into the card. Related product gap: `handleDownload` (`:600-635`) and Open/Reveal (`:575-598`) still prefer `openPath` — in the exact temp-conversation scenario this release fixes for preview, Download falls through `downloadFileFromPath` → `readGeneratedArtifactPreview` against the wrong-root path and errors, even though verified bytes sit in `managedImagePreviewSource`. Remediation: for `isManagedImage`, force `previewSource = managedImagePreviewSource` and prefer it in `handleDownload`.

  ### P2 — Missing negative tests that would let a future refactor fail open

  - No harness case where `tool_call` wraps an **ask-classified** tool (e.g. `browser_click`): the approve directive's `rule_key`/label carrying the *underlying* name is unpinned; a regression to labeling `tool_call` would silently hand out always-grants on the bridge key. (Harness case 11, `permission_authority_patch_harness.py:249-287`, covers only allow + quarantine.)
  - No harness case for `tool_call` with `name` in `_COMMAND_EVE_NATIVE_AUTHORITY_TOOLS` returning `None` (`runtimeBootstrapCore.ts:7404-7405`) — the "terminal/edits keep their native seam through the bridge" assumption is untested.
  - No test for malformed JSON-string `arguments` (`runtimeBootstrapCore.ts:7397-7401`) — the `except → {}` path must keep failing closed (e.g. `computer_use` with unparseable arguments → ask).
  - No TS test pinning case-sensitivity fail-closed (`MCP__AIONUI_EVE_ARTIFACTS__EVE_IMAGE_EDIT` → ask) or empty inner name (`mcp__aionui_eve_artifacts__` → ask). Both fail closed today by construction; nothing stops a "helpful" `.toLowerCase()` or prefix-loosening refactor from opening them.
  - No renderer test that a managed payload carrying a URL does not render it (P2 above).

  ### P3

  - Paid MCP calls (`eve_video_generate`, `eve_image_edit`, …) auto-allow at **rung 0** (`eveAuthorityRuntimeCore.ts:294-310`; pinned by `eveHermesToolAuthority.test.ts:92-103`). Consistent with the pre-existing native doctrine, but it means the "off" rung spends money with no card — the entire seam is the product server's credit preflight/permit, which is outside the scoped evidence. Worth an explicit product sign-off, not just inheritance.
  - During an authority outage, every gated structured tool call eats the 2s HTTP timeout *before* the allowlist can even be consulted (the hook must compute the rule key first) — expect visible stalls exactly when the shim is degraded.
  - `RegistrationGatePage.css`: new `color-mix(in srgb, var(--eve-accent) …)` usages carry no fallback (unlike `var(--eve-brand-ui, #c2410c)` on the same page); if `--eve-accent` is ever undefined in that context the declarations go invalid at computed-value time and the button shadow / active-tab background silently vanish. Cosmetic.
  - Harness case numbering runs 11 before 10 (acknowledged in a comment); harmless but confusing in a security gate.

  ### Verified clean (traced, not assumed)

  - Prefix confusion through `mcp__aionui_*`: trailing-`__` prefixes make near-miss servers and unknown tools fail closed; third-party servers (`mcp__github__…`) never match and land on the catch-all `ask`; the 128-char URL truncation cannot truncate *into* an allow-listed name (allowed full names are ≤ ~60 chars, truncation keeps ≥128).
  - `tool_call` unwrap ordering is correct: native-authority short-circuit → unwrap → native re-check → quarantine → authority call; malformed/non-dict/JSON-string arguments degrade to `{}` → empty action → `ask`; bare `tool_call` is pinned to `ask` at both the shim-TS boundary (`eveAuthorityRuntimeCore.ts:365`) and in tests (`eveHermesToolAuthority.test.ts:118`).
  - The shim has `import json` (`runtimeBootstrapCore.ts:5544`); `int(authority.get("ladder") or 0)` cannot raise because the client already normalizes.
  - Patch-install integrity: missing hook/factory markers raise at model-call build time (`runtimeBootstrapCore.ts:10086-10093`) rather than silently ungating.
  - Version bumps (1.823.4) are consistent across the two manifests and `commandEveShell.ts`.

  ## Tests / probes required before release

  1. Wheel-backed `request_tool_approval` probe (P1 #2): interactivity in ACP mode, deny-on-timeout, no-callback behavior, exact-match allowlist, callback command format vs the `^<[a-z][a-z0-9_:-]*>` regex.
  2. Timeout-ask non-persistence test for whatever remediation closes P1 #1.
  3. The five missing negative tests listed under P2.

  ## Release-risk staging

  - **Before local live testing:** items 1-2 above.
  - **Before R2 dev publication:** P2 name-identity binding decision, managed-image URL fallback + download ordering, negative tests.
  - **Deferrable:** P3 items.

  ## Claims I could not verify (out of scoped evidence)

  - Existence and semantics of `tools.approval.request_tool_approval` in the bundled Hermes 0.20.0 wheel (interactivity, gateway-queue avoidance, allowlist key matching, permanent-allowlist storage location and whether it is per-seat).
  - That the Tool-Search bridge skips *only* `pre_tool_call` and leaves terminal/edit native seams intact for unwrapped `terminal`/`write_file`/`patch`/`search_files`.
  - That the credit preflight / minted permit actually gates the four paid MCP tools inside the builtin servers.
  - The `/v1/command-eve/tool-approval` endpoint handler (`ollamaOpenAiShim.ts:3632`) — outside the sanitized scope; reviewed only via its in-scope tests.
  - Whether Hermes re-fires hooks after an approve decision (double-prompt/loop behavior).

  This review covers the frozen diff and the scoped files only; it is not a blanket assurance for paths outside that evidence.

  EVE_18234_KIMI_REVIEW_COMPLETE

