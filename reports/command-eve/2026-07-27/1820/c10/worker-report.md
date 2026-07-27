# Command EVE 1.820 C10 / COMPA-819 worker report

## Identity and scope

- Worktree: `/Users/mathiasheinke/Developer/.agent-sandboxes/aionui/eve-1820-rebuild`
- Branch: `codex/command-eve-1820-rebuild`
- Integration HEAD while this slice was built: `3b44fd6cb6adf3ac1b6e7dcbb23e4f831afb9d0a`
- Live lineage required by the contract: `242eb69486af584c8028932b933d9d60da8e6364`
- Contract description SHA-256: `ee779726a822d75f40de8fc425b515f72ce95eee48f342b2462ff57f43a97c3f`
- Authority contract revision: `v13`
- Authority contract SHA-256: `66f5c7fae2f13de36ba90a4902950033007e5fbd145dc8f86a1135963fc52236`
- Plane receipts supplied by Root:
  - Stage 0.5 `CONTRACT_PASS`: `b9a4464a-eaf2-4196-beb6-020fda653046`
  - Stage 0.65 `RUNTIME_READY_PASS`: `d949b4f8-9ad5-44f5-b991-b28ad587221c`
- COMPA-806 lineage remains open. This worker does not claim the temporary exception closed.

The slice is a behavior-preserving source split only. No Supabase auth wrapper,
`verify_jwt`, `config.toml`, schema, migration, data, desktop, deploy, release or
provider/economics behavior was changed.

## Pre-split freeze

- Pre-split `index.ts` SHA-256 from Git HEAD:
  `ab3eff49ccf6c86f1b1dd63fbc34baab23f644fb8b601e0f0a5afa40e8a1e7ad`
- Frozen normalized fixture:
  `supabase/functions/eve-multimodal/fixtures/pre-split-golden.json`
- Fixture SHA-256:
  `47141a7520cafa4f449dc27eec504f43e6812cee6b9b29cc58ed8bd450f09e77`
- The fixture suite was executed successfully before the split and again after
  the split.

The frozen cases cover the current image-generation response, the current
PPTX-shaped vision request response, enabled TTS provider request/response,
missing-license authorization, and invalid-JSON error behavior. Only the
runtime timestamp and provider authorization value are normalized. Provider
payload text, PPTX filename and test credentials are asserted absent from the
client response.

## Implementation

The former 843-line entrypoint is now a 17-line deployment entrypoint. Existing
boundaries were moved without changing their conditions, values or ordering:

- `gateway/handler.ts` (322 lines): request sequencing, verified-license
  response enrichment, entitlement/usage decisions and final response assembly.
- `gateway/http.ts` (48 lines): CORS and JSON/blocked response behavior.
- `gateway/license.ts` (36 lines): CEVE WIRE verification, cached public key and
  request-id behavior.
- `providers/pdf-ocr.ts` (318 lines): PDF validation-adjacent provider request,
  ZDR payload, response bounds/page parsing and daily usage reservation.
- `providers/tts.ts` (98 lines): xAI TTS gate, timeout, content validation and
  bounded audio response.
- `providers/encoding.ts` (8 lines): unchanged base64 conversion.
- `providers/types.ts` (22 lines): injected fetch and usage-reservation seams.
- `golden-parity.test.ts`: fixture-backed normalized semantic parity.

The `eve-multimodal` directory has 9 direct children, below the repository
limit of 10.

## Preserved contracts

- Request methods and CORS response headers are unchanged.
- The bearer remains the raw CEVE license WIRE; no Supabase JWT migration was
  introduced.
- Invalid, expired and absent licenses retain the same status/reason/message.
- Provider keys remain server-only and provider response bodies are not echoed.
- Privacy/residency decisions remain in `multimodal-core.ts`, unchanged.
- PDF entitlement, tenant/global page caps, request replay, accounting
  fail-closed behavior and provider-before/after ordering are unchanged.
- xAI TTS remains server-feature-gated with the same provider URL, body,
  timeout, MIME, empty-body and size checks.
