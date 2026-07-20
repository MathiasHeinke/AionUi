import type {
  CalibrationReceiptV1,
  ExistingProjectCandidate,
  ImmutableProjectTargetSnapshot,
} from '@/common/types/project-workspace/intent';
import { evaluateCalibrationReceipt, resolveProjectIntent } from '@process/services/project-workspace/core/intentCore';

const snapshot: ImmutableProjectTargetSnapshot = {
  seat_id: 'seat-alpha',
  realm_id: '11111111-1111-4111-8111-111111111111',
  root_id: '22222222-2222-4222-8222-222222222222',
  workspace_root_ref: 'root:22222222-2222-4222-8222-222222222222',
  realm_revision: 1,
  root_revision: 1,
  project_catalog_revision: 0,
};

const candidate: ExistingProjectCandidate = {
  project_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  seat_id: 'seat-alpha',
  realm_id: snapshot.realm_id,
  root_id: snapshot.root_id,
  workspace_root_ref: snapshot.workspace_root_ref,
  title: 'Atlas Research',
  slug: 'atlas-research',
  status: 'active',
};

function route(overrides: Record<string, unknown> = {}) {
  return resolveProjectIntent({
    conversation_id: 'conversation-atlas',
    snapshot,
    title: 'Atlas Research',
    confidence: 0.94,
    explicit_create: false,
    explicit_one_off: false,
    durable_signal_count: 3,
    ambiguous_scope: false,
    sensitive_root_choice: false,
    auto_create_requested: false,
    candidates: [],
    accepted_domain_ids: ['domain:research'],
    proposed_domain_labels: ['possible-new-domain'],
    ...overrides,
  });
}

describe('project intent router', () => {
  it('emits one_off for a clearly bounded single action', () => {
    expect(route({ explicit_one_off: true, durable_signal_count: 0 }).action).toBe('one_off');
  });

  it('continues one deterministic same-realm match without creating a duplicate', () => {
    expect(route({ candidates: [candidate] })).toMatchObject({
      action: 'continue_existing',
      project_id: candidate.project_id,
    });
  });

  it('proposes an implicit durable project while auto-create is locked', () => {
    expect(route({ auto_create_requested: true })).toMatchObject({
      action: 'propose_create',
      needs_human_confirmation: true,
      reason_code: 'auto-create.locked',
    });
  });

  it('creates immediately only for an explicit unambiguous user instruction', () => {
    expect(route({ explicit_create: true })).toMatchObject({
      action: 'create',
      needs_human_confirmation: false,
    });
  });

  it('asks exactly one question when scope or candidates are ambiguous', () => {
    const second = { ...candidate, project_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
    expect(route({ candidates: [candidate, second] })).toMatchObject({
      action: 'disambiguate',
      question_count: 1,
    });
  });

  it('keeps new domains proposal-only', () => {
    expect(route()).toMatchObject({
      domain_ids: ['domain:research'],
      proposed_domains: [{ label: 'possible-new-domain', status: 'proposed' }],
    });
  });
});

describe('implicit auto-create calibration', () => {
  const perfectReceipt: CalibrationReceiptV1 = {
    schema_version: 'command-eve-project-calibration/v1',
    dataset_version: 'dataset/v1',
    router_version: 'router/v1',
    policy_version: 'policy/v1',
    seat_id: 'seat-alpha',
    evaluated_at: '2026-07-20T00:00:00.000Z',
    sample_size: 250,
    class_counts: {
      one_off: 50,
      continue_existing: 50,
      propose_create: 50,
      create: 50,
      disambiguate: 50,
    },
    harmful_false_positive_count: 0,
    false_positive_rate: 0,
    false_positive_wilson_upper: 0.015,
    create_precision: 1,
    class_recall: {
      one_off: 0.98,
      continue_existing: 0.98,
      propose_create: 0.98,
      create: 0.98,
      disambiguate: 0.98,
    },
    abstention_rate: 0,
    cao_verdict: 'PASS',
    controller_gate: 'HG-2.5',
  };

  it('keeps release auto-create locked even when a receipt is structurally eligible', () => {
    expect(
      evaluateCalibrationReceipt(perfectReceipt, {
        seat_id: 'seat-alpha',
        dataset_version: 'dataset/v1',
        router_version: 'router/v1',
        policy_version: 'policy/v1',
      })
    ).toMatchObject({ eligible: true, unlocked: false, reason_code: 'auto-create.locked' });
  });

  it('rejects undefined or below-threshold metrics fail-closed', () => {
    expect(
      evaluateCalibrationReceipt(
        { ...perfectReceipt, create_precision: undefined },
        {
          seat_id: 'seat-alpha',
          dataset_version: 'dataset/v1',
          router_version: 'router/v1',
          policy_version: 'policy/v1',
        }
      )
    ).toMatchObject({ eligible: false, unlocked: false, reason_code: 'calibration.metric-undefined' });
  });

  it('rejects forged counts, confidence bounds, and unknown receipt fields', () => {
    const expected = {
      seat_id: 'seat-alpha',
      dataset_version: 'dataset/v1',
      router_version: 'router/v1',
      policy_version: 'policy/v1',
    };
    expect(
      evaluateCalibrationReceipt(
        { ...perfectReceipt, class_counts: { ...perfectReceipt.class_counts, create: 49 } },
        expected
      )
    ).toMatchObject({ eligible: false, reason_code: 'calibration.insufficient-sample' });
    expect(evaluateCalibrationReceipt({ ...perfectReceipt, false_positive_wilson_upper: 0 }, expected)).toMatchObject({
      eligible: false,
      reason_code: 'calibration.threshold-not-met',
    });
    expect(
      evaluateCalibrationReceipt({ ...perfectReceipt, raw_dataset: '/private/data' } as CalibrationReceiptV1, expected)
    ).toMatchObject({ eligible: false, reason_code: 'calibration.insufficient-sample' });
  });
});
