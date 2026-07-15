export type EvalTaskScore = Readonly<{
  task: 'long_form' | 'tool_roundtrip' | 'constraint_list' | 'context_recall';
  score: number;
  maxScore: number;
  hardPass: boolean;
  reasons: string[];
}>;

export type ModelEvalSummary = Readonly<{
  targetId: string;
  score: number;
  maxScore: number;
  scoreRatio: number;
  hardPass: boolean;
  failedReasons: string[];
}>;

function stoppedNormally(finishReason: string | undefined): boolean {
  return finishReason === 'stop' || finishReason === 'tool_calls';
}

export function scoreLongForm(args: {
  content: string;
  finishReason?: string;
  terminalMarker: string;
  requiredHeadings: string[];
}): EvalTaskScore {
  const reasons: string[] = [];
  let score = 0;
  if (args.content.trim()) score += 1;
  else reasons.push('empty_output');
  if (stoppedNormally(args.finishReason)) score += 1;
  else reasons.push(`finish_${args.finishReason || 'missing'}`);
  if (args.content.includes(args.terminalMarker)) score += 2;
  else reasons.push('terminal_marker_missing');
  const headingCount = args.requiredHeadings.filter((heading) => args.content.includes(heading)).length;
  score += (headingCount / args.requiredHeadings.length) * 2;
  if (headingCount !== args.requiredHeadings.length) reasons.push('required_headings_missing');
  if (args.content.length >= 1_500) score += 2;
  else reasons.push('output_too_short');
  if (!/(?:^|\n)\s*(?:Entschuldigung|I cannot|I can't)/i.test(args.content)) score += 2;
  else reasons.push('refusal_detected');
  return {
    task: 'long_form',
    score,
    maxScore: 10,
    hardPass:
      stoppedNormally(args.finishReason) &&
      args.content.includes(args.terminalMarker) &&
      headingCount === args.requiredHeadings.length,
    reasons,
  };
}

export function scoreToolRoundtrip(args: {
  finishReason?: string;
  toolName?: string;
  toolArguments?: string;
  finalContent: string;
  finalFinishReason?: string;
}): EvalTaskScore {
  const reasons: string[] = [];
  let score = 0;
  if (args.toolName) score += 2;
  else reasons.push('tool_call_missing');
  if (args.toolName === 'add_numbers') score += 2;
  else reasons.push('wrong_tool');
  try {
    const parsed = JSON.parse(args.toolArguments || '{}') as { a?: number; b?: number };
    if (parsed.a === 19 && parsed.b === 23) score += 2;
    else reasons.push('wrong_tool_arguments');
  } catch {
    reasons.push('invalid_tool_arguments');
  }
  if (/\b42\b/.test(args.finalContent)) score += 2;
  else reasons.push('tool_result_not_used');
  if (stoppedNormally(args.finishReason) && stoppedNormally(args.finalFinishReason)) score += 2;
  else reasons.push('tool_roundtrip_cutoff');
  return {
    task: 'tool_roundtrip',
    score,
    maxScore: 10,
    hardPass:
      args.toolName === 'add_numbers' &&
      /\b42\b/.test(args.finalContent) &&
      stoppedNormally(args.finishReason) &&
      stoppedNormally(args.finalFinishReason),
    reasons,
  };
}

export function scoreConstraintList(args: { content: string; finishReason?: string }): EvalTaskScore {
  const reasons: string[] = [];
  const lines = args.content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const numbered = lines.filter((line) => /^\d+[.)]\s/.test(line));
  const tagged = numbered.filter((line) => line.includes('[RISIKO]'));
  let score = 0;
  if (numbered.length === 7) score += 3;
  else reasons.push(`numbered_items_${numbered.length}`);
  if (tagged.length === 7) score += 2;
  else reasons.push(`tagged_items_${tagged.length}`);
  if (lines.length === 7) score += 1;
  else reasons.push(`nonempty_lines_${lines.length}`);
  if (stoppedNormally(args.finishReason)) score += 2;
  else reasons.push(`finish_${args.finishReason || 'missing'}`);
  return {
    task: 'constraint_list',
    score,
    maxScore: 8,
    hardPass: numbered.length === 7 && tagged.length === 7 && stoppedNormally(args.finishReason),
    reasons,
  };
}

export function scoreContextRecall(args: { content: string; finishReason?: string; canary: string }): EvalTaskScore {
  const reasons: string[] = [];
  let score = 0;
  const normalized = args.content.trim().replace(/^['"`]|['"`]$/g, '');
  if (normalized === args.canary) score += 5;
  else reasons.push('canary_not_exact');
  if (stoppedNormally(args.finishReason)) score += 2;
  else reasons.push(`finish_${args.finishReason || 'missing'}`);
  return {
    task: 'context_recall',
    score,
    maxScore: 7,
    hardPass: normalized === args.canary && stoppedNormally(args.finishReason),
    reasons,
  };
}

export function summarizeModelScores(targetId: string, scores: EvalTaskScore[]): ModelEvalSummary {
  const score = scores.reduce((sum, item) => sum + item.score, 0);
  const maxScore = scores.reduce((sum, item) => sum + item.maxScore, 0);
  return {
    targetId,
    score,
    maxScore,
    scoreRatio: maxScore > 0 ? score / maxScore : 0,
    hardPass: scores.length > 0 && scores.every((item) => item.hardPass),
    failedReasons: scores.flatMap((item) => item.reasons.map((reason) => `${item.task}:${reason}`)),
  };
}

export function evaluateBonsaiPromotion(args: {
  bonsai: ModelEvalSummary;
  baselines: ModelEvalSummary[];
  cleanupPass: boolean;
  memoryPass: boolean;
  minimumRelativeGain?: number;
}): { visiblePickerPass: boolean; bestBaselineRatio: number; relativeGain: number; reasons: string[] } {
  const bestBaselineRatio = Math.max(0, ...args.baselines.map((item) => item.scoreRatio));
  const relativeGain = bestBaselineRatio > 0 ? args.bonsai.scoreRatio / bestBaselineRatio - 1 : 0;
  const minimumRelativeGain = args.minimumRelativeGain ?? 0.15;
  const reasons: string[] = [];
  if (!args.bonsai.hardPass) reasons.push('bonsai_hard_gate_failed');
  if (!args.cleanupPass) reasons.push('cleanup_failed');
  if (!args.memoryPass) reasons.push('memory_gate_failed');
  if (relativeGain < minimumRelativeGain) reasons.push('quality_gain_below_15_percent');
  return {
    visiblePickerPass: reasons.length === 0,
    bestBaselineRatio,
    relativeGain,
    reasons,
  };
}
