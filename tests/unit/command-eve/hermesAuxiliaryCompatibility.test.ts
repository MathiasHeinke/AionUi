/**
 * MAT-1749 — Hermes auxiliary compatibility, and the terminality of a refusal.
 *
 * Two properties that are cheap to lose silently:
 *
 *  1. The classification of Hermes' auxiliary tasks is derived from ONE bundled
 *     wheel. A Hermes bump can add a task, and an unclassified task is exactly how
 *     an unrequested charge got to a customer in the first place. The wheel is
 *     pinned by sha256 so a bump cannot land without this decision being re-made.
 *
 *  2. A refusal must be TERMINAL. Hermes' auxiliary client retries on the next
 *     provider in its auto chain for payment, auth and rate-limit failures — which
 *     can mean OpenRouter, Nous Portal or Anthropic. If our refusal looked like one
 *     of those, refusing a request would push it OFF-DEVICE. That is worse than the
 *     bug this ticket fixes: a money defect would become a privacy defect.
 */
import crypto from 'crypto';
import fs from 'fs';
import http, { type IncomingMessage, type ServerResponse } from 'http';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ensureCommandEveShimAuthToken,
  startCommandEveOllamaOpenAiShim,
  stopCommandEveOllamaOpenAiShimForTest,
} from '@/process/commandEve/ollamaOpenAiShim';
import {
  COMMAND_EVE_DIRECT_AUXILIARY_OPERATION,
  COMMAND_EVE_HERMES_AUXILIARY_TASKS,
  COMMAND_EVE_HERMES_DIRECT_AUXILIARY_CLIENTS,
  COMMAND_EVE_HERMES_TRANSPORT_BYPASS_SEAMS,
  COMMAND_EVE_ITERATION_SUMMARY_OPERATION,
  COMMAND_EVE_WHEEL_NON_TASK_NAMES,
  commandEvePaidOperations,
  commandEveRegisteredOperations,
  resolveCommandEvePaidSeam,
} from '@/process/commandEve/paidOperationRegistryCore';

const WHEEL_PATH = fileURLToPath(
  new URL('../../../resources/bundled-hermes/hermes_agent-0.20.0-py3-none-any.whl', import.meta.url)
);

/**
 * The exact wheel this classification was read from.
 *
 * Bumping Hermes changes this digest and reddens the test BY DESIGN. The correct
 * response is to re-enumerate `task=` call sites in the new wheel, classify anything
 * new, and update this constant — never to relax the assertion.
 */
const PINNED_WHEEL_SHA256 = '0fcd755a455743869b00c3831ec01bd71e9c392c8b3c1fedaa9da45d99d9b67e';

/** Matches a task name in either form Hermes uses: `task="x"` or `"task": "x"`. */
const WHEEL_TASK_NAME = /task\s*=\s*["']([a-z_][a-z0-9_]*)["']|["']task["']\s*:\s*["']([a-z_][a-z0-9_]*)["']/;

/**
 * `task=SOME_CONSTANT` — a task passed by NAME, not by literal. The literal
 * regex above is blind to this form, which is how `memory_query_rewrite`
 * (plugins/memory/query_rewrite.py: TASK_KEY at :16, call_llm at :118) slipped
 * past the pin while the pin claimed completeness. Resolved per file against
 * the module-level constant table below.
 */
const WHEEL_TASK_IDENTIFIER = /(?<![A-Za-z0-9_])task\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,)\n]/;

