import { validateCommandEveProviderCallReceipt, type CommandEveProviderCallReceipt } from './formal-core';

export const COMMAND_EVE_TTFT_GOLDEN_RESULT_VERSION = 'command-eve-ttft-golden-result/v1' as const;

export const COMMAND_EVE_TTFT_GOLDEN_CATEGORIES = [
  'text',
  'code',
  'tool_selection',
  'skills',
  'memory',
  'workspace_context',
  'long_reasoning',
] as const;

export type CommandEveTtftGoldenCategory = (typeof COMMAND_EVE_TTFT_GOLDEN_CATEGORIES)[number];

export type CommandEveTtftGoldenResult = {
  version: typeof COMMAND_EVE_TTFT_GOLDEN_RESULT_VERSION;
  artifactCommit: string;
  profileFingerprints: {
    promptPrefixSha256: string;
    toolSchemasSha256: string;
    skillsIndexSha256: string;
    safetyContractSha256: string;
    memoryContractSha256: string;
    workspaceContractSha256: string;
  };
  tokenEvidence: {
    providerCallReceipt: CommandEveProviderCallReceipt | null;
  };
  tasks: Array<{
    id: string;
    category: CommandEveTtftGoldenCategory;
    passed: boolean;
    evidenceSha256: string;
  }>;
};

export type CommandEveTtftGoldenGate = {
  version: 'command-eve-ttft-golden-gate/v1';
  outcome: 'PASS' | 'FAIL' | 'SOURCE_PASS_MEASUREMENT_REQUIRED';
  qualityOutcome: 'PASS' | 'FAIL';
  coldTokenOutcome: 'PASS' | 'FAIL' | 'INSUFFICIENT_EVIDENCE';
  requiredColdTokenReduction: number;
  observedColdTokenReduction: number | null;
  parityViolations: string[];
  taskViolations: string[];
  tokenEvidenceViolations: string[];
  categoryPassRates: Record<CommandEveTtftGoldenCategory, { baseline: number; candidate: number }>;
  reason: string;
};

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_COMMIT = /^[a-f0-9]{40}$/;

const passRate = (tasks: CommandEveTtftGoldenResult['tasks']): number =>
  tasks.length === 0 ? 0 : tasks.filter((task) => task.passed).length / tasks.length;

/**
 * Provider-free comparison gate. It never executes a model and never stores a
 * prompt, skill, tool schema, response, or workspace path. Exact hashes prove
 * parity; real call-correlated token receipts remain a separate measurement.
 */
