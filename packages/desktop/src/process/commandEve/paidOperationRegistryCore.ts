/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1749 — THE PAID-SEAM OPERATION ALLOWLIST.
 *
 * The loopback shim authenticates WHO calls it (bearer nonce, 127.0.0.1 bind,
 * constant-time compare) but never authorised WHAT FOR. Any in-product component
 * holding the nonce therefore reached the METERED cloud lane through the general
 * `POST /v1/chat/completions` path. Hermes' auxiliary `title_generation` is such a
 * component: one user message produced TWO debits, the second for a title the
 * customer never requested, cannot decline and cannot see.
 *
 * This module is the POSITIVE registry that closes it. Membership is the ONLY way
 * to the paid lane; absence is a refusal, never a default. It is the client-side
 * twin of the server's billable-operation registry.
 *
 * WHY A POSITIVE LIST AND NOT A DENYLIST: a denylist has to name every auxiliary
 * that must not spend. `title_generation` was closed once already for AionUi's own
 * title path (commit d5135ec6) and a SECOND producer inside Hermes survived on a
 * different call site. A positive list makes the NEXT unnamed auxiliary — one that
 * does not exist yet — unable to spend on the day it ships.
 *
 * WHAT "FAIL CLOSED" MEANS HERE, because the phrase is ambiguous and the ambiguity
 * is expensive: it means CANNOT SPEND, not CANNOT RUN. This registry governs money,
 * so it is entitled to withhold the paid lane and nothing more. A named operation it
 * does not know still runs — locally, for free. The one exception is an operation
 * that names itself NOTHING, which is refused loudly; see resolveCommandEvePaidSeam.
 *
 * THE CARRIER — why the operation rides the BODY and not `X-EVE-Dispatch`.
 *
 * The brief asked for the existing `X-EVE-Dispatch` header unless there is a
 * concrete reason it cannot carry this. There are two, both verified against the
 * bundled wheel (`resources/bundled-hermes/hermes_agent-0.17.0-py3-none-any.whl`):
 *
 *   1. OPPOSITE DEFAULTS ON ONE CARRIER. `X-EVE-Dispatch` answers WHO (roster
 *      attribution) and is fail-OPEN by written contract — "any token that does not
 *      resolve returns `eve` so the main lane never breaks" (ollamaOpenAiShim.ts,
 *      CommandEveDispatchAttributionResolver). This registry answers WHAT FOR and
 *      must fail CLOSED. Putting a fail-closed money decision on a fail-open
 *      identity channel makes one carrier owe two contradictory defaults.
 *
 *   2. A HEADER CANNOT DISTINGUISH THE CALLERS WE MUST SEPARATE. The only Hermes
 *      seams that can stamp a header on a shim-bound request are
 *      `model.default_headers` and `ProviderProfile.default_headers` — and BOTH are
 *      applied to the main agent client (whl agent/agent_init.py:782-790) AND to
 *      every auxiliary client (whl agent/auxiliary_client.py:1487-1488, 3718-3719).
 *      A header identity minted for the user's own turn would therefore be
 *      INHERITED by title_generation and by every auxiliary added later — fail-open
 *      by inheritance, which is the exact defect class this ticket exists to close.
 *
 * The BODY has a seam the header does not: `ProviderProfile.build_api_kwargs_extras`
 * is called ONLY from `ChatCompletionsTransport._build_kwargs_from_profile`
 * (whl agent/transports/chat_completions.py:458,529) and NEVER from the auxiliary
 * client, which issues `client.chat.completions.create(**kwargs)` directly
 * (whl agent/auxiliary_client.py:5282-5307). That makes it a MAIN-AGENT-ONLY
 * producer the desktop already owns, so the user's own turn can declare itself
 * without the declaration ever leaking to an auxiliary.
 *
 * The declaration NEVER egresses: every outbound payload builder in the shim
 * (`nativeChatPayload`, `localOpenAiPayload`, and the cloud `outboundBody`) is a
 * strict allowlist, so this key reaches no provider, local or cloud.
 */

/** Body key carrying the caller-declared operation identity. */
export const COMMAND_EVE_OPERATION_BODY_KEY = 'eve_operation';