- OpenRouter PDF OCR retains the same model selection, ZDR/data-collection
  fields, Mistral parser declaration, page-boundary validation and bounded
  response behavior.
- Image and PPTX-shaped vision requests remain provider-disabled at this server
  function; the refactor does not invent support.

## Verification

### Required behavior and type gates

- `deno test -A supabase/functions/eve-multimodal/index.test.ts supabase/functions/eve-multimodal/multimodal-core.test.ts`
  - PASS: 41/41
- `deno test -A supabase/functions/eve-multimodal/golden-parity.test.ts`
  - PASS before split: 5/5
  - PASS after split: 5/5
- `deno check supabase/functions/eve-multimodal/index.ts supabase/functions/eve-multimodal/multimodal-core.ts`
  - PASS
- `deno lint supabase/functions/eve-multimodal`
  - PASS: 12 TypeScript files checked
- `npx oxfmt --check supabase/functions/eve-multimodal`
  - PASS: 14 files, repository-canonical formatter
  - Root independently repeated this gate: PASS
- `git diff --check -- supabase/functions/eve-multimodal`
  - PASS

### Formatter contract correction

Root corrected the mistaken raw-Deno formatter command in the canonical C10
contract to the repository-canonical Oxfmt gate above. The corrected contract
has fresh Stage 0.5 and Stage 0.65 receipts bound to its new description hash.
There is no remaining formatter blocker.

### Security and privacy scan

- Secret-shaped pattern scan across non-test function sources: PASS, no match.
- Customer/patient/health/contact-data scan of the frozen fixture: PASS, no
  match.
- Test fixtures contain only explicitly fake keys; provider authorization is
  normalized to `Bearer [redacted]`.
- Existing tests prove provider error bodies, provider keys, TTS text and PDF
  bytes are not echoed in responses.

### GitNexus

- Impact was run before edits for all 27 existing function symbols in the
  pre-split `index.ts`: every resolved function returned LOW.
- Five private type aliases were not indexed and returned UNKNOWN with zero
  impacted symbols; they had no exported consumer surface.
- API impact reported no route node for the Supabase function path.
- `detect_changes(scope=all)` was executed. Its HIGH aggregate is caused by
  already-present concurrent desktop permission/runtime changes in the shared
  worktree. GitNexus did not map the untracked new C10 module files or the
  delete-and-reexport entrypoint split into a C10 process. This limitation is
  not represented as a C10 PASS; the C10 evidence is the LOW pre-change symbol
  impacts plus the 46 behavior/parity tests.

## Diff and rollback

Allowed source changes only:

- replace `supabase/functions/eve-multimodal/index.ts` with the thin entrypoint;
- add `gateway/**`, `providers/**`, the frozen fixture and the parity test;
- add this report under the authorized C10 report path.

Rollback is code-only: revert the future C10 source-split commit (or restore
the pre-split `index.ts` with SHA-256 above and remove the added C10 modules,
fixture and test). No schema, data, Supabase project, secret, provider or
production rollback action is required.

## Blockers and residual review

- Functional blocker: none found.
- Contract/tooling blocker: none; the canonical contract now names the green
  repository Oxfmt gate.
- Independent security/regression review remains a controller/CAO gate; this
  worker does not self-close COMPA-806 or mark Plane Done.
- No commit, push, Plane write or deploy was performed.

## Outcome rubric self-assessment

- Auth and entitlement parity: 30/30
- Metering and privacy parity: 25/25
- Provider and response parity: 25/25
- Rollback and maintainability: 20/20
- Total: 100/100

This score is evidence for controller review, not release authority or
self-promotion.

## Reflection

The safest split was mechanical ownership separation around the already-tested
boundaries, not a new abstraction or framework. Freezing observable behavior
before moving code caught the actual client contract and made it possible to
prove the same image, PPTX-shaped, TTS, auth and error outputs after the move.
The process correction is now incorporated: release contracts must name the
repository-canonical formatter explicitly, and this leaf's corrected Oxfmt gate
is independently green.

subagents: []
