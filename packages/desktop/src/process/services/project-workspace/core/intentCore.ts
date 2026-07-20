import crypto from 'node:crypto';
import type {
  CalibrationExpectation,
  CalibrationReceiptV1,
  ExistingProjectCandidate,
  ProjectIntentPlan,
  ProjectIntentRouterInput,
} from '@/common/types/project-workspace/intent';

export const PROJECT_AUTO_CREATE_RELEASE_LOCKED = true;
const CALIBRATION_CLASSES = ['one_off', 'continue_existing', 'propose_create', 'create', 'disambiguate'] as const;
const CALIBRATION_RECEIPT_KEYS = new Set([
  'schema_version',
  'dataset_version',
  'router_version',
  'policy_version',
  'seat_id',
  'evaluated_at',
  'sample_size',
  'class_counts',
  'harmful_false_positive_count',
  'false_positive_rate',
  'false_positive_wilson_upper',
  'create_precision',
  'class_recall',
  'abstention_rate',
  'cao_verdict',
  'controller_gate',
]);

function hasExactKeys(value: unknown, expected: ReadonlySet<string>): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === expected.size &&
    Object.keys(value).every((key) => expected.has(key))
  );
}

function normalizedWords(value: string): string[] {
  return value
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .toLocaleLowerCase('en-US')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function projectSlug(value: string): string {
  const slug = normalizedWords(value).join('-').slice(0, 64).replace(/-+$/g, '');
  return slug || 'project';
}

function similarity(left: string, right: string): number {
  const a = new Set(normalizedWords(left));
  const b = new Set(normalizedWords(right));
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) if (b.has(word)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function deterministicProjectId(input: ProjectIntentRouterInput): string {
  const digest = Buffer.from(
    crypto
      .createHash('sha256')
      .update(`${input.snapshot.seat_id}\0${input.snapshot.realm_id}\0${input.title.normalize('NFC')}`)
      .digest()
  );
  digest[6] = (digest[6] & 0x0f) | 0x40;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function matchingCandidates(input: ProjectIntentRouterInput): ExistingProjectCandidate[] {
  const targetSlug = projectSlug(input.title);
  return input.candidates
    .filter(
      (candidate) =>
        candidate.seat_id === input.snapshot.seat_id &&
        candidate.realm_id === input.snapshot.realm_id &&
        candidate.status === 'active'
    )
    .filter((candidate) => candidate.slug === targetSlug || similarity(candidate.title, input.title) >= 0.8)
    .toSorted((left, right) => left.project_id.localeCompare(right.project_id));
}

export function resolveProjectIntent(input: ProjectIntentRouterInput): ProjectIntentPlan {
  const matches = matchingCandidates(input);
  const projectId = input.project_id ?? deterministicProjectId(input);
  const domainIds = uniqueStrings(input.accepted_domain_ids).filter((value) =>
    /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(value)
  );
  const proposedDomains = uniqueStrings(input.proposed_domain_labels).map((label) => ({
    label,
    status: 'proposed' as const,
  }));
  const base = {
    conversation_id: input.conversation_id,
    seat_id: input.snapshot.seat_id,
    realm_id: input.snapshot.realm_id,
    root_id: input.snapshot.root_id,
    project_id: projectId,
    title: input.title.trim(),
    slug: projectSlug(input.title),
    domain_ids: domainIds,
    proposed_domains: proposedDomains,
    confidence: Math.max(0, Math.min(1, input.confidence)),
    workspace_root_ref: input.snapshot.workspace_root_ref,
    existing_candidates: matches,
    snapshot: Object.freeze({ ...input.snapshot }),
  };

  if (input.explicit_one_off && !input.explicit_create) {
    return { ...base, action: 'one_off', needs_human_confirmation: false, question_count: 0 };
  }
  if (matches.length === 1) {
    const match = matches[0];
    return {
      ...base,
      action: 'continue_existing',
      project_id: match.project_id,
      root_id: match.root_id,
      workspace_root_ref: match.workspace_root_ref,
      needs_human_confirmation: false,
      question_count: 0,
    };
  }
  if (matches.length > 1 || input.ambiguous_scope || input.sensitive_root_choice) {
    return {
      ...base,
      action: 'disambiguate',
      needs_human_confirmation: true,
      question_count: 1,
      reason_code: 'intent.disambiguate',
    };
  }
  if (input.explicit_create) {
    return { ...base, action: 'create', needs_human_confirmation: false, question_count: 0 };
  }
  if (input.durable_signal_count >= 2) {
    return {
      ...base,
      action: 'propose_create',
      needs_human_confirmation: true,
      question_count: 0,
      ...(input.auto_create_requested ? { reason_code: 'auto-create.locked' as const } : {}),
    };
  }
  return { ...base, action: 'one_off', needs_human_confirmation: false, question_count: 0 };
}

export type CalibrationEvaluation = {
  eligible: boolean;
  unlocked: boolean;
  reason_code:
    | 'auto-create.locked'
    | 'calibration.insufficient-sample'
    | 'calibration.false-positive'
    | 'calibration.metric-undefined'
    | 'calibration.threshold-not-met';
};

export function evaluateCalibrationReceipt(
  receipt: CalibrationReceiptV1,
  expected: CalibrationExpectation
): CalibrationEvaluation {
  const classKeys = new Set<string>(CALIBRATION_CLASSES);
  if (
    !hasExactKeys(receipt, CALIBRATION_RECEIPT_KEYS) ||
    !hasExactKeys(receipt.class_counts, classKeys) ||
    !hasExactKeys(receipt.class_recall, classKeys) ||
    typeof receipt.dataset_version !== 'string' ||
    receipt.dataset_version.length === 0 ||
    typeof receipt.router_version !== 'string' ||
    receipt.router_version.length === 0 ||
    typeof receipt.policy_version !== 'string' ||
    receipt.policy_version.length === 0 ||
    typeof receipt.evaluated_at !== 'string' ||
    !Number.isFinite(Date.parse(receipt.evaluated_at)) ||
    !Number.isInteger(receipt.sample_size) ||
    receipt.sample_size < 0 ||
    !Number.isInteger(receipt.harmful_false_positive_count) ||
    receipt.harmful_false_positive_count < 0 ||
    receipt.harmful_false_positive_count > receipt.sample_size ||
    Object.values(receipt.class_counts).some((count) => !Number.isInteger(count) || count < 0)
  ) {
    return { eligible: false, unlocked: false, reason_code: 'calibration.insufficient-sample' };
  }
  const metrics = [
    receipt.false_positive_rate,
    receipt.false_positive_wilson_upper,
    receipt.create_precision,
    receipt.abstention_rate,
    ...Object.values(receipt.class_recall),
  ];
  if (metrics.some((metric) => typeof metric !== 'number' || !Number.isFinite(metric))) {
    return { eligible: false, unlocked: false, reason_code: 'calibration.metric-undefined' };
  }
  if (metrics.some((metric) => (metric as number) < 0 || (metric as number) > 1)) {
    return { eligible: false, unlocked: false, reason_code: 'calibration.threshold-not-met' };
  }
  if (
    receipt.schema_version !== 'command-eve-project-calibration/v1' ||
    receipt.seat_id !== expected.seat_id ||
    receipt.dataset_version !== expected.dataset_version ||
    receipt.router_version !== expected.router_version ||
    receipt.policy_version !== expected.policy_version ||
    receipt.sample_size < 200 ||
    Object.values(receipt.class_counts).reduce((sum, count) => sum + count, 0) !== receipt.sample_size ||
    Object.values(receipt.class_counts).some((count) => count < 40)
  ) {
    return { eligible: false, unlocked: false, reason_code: 'calibration.insufficient-sample' };
  }
  if (receipt.harmful_false_positive_count !== 0) {
    return { eligible: false, unlocked: false, reason_code: 'calibration.false-positive' };
  }
  const observedFalsePositiveRate = receipt.harmful_false_positive_count / receipt.sample_size;
  const z = 1.959963984540054;
  const denominator = 1 + (z * z) / receipt.sample_size;
  const center = observedFalsePositiveRate + (z * z) / (2 * receipt.sample_size);
  const radius =
    z *
    Math.sqrt(
      (observedFalsePositiveRate * (1 - observedFalsePositiveRate)) / receipt.sample_size +
        (z * z) / (4 * receipt.sample_size * receipt.sample_size)
    );
  const observedWilsonUpper = (center + radius) / denominator;
  if (
    Math.abs((receipt.false_positive_rate as number) - observedFalsePositiveRate) > 0.000_001 ||
    Math.abs((receipt.false_positive_wilson_upper as number) - observedWilsonUpper) > 0.001 ||
    (receipt.false_positive_wilson_upper as number) >= 0.02 ||
    (receipt.create_precision as number) < 0.98 ||
    Object.values(receipt.class_recall).some((recall) => (recall as number) < 0.9) ||
    receipt.cao_verdict !== 'PASS' ||
    receipt.controller_gate !== 'HG-2.5'
  ) {
    return { eligible: false, unlocked: false, reason_code: 'calibration.threshold-not-met' };
  }
  return {
    eligible: true,
    unlocked: !PROJECT_AUTO_CREATE_RELEASE_LOCKED,
    reason_code: 'auto-create.locked',
  };
}

/**
 * CHAT-GATE CANDIDATE MATCHING (S81/R3, main-process only).
 *
 * Scores the free-text of an outgoing chat message against the existing
 * project candidates of a seat. A candidate matches when >= 80% of its title
 * words appear in the message, or when every token of its slug appears. This
 * deliberately reuses the same normalization as title matching so the chat
 * gate cannot drift from the router. Returns matches in deterministic order.
 *
 * The caller (chat gate) decides: 0 matches -> pass through, 1 -> bind,
 * >1 -> clarify. Auto-create stays release-locked and is never produced here.
 */
export function matchConversationCandidates(
  input: string,
  candidates: ExistingProjectCandidate[]
): ExistingProjectCandidate[] {
  const words = new Set(normalizedWords(input));
  if (words.size === 0) return [];
  return candidates
    .filter((candidate) => candidate.status === 'active')
    .filter((candidate) => {
      const titleWords = normalizedWords(candidate.title);
      if (titleWords.length > 0) {
        const hits = titleWords.filter((word) => words.has(word)).length;
        if (hits / titleWords.length >= 0.8) return true;
      }
      const slugTokens = candidate.slug.split('-').filter(Boolean);
      return slugTokens.length > 0 && slugTokens.every((token) => words.has(token));
    })
    .toSorted((left, right) => left.project_id.localeCompare(right.project_id));
}