/** Module-level `CONSTANT = "string"` assignments (Python constant style). */
const MODULE_STRING_CONSTANT = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*["']([a-z_][a-z0-9_]*)["']\s*$/;

/**
 * The STATIC RESOLUTION BOUNDARY, pinned honestly instead of claiming
 * completeness the scanner cannot deliver:
 *
 *   - `task=task` parameter FORWARDING is runtime-dynamic. Verified against the
 *     0.20 bytes: `agent/oneshot.py:139` forwards run_oneshot's `task`
 *     parameter (default 'title_generation'), and `tui_gateway/
 *     methods_session.py:1043` feeds it from an RPC param with the same
 *     default. A gateway client can pass ANY name there — statically not
 *     enumerable. Cost-covered by design: an unregistered name resolves
 *     local_only/unregistered (paidOperationRegistryCore resolve path), so the
 *     residual risk is classification completeness, not money.
 *   - `None` is the task-less escape hatch (agent/plugin_llm.py:949
 *     `task=None`), classified as `eve_auxiliary` by the declaration patch.
 *
 * Any identifier site NOT in this allowlist reddens: a new dynamic channel or
 * a cross-module constant must be looked at by a human, never skipped.
 */
const KNOWN_DYNAMIC_TASK_IDENTIFIERS = new Set(['task', 'None']);

/**
 * Line-based scanning cannot see WHICH function a `task=` kwarg belongs to, so
 * a `task=` on a non-LLM function is indistinguishable from a call_llm site.
 * Each entry here was verified at the bytes to be NO call_llm call:
 *
 *   - tools/delegate_tool.py — `_memory_manager.on_delegation(task=task_goal)`:
 *     a delegation MEMORY record; task_goal is the delegated goal TEXT, not an
 *     auxiliary task name (verified 0.20, :2672).
 *
 * A new site reddens and must be reviewed, then either classified or added
 * here with its verification.
 */
const KNOWN_NON_CALL_LLM_TASK_KWARG_SITES = ['tools/delegate_tool.py'];

type WheelTaskScan = { names: Set<string>; unresolvedIdentifierSites: string[] };

/**
 * Read every task name the bundled wheel mentions, straight out of the archive.
 *
 * Deliberately over-inclusive on LITERALS (config defaults and docstrings count
 * too — noise in this direction can only demand that MORE names be accounted
 * for), and constant-resolving on IDENTIFIERS within one module. Deliberate
 * limits, named above: cross-module constants and computed names are NOT
 * resolved — they land in `unresolvedIdentifierSites` and redden unless pinned.
 */
async function deriveTaskNamesFromWheel(): Promise<WheelTaskScan> {
  const yauzl = await import('yauzl');
  const buffer = fs.readFileSync(WHEEL_PATH);
  return new Promise<WheelTaskScan>((resolve, reject) => {
    const found = new Set<string>();
    const unresolvedIdentifierSites: string[] = [];
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (openErr, zip) => {
      if (openErr || !zip) return reject(openErr ?? new Error('wheel could not be opened'));
      zip.on('entry', (entry: { fileName: string }) => {
        if (!entry.fileName.endsWith('.py')) return zip.readEntry();
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) return reject(streamErr ?? new Error('wheel entry unreadable'));
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => {
            const lines = Buffer.concat(chunks).toString('utf8').split('\n');
            // Pass 1: this module's string constants.
            const constants = new Map<string, string>();
            for (const line of lines) {
              const constant = MODULE_STRING_CONSTANT.exec(line);
              if (constant) constants.set(constant[1], constant[2]);
            }
            // Pass 2: literal sites, then identifier sites resolved against pass 1.
            for (const [index, line] of lines.entries()) {
              const literal = WHEEL_TASK_NAME.exec(line);
              if (literal) {
                found.add(literal[1] ?? literal[2]);
                continue;
              }
              const identifier = WHEEL_TASK_IDENTIFIER.exec(line);
              if (!identifier) continue;
              const name = identifier[1];
              if (constants.has(name)) found.add(constants.get(name) as string);
              else if (
                !KNOWN_DYNAMIC_TASK_IDENTIFIERS.has(name) &&
                !KNOWN_NON_CALL_LLM_TASK_KWARG_SITES.some((site) => entry.fileName.startsWith(site))
              ) {
                unresolvedIdentifierSites.push(`${entry.fileName}:${index + 1} task=${name}`);
              }
            }
            zip.readEntry();
          });
          stream.on('error', reject);
        });
      });
      zip.on('end', () => resolve({ names: found, unresolvedIdentifierSites }));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

describe('MAT-1749 — the auxiliary classification is pinned to the wheel it came from', () => {
  it('DERIVES every task name from the wheel — a name in neither list reddens', async () => {
    // THE ENUMERATION IS NO LONGER TRUSTED, IT IS CHECKED.
    //
    // COMMAND_EVE_HERMES_AUXILIARY_TASKS was hand-written, so a task nobody noticed
    // would simply have been absent and every assertion would still have passed —
    // which is exactly how the direct-client mechanism went unseen. This scans the
    // bundled wheel and requires every task name it finds to be in EXACTLY ONE of two
    // lists: classified, or acknowledged as a non-task with a reason. A task a future
    // wheel introduces is in neither, so it fails here instead of shipping unclassified.
    const scan = await deriveTaskNamesFromWheel();
    const derived = scan.names;

    // The scan must actually find things: a scanner returning nothing would satisfy
    // every loop below while proving nothing at all.
    expect(derived.size, 'the wheel scan found no task names — the scanner is broken').toBeGreaterThan(5);
    // Constant resolution must be ALIVE, not decorative: memory_query_rewrite
    // only exists as `task=TASK_KEY` — if it disappears from the derived set,
    // the identifier pass silently died and the pin is back to literals-only.
    expect(
      derived.has('memory_query_rewrite'),
      'the constant-resolving pass no longer sees task=TASK_KEY — the scanner regressed to literal-only'
    ).toBe(true);
    // Every identifier site the scanner could NOT resolve must be a pinned,
    // human-reviewed dynamic channel. A new one reddens here.
    expect(
      scan.unresolvedIdentifierSites,
      `unreviewed dynamic task sites: ${scan.unresolvedIdentifierSites.join('; ')}`
    ).toEqual([]);

    const classified = new Set(COMMAND_EVE_HERMES_AUXILIARY_TASKS);
    const excluded = new Set(COMMAND_EVE_WHEEL_NON_TASK_NAMES);

    for (const name of derived) {
      const inClassified = classified.has(name);
      const inExcluded = excluded.has(name);
      expect(
        inClassified || inExcluded,
        `wheel task "${name}" is neither classified nor acknowledged — classify it, or exclude it with a reason`
      ).toBe(true);
      expect(inClassified && inExcluded, `wheel task "${name}" is in both lists`).toBe(false);
    }

    // ...and nothing is claimed that the wheel no longer contains.
    for (const task of COMMAND_EVE_HERMES_AUXILIARY_TASKS) {
      expect(derived.has(task), `"${task}" is classified but no longer exists in the wheel`).toBe(true);
    }
  });

  it('still ships the exact Hermes wheel the classification was derived from', () => {
    expect(fs.existsSync(WHEEL_PATH), 'the pinned Hermes wheel is missing or was renamed').toBe(true);
    const digest = crypto.createHash('sha256').update(fs.readFileSync(WHEEL_PATH)).digest('hex');
    expect(
      digest,
      'the bundled Hermes wheel changed — re-enumerate its call_llm task= call sites and classify anything new before updating this pin'
    ).toBe(PINNED_WHEEL_SHA256);
  });

  it('classifies every enumerated auxiliary, and makes none of them payable', () => {
    const registered = commandEveRegisteredOperations();
    const paid = commandEvePaidOperations();

    // 17 in the 0.20 wheel: the nine 0.17 tasks, the two MoA halves, the four
    // former direct clients #35566 routed through call_llm, the genuinely new
    // kanban_estimator, and memory_query_rewrite (passed by CONSTANT — found
    // only once the scanner resolved identifiers).
    expect(COMMAND_EVE_HERMES_AUXILIARY_TASKS).toHaveLength(17);
    for (const task of COMMAND_EVE_HERMES_AUXILIARY_TASKS) {
      expect(registered, `${task} is reachable in the bundled wheel but is not classified`).toContain(task);
      expect(paid, `${task} must never be payable — no hidden auxiliary charges`).not.toContain(task);
    }

    // The payable set is the whole product rule in one line.
    expect(paid).toEqual(['user_chat_turn', 'honcho_deriver']);
  });

  it('keeps the task-less auxiliary escape hatch classified too', () => {
    // Hermes calls call_llm with no task at all in places (plugin_llm, the trajectory
    // compressor). They declare `eve_auxiliary` instead, which must stay non-payable.
    expect(commandEveRegisteredOperations()).toContain('eve_auxiliary');
    expect(commandEvePaidOperations()).not.toContain('eve_auxiliary');
  });

  it('pins the DIRECT-client population too, not just the call_llm one', () => {
    // THE PIN USED TO MEASURE THE WRONG POPULATION. It enumerated `task=` kwargs and
    // claimed a Hermes bump would force re-classification — but direct clients are
    // not in that population, so it could never have seen them, and four shipped
    // features hard-failed on a cloud tier. Both populations are pinned now, and the
    // wheel sha above is what forces either to be re-derived on a bump.
    //
    // 0.20 EMPTIED THIS POPULATION: upstream #35566 routed all four former
    // direct clients through call_llm(task=…), so they moved into the
    // AUXILIARY_TASKS population (with 0.20 FACTs in the registry). Verified by
    // a full wheel scan for `.chat.completions.create(` call sites — the only
    // remaining direct callers are the auxiliary client substrate, the
    // task-less trajectory compressor (eve_auxiliary) and the pinned
    // transport-bypass. The empty pin stays load-bearing: a future wheel that
    // reintroduces a direct client must land here or redden.
    expect(COMMAND_EVE_HERMES_DIRECT_AUXILIARY_CLIENTS).toEqual([]);

    const decision = resolveCommandEvePaidSeam(COMMAND_EVE_DIRECT_AUXILIARY_OPERATION);
    expect(decision.disposition).toBe('local_only');
    expect(commandEveRegisteredOperations()).toContain(COMMAND_EVE_DIRECT_AUXILIARY_OPERATION);
    expect(commandEvePaidOperations()).not.toContain(COMMAND_EVE_DIRECT_AUXILIARY_OPERATION);

    // Disjoint populations — a name in both would mean one list describes the wrong
    // mechanism.
    for (const client of COMMAND_EVE_HERMES_DIRECT_AUXILIARY_CLIENTS) {
      expect(COMMAND_EVE_HERMES_AUXILIARY_TASKS, `${client} appears in both populations`).not.toContain(client);
    }
  });

  it('pins the TRANSPORT-BYPASS seam too — the pin now describes all five mechanisms', () => {
    // MECHANISM 5. Hermes documents this bypass in its own comment
    // (FACT whl agent/chat_completion_helpers.py:1328-1331), written for schema
    // sanitisation — so the bypass is DELIBERATE upstream and a version bump will not
    // repair it. That is exactly why it must be pinned rather than assumed away.
    expect(COMMAND_EVE_HERMES_TRANSPORT_BYPASS_SEAMS).toEqual([
      'iteration_limit_summary',
      'iteration_limit_summary_retry',
    ]);

    const decision = resolveCommandEvePaidSeam(COMMAND_EVE_ITERATION_SUMMARY_OPERATION);
    expect(decision.disposition).toBe('local_only');
    expect(commandEveRegisteredOperations()).toContain(COMMAND_EVE_ITERATION_SUMMARY_OPERATION);
    expect(commandEvePaidOperations(), 'the iteration summary must never be payable').not.toContain(
      COMMAND_EVE_ITERATION_SUMMARY_OPERATION
    );

    // All three populations stay disjoint — a name in two lists means one is
    // describing the other's mechanism, which is how mechanism 3 went unseen.
    const populations = [
      COMMAND_EVE_HERMES_AUXILIARY_TASKS,
      COMMAND_EVE_HERMES_DIRECT_AUXILIARY_CLIENTS,
      COMMAND_EVE_HERMES_TRANSPORT_BYPASS_SEAMS,
    ];
    const all: string[] = [];
    for (const population of populations) all.push(...population);
    expect(new Set(all).size, 'the mechanism populations overlap').toBe(all.length);
  });

  it('installs the transport-bypass producer, scoped so the MAIN lane cannot be touched', () => {
    const bootstrapSource = fs.readFileSync(
      fileURLToPath(
        new URL('../../../packages/desktop/src/process/commandEve/runtimeBootstrapCore.ts', import.meta.url)
      ),
      'utf8'
    );

    expect(bootstrapSource).toContain('def _install_command_eve_iteration_summary_declaration_patch() -> None:');
    expect(bootstrapSource).toContain("'_install_command_eve_iteration_summary_declaration_patch()',");
    expect(bootstrapSource).toContain(
      'AIAgent._ensure_primary_openai_client = command_eve_ensure_primary_openai_client'
    );
    expect(bootstrapSource).toContain('_merged["eve_operation"] = "iteration_limit_summary"');

    // SCOPING IS THE SAFETY PROPERTY. _ensure_primary_openai_client is on the MAIN
    // lane's critical path, so the match must be exact-equality against the two known
    // reasons, with every other reason returning the untouched client. A prefix match
    // would be a standing invitation to catch a future main-lane reason.
    expect(bootstrapSource).toContain('if reason not in _COMMAND_EVE_SUMMARY_REASONS:');
    expect(bootstrapSource, 'the summary seam must not be matched by prefix').not.toContain(
      'reason.startswith("iteration_limit_summary")'
    );
  });

  it('stamps the ONE choke point every direct client draws its body from', () => {
    // All four import get_auxiliary_extra_body INSIDE the calling function (late
    // binding), so patching this single module attribute reaches all of them — and
    // reaches a direct client a future Hermes adds that follows the same idiom.
    const bootstrapSource = fs.readFileSync(
      fileURLToPath(
        new URL('../../../packages/desktop/src/process/commandEve/runtimeBootstrapCore.ts', import.meta.url)
      ),
      'utf8'
    );
    expect(bootstrapSource).toContain(
      'auxiliary_client.get_auxiliary_extra_body = command_eve_get_auxiliary_extra_body'
    );

    // THE ASSIGNMENT MUST BE UNCONDITIONAL. An earlier draft used setdefault, which
    // preserves a value that is already there — so a preexisting `user_chat_turn`
    // would have survived this choke point and turned an auxiliary into a PAID call
    // with a hidden debit. That is the original defect rebuilt inside its own fix.
    // A choke point a caller can pre-empt is not a choke point.
    expect(bootstrapSource).toContain('_merged["eve_operation"] = "eve_auxiliary"');
    expect(bootstrapSource, 'the direct-client declaration must overwrite, never setdefault').not.toContain(
      '_merged.setdefault("eve_operation"'
    );
    // The call_llm wrapper has always assigned; pin that it stays that way too, so
    // neither choke point can drift to a fail-open form.
    expect(bootstrapSource).toContain('merged["eve_operation"] = operation');
    expect(bootstrapSource).not.toContain('merged.setdefault("eve_operation"');
  });
});

/**
 * Hermes' provider-fallback triggers, transcribed from the pinned wheel.
 *
 * HONEST ABOUT WHAT THIS IS: a transcription, not the executed Python. vitest cannot
 * run the wheel's interpreter, so these predicates mirror the source and the wheel is
 * sha-pinned above so the mirror cannot drift without a test failing first.
 *
 * This is the COMPLETE set of predicates in the pinned wheel's except-chain. An
 * earlier version of this file transcribed only three of them and omitted every
 * quota keyword — a check named for a property it only partly measured, which is the
 * defect class this ticket keeps finding.
 *
 *   _is_payment_error              FACT(whl agent/auxiliary_client.py:2353-2390)
 *   _is_rate_limit_error           FACT(whl agent/auxiliary_client.py:2405-2439)
 *   _is_auth_error                 FACT(whl agent/auxiliary_client.py:2499-2514)
 *   _is_connection_error           FACT(whl agent/auxiliary_client.py:2442-2477)
 *   _is_transient_transport_error  FACT(whl agent/auxiliary_client.py:2480-2496)
 *   _is_model_not_found_error      FACT(whl agent/auxiliary_client.py:2560-2596)
 *   _is_unsupported_parameter_error FACT(whl agent/auxiliary_client.py:2517-2548)
 */
const HERMES_BILLING_KEYWORDS = [
  'credits',
  'insufficient funds',
  'can only afford',
  'billing',
  'payment required',
  'out of funds',
  'run out of funds',
  'balance_depleted',
  'no usable credits',
  'model_not_supported_on_free_tier',
  'not available on the free tier',
  'quota exceeded',
  'quota_exceeded',
  'too many tokens per day',
  'daily limit',
  'tokens per day',
  'daily quota',
  'resource exhausted',
  'weekly usage limit',
  'weekly limit',
];

const HERMES_RATE_LIMIT_KEYWORDS = [
  'rate limit',
  'rate_limit',
  'too many requests',
  'try again',
  'retry after',
  'resets in',
];

const HERMES_CONNECTION_KEYWORDS = [
  'connection refused',
  'name or service not known',
  'no route to host',
  'network is unreachable',
  'timed out',
  'connection reset',
  'incomplete chunked read',
  'peer closed connection',
  'response ended prematurely',
  'unexpected eof',
  'remoteprotocolerror',
  'localprotocolerror',
];

const HERMES_MODEL_NOT_FOUND_KEYWORDS = [
  'model does not exist',
  'does not exist in our configuration',
  'openrouter catalog',
  'is not a valid model',
  'no such model',
  'model not found',
  'the model `',
  'model_not_found',
  'unknown model',
];

const HERMES_UNSUPPORTED_PARAM_MARKERS = [
  'unsupported parameter',
  'unsupported_parameter',
  'not supported',
  'does not support',
  'unknown parameter',
  'unrecognized request argument',
  'unrecognized parameter',
  'invalid parameter',
];

/**
 * Every trigger, evaluated the way the wheel evaluates it. `excTypeName` matters:
 * several predicates key off the exception CLASS, not the payload.
 */
function hermesFallbackTriggers(status: number, message: string, excTypeName: string): string[] {
  const lower = message.toLowerCase();
  const fired: string[] = [];

  if ([402, 404, 429].includes(status) && HERMES_BILLING_KEYWORDS.some((kw) => lower.includes(kw))) {
    fired.push('_is_payment_error');
  }
  if (status === 402) fired.push('_is_payment_error(402)');
  if (
    excTypeName === 'RateLimitError' ||
    (status === 429 &&
      (HERMES_RATE_LIMIT_KEYWORDS.some((kw) => lower.includes(kw)) ||
        !HERMES_BILLING_KEYWORDS.some((kw) => lower.includes(kw))))
  ) {
    fired.push('_is_rate_limit_error');
  }
  if (
    status === 401 ||
    lower.includes('error code: 401') ||
    excTypeName.toLowerCase().includes('authenticationerror') ||
    (status === 403 && lower.includes('bad-credentials')) ||
    (lower.includes('unauthenticated') && lower.includes('bad-credentials'))
  ) {
    fired.push('_is_auth_error');
  }
  if (
    ['Connection', 'Timeout', 'DNS', 'SSL'].some((kw) => excTypeName.includes(kw)) ||
    HERMES_CONNECTION_KEYWORDS.some((kw) => lower.includes(kw))
  ) {
    fired.push('_is_connection_error');
  }
  if (status === 408 || (status >= 500 && status < 600)) {
    fired.push('_is_transient_transport_error');
  }
  if (
    ![
      'credits',
      'insufficient funds',
      'billing',
      'out of funds',
      'balance_depleted',
      'no usable credits',
      'free tier',
      'free-tier',
      'not available on the free tier',
    ].some((kw) => lower.includes(kw)) &&
    [404, 400].includes(status) &&
    HERMES_MODEL_NOT_FOUND_KEYWORDS.some((kw) => lower.includes(kw))
  ) {
    fired.push('_is_model_not_found_error');
  }
  for (const param of ['temperature', 'max_tokens']) {
    if (lower.includes(param) && HERMES_UNSUPPORTED_PARAM_MARKERS.some((m) => lower.includes(m))) {
      fired.push(`_is_unsupported_parameter_error(${param})`);
    }
  }
  return fired;
}

/**
 * The EXACT refusal messages, pinned. Changing one is a deliberate act that has to
 * be re-checked against every trigger above — a stray "billing" or "try again" in a
 * refusal would silently hand the turn to an external provider.
 */
const COMMAND_EVE_REFUSAL_MESSAGES = {
  absent: 'This request declared no Command EVE operation, so it may not use the paid lane.',
  notClientDeclarable: 'This Command EVE operation cannot be claimed by a caller on the general lane.',
  unregistered: 'This Command EVE operation is not registered for the paid lane.',
} as const;

const SHIM_JSON_HEADERS = {
  'content-type': 'application/json',
  authorization: `Bearer ${ensureCommandEveShimAuthToken()}`,
};

let meteredServer: http.Server | undefined;
let meteredHits = 0;

afterEach(async () => {
  await stopCommandEveOllamaOpenAiShimForTest();
  await new Promise<void>((resolve) => (meteredServer ? meteredServer.close(() => resolve()) : resolve()));
  meteredServer = undefined;
  meteredHits = 0;
});

async function startShimWithMeteredLane(): Promise<string> {
  meteredHits = 0;
  meteredServer = http.createServer((_request: IncomingMessage, response: ServerResponse) => {
    meteredHits += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: 'paid' }, finish_reason: 'stop' }] }));
  });
  await new Promise<void>((resolve, reject) => {
    meteredServer?.once('error', reject);
    meteredServer?.listen(0, '127.0.0.1', resolve);
  });
  const address = meteredServer.address();
  if (!address || typeof address === 'string') throw new Error('metered host exposed no port');
  const functionUrl = `http://127.0.0.1:${address.port}`;

  return startCommandEveOllamaOpenAiShim({
    port: 0,
    ollamaBaseUrl: 'http://127.0.0.1:1', // deliberately dead: refusals must not need it
    eveRouting: () => ({ active: true, functionUrl, license: 'ceve-test-license', tier: 'standard' }),
  });
}

