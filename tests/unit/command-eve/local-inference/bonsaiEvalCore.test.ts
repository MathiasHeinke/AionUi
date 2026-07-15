import { describe, expect, it } from 'vitest';

import {
  evaluateBonsaiPromotion,
  scoreConstraintList,
  scoreContextRecall,
  scoreLongForm,
  scoreToolRoundtrip,
  summarizeModelScores,
} from '../../../../scripts/command-eve-bonsai-eval-core';

describe('Bonsai pilot eval core', () => {
  it('requires explicit completion evidence for long output', () => {
    const score = scoreLongForm({
      content: `${'# Ausgangslage\n'.repeat(200)}# Empfehlung\n# Risiken\n# Nächste Schritte\n<EVE_DONE_42>`,
      finishReason: 'stop',
      terminalMarker: '<EVE_DONE_42>',
      requiredHeadings: ['# Ausgangslage', '# Empfehlung', '# Risiken', '# Nächste Schritte'],
    });
    expect(score.hardPass).toBe(true);
    expect(score.score).toBe(10);
  });

  it('fails a tool call that ignores the returned value', () => {
    const score = scoreToolRoundtrip({
      finishReason: 'tool_calls',
      toolName: 'add_numbers',
      toolArguments: '{"a":19,"b":23}',
      finalContent: 'Erledigt.',
      finalFinishReason: 'stop',
    });
    expect(score.hardPass).toBe(false);
    expect(score.reasons).toContain('tool_result_not_used');
  });

  it('scores constrained lists and exact context recall deterministically', () => {
    const list = Array.from({ length: 7 }, (_, index) => `${index + 1}. [RISIKO] Punkt`).join('\n');
    expect(scoreConstraintList({ content: list, finishReason: 'stop' }).hardPass).toBe(true);
    expect(
      scoreContextRecall({ content: ' EVE-CANARY-7Q4 ', finishReason: 'stop', canary: 'EVE-CANARY-7Q4' }).score
    ).toBe(7);
  });

  it('keeps the visible picker gated behind hard gates, cleanup, memory, and 15 percent gain', () => {
    const baseline = summarizeModelScores('gemma', [
      { task: 'context_recall', score: 5, maxScore: 7, hardPass: true, reasons: [] },
    ]);
    const bonsai = summarizeModelScores('bonsai', [
      { task: 'context_recall', score: 7, maxScore: 7, hardPass: true, reasons: [] },
    ]);
    expect(
      evaluateBonsaiPromotion({ bonsai, baselines: [baseline], cleanupPass: true, memoryPass: true }).visiblePickerPass
    ).toBe(true);
    expect(
      evaluateBonsaiPromotion({ bonsai, baselines: [baseline], cleanupPass: false, memoryPass: true }).visiblePickerPass
    ).toBe(false);
  });
});
