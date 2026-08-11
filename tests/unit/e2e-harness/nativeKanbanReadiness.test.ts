import {
  EXPECTED_HERMES_VERSION,
  EXPECTED_HERMES_WHEEL_SHA256,
  EXPECTED_NATIVE_KANBAN_STATUSES,
  classifyNativeKanbanProfile,
  evaluateNativeKanbanRead,
} from '../../e2e/helpers/nativeKanbanReadiness';
import { describe, expect, it } from 'vitest';

const coldProfile = {
  bootstrapReceiptExists: false,
  bootstrapHermesStageStatus: null,
  wheelReceiptVersion: null,
  wheelReceiptPackageVersion: null,
  wheelReceiptSha256: null,
  kanbanDbBytes: 0,
};

const warmProfile = {
  bootstrapReceiptExists: true,
  bootstrapHermesStageStatus: 'pass',
  wheelReceiptVersion: 'command-eve-hermes-wheel-receipt/v2',
  wheelReceiptPackageVersion: EXPECTED_HERMES_VERSION,
  wheelReceiptSha256: EXPECTED_HERMES_WHEEL_SHA256,
  kanbanDbBytes: 49_152,
};

describe('native Kanban Electron readiness oracle', () => {
  it('treats an empty profile plus the typed runtime-not-ready response as bounded cold provisioning', () => {
    expect(classifyNativeKanbanProfile(coldProfile)).toBe('cold');
    expect(
      evaluateNativeKanbanRead(
        {
          success: false,
          msg: 'HERMES_RUNTIME_NOT_READY',
          data: {
            version: 'command-eve-native-kanban/v1',
            ok: false,
            state: 'needs_user',
            reason_code: 'HERMES_RUNTIME_NOT_READY',
          },
        },
        'cold'
      )
    ).toMatchObject({ disposition: 'retry', summary: { columns: [], reason_code: 'HERMES_RUNTIME_NOT_READY' } });
  });

  it('accepts a warm profile only with the exact native Hermes contract and eight ordered columns', () => {
    expect(classifyNativeKanbanProfile(warmProfile)).toBe('warm');
    expect(
      evaluateNativeKanbanRead(
        {
          success: true,
          data: {
            version: 'command-eve-native-kanban/v1',
            ok: true,
            state: 'ready',
            board: {
              slug: 'default',
              columns: EXPECTED_NATIVE_KANBAN_STATUSES.map((name) => ({ name })),
            },
            source: {
              adapter: 'hermes-plugin-api',
              hermes_version: EXPECTED_HERMES_VERSION,
              board_slug: 'default',
              home_scope_id: 'seat-home-proof',
              seat_scope: 'active-hermes-home',
            },
          },
        },
        'warm'
      )
    ).toMatchObject({
      disposition: 'ready',
      summary: { columns: EXPECTED_NATIVE_KANBAN_STATUSES, home_scope_id: 'seat-home-proof' },
    });
  });

  it('does not call wheel and DB artifacts warm without a parsed Hermes-pass bootstrap receipt', () => {
    expect(
      classifyNativeKanbanProfile({
        ...warmProfile,
        bootstrapReceiptExists: false,
        bootstrapHermesStageStatus: null,
      })
    ).toBe('partial');
  });

  it('fails closed on a warm profile whose real board response loses a canonical column', () => {
    expect(
      evaluateNativeKanbanRead(
        {
          success: true,
          data: {
            version: 'command-eve-native-kanban/v1',
            ok: true,
            state: 'ready',
            board: {
              slug: 'default',
              columns: EXPECTED_NATIVE_KANBAN_STATUSES.slice(0, -1).map((name) => ({ name })),
            },
            source: {
              adapter: 'hermes-plugin-api',
              hermes_version: EXPECTED_HERMES_VERSION,
              board_slug: 'default',
              home_scope_id: 'seat-home-proof',
              seat_scope: 'active-hermes-home',
            },
          },
        },
        'warm'
      ).disposition
    ).toBe('terminal');
  });

  it('fails closed instead of reprovisioning when a previously warm profile loses its runtime', () => {
    expect(
      evaluateNativeKanbanRead(
        {
          success: false,
          msg: 'HERMES_RUNTIME_NOT_READY',
          data: {
            version: 'command-eve-native-kanban/v1',
            ok: false,
            state: 'needs_user',
            reason_code: 'HERMES_RUNTIME_NOT_READY',
          },
        },
        'warm'
      ).disposition
    ).toBe('terminal');
  });
});
