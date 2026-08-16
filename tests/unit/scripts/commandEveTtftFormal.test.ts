import type { AcpPerformanceMark } from '../../../packages/desktop/src/renderer/utils/performance/acpPerformanceMarks';
import {
  buildCommandEveTtftFormalReceipt,
  isCommandEveTtftVisibleElement,
  selectCommandEveTtftAttemptBinding,
  selectCommandEveTtftUpstreamEvidence,
  validateCommandEveProviderCallReceipt,
  type CommandEveProviderCallReceipt,
  type CommandEveProviderCallResponseUsage,
} from '../../../scripts/command-eve/ttft/formal-core';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const mark = (
  stage: AcpPerformanceMark['stage'],
  atEpochMs: number,
  overrides: Partial<AcpPerformanceMark> = {}
): AcpPerformanceMark => ({
  version: 'command-eve-acp-performance-mark/v1',
  stage,
  conversationId: 'conv-b',
  atEpochMs,
  atMonotonicMs: atEpochMs,
  ...overrides,
});

const exactTurnMarks = (): AcpPerformanceMark[] => [
  mark('submit_started', 1_000, { attemptId: 7, seatGeneration: 3 }),
  mark('runtime_activity_visible', 1_080, { attemptId: 7, seatGeneration: 3 }),
  mark('warmup_joined', 1_090, { attemptId: 7, seatGeneration: 3 }),
  mark('warmup_ready', 1_150, { attemptId: 7, seatGeneration: 3, outcome: 'ready' }),
  mark('turn_admitted', 1_200, {
    attemptId: 7,
    seatGeneration: 3,
    turnId: 'turn-b',
    messageId: 'request-b',
  }),
  mark('model_request_started', 1_300, { turnId: 'turn-b' }),
  mark('first_output_state', 1_500, { turnId: 'turn-b', messageId: 'message-b', outputKind: 'thought' }),
  mark('response_finished', 1_900, { turnId: 'turn-b' }),
];

const usage = (overrides: Partial<CommandEveProviderCallResponseUsage> = {}): CommandEveProviderCallResponseUsage => ({
  cache_read_tokens: 20,
  cache_write_tokens: 0,
  input_tokens: 80,
  output_tokens: 10,
  prompt_eval_count: null,
  prompt_reuse_status: 'observed',
  prompt_reused_tokens: 20,
  prompt_tokens: 100,
  reasoning_tokens: 0,
  ...overrides,
});

const providerReceipt = (turnId = 'turn-b', callIndex = 1, responseUsage = usage()): CommandEveProviderCallReceipt => ({
  attempt_count: 1,
  call_index: callIndex,
  content_included: false,
  final_request_fingerprint_sha256: 'a'.repeat(64),
  hash_algorithm: 'sha256',
  reason_code: null,
  request_id: `${turnId}:api:${callIndex}`,
  response_usage: responseUsage,
  response_usage_fingerprint_sha256: createHash('sha256')
    .update(
      JSON.stringify(
        Object.fromEntries(Object.entries(responseUsage).toSorted(([left], [right]) => left.localeCompare(right)))
      )
    )
    .digest('hex'),
  schema_version: 'command-eve-provider-call/v1',
  status: 'observed',
  turn_id: turnId,
});

const providerHistoryLine = (receipt: CommandEveProviderCallReceipt): string =>
  JSON.stringify({
    version: 'command-eve-upstream-outcome/v3',
    boundary: 'desktop_upstream_transport',
    provider_call: receipt,
    started_at: new Date(1_310).toISOString(),
    headers_received_at: new Date(1_400).toISOString(),
    first_body_chunk_at: new Date(1_450).toISOString(),
    observed_at: new Date(1_800).toISOString(),
    outcome: 'completed',
    response_started: true,
  });

const exactEvidence = {
  notBeforeEpochMs: 1_000,
  attemptBinding: {
    conversationId: 'conv-b',
    attemptId: 7,
    seatGeneration: 3,
    turnId: 'turn-b',
    requestMessageId: 'request-b',
  },
  firstVisible: { messageId: 'message-b', atEpochMs: 1_550 },
  runtimeReadiness: {
    conversationId: 'conv-b',
    turnId: 'turn-b',
    taskReadyAtEpochMs: 1_210,
    hermesSessionReadyAtEpochMs: 1_220,
  },
  upstream: {
    turnId: 'turn-b',
    callIndex: 1,
    requestId: 'turn-b:api:1',
    finalRequestFingerprintSha256: 'a'.repeat(64),
    responseUsageFingerprintSha256: 'b'.repeat(64),
    attemptCount: 1,
    startedAtEpochMs: 1_310,
    headersReceivedAtEpochMs: 1_400,
    firstBodyChunkAtEpochMs: 1_450,
    observedAtEpochMs: 1_800,
  },
};