export function evaluateCommandEveTtftGoldenSet(input: {
  baseline: CommandEveTtftGoldenResult;
  candidate: CommandEveTtftGoldenResult;
  requiredColdTokenReduction?: number;
}): CommandEveTtftGoldenGate {
  const requiredColdTokenReduction = input.requiredColdTokenReduction ?? 0.3;
  const parityViolations = [
    ...(!GIT_COMMIT.test(input.baseline.artifactCommit) ? ['baseline artifactCommit must be a full git sha'] : []),
    ...(!GIT_COMMIT.test(input.candidate.artifactCommit) ? ['candidate artifactCommit must be a full git sha'] : []),
    ...Object.keys(input.baseline.profileFingerprints).flatMap((key) => {
      const field = key as keyof CommandEveTtftGoldenResult['profileFingerprints'];
      const baselineHash = input.baseline.profileFingerprints[field];
      const candidateHash = input.candidate.profileFingerprints[field];
      if (!SHA256.test(baselineHash) || !SHA256.test(candidateHash)) return [`${field}: invalid sha256`];
      return baselineHash === candidateHash ? [] : [`${field}: changed without parity proof`];
    }),
  ];

  const taskViolations: string[] = [];
  const duplicateIds = (tasks: CommandEveTtftGoldenResult['tasks']): string[] => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const task of tasks) {
      if (seen.has(task.id)) duplicates.add(task.id);
      seen.add(task.id);
    }
    return [...duplicates];
  };
  for (const id of duplicateIds(input.baseline.tasks)) taskViolations.push(`${id}: duplicate baseline task id`);
  for (const id of duplicateIds(input.candidate.tasks)) taskViolations.push(`${id}: duplicate candidate task id`);
  const baselineById = new Map(input.baseline.tasks.map((task) => [task.id, task]));
  const candidateById = new Map(input.candidate.tasks.map((task) => [task.id, task]));
  for (const [id, baselineTask] of baselineById) {
    const candidateTask = candidateById.get(id);
    if (!candidateTask) {
      taskViolations.push(`${id}: missing candidate task`);
      continue;
    }
    if (candidateTask.category !== baselineTask.category) taskViolations.push(`${id}: category changed`);
    if (!SHA256.test(baselineTask.evidenceSha256) || !SHA256.test(candidateTask.evidenceSha256)) {
      taskViolations.push(`${id}: invalid evidence sha256`);
    }
  }
  for (const id of candidateById.keys()) {
    if (!baselineById.has(id)) taskViolations.push(`${id}: candidate task not present in baseline`);
  }

  const categoryPassRates = Object.fromEntries(
    COMMAND_EVE_TTFT_GOLDEN_CATEGORIES.map((category) => {
      const baselineTasks = input.baseline.tasks.filter((task) => task.category === category);
      const candidateTasks = input.candidate.tasks.filter((task) => task.category === category);
      if (baselineTasks.length === 0 || candidateTasks.length === 0) {
        taskViolations.push(`${category}: category coverage missing`);
      }
      const baselineRate = passRate(baselineTasks);
      const candidateRate = passRate(candidateTasks);
      if (candidateRate < baselineRate) {
        taskViolations.push(`${category}: pass rate ${candidateRate} below baseline ${baselineRate}`);
      }
      return [category, { baseline: baselineRate, candidate: candidateRate }];
    })
  ) as CommandEveTtftGoldenGate['categoryPassRates'];

  const tokenEvidenceViolations: string[] = [];
  const validatedReceipt = (
    label: 'baseline' | 'candidate',
    receipt: CommandEveProviderCallReceipt | null
  ): CommandEveProviderCallReceipt | null => {
    if (!receipt) return null;
    const validation = validateCommandEveProviderCallReceipt(receipt);
    if ('violations' in validation) {
      tokenEvidenceViolations.push(...validation.violations.map((violation) => `${label}: ${violation}`));
      return null;
    }
    return validation.receipt;
  };
  const baselineReceipt = validatedReceipt('baseline', input.baseline.tokenEvidence.providerCallReceipt);
  const candidateReceipt = validatedReceipt('candidate', input.candidate.tokenEvidence.providerCallReceipt);
  if (baselineReceipt && candidateReceipt && baselineReceipt.request_id === candidateReceipt.request_id) {
    tokenEvidenceViolations.push('baseline and candidate reuse the same provider request identity');
  }
  const newlyEvaluatedTokens = (receipt: CommandEveProviderCallReceipt | null): number | null => {
    if (!receipt || receipt.response_usage.prompt_reuse_status !== 'observed') return null;
    const promptTokens = receipt.response_usage.prompt_tokens;
    const reusedTokens = receipt.response_usage.prompt_reused_tokens;
    if (typeof promptTokens !== 'number' || typeof reusedTokens !== 'number' || reusedTokens > promptTokens)
      return null;
    return promptTokens - reusedTokens;
  };
  const baselineTokens = newlyEvaluatedTokens(baselineReceipt);
  const candidateTokens = newlyEvaluatedTokens(candidateReceipt);
  const exactTokenEvidence = baselineTokens !== null && baselineTokens > 0 && candidateTokens !== null;
  const observedColdTokenReduction = exactTokenEvidence ? (baselineTokens - candidateTokens) / baselineTokens : null;
  const coldTokenOutcome =
    tokenEvidenceViolations.length > 0
      ? 'FAIL'
      : observedColdTokenReduction === null
        ? 'INSUFFICIENT_EVIDENCE'
        : observedColdTokenReduction >= requiredColdTokenReduction
          ? 'PASS'
          : 'FAIL';
  const qualityOutcome = parityViolations.length === 0 && taskViolations.length === 0 ? 'PASS' : 'FAIL';
  const outcome =
    qualityOutcome === 'FAIL' || coldTokenOutcome === 'FAIL'
      ? 'FAIL'
      : coldTokenOutcome === 'INSUFFICIENT_EVIDENCE'
        ? 'SOURCE_PASS_MEASUREMENT_REQUIRED'
        : 'PASS';

  return {
    version: 'command-eve-ttft-golden-gate/v1',
    outcome,
    qualityOutcome,
    coldTokenOutcome,
    requiredColdTokenReduction,
    observedColdTokenReduction,
    parityViolations,
    taskViolations,
    tokenEvidenceViolations,
    categoryPassRates,
    reason:
      outcome === 'PASS'
        ? 'quality parity and exact-call cold-token reduction pass'
        : outcome === 'SOURCE_PASS_MEASUREMENT_REQUIRED'
          ? 'quality parity passes; exact-call evaluated-token receipts are still required'
          : 'quality parity or cold-token reduction failed',
  };
}
