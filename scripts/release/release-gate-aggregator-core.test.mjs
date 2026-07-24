import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REQUIRED_RELEASE_GATES,
  RELEASE_GATE_AGGREGATOR_STATUS_EXIT_CODES,
  normalizeGateResult,
  runReleaseGates,
} from './release-gate-aggregator-core.mjs';

const PASS_EGRESS = { status: 'PASS', detail: 'egress proof passed', exit_code: 0 };
const PASS_NOTARIZATION = { status: 'PASS', detail: 'Artifact is stapled and accepted by Gatekeeper', exit_code: 0 };
const PASS_UPDATE_FEED = { status: 'PASS', detail: 'mac update feed matched final artifacts', exit_code: 0 };
const PASS_FIRST_RUN_BUNDLE = { status: 'PASS', detail: 'fresh packaged first-run bundle verified', exit_code: 0 };

function passingRunners(overrides = {}) {
  return {
    egressKeystone: () => PASS_EGRESS,
    notarizationStapled: () => PASS_NOTARIZATION,
    macUpdateFeed: () => PASS_UPDATE_FEED,
    firstRunBundle: () => PASS_FIRST_RUN_BUNDLE,
    ...overrides,
  };
}

test('notarization-stapled is a required, fail-closed gate in the roster', () => {
  const ids = REQUIRED_RELEASE_GATES.map((gate) => gate.id);
  assert.ok(ids.includes('notarization-stapled'), 'notarization-stapled must be a required gate');
  assert.ok(ids.includes('egress-keystone'), 'egress-keystone stays a required gate');
  assert.ok(ids.includes('mac-update-feed'), 'mac-update-feed must block stale updater metadata');
  assert.ok(ids.includes('first-run-bundle'), 'first-run-bundle (C9) must be a required gate');
});

test('aggregate PASSes only when every required gate passes', async () => {
  const result = await runReleaseGates(passingRunners());
  assert.equal(result.status, 'PASS');
  assert.equal(result.exit_code, RELEASE_GATE_AGGREGATOR_STATUS_EXIT_CODES.PASS);
  assert.deepEqual(result.blocked_gates, []);
});

test('aggregator invokes the notarization gate runner exactly once', async () => {
  let notarizationCalls = 0;
  await runReleaseGates(
    passingRunners({
      notarizationStapled: () => {
        notarizationCalls += 1;
        return PASS_NOTARIZATION;
      },
    })
  );
  assert.equal(notarizationCalls, 1, 'notarization gate must be invoked by the aggregator');
});

test('aggregate FAILS CLOSED when the notarization gate reports BLOCKED (spctl rejected)', async () => {
  const result = await runReleaseGates(
    passingRunners({
      notarizationStapled: () => ({
        status: 'BLOCKED_SPCTL_REJECTED',
        detail: 'spctl rejected the artifact (Gatekeeper would block it)',
        exit_code: 4,
      }),
    })
  );
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.exit_code, RELEASE_GATE_AGGREGATOR_STATUS_EXIT_CODES.BLOCKED);
  assert.ok(
    result.blocked_gates.includes('notarization-stapled'),
    'a BLOCKED notarization gate must block the whole release'
  );
});

test('aggregate FAILS CLOSED when the notarization gate reports an unstapled DMG', async () => {
  const result = await runReleaseGates(
    passingRunners({
      notarizationStapled: () => ({
        status: 'BLOCKED_STAPLE_INVALID',
        detail: 'stapler validate did not confirm a stapled ticket',
        exit_code: 3,
      }),
    })
  );
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blocked_gates.includes('notarization-stapled'));
});

test('aggregate FAILS CLOSED when the notarization runner throws', async () => {
  const result = await runReleaseGates(
    passingRunners({
      notarizationStapled: () => {
        throw new Error('xcrun missing');
      },
    })
  );
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blocked_gates.includes('notarization-stapled'));
});

test('aggregate FAILS CLOSED when the notarization runner returns no result', async () => {
  const result = await runReleaseGates(passingRunners({ notarizationStapled: () => undefined }));
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blocked_gates.includes('notarization-stapled'));
});

test('a missing notarization runner is a fail-closed config error', async () => {
  const result = await runReleaseGates({
    egressKeystone: () => PASS_EGRESS,
    macUpdateFeed: () => PASS_UPDATE_FEED,
    // notarizationStapled intentionally omitted
  });
  assert.equal(result.status, 'BLOCKED_CONFIG_ERROR');
  assert.equal(result.exit_code, RELEASE_GATE_AGGREGATOR_STATUS_EXIT_CODES.BLOCKED_CONFIG_ERROR);
  assert.ok(result.blocked_gates.includes('notarization-stapled'));
});

test('a blocked egress gate also blocks even when notarization passes', async () => {
  const result = await runReleaseGates(
    passingRunners({
      egressKeystone: () => ({ status: 'BLOCKED_TEST_SKIPPED', detail: 'egress proof skipped' }),
    })
  );
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blocked_gates.includes('egress-keystone'));
});

test('a blocked mac update feed gate blocks the release', async () => {
  const result = await runReleaseGates(
    passingRunners({
      macUpdateFeed: () => ({
        status: 'BLOCKED_HASH_MISMATCH',
        detail: 'latest-arm64-mac.yml points to pre-staple bytes',
        exit_code: 5,
      }),
    })
  );
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blocked_gates.includes('mac-update-feed'));
});

test('a missing mac update feed runner is a fail-closed config error', async () => {
  const result = await runReleaseGates({
    egressKeystone: () => PASS_EGRESS,
    notarizationStapled: () => PASS_NOTARIZATION,
    // macUpdateFeed intentionally omitted
  });
  assert.equal(result.status, 'BLOCKED_CONFIG_ERROR');
  assert.ok(result.blocked_gates.includes('mac-update-feed'));
});

test('normalizeGateResult treats any non-PASS status as a block', () => {
  const gate = { id: 'notarization-stapled' };
  assert.equal(normalizeGateResult(gate, { status: 'PASS' }).ok, true);
  assert.equal(normalizeGateResult(gate, { status: 'BLOCKED_SPCTL_REJECTED' }).ok, false);
  assert.equal(normalizeGateResult(gate, { status: '' }).ok, false);
  assert.equal(normalizeGateResult(gate, null).ok, false);
});

test('aggregate FAILS CLOSED when the first-run-bundle gate reports a stale receipt', async () => {
  const result = await runReleaseGates(
    passingRunners({
      firstRunBundle: () => ({
        status: 'BLOCKED_RECEIPT',
        detail: 'runtime-bootstrap-receipt.json is not bound to the packaged version',
        exit_code: 6,
      }),
    })
  );
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blocked_gates.includes('first-run-bundle'));
});

test('aggregate FAILS CLOSED when the first-run-bundle runner throws', async () => {
  const result = await runReleaseGates(
    passingRunners({
      firstRunBundle: () => {
        throw new Error('packaged app missing');
      },
    })
  );
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blocked_gates.includes('first-run-bundle'));
});

test('a missing first-run-bundle runner is a fail-closed config error', async () => {
  const result = await runReleaseGates({
    egressKeystone: () => PASS_EGRESS,
    notarizationStapled: () => PASS_NOTARIZATION,
    macUpdateFeed: () => PASS_UPDATE_FEED,
    // firstRunBundle intentionally omitted
  });
  assert.equal(result.status, 'BLOCKED_CONFIG_ERROR');
  assert.ok(result.blocked_gates.includes('first-run-bundle'));
});
