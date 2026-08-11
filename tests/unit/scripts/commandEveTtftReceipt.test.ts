import {
  buildCommandEveTtftReceipt,
  evaluateCommandEveTtftRegression,
  summarizeCommandEveTtftMetric,
  type CommandEveTtftMilestone,
} from '../../../scripts/command-eve/ttft/receipt-core';
import { describe, expect, it } from 'vitest';

const observed = (atEpochMs: number): CommandEveTtftMilestone => ({
  status: 'observed',
  atEpochMs,
  source: 'harness',
  evidence: 'unit fixture',
});

const receipt = (sendToVisibleMs: number, iteration = 1) =>
  buildCommandEveTtftReceipt({
    releaseVersion: '1.822.2',
    hermesVersion: '0.20.0',
    appCommit: 'a289ce2f',
    appCommitSource: 'packaged_cli_assertion',
    promptSha256: 'a'.repeat(64),
    runtimeSelection: 'command-eve-local:default',
    cohort: 'warm_existing_session',
    iteration,
    recordedAt: '2026-08-11T00:00:00.000Z',
    milestones: {
      send_action: observed(1_000),
      request_accepted: observed(1_050),
      model_request_started: observed(1_075),
      model_first_token: observed(1_000 + Math.max(0, sendToVisibleMs - 20)),
      acp_first_text: observed(1_000 + Math.max(0, sendToVisibleMs - 10)),
      renderer_first_visible: observed(1_000 + sendToVisibleMs),
    },
  });

describe('Command EVE TTFT receipt core', () => {
  it('keeps unobservable stages unavailable instead of encoding fake zeroes', () => {
    const result = receipt(400);
    expect(result.milestones.hermes_ready.status).toBe('unavailable');
    expect(result.metrics.coldAppToRendererMs).toBeNull();
    expect(result.metrics.sendToFirstVisibleMs).toBe(400);
    expect(result.chronology.valid).toBe(true);
  });

  it('rejects impossible clock ordering and suppresses invalid durations', () => {
    const result = buildCommandEveTtftReceipt({
      releaseVersion: '1.822.2',
      hermesVersion: '0.20.0',
      appCommit: 'a289ce2f',
      appCommitSource: 'packaged_cli_assertion',
      promptSha256: 'a'.repeat(64),
      runtimeSelection: 'command-eve-local:default',
      cohort: 'warm_start_chat',
      iteration: 1,
      milestones: {
        send_action: observed(2_000),
        request_accepted: observed(1_900),
      },
    });
    expect(result.chronology.valid).toBe(false);
    expect(result.metrics.sendToRequestAcceptedMs).toBeNull();
  });

  it('validates ACP session readiness in cohort-specific order', () => {
    const shared = {
      releaseVersion: '1.822.2',
      hermesVersion: '0.20.0',
      appCommit: 'a289ce2f',
      appCommitSource: 'packaged_cli_assertion' as const,
      promptSha256: 'a'.repeat(64),
      runtimeSelection: 'command-eve-local:default',
      iteration: 1,
    };
    const startChat = buildCommandEveTtftReceipt({
      ...shared,
      cohort: 'warm_start_chat',
      milestones: {
        send_action: observed(1_000),
        acp_session_ready: observed(1_100),
      },
    });
    const existingSession = buildCommandEveTtftReceipt({
      ...shared,
      cohort: 'warm_existing_session',
      milestones: {
        acp_session_ready: observed(900),
        send_action: observed(1_000),
      },
    });

    expect(startChat.chronology.valid).toBe(true);
    expect(startChat.metrics.sendToAcpSessionReadyMs).toBe(100);
    expect(existingSession.chronology.valid).toBe(true);
    expect(existingSession.metrics.sendToAcpSessionReadyMs).toBeNull();
  });

  it('uses deterministic nearest-rank p50 and p95 summaries', () => {
    const summary = summarizeCommandEveTtftMetric(
      [100, 200, 300, 400, 500].map((value, index) => receipt(value, index + 1)),
      'sendToFirstVisibleMs'
    );
    expect(summary).toEqual({ count: 5, p50: 300, p95: 500, min: 100, max: 500 });
  });

  it('fails only when candidate p95 crosses both relative and absolute thresholds', () => {
    const baseline = [500, 500, 500, 500, 500].map((value, index) => receipt(value, index + 1));
    const relativeOnly = [620, 620, 620, 620, 620].map((value, index) => receipt(value, index + 1));
    const material = [800, 800, 800, 800, 800].map((value, index) => receipt(value, index + 1));

    expect(
      evaluateCommandEveTtftRegression({
        baselineReceipts: baseline,
        candidateReceipts: relativeOnly,
        metric: 'sendToFirstVisibleMs',
      }).outcome
    ).toBe('PASS');
    expect(
      evaluateCommandEveTtftRegression({
        baselineReceipts: baseline,
        candidateReceipts: material,
        metric: 'sendToFirstVisibleMs',
      }).outcome
    ).toBe('FAIL');
  });

  it('refuses a gate judgment below the five-sample floor', () => {
    expect(
      evaluateCommandEveTtftRegression({
        baselineReceipts: [receipt(500)],
        candidateReceipts: [receipt(800)],
        metric: 'sendToFirstVisibleMs',
      }).outcome
    ).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('fails a material absolute regression from a zero-millisecond baseline', () => {
    const baseline = [0, 0, 0, 0, 0].map((value, index) => receipt(value, index + 1));
    const candidate = [300, 300, 300, 300, 300].map((value, index) => receipt(value, index + 1));

    const gate = evaluateCommandEveTtftRegression({
      baselineReceipts: baseline,
      candidateReceipts: candidate,
      metric: 'sendToFirstVisibleMs',
      absoluteLimitMs: 250,
    });

    expect(gate.outcome).toBe('FAIL');
    expect(gate.relativeDelta).toBeNull();
  });
});
