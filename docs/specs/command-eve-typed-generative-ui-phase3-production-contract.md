# Command EVE Typed Generative UI — Phase 3 production contract

Status: implementation contract. It does not authorize a merge to `main`, release, signing, notarization, R2 upload, deployment, or production enablement.

Work item: `MAT-1776`

Candidate base: AionUI `bc9e2b9727a57b4bdb6519e945104f3828a7141a`

Frozen upstream inputs:

- Hermes native goal ledger: `c8f3c0051d5b5e1760b2d135d93aaf699294c327`
- Hermes durable delegation completion: `c72363fc572a8a72d6b6e23e53b82da5753a1bc9`
- AionCore route-scoped durable wake: `8a71ed74238f7ab87471d1b0ccf690ddecc24786`
- AionCore Restart + Pending + Load fix: `3c5eab9a62c336b298d680845ff976e13ea212df`
- AionCore Durable-Work receipt delta (read-only design input; never integrate directly): `dcb47906ade6d88238a84550d974c77a7ea5e17c`
- AionUI Durable-Work activity surface: `cbf18129e9333289215a3b089c024f711fa124a1`

`3c5eab9` has independent review evidence, but `dcb47906` diverges from it and must not be pinned or integrated directly. The Durable-Work owner is producing a new reviewed composite on top of `3c5eab9`. Goal and per-worker typed write adapters also do not yet exist. Those facts keep lifecycle controls closed; they do not block the independent generation-receipt implementation.

## Non-negotiable boundary

The model may submit only a versioned declarative Typed UI envelope through one fixed, app-owned MCP tool. It cannot submit React, JavaScript, CSS, HTML, an iframe, a callback, a shell command, IPC, a URL fetch, provider evidence, a receipt, a seat, a conversation, a message ID, or a filesystem path.

Every host action remains a two-phase Main-owned operation:

1. Main verifies provenance and authorizes an exact attested action binding.
2. Only after the durable authorized intent exists may the host perform the effect.
3. Main then finalizes the same intent with immutable downstream evidence.

No renderer claim is evidence. No latest-by-session lookup is allowed. No second chat, lifecycle, queue, completion store, or state machine is introduced.

## Production generation receipt

### Publish surface

The built-in artifact MCP advertises exactly one additional non-spending tool:

```text
eve_typed_ui_publish(envelope)
```

The tool accepts one JSON object. Main runs the canonical Typed UI schema/catalog validator and returns only:

```json
{
  "ok": true,
  "mime_type": "application/vnd.command-eve.typed-ui+json",
  "schema_version": "command-eve.typed-ui/v2",
  "catalog_version": "command-eve.typed-ui.catalog/v2",
  "content": "<canonical JSON envelope>"
}
```

Invalid, partial, oversized, over-depth, over-node, over-action, forbidden-key, invalid-event/action, invalid-pointer, or executable content returns a fixed failure reason and no artifact. This operation has no handle, permit, provider call, network target, arbitrary operation name, or state mutation.

### Provider-terminal capture

Every real Main-owned chat-completion route observes its own final provider response before forwarding success:

- Command EVE cloud;
- managed local;
- connected OpenAI-compatible;
- Ollama/local compatibility.

For each complete `eve_typed_ui_publish` tool call, the route writes one private completion record only after all of these are true:

- the upstream HTTP request succeeded;
- a streaming response reached a syntactically complete terminal event, or a non-streaming body parsed completely;
- the tool name and exact tool-call ID are present;
- the accumulated arguments parse as one envelope;
- the canonical schema/catalog validator accepts it;
- the route owns its private provider/model/route identity, request correlation, active seat and seat revision.

The completion record binds domain-separated hashes of the exact tool-call ID, canonical envelope bytes, model-authored provenance claims, route-owned identity, request correlation, session, seat, and terminal provider receipt. Raw provider/model/base URL details remain Main-private and never cross IPC. For the Command EVE cloud lane, the desktop can truthfully attest only the EVE Inference service and selected tier; it does not claim the hidden downstream vendor/model without a future authenticated upstream receipt.

Malformed, truncated, duplicated, conflicting, non-terminal, non-2xx, or unknown-tool responses never produce a completion receipt. One receipt binds one exact tool call; session-wide or “most recent” matching is forbidden.

### Durable artifact join

The renderer may wake the attestation provider with only the existing opaque artifact/conversation/source-message reference and envelope. Main then performs an authenticated exact-message read from AionCore:

```text
GET /api/conversations/{conversation_id}/messages/{source_message_id}
```

Main must prove from the durable message/tool result that:

- the conversation and source message are exact;
- the tool call is `eve_typed_ui_publish`;
- its call ID matches exactly one unused private completion;
- the persisted result contains the same MIME type, schema/catalog versions, and canonical envelope hash;
- the host artifact ID is deterministically derived from that same call ID;
- creation time and active seat/revision are within the existing attestation contract.