/** Response header naming the seam decision (content-free, receipt only). */
export const COMMAND_EVE_OPERATION_DECISION_HEADER = 'x-command-eve-operation';

/** Lanes a REGISTERED operation may take. */
export type CommandEvePaidSeamLane = 'paid' | 'local_only';

/** What the seam decided. `refused` never reaches any provider. */
export type CommandEvePaidSeamDisposition = CommandEvePaidSeamLane | 'refused';

/**
 * Why the seam decided what it decided.
 *
 * Note that `unregistered` is NOT a refusal reason. A named operation that nobody
 * registered is sent to the LOCAL lane, not turned away — see the asymmetry below.
 * `absent` and `not_client_declarable` are the two that refuse.
 */
export type CommandEvePaidSeamReason = 'absent' | 'unregistered' | 'not_client_declarable';

/**
 * WHO is making the claim.
 *
 * `client` — the operation was read out of a request body on the general path.
 * `shim`   — the shim itself minted it from the ingress the caller reached.
 *
 * The distinction exists because not every registered operation may be CLAIMED by
 * a caller. Without it, any component holding the loopback nonce could put
 * `honcho_deriver` in its body and inherit that rung's right to spend — which would
 * re-open this exact defect one level down.
 */
export type CommandEvePaidSeamSource = 'client' | 'shim';

export type CommandEvePaidSeamDecision = {
  /** The declared operation, normalized. Empty string when nothing was declared. */
  operation: string;
  disposition: CommandEvePaidSeamDisposition;
  reason?: CommandEvePaidSeamReason;
};

/**
 * THE REGISTRY. Founder-approved membership — changing it changes what the product
 * is allowed to charge for, so every entry states who declares it and why.
 *
 * PAID (may reach the metered cloud lane):
 *   user_chat_turn  — the user's OWN Standard/MAX turn. The one thing the customer
 *                     asked for and expects to pay for. Declared by the main agent
 *                     client only (build_api_kwargs_extras, see above).
 *   honcho_deriver  — EVE's memory derivation. A metered rung BY CONTRACT
 *                     (honchoRuntimeConfigCore forces the cheapest Standard entry
 *                     rung). Declared STRUCTURALLY by its own dedicated ingress
 *                     `POST /honcho/deriver/v1/chat/completions`, minted by the shim
 *                     itself — never client-declarable, so this entry cannot be
 *                     borrowed by a caller on the general path.
 *
 * LOCAL_ONLY (registered, but MUST NEVER debit — forced onto the local lane):
 *   title_generation    — carries commit d5135ec6's doctrine forward: a title we
 *                         cannot make for free is a title nobody gets. If local
 *                         derivation is unavailable the user simply gets no
 *                         auto-title; it must NOT fall back to the paid lane.
 *   context_compression — the C9a bounded compaction call, as the DESKTOP's own
 *                         patched HTTP call names it.
 *   compression         — the same operation as HERMES natively names it
 *                         (whl agent/context_compressor.py:1500). Both names are
 *                         registered ON PURPOSE. The desktop's compression patch
 *                         returns silently when its import fails, and if that ever
 *                         happens Hermes' native call runs instead and declares the
 *                         OTHER name. Registering one name would make the safe
 *                         behaviour depend on a silent ImportError; registering both
 *                         makes the outcome identical either way.
 *
 * EVERYTHING ELSE — any named operation not listed here — resolves to local_only
 * as well. Membership still governs SPENDING, which is the only thing this registry
 * is entitled to govern; it does not govern whether a feature may run at all.
 */
type CommandEveOperationEntry = {
  lane: CommandEvePaidSeamLane;
  /**
   * May a CALLER claim this operation in a request body on the general path?
   *
   * False means the membership is STRUCTURAL — only the shim may assert it, from
   * the ingress the caller reached. `honcho_deriver` is the case that matters: it is
   * a payable rung, so a body-declarable version of it would be a ready-made way for
   * any nonce-holding component to buy itself the right to spend.
   */
  clientDeclarable: boolean;
};

const COMMAND_EVE_OPERATION_REGISTRY: ReadonlyMap<string, CommandEveOperationEntry> = new Map<
  string,
  CommandEveOperationEntry
