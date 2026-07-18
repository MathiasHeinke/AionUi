import { describe, expect, it } from 'vitest';

import { inspectPackagedRuntimeReadiness } from '../../../scripts/benchmark-runtime-readiness';

describe('packaged benchmark runtime readiness', () => {
  it('requires both the Command EVE and managed runtime receipts', () => {
    expect(inspectPackagedRuntimeReadiness(['Runtime bootstrap ready: Runtime ready for EVE first session.'])).toEqual({
      ready: false,
      commandEveRuntimeReady: true,
      managedRuntimeSettled: false,
      failureReason: null,
    });

    expect(
      inspectPackagedRuntimeReadiness([
        'Runtime bootstrap ready: Runtime ready for EVE first session.',
        'startup: managed runtime background preparation completed prepare_elapsed_ms=751',
      ])
    ).toEqual({
      ready: true,
      commandEveRuntimeReady: true,
      managedRuntimeSettled: true,
      failureReason: null,
    });
  });

  it('fails closed when either runtime preparation reports an error', () => {
    expect(
      inspectPackagedRuntimeReadiness([
        'Runtime bootstrap ready: Runtime ready for EVE first session.',
        'startup: managed runtime background preparation failed code="BOOTSTRAP_DEGRADED"',
      ])
    ).toMatchObject({ ready: false, failureReason: 'managed runtime background preparation failed' });

    expect(
      inspectPackagedRuntimeReadiness([
        'Runtime bootstrap failed: Runtime bootstrap skipped.',
        'startup: managed runtime background preparation completed prepare_elapsed_ms=751',
      ])
    ).toMatchObject({ ready: false, failureReason: 'Command EVE runtime bootstrap failed' });
  });
});