Only then may Main consume the private completion and append the trusted generation receipt. The consumption marker is appended to the same private completion ledger after the fsynced generation record, so an old generation line falling outside the bounded verification tail cannot make the completion reusable. Missing AionCore data, missing call ID, ambiguous calls, hash drift, stale seat/revision, cross-conversation lookup, replay, or backend unavailability returns a rejected attestation without consuming a different receipt.

Actual route identity is attested privately. Model-authored provider/model strings are untrusted claims sealed to the generated bytes, not proof of the real provider. The renderer displays only the existing provider-free verified/rejected status.

## Durable lifecycle adapter

### Read contract

Typed UI consumes only the authenticated Durable-Work projection:

```text
command-eve-async-completion-receipts/v1
    -> command-eve-durable-work-activity/v1
```

The host, never the model, supplies `conversationId`. A lifecycle declaration may identify only its exact `goal_id` or `worker_id`, requested action, `expectedRevision`, and `expectedSequence`.

Before any adapter call, Main authorization must already have durably bound artifact, conversation, source message, attestation, action ID/type and exact parameters. The current authenticated snapshot must then confirm exact conversation, work-item ID, target kind, canonical ACP session, revision, sequence, and `actions[action].available`.

### Write contract

The only allowed effect seam is the installed `AionCoreDurableWorkActivityAdapterV1.requestDurableWorkAction()` implementation. The request and acknowledgement must echo the exact version, conversation, work-item, action, revision and sequence.

An acknowledgement may be:

```text
accepted | already_applied | needs_approval | rejected | unavailable
```

`accepted` and `already_applied` prove command admission/application only. They never prove the goal or worker succeeded, paused, resumed, cancelled, or completed. Target state changes only from a later authenticated persistent-receipt snapshot with a greater revision or sequence.

The adapter acknowledgement receipt ID must be persisted as downstream evidence on the same existing Typed UI action receipt before finalization. This is a versioned extension of the current action ledger, not a new store. A completion-persistence failure after an admitted effect retries only the identical finalization and never performs the effect again or rewrites it as failed.

### Capability state at this contract freeze

- `goal_control`: disabled. Hermes has native GoalManager state, but only a text `/goal` write surface without typed CAS/action receipts.
- `worker_control`: disabled. Hermes has session-wide interruption, not an exact delegation-ID control surface.
- live AionCore turn cancellation: may be considered only when an authenticated item explicitly advertises `cancel.available`, the turn ID is exact, and the installed adapter returns its typed acknowledgement. It must not be presented as per-worker cancellation.
- pause/resume/retry: disabled until their exact upstream capability exists and receives independent review.

The new AionCore composite must be based on `3c5eab9`, carry the reviewed receipt projection semantics represented by `dcb47906`, and receive its own independent review. `dcb47906` itself is not an admissible dependency. Until that composite is frozen, a pre-bind completion can be terminally lost and no lifecycle action is attested or enabled.

## Provider-free integration gates

Generation receipt:

- all four production route shapes, streaming and non-streaming;
- exact fragmented tool-call argument reconstruction;
- non-2xx, truncated stream, missing terminal event, malformed JSON and unknown tool;
- multiple calls and parallel sessions without latest-by-session matching;
- exact AionCore persisted-message re-fetch and call-ID/content correlation;
- forged renderer provider/model/receipt evidence has no input path;
- replay, seat/revision/source/conversation/artifact/content mismatch;
- no raw provider/model/base URL or raw action parameters across IPC or public ledgers;
- bounded private ledgers cannot brick attestation when old records exceed the read window.

Durable transport:

- real two-process Restart + Pending + Load with the identical DTO delivered once;
- foreign bound session rejected; unbound pre-load session retryable;
- exact ID/kind/conversation/CAS failures before effect;
- authority and durable intent before adapter call;
- immutable downstream acknowledgement correlation;
- duplicate, crash and replay behavior;
- `accepted` is not terminal;
- no text-command success parsing and no broad session cancellation presented as per-worker control.

## Gate rule

The current Superintendent scope is the display/typed-schema lane only. That candidate may report `DISPLAY_CANDIDATE_PASS` when the production producer is reached from every supported provider route, the durable artifact join re-fetches AionCore-owned truth, provider-free integration and action-broker tests pass, lifecycle remains disabled, an independent P0/P1 review passes, and the frozen candidate receives an explicit Opus 5 xhigh `OPUS5_REVIEW_PASS`.

Full Phase 3 may report `PASS` only when the combined Durable-Work dependency is also frozen and reviewed and the exact lifecycle identity/transport contract has been integrated and retested.

Until then the precise result is `DEPENDENCY_REJECT` or `REJECT`, with implemented independent parts and exact missing commits named. No test injection, mock success, renderer-supplied adapter, or disabled-reason bypass may upgrade that result.
