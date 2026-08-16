import type { AcpPerformanceMark } from '../../../packages/desktop/src/renderer/utils/performance/acpPerformanceMarks';
import { buildCommandEveTtftFormalReceipt } from '../../../scripts/command-eve/ttft/formal-core';
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

const exactEvidence = {
  notBeforeEpochMs: 1_000,
  firstVisible: { messageId: 'message-b', atEpochMs: 1_550 },
  runtimeReadiness: {
    conversationId: 'conv-b',
    turnId: 'turn-b',
    taskReadyAtEpochMs: 1_210,
    hermesSessionReadyAtEpochMs: 1_220,
  },
  upstream: {
    conversationId: 'conv-b',
    turnId: 'turn-b',
    requestId: 'upstream-b',
    startedAtEpochMs: 1_310,
    headersReceivedAtEpochMs: 1_400,
    firstBodyChunkAtEpochMs: 1_450,
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
});
