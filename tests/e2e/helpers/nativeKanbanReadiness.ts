/**
 * Typed readiness oracle for the native Hermes Kanban Electron harness.
 *
 * This module deliberately owns no board state. It only validates the response
 * returned by the real `command-eve.native-kanban-board` provider and classifies
 * whether an isolated desktop profile is empty, partially provisioned, or warm.
 */

export const EXPECTED_NATIVE_KANBAN_STATUSES = [
  'triage',
  'todo',
  'scheduled',
  'ready',
  'running',
  'blocked',
  'review',
  'done',
] as const;

export const EXPECTED_NATIVE_KANBAN_VERSION = 'command-eve-native-kanban/v1';
export const EXPECTED_HERMES_VERSION = '0.20.0';
export const EXPECTED_HERMES_WHEEL_SHA256 = 'a91cd1edb383dbbab20d0af7d2b6c9d56183d3248a6ee56ae583b427dbd54bfd';

export type NativeKanbanBridgeResponse = {
  success?: boolean;
  msg?: string;
  data?: {
    version?: string;
    ok?: boolean;
    state?: string;
    reason_code?: string;
    message?: string;
    board?: {
      slug?: string;
      columns?: Array<{ name?: string }>;
    };
    source?: {
      adapter?: string;
      hermes_version?: string | null;
      board_slug?: string;
      home_scope_id?: string;
      seat_scope?: string;
    };
  };
};

export type NativeKanbanReadSummary = {
  success: boolean;
  ok: boolean;
  state: string | null;
  reason_code: string | null;
  message: string | null;
  version: string | null;
  adapter: string | null;
  hermes_version: string | null;
  board_slug: string | null;
  home_scope_id: string | null;
  seat_scope: string | null;
  columns: string[];
};

export type NativeKanbanReadEvaluation = {
  disposition: 'ready' | 'retry' | 'terminal';
  summary: NativeKanbanReadSummary;
};

export type NativeKanbanProfileEvidence = {
  bootstrapReceiptExists: boolean;
  bootstrapHermesStageStatus: string | null;
  wheelReceiptVersion: string | null;
  wheelReceiptPackageVersion: string | null;
  wheelReceiptSha256: string | null;
  kanbanDbBytes: number;
};

export type NativeKanbanProfileState = 'cold' | 'partial' | 'warm';

export function classifyNativeKanbanProfile(evidence: NativeKanbanProfileEvidence): NativeKanbanProfileState {
  const wheelReady =
    evidence.wheelReceiptVersion === 'command-eve-hermes-wheel-receipt/v2' &&
    evidence.wheelReceiptPackageVersion === EXPECTED_HERMES_VERSION &&
    evidence.wheelReceiptSha256 === EXPECTED_HERMES_WHEEL_SHA256;
  if (
    evidence.bootstrapReceiptExists &&
    evidence.bootstrapHermesStageStatus === 'pass' &&
    wheelReady &&
    evidence.kanbanDbBytes > 0
  )
    return 'warm';
  if (
    !evidence.bootstrapReceiptExists &&
    evidence.bootstrapHermesStageStatus === null &&
    evidence.wheelReceiptVersion === null &&
    evidence.wheelReceiptPackageVersion === null &&
    evidence.wheelReceiptSha256 === null &&
    evidence.kanbanDbBytes === 0
  ) {
    return 'cold';
  }
  return 'partial';
}

export function summarizeNativeKanbanRead(response: NativeKanbanBridgeResponse): NativeKanbanReadSummary {
  const data = response.data;
  return {
    success: response.success === true,
    ok: data?.ok === true,
    state: typeof data?.state === 'string' ? data.state : null,
    reason_code:
      typeof data?.reason_code === 'string' ? data.reason_code : typeof response.msg === 'string' ? response.msg : null,
    message: typeof data?.message === 'string' ? data.message : null,
    version: typeof data?.version === 'string' ? data.version : null,
    adapter: typeof data?.source?.adapter === 'string' ? data.source.adapter : null,
    hermes_version: typeof data?.source?.hermes_version === 'string' ? data.source.hermes_version : null,
    board_slug:
      typeof data?.board?.slug === 'string'
        ? data.board.slug
        : typeof data?.source?.board_slug === 'string'
          ? data.source.board_slug
          : null,
    home_scope_id: typeof data?.source?.home_scope_id === 'string' ? data.source.home_scope_id : null,
    seat_scope: typeof data?.source?.seat_scope === 'string' ? data.source.seat_scope : null,
    columns: Array.isArray(data?.board?.columns)
      ? data.board.columns.map((column) => (typeof column.name === 'string' ? column.name : ''))
      : [],
  };
}

export function evaluateNativeKanbanRead(
  response: NativeKanbanBridgeResponse,
  profile: NativeKanbanProfileState
): NativeKanbanReadEvaluation {
  const summary = summarizeNativeKanbanRead(response);
  const ready =
    summary.success &&
    summary.ok &&
    summary.state === 'ready' &&
    summary.version === EXPECTED_NATIVE_KANBAN_VERSION &&
    summary.adapter === 'hermes-plugin-api' &&
    summary.hermes_version === EXPECTED_HERMES_VERSION &&
    summary.board_slug === 'default' &&
    summary.seat_scope === 'active-hermes-home' &&
    summary.home_scope_id !== null &&
    JSON.stringify(summary.columns) === JSON.stringify(EXPECTED_NATIVE_KANBAN_STATUSES);
  if (ready) return { disposition: 'ready', summary };

  const coldProvisioning =
    profile !== 'warm' &&
    (summary.reason_code === 'HERMES_RUNTIME_NOT_READY' || summary.reason_code === 'HERMES_KANBAN_ADAPTER_UNAVAILABLE');
  return { disposition: coldProvisioning ? 'retry' : 'terminal', summary };
}