>([
  ['user_chat_turn', { lane: 'paid', clientDeclarable: true }],
  ['honcho_deriver', { lane: 'paid', clientDeclarable: false }],
  ['title_generation', { lane: 'local_only', clientDeclarable: true }],
  ['context_compression', { lane: 'local_only', clientDeclarable: true }],
  ['compression', { lane: 'local_only', clientDeclarable: true }],
  // --- the remaining Hermes 0.17 auxiliaries, classified EXPLICITLY -------------
  // Behaviourally identical to leaving them unregistered (both resolve local_only),
  // but naming them is the point: the set a shipped Hermes can reach is now a
  // decision on the record, pinned by COMMAND_EVE_HERMES_AUXILIARY_TASKS below.
  ['web_extract', { lane: 'local_only', clientDeclarable: true }],
  ['vision', { lane: 'local_only', clientDeclarable: true }],
  ['mcp', { lane: 'local_only', clientDeclarable: true }],
  ['approval', { lane: 'local_only', clientDeclarable: true }],
  ['tts_audio_tags', { lane: 'local_only', clientDeclarable: true }],
  ['monitor', { lane: 'local_only', clientDeclarable: true }],
  ['call', { lane: 'local_only', clientDeclarable: true }],
  // Hermes has auxiliary call sites that pass NO task at all — FACT(whl
  // agent/plugin_llm.py:949-950, `task=None`) and FACT(whl trajectory_compressor.py:
  // 649-655, no task kwarg). With no name of their own they would arrive ABSENT and
  // be REFUSED, breaking real paths. The declaration patch gives them this generic
  // name instead, which also keeps ABSENT precise: it no longer means "an auxiliary
  // forgot to say", it means "the user's own turn lost its producer".
  ['eve_auxiliary', { lane: 'local_only', clientDeclarable: true }],
]);

/**
 * The auxiliary tasks a SHIPPED Hermes 0.17 can actually reach.
 *
 * Read off the bundled wheel, whose sha256 is pinned by the compatibility test, so a
 * Hermes bump forces this classification to be re-made deliberately:
 *   title_generation  FACT(whl agent/title_generator.py:58)
 *   compression       FACT(whl agent/context_compressor.py:1500)
 *   web_extract       FACT(whl tools/web_tools.py:517, :668; tools/browser_tool.py:2258)
 *   vision            FACT(whl tools/vision_tools.py:968, :1453; tools/browser_tool.py:3298)
 *   mcp               FACT(whl tools/mcp_tool.py:1154)
 *   approval          FACT(whl tools/approval.py:1116)
 *   tts_audio_tags    FACT(whl tools/tts_tool.py:1151)
 *   monitor           FACT(whl cron/scripts/classify_items.py:167)
 *   call              FACT(whl plugins/teams_pipeline/pipeline.py:513)
 *
 * DELIBERATELY ABSENT: `session_search` and `skills_hub`. Both are named in the
 * `call_llm` docstring (whl agent/auxiliary_client.py:5189-5191) but neither appears
 * as a `task=` at any call site in this wheel. They were reported as reachable
 * earlier in this ticket on the strength of that docstring alone — a docstring is not
 * a call site, and the correction is recorded here so it is not re-made.
 *
 * NONE of these is payable. Only the user's own turn and the structurally minted
 * deriver are; this ticket exists because an auxiliary charge nobody asked for
 * reached a customer's bill.
 */
export const COMMAND_EVE_HERMES_AUXILIARY_TASKS: readonly string[] = [
  'title_generation',
  'compression',
  'web_extract',
  'vision',
  'mcp',
  'approval',
  'tts_audio_tags',
  'monitor',
  'call',
];

/** The registered operations, for tests, receipts and diagnostics. */
export function commandEveRegisteredOperations(): readonly string[] {
  return [...COMMAND_EVE_OPERATION_REGISTRY.keys()];
}

/** The subset that may reach the METERED cloud lane. */
export function commandEvePaidOperations(): readonly string[] {
  return [...COMMAND_EVE_OPERATION_REGISTRY.entries()]
    .filter(([, entry]) => entry.lane === 'paid')
    .map(([operation]) => operation);
}

/**
 * Read the caller-declared operation out of a request body.
 *
 * Deliberately total and narrow: only a plain non-empty string counts. A number, an
 * object, an array or a blank string is NOT a declaration and resolves to '' — which
 * the seam treats as ABSENT, i.e. a refusal on the paid path.
 */
