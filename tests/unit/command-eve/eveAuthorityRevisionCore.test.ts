import { describe, expect, it } from 'vitest';

import { renderEveAuthorityRuntime } from '@/common/config/eveAuthorityRuntimeCore';
import type { EveAuthorityGrant } from '@/common/config/eveAuthorityCore';
import { withSeal } from '@/common/config/eveAuthorityStoreCore';
import { deriveEveAuthorityRevision } from '@/process/commandEve/eveAuthorityRevisionCore';

const grant = (ladder: number, overrides: Partial<EveAuthorityGrant> = {}): EveAuthorityGrant =>
  ({
    ladder,
    capabilities: {},
    ...overrides,
  }) as EveAuthorityGrant;

describe('deriveEveAuthorityRevision', () => {
  it('is stable for the same runtime and seat context', () => {
    const runtime = renderEveAuthorityRuntime(grant(3));
    const input = { runtime, seatId: 'seat-1', seatContextRevision: 7, authorityMutationEpoch: 3 };
    expect(deriveEveAuthorityRevision(input)).toBe(deriveEveAuthorityRevision(input));
    expect(deriveEveAuthorityRevision(input)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('changes when a same-rung grant changes', () => {
    const base = deriveEveAuthorityRevision({
      runtime: renderEveAuthorityRuntime(grant(4)),
      seatId: 'seat-1',
      seatContextRevision: 7,
      authorityMutationEpoch: 3,
    });
    const opaqueUiChanged = deriveEveAuthorityRevision({
      runtime: renderEveAuthorityRuntime({
        ...grant(4),
        opaqueUiAutoRun: true,
        opaqueUiAutoRunGrantedAt: '2026-08-18T00:00:00.000Z',
      }),
      seatId: 'seat-1',
      seatContextRevision: 7,
      authorityMutationEpoch: 3,
    });
    const sealChanged = deriveEveAuthorityRevision({
      runtime: renderEveAuthorityRuntime({ ...grant(4), capabilities: { 'delete.outside': true } }),
      seatId: 'seat-1',
      seatContextRevision: 7,
      authorityMutationEpoch: 3,
    });

    expect(opaqueUiChanged).not.toBe(base);
    expect(sealChanged).not.toBe(base);
  });

  it('changes with seat identity and seat context revision', () => {
    const runtime = renderEveAuthorityRuntime(grant(3));
    const base = deriveEveAuthorityRevision({
      runtime,
      seatId: 'seat-1',
      seatContextRevision: 7,
      authorityMutationEpoch: 3,
    });

    expect(
      deriveEveAuthorityRevision({ runtime, seatId: 'seat-2', seatContextRevision: 7, authorityMutationEpoch: 3 })
    ).not.toBe(base);
    expect(
      deriveEveAuthorityRevision({ runtime, seatId: 'seat-1', seatContextRevision: 8, authorityMutationEpoch: 3 })
    ).not.toBe(base);
  });

  it('does not resurrect a revoked and restored projection', () => {
    const initial = withSeal(grant(4), 'delete.outside', true, '2026-08-18T01:00:00.000Z');
    const revoked = withSeal(initial, 'delete.outside', false, '2026-08-18T02:00:00.000Z');
    const restored = withSeal(revoked, 'delete.outside', true, '2026-08-18T03:00:00.000Z');

    const fullProjection = renderEveAuthorityRuntime(initial);
    expect(renderEveAuthorityRuntime(restored)).toEqual(fullProjection);

    const derive = (value: EveAuthorityGrant) =>
      deriveEveAuthorityRevision({
        runtime: fullProjection,
        seatId: 'seat-1',
        seatContextRevision: 7,
        authorityMutationEpoch: value.revisionEpoch ?? 0,
      });

    expect(derive(initial)).not.toBe(derive(revoked));
    expect(derive(restored)).not.toBe(derive(initial));
    expect(derive(restored)).not.toBe(derive(revoked));
  });

  it('ignores an incoming diagnostic revision', () => {
    const runtime = renderEveAuthorityRuntime(grant(3));
    const input = { runtime, seatId: 'seat-1', seatContextRevision: 7, authorityMutationEpoch: 3 };
    expect(deriveEveAuthorityRevision({ ...input, runtime: { ...runtime, authority_revision: 'old' } })).toBe(
      deriveEveAuthorityRevision(input)
    );
  });
});
