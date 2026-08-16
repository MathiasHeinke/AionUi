import {
  COMMAND_EVE_TTFT_GOLDEN_CATEGORIES,
  evaluateCommandEveTtftGoldenSet,
  type CommandEveTtftGoldenResult,
} from '../../../scripts/command-eve/ttft/golden-set-core';
import { describe, expect, it } from 'vitest';

const sha = (digit: string): string => digit.repeat(64);

const result = (
  newlyEvaluatedInputTokens: number | null,
  correlation: CommandEveTtftGoldenResult['tokenEvidence']['correlation'] = 'exact_call'
): CommandEveTtftGoldenResult => ({
  version: 'command-eve-ttft-golden-result/v1',
  artifactCommit: '2f30231b',
  profileFingerprints: {
    promptPrefixSha256: sha('1'),
    toolSchemasSha256: sha('2'),
    skillsIndexSha256: sha('3'),
    safetyContractSha256: sha('4'),
    memoryContractSha256: sha('5'),
    workspaceContractSha256: sha('6'),
  },
  tokenEvidence: { correlation, newlyEvaluatedInputTokens },
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
      baseline: result(10_000),
      candidate: result(7_000),
    });

    expect(gate.outcome).toBe('PASS');
    expect(gate.qualityOutcome).toBe('PASS');
    expect(gate.coldTokenOutcome).toBe('PASS');
    expect(gate.observedColdTokenReduction).toBeCloseTo(0.3);
  });

  it('requires real exact-call token receipts even when provider-free quality fixtures pass', () => {
    const gate = evaluateCommandEveTtftGoldenSet({
      baseline: result(10_000, 'fixture'),
      candidate: result(7_000, 'fixture'),
    });

    expect(gate.outcome).toBe('SOURCE_PASS_MEASUREMENT_REQUIRED');
    expect(gate.qualityOutcome).toBe('PASS');
    expect(gate.coldTokenOutcome).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('rejects prompt, tool, or skill profile changes without parity proof', () => {
    const baseline = result(10_000);
    const candidate = result(7_000);
    candidate.profileFingerprints.toolSchemasSha256 = sha('a');

    const gate = evaluateCommandEveTtftGoldenSet({ baseline, candidate });

    expect(gate.outcome).toBe('FAIL');
    expect(gate.parityViolations).toContain('toolSchemasSha256: changed without parity proof');
  });

  it('rejects a lower pass rate in any required capability category', () => {
    const baseline = result(10_000);
    const candidate = result(7_000);
    const skillsTask = candidate.tasks.find((task) => task.category === 'skills');
    if (!skillsTask) throw new Error('fixture missing skills task');
    skillsTask.passed = false;

    const gate = evaluateCommandEveTtftGoldenSet({ baseline, candidate });

    expect(gate.outcome).toBe('FAIL');
    expect(gate.taskViolations.some((violation) => violation.startsWith('skills: pass rate'))).toBe(true);
  });
});