export function readCommandEveDeclaredOperation(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '';
  const declared = (body as Record<string, unknown>)[COMMAND_EVE_OPERATION_BODY_KEY];
  if (typeof declared !== 'string') return '';
  return declared.trim().toLowerCase();
}

/**
 * THE SEAM DECISION. Total, pure, and fail-closed in every direction.
 *
 * An ABSENT declaration REFUSES. That is the deliberate reversal of the old
 * behaviour, where a missing header silently defaulted to a valid identity — the
 * default that let an unrequested title reach a paid provider and debit a customer.
 */
export function resolveCommandEvePaidSeam(
  declared: unknown,
  source: CommandEvePaidSeamSource = 'client'
): CommandEvePaidSeamDecision {
  const operation = typeof declared === 'string' ? declared.trim().toLowerCase() : '';
  if (operation.length === 0) {
    // ABSENT STAYS LOUD, and it is the one case that does NOT degrade to local.
    // The most likely producer of an undeclared request in production is the user's
    // OWN paid turn with a broken declaration. Sending that to the local lane would
    // hand a paying Standard/MAX customer free-model answers with no signal at all —
    // a silent quality and trust defect, and far harder to notice than a 403. An
    // unnamed operation must fail where somebody can see it.
    return { operation: '', disposition: 'refused', reason: 'absent' };
  }
  const entry = COMMAND_EVE_OPERATION_REGISTRY.get(operation);
  if (entry === undefined) {
    // NAMED BUT UNREGISTERED ⇒ LOCAL, NOT REFUSED. The asset this seam protects is
    // the customer's money, so the correct fail-closed direction is "cannot SPEND",
    // not "cannot RUN". Turning these away would trade a money defect for a
    // functionality defect: Hermes has at least seven auxiliaries on this path
    // (web_extract, vision, mcp, approval, tts_audio_tags among them), and hard
    // refusal would break shipped features to save money they never needed to
    // spend. Local costs nothing and egresses nothing, so the feature survives and
    // the customer is never billed. An auxiliary a FUTURE Hermes adds inherits this
    // same outcome on the day it ships — degraded, never surprising, never charged.
    return { operation, disposition: 'local_only', reason: 'unregistered' };
  }
  // A structural rung cannot be CLAIMED. Being registered is not the same as being
  // claimable: the deriver is payable because it arrived on the deriver ingress,
  // never because a request body said so.
  if (source === 'client' && !entry.clientDeclarable) {
    return { operation, disposition: 'refused', reason: 'not_client_declarable' };
  }
  return { operation, disposition: entry.lane };
}

/**
 * Hard assertion for the ONE function that performs the metered egress.
 *
 * `handleChatCompletions` already routes local_only away from the cloud, so this is
 * defence in depth: it guarantees that NO future call site can reach the paid
 * provider with an operation the registry does not list as payable, regardless of
 * how it got there.
 */
export function isCommandEvePaidOperation(operation: unknown): boolean {
  // 'shim': by this point the operation has already been resolved by the router —
  // either from a body declaration that passed the client rules, or minted from the
  // ingress. The question here is only "is this rung payable at all".
  return resolveCommandEvePaidSeam(operation, 'shim').disposition === 'paid';
}

/**
 * The client-facing refusal payload. Content-free and deliberately non-retryable in
 * meaning: the caller must not "try again" onto the paid lane.
 */
export function commandEvePaidSeamRefusalBody(decision: CommandEvePaidSeamDecision): {
  error: { code: string; message: string };
} {
  if (decision.reason === 'absent') {
    return {
      error: {
        code: 'eve_operation_absent',
        message: 'This request declared no Command EVE operation, so it may not use the paid lane.',
      },
    };
  }
  if (decision.reason === 'not_client_declarable') {
    return {
      error: {
        code: 'eve_operation_not_client_declarable',
        message: 'This Command EVE operation cannot be claimed by a caller on the general lane.',
      },
    };
  }
  return {
    error: {
      code: 'eve_operation_unregistered',
      message: 'This Command EVE operation is not registered for the paid lane.',
    },
  };
}
