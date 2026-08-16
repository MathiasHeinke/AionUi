import {
  COMMAND_EVE_TTFT_GOLDEN_CATEGORIES,
  evaluateCommandEveTtftGoldenSet,
  type CommandEveTtftGoldenResult,
} from '../../../scripts/command-eve/ttft/golden-set-core';
import type {
  CommandEveProviderCallReceipt,
  CommandEveProviderCallResponseUsage,
} from '../../../scripts/command-eve/ttft/formal-core';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const sha = (digit: string): string => digit.repeat(64);

const providerReceipt = (newlyEvaluatedInputTokens: number, turnId: string): CommandEveProviderCallReceipt => {
  const promptTokens = 10_000;
  const reusedTokens = promptTokens - newlyEvaluatedInputTokens;
  const responseUsage: CommandEveProviderCallResponseUsage = {
    cache_read_tokens: reusedTokens,
    cache_write_tokens: 0,
    input_tokens: newlyEvaluatedInputTokens,
    output_tokens: 10,
    prompt_eval_count: null,
    prompt_reuse_status: 'observed',
    prompt_reused_tokens: reusedTokens,
    prompt_tokens: promptTokens,
    reasoning_tokens: 0,
  };
  return {
    attempt_count: 1,
    call_index: 1,
    content_included: false,
    final_request_fingerprint_sha256: sha('a'),
    hash_algorithm: 'sha256',
    reason_code: null,
    request_id: `${turnId}:api:1`,
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
  };
};

const result = (newlyEvaluatedInputTokens: number | null, turnId: string): CommandEveTtftGoldenResult => ({
  version: 'command-eve-ttft-golden-result/v1',
  artifactCommit: 'a'.repeat(40),
  profileFingerprints: {
    promptPrefixSha256: sha('1'),
    toolSchemasSha256: sha('2'),
    skillsIndexSha256: sha('3'),
    safetyContractSha256: sha('4'),
    memoryContractSha256: sha('5'),
    workspaceContractSha256: sha('6'),
  },
  tokenEvidence: {
    providerCallReceipt: newlyEvaluatedInputTokens === null ? null : providerReceipt(newlyEvaluatedInputTokens, turnId),
  },
  tasks: COMMAND_EVE_TTFT_GOLDEN_CATEGORIES.map((category, index) => ({
    id: `golden-${category}`,
    category,
    passed: true,
    evidenceSha256: (index + 1).toString(16).repeat(64),
  })),
});

describe('Command EVE TTFT Golden Set gate', () => {
  it('passes unchanged capability profiles, quality, and a 30 percent exact-call cold-token reduction', () => {
    const gate = evaluateCommandEveTtftGoldenSet({
      baseline: result(10_000, 'turn-baseline'),
      candidate: result(7_000, 'turn-candidate'),
    });

    expect(gate.outcome).toBe('PASS');
    expect(gate.qualityOutcome).toBe('PASS');
    expect(gate.coldTokenOutcome).toBe('PASS');
    expect(gate.observedColdTokenReduction).toBeCloseTo(0.3);
  });

  it('requires real exact-call token receipts even when provider-free quality fixtures pass', () => {
    const gate = evaluateCommandEveTtftGoldenSet({
      baseline: result(null, 'turn-baseline'),
      candidate: result(null, 'turn-candidate'),
    });

    expect(gate.outcome).toBe('SOURCE_PASS_MEASUREMENT_REQUIRED');
    expect(gate.qualityOutcome).toBe('PASS');
    expect(gate.coldTokenOutcome).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('rejects prompt, tool, or skill profile changes without parity proof', () => {
    const baseline = result(10_000, 'turn-baseline');
    const candidate = result(7_000, 'turn-candidate');
    candidate.profileFingerprints.toolSchemasSha256 = sha('a');

    const gate = evaluateCommandEveTtftGoldenSet({ baseline, candidate });

    expect(gate.outcome).toBe('FAIL');
    expect(gate.parityViolations).toContain('toolSchemasSha256: changed without parity proof');
  });

  it('rejects a lower pass rate in any required capability category', () => {
    const baseline = result(10_000, 'turn-baseline');
    const candidate = result(7_000, 'turn-candidate');
    const skillsTask = candidate.tasks.find((task) => task.category === 'skills');
    if (!skillsTask) throw new Error('fixture missing skills task');
    skillsTask.passed = false;

    const gate = evaluateCommandEveTtftGoldenSet({ baseline, candidate });

    expect(gate.outcome).toBe('FAIL');
    expect(gate.taskViolations.some((violation) => violation.startsWith('skills: pass rate'))).toBe(true);
  });

  it('rejects duplicate task ids before maps can collapse them', () => {
    const baseline = result(10_000, 'turn-baseline');
    const candidate = result(7_000, 'turn-candidate');
    candidate.tasks.push({ ...candidate.tasks[0] });

    const gate = evaluateCommandEveTtftGoldenSet({ baseline, candidate });

    expect(gate.outcome).toBe('FAIL');
    expect(gate.taskViolations).toContain(`${candidate.tasks[0].id}: duplicate candidate task id`);
  });

  it('requires a full artifact commit and a valid non-reused provider-call identity', () => {
    const baseline = result(10_000, 'same-turn');
    const candidate = result(7_000, 'same-turn');
    candidate.artifactCommit = '';

    const gate = evaluateCommandEveTtftGoldenSet({ baseline, candidate });

    expect(gate.outcome).toBe('FAIL');
    expect(gate.parityViolations).toContain('candidate artifactCommit must be a full git sha');
    expect(gate.tokenEvidenceViolations).toContain('baseline and candidate reuse the same provider request identity');
  });
});