describe('MAT-1749 — a refusal is TERMINAL and cannot push the turn off-device', () => {
  it.each([
    ['an absent declaration', {}],
    ['a caller claiming the deriver rung', { eve_operation: 'honcho_deriver' }],
  ])('%s is refused in a way Hermes will not retry elsewhere', async (_label, extra) => {
    const shimUrl = await startShimWithMeteredLane();

    const response = await fetch(`${shimUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        model: 'custom:command-eve-gemma-64k:latest',
        messages: [{ role: 'user', content: 'Fasse meine offenen Rechnungen zusammen.' }],
        ...(extra as Record<string, unknown>),
      }),
    });
    const payload = (await response.json()) as { error?: { message?: string; code?: string } };
    const message = payload.error?.message ?? '';

    expect(response.status).toBe(403);
    expect(meteredHits).toBe(0);

    // The message is one of the pinned safe strings, not merely "some 403".
    expect(Object.values(COMMAND_EVE_REFUSAL_MESSAGES)).toContain(message);

    // THE CLAIM: this exact (status, message, exception-class) triple matches NONE of
    // the wheel's triggers, so the auxiliary client raises instead of re-running the
    // turn on OpenRouter, Nous Portal or Anthropic. A refusal that leaked off-device
    // would be worse than the overcharge this ticket exists to fix.
    //
    // INFERENCE: the OpenAI Python SDK raises PermissionDeniedError for 403. Both the
    // specific class and a generic status error are checked so the conclusion does not
    // rest on that mapping alone.
    for (const excTypeName of ['PermissionDeniedError', 'APIStatusError']) {
      const fired = hermesFallbackTriggers(response.status, message, excTypeName);
      expect(fired, `refusal "${message}" as ${excTypeName} would trigger: ${fired.join(', ')}`).toEqual([]);
    }
  });

  it('every pinned refusal message is inert against every trigger, at its own status', () => {
    // Checks the messages directly as well as through the wire, so a message edited
    // in the registry core is caught even if no route currently emits it.
    for (const [label, message] of Object.entries(COMMAND_EVE_REFUSAL_MESSAGES)) {
      const fired = hermesFallbackTriggers(403, message, 'PermissionDeniedError');
      expect(fired, `${label} refusal would trigger: ${fired.join(', ')}`).toEqual([]);
    }
  });

  it('the trigger transcription is live — it fires on inputs that SHOULD reroute', () => {
    // A checker that never fires proves nothing. These are the shapes Hermes really
    // does reroute on, so if this test stops going red the transcription has rotted.
    expect(hermesFallbackTriggers(402, 'payment required', 'APIStatusError')).not.toEqual([]);
    expect(hermesFallbackTriggers(429, 'rate limit exceeded', 'APIStatusError')).toContain('_is_rate_limit_error');
    expect(hermesFallbackTriggers(401, 'unauthorized', 'AuthenticationError')).toContain('_is_auth_error');
    expect(hermesFallbackTriggers(503, 'upstream boom', 'APIStatusError')).toContain('_is_transient_transport_error');
    expect(hermesFallbackTriggers(404, 'quota exceeded', 'APIStatusError')).toContain('_is_payment_error');
    expect(hermesFallbackTriggers(0, 'connection refused', 'APIConnectionError')).toContain('_is_connection_error');
  });
});