describe('Command EVE TTFT formal correlation', () => {
  it('passes the eight content-free groups for one exact attempt and turn', () => {
    const receipt = buildCommandEveTtftFormalReceipt({
      ...exactEvidence,
      marks: exactTurnMarks(),
    });

    expect(receipt.outcome).toBe('PASS');
    expect(receipt.missingGroups).toEqual([]);
    expect(receipt.timings.submitToRuntimeActivityVisibleMs).toBe(80);
    expect(receipt.correlation).toMatchObject({ attemptId: 7, seatGeneration: 3, terminalStage: 'response_finished' });
    expect(receipt.correlation.turnIdSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(receipt)).not.toContain('turn-b');
    expect(JSON.stringify(receipt)).not.toContain('message-b');
  });

  it('does not let a delayed old finish or assistant node fulfill the admitted turn', () => {
    const marks = exactTurnMarks().filter((candidate) => candidate.stage !== 'response_finished');
    marks.push(
      mark('first_output_state', 1_510, {
        conversationId: 'conv-a',
        turnId: 'turn-a',
        messageId: 'message-a',
        outputKind: 'text',
      }),
      mark('response_finished', 1_520, { conversationId: 'conv-a', turnId: 'turn-a' })
    );

    const receipt = buildCommandEveTtftFormalReceipt({
      ...exactEvidence,
      marks,
      firstVisible: { messageId: 'message-a', atEpochMs: 1_560 },
    });

    expect(receipt.outcome).toBe('INSUFFICIENT_EVIDENCE');
    expect(receipt.missingGroups).toEqual(expect.arrayContaining(['first_visible_output', 'terminal']));
    expect(receipt.correlation.terminalStage).toBeNull();
    expect(receipt.staleEvidenceRejected).toBeGreaterThanOrEqual(3);
  });

  it('fails closed when a marker grows a content-bearing field', () => {
    const marks = exactTurnMarks();
    marks[0] = { ...marks[0], prompt: 'must never be retained' } as AcpPerformanceMark;

    const receipt = buildCommandEveTtftFormalReceipt({ ...exactEvidence, marks });

    expect(receipt.outcome).toBe('INSUFFICIENT_EVIDENCE');
    expect(receipt.contentFree).toBe(false);
    expect(receipt.violations).toContain('non-content-free marker field: submit_started.prompt');
  });

  it('rejects every reversed chronology instead of returning null timings with PASS', () => {
    const marks = exactTurnMarks().map((candidate) => {
      if (candidate.stage === 'warmup_ready') return { ...candidate, atEpochMs: 1_085 };
      if (candidate.stage === 'turn_admitted') return { ...candidate, atEpochMs: 1_300 };
      if (candidate.stage === 'first_output_state') return { ...candidate, atEpochMs: 1_200 };
      if (candidate.stage === 'response_finished') return { ...candidate, atEpochMs: 1_100 };
      return candidate;
    });
    const receipt = buildCommandEveTtftFormalReceipt({
      ...exactEvidence,
      marks,
      firstVisible: { messageId: 'message-b', atEpochMs: 1_250 },
      runtimeReadiness: { ...exactEvidence.runtimeReadiness, taskReadyAtEpochMs: 1_400 },
      upstream: {
        ...exactEvidence.upstream,
        startedAtEpochMs: 1_500,
        headersReceivedAtEpochMs: 1_450,
        firstBodyChunkAtEpochMs: 1_440,
      },
    });

    expect(receipt.outcome).toBe('INSUFFICIENT_EVIDENCE');
    expect(receipt.violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining('warmup disposition -> warmup settled'),
        expect.stringContaining('turn_admitted -> first_output_state'),
        expect.stringContaining('first_output_state -> terminal'),
        expect.stringContaining('upstream started -> headers received'),
        expect.stringContaining('headers received -> first body chunk'),
      ])
    );
  });

  it('binds admission to the measured conversation even when a foreign turn is observed first', () => {
    const marks = [
      mark('submit_started', 1_001, { conversationId: 'conv-a', attemptId: 1, seatGeneration: 3 }),
      mark('turn_admitted', 1_002, {
        conversationId: 'conv-a',
        attemptId: 1,
        seatGeneration: 3,
        turnId: 'turn-a',
        messageId: 'request-a',
      }),
      ...exactTurnMarks(),
    ];

    const selection = selectCommandEveTtftAttemptBinding({
      marks,
      expectedConversationId: 'conv-b',
      notBeforeEpochMs: 1_000,
    });

    expect(selection.violations).toEqual([]);
    expect(selection.binding).toMatchObject({ conversationId: 'conv-b', attemptId: 7, turnId: 'turn-b' });
  });

  it('rejects a foreign single upstream receipt instead of assigning the admitted turn retroactively', () => {
    const selection = selectCommandEveTtftUpstreamEvidence({
      lines: [providerHistoryLine(providerReceipt('turn-a'))],
      expectedTurnId: 'turn-b',
      notBeforeEpochMs: 1_000,
      notAfterEpochMs: 1_900,
    });

    expect(selection.evidence).toBeNull();
    expect(selection.violations).toContain('expected exactly one provider receipt for admitted turn, observed 0');
  });

  it('rejects ambiguous same-turn calls and impossible provider-receipt chronology', () => {
    const receipt = providerReceipt();
    const ambiguous = selectCommandEveTtftUpstreamEvidence({
      lines: [
        providerHistoryLine(receipt),
        providerHistoryLine({ ...receipt, call_index: 2, request_id: 'turn-b:api:2' }),
      ],
      expectedTurnId: 'turn-b',
      notBeforeEpochMs: 1_000,
      notAfterEpochMs: 1_900,
    });
    const reversed = selectCommandEveTtftUpstreamEvidence({
      lines: [
        JSON.stringify({
          ...JSON.parse(providerHistoryLine(receipt)),
          observed_at: new Date(1_440).toISOString(),
        }),
      ],
      expectedTurnId: 'turn-b',
      notBeforeEpochMs: 1_000,
      notAfterEpochMs: 1_900,
    });

    expect(ambiguous.evidence).toBeNull();
    expect(ambiguous.violations).toContain('expected exactly one provider receipt for admitted turn, observed 2');
    expect(reversed.evidence).toBeNull();
    expect(reversed.violations).toContain('provider history observed_at precedes first_body_chunk_at');
  });

  it('rejects wrong submit attempt and wrong upstream turn/request identities', () => {
    const wrongAttempt = buildCommandEveTtftFormalReceipt({
      ...exactEvidence,
      marks: exactTurnMarks(),
      attemptBinding: { ...exactEvidence.attemptBinding, attemptId: 8 },
    });
    const wrongUpstream = buildCommandEveTtftFormalReceipt({
      ...exactEvidence,
      marks: exactTurnMarks(),
      upstream: { ...exactEvidence.upstream, turnId: 'turn-a', requestId: 'wrong-request' },
    });

    expect(wrongAttempt.missingGroups).toContain('submit_started');
    expect(wrongUpstream.missingGroups).toContain('upstream_transport');
    expect(wrongAttempt.outcome).toBe('INSUFFICIENT_EVIDENCE');
    expect(wrongUpstream.outcome).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('rejects over-attribution and content-bearing or malformed provider receipts', () => {
    const overAttributed = providerReceipt(
      'turn-b',
      1,
      usage({
        cache_read_tokens: 0,
        input_tokens: 508,
        prompt_reuse_status: 'unavailable',
        prompt_reused_tokens: null,
        prompt_tokens: 1,
      })
    );
    const contentBearing = { ...providerReceipt(), prompt: 'must never be retained' };
    const malformedHash = { ...providerReceipt(), final_request_fingerprint_sha256: 'not-a-hash' };
    const underAttributed = providerReceipt(
      'turn-b',
      1,
      usage({ cache_read_tokens: 0, input_tokens: 1, prompt_reused_tokens: 0, prompt_tokens: 508 })
    );
    const missingUsage = providerReceipt(
      'turn-b',
      1,
      usage({ cache_read_tokens: null, cache_write_tokens: null, input_tokens: null, prompt_tokens: null })
    );
    const multipleAttempts = { ...providerReceipt(), attempt_count: 2 };

    expect(validateCommandEveProviderCallReceipt(overAttributed)).toMatchObject({ ok: false });
    expect(validateCommandEveProviderCallReceipt(underAttributed)).toMatchObject({ ok: false });
    expect(validateCommandEveProviderCallReceipt(missingUsage)).toMatchObject({ ok: false });
    expect(validateCommandEveProviderCallReceipt(multipleAttempts)).toMatchObject({ ok: false });
    expect(validateCommandEveProviderCallReceipt(contentBearing)).toMatchObject({ ok: false });
    expect(validateCommandEveProviderCallReceipt(malformedHash)).toMatchObject({ ok: false });
  });

  it('rechecks second-frame visibility instead of accepting a now-hidden message', () => {
    const visible = {
      connected: true,
      documentVisible: true,
      messageId: 'message-b',
      expectedMessageId: 'message-b',
      hasText: true,
      display: 'block',
      visibility: 'visible',
      opacity: 1,
      width: 100,
      height: 20,
    };

    expect(isCommandEveTtftVisibleElement(visible)).toBe(true);
    expect(isCommandEveTtftVisibleElement({ ...visible, display: 'none' })).toBe(false);
  });
});
