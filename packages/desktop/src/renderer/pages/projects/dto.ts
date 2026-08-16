import {
  PROJECT_WORKSPACE_REASON_CODES,
  type ProjectPlacementDTO,
  type ProjectSummaryDTO,
  type ProjectWorkspaceAction,
  type ProjectWorkspaceAssignmentChoice,
  type ProjectWorkspaceAssignmentPreviewDTO,
  type ProjectWorkspaceAssignmentPreviewResult,
  type ProjectWorkspaceAssignmentReceiptDTO,
  type ProjectWorkspaceArtifactDTO,
  type ProjectWorkspaceConversationArtifactDTO,
  type ProjectWorkspaceArtifactState,
  type ProjectWorkspaceI18nRef,
  type ProjectWorkspaceListDTO,
  type ProjectWorkspaceReasonCode,
  type ProjectWorkspaceReceiptDTO,
} from './types';

const SENSITIVE_KEY =
  /(?:^|_)(?:absolute_?path|canonical_?path|file_?path|ticket|capability|owner_?token|lease|journal|environment_?hint|attestation|compact_?jws|secret|password|token)(?:$|_)/i;
const ABSOLUTE_PATH_VALUE = /^(?:file:\/\/|~(?:\/|\\)|\/|[a-z]:[\\/]|\\\\)/i;
const EMBEDDED_HOME_PATH_VALUE = /(?:^|\s)(?:\/Users\/|\/home\/|[a-z]:\\Users\\|\\\\[^\s\\]+\\[^\s\\]+)/i;
const ACTIONS: ProjectWorkspaceAction[] = ['edit', 'archive', 'restore', 'reveal', 'recover', 'undo', 'bind', 'unbind'];
const ARTIFACT_STATES: ProjectWorkspaceArtifactState[] = [
  'preview',
  'awaiting_confirmation',
  'committing',
  'completed',
  'rejected',
  'recovery_required',
];

export class UnsafeProjectWorkspaceDTOError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeProjectWorkspaceDTOError';
  }
}

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UnsafeProjectWorkspaceDTOError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
};

const exactKeys = (value: Record<string, unknown>, allowed: readonly string[], label: string): void => {
  for (const key of Object.keys(value)) {
    if (SENSITIVE_KEY.test(key)) throw new UnsafeProjectWorkspaceDTOError(`${label} contains a sensitive field`);
    if (!allowed.includes(key)) throw new UnsafeProjectWorkspaceDTOError(`${label} contains an unknown field`);
  }
};

const stringValue = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 240) {
    throw new UnsafeProjectWorkspaceDTOError(`${label} must be a bounded string`);
  }
  const trimmed = value.trim();
  if (ABSOLUTE_PATH_VALUE.test(trimmed) || EMBEDDED_HOME_PATH_VALUE.test(trimmed) || trimmed.includes('\0')) {
    throw new UnsafeProjectWorkspaceDTOError(`${label} contains a local path`);
  }
  return trimmed;
};

const numberValue = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new UnsafeProjectWorkspaceDTOError(`${label} must be a non-negative integer`);
  }
  return value;
};

const enumValue = <T extends string>(value: unknown, allowed: readonly T[], label: string): T => {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new UnsafeProjectWorkspaceDTOError(`${label} is invalid`);
  }
  return value as T;
};

const strings = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value) || value.length > 32) throw new UnsafeProjectWorkspaceDTOError(`${label} is invalid`);
  return value.map((item, index) => stringValue(item, `${label}[${index}]`));
};

const actions = (value: unknown, label: string): ProjectWorkspaceAction[] => {
  if (!Array.isArray(value) || value.length > ACTIONS.length) {
    throw new UnsafeProjectWorkspaceDTOError(`${label} is invalid`);
  }
  return value.map((item) => enumValue(item, ACTIONS, label));
};

const optionalReason = (value: unknown): ProjectWorkspaceReasonCode | undefined =>
  value === undefined ? undefined : enumValue(value, PROJECT_WORKSPACE_REASON_CODES, 'reason_code');

const assignmentChoice = (value: unknown): ProjectWorkspaceAssignmentChoice => {
  const source = record(value, 'assignment choice');
  if (source.kind === 'keep') {
    exactKeys(source, ['kind', 'title'], 'assignment choice');
    if (source.title === undefined) return { kind: 'keep' };
    const title = stringValue(source.title, 'assignment choice title');
    if (title.length > 120) throw new UnsafeProjectWorkspaceDTOError('assignment choice title is too long');
    return { kind: 'keep', title };
  }
  if (source.kind === 'temporary') {
    exactKeys(source, ['kind'], 'assignment choice');
    return { kind: 'temporary' };
  }
  exactKeys(source, ['kind', 'project_id', 'expected_project_revision'], 'assignment choice');
  return {
    kind: enumValue(source.kind, ['project'], 'assignment choice kind'),
    project_id: stringValue(source.project_id, 'assignment project_id'),
    expected_project_revision: numberValue(source.expected_project_revision, 'expected_project_revision'),
  };
};

/**
 * Validate a main-process i18n reference (1.818 CAO-P2). Bounded like every
 * other display string: param keys must not be sensitive, param values go
 * through the same path/overlong fences as free text, arrays stay small.
 */
const i18nRefValue = (value: unknown, label: string): ProjectWorkspaceI18nRef => {
  const source = record(value, label);
  exactKeys(source, ['key', 'params'], label);
  const key = stringValue(source.key, `${label}.key`);
  if (source.params === undefined) return { key };
  const paramsSource = record(source.params, `${label}.params`);
  const params: Record<string, string | string[]> = {};
  for (const [paramKey, paramValue] of Object.entries(paramsSource)) {
    if (SENSITIVE_KEY.test(paramKey)) {
      throw new UnsafeProjectWorkspaceDTOError(`${label}.params contains a sensitive field`);
    }
    if (Array.isArray(paramValue)) {
      if (paramValue.length > 32) throw new UnsafeProjectWorkspaceDTOError(`${label}.params.${paramKey} is invalid`);
      params[paramKey] = paramValue.map((item, index) => stringValue(item, `${label}.params.${paramKey}[${index}]`));
    } else {
      params[paramKey] = stringValue(paramValue, `${label}.params.${paramKey}`);
    }
  }
  return { key, params };
};

const placement = (value: unknown): ProjectPlacementDTO => {
  const source = record(value, 'placement');
  exactKeys(
    source,
    ['placement_id', 'realm_kind', 'realm_label', 'root_label', 'writable', 'disabled_reason'],
    'placement'
  );
  if (typeof source.writable !== 'boolean') throw new UnsafeProjectWorkspaceDTOError('placement.writable is invalid');
  return {
    placement_id: stringValue(source.placement_id, 'placement_id'),
    realm_kind: enumValue(source.realm_kind, ['private', 'business', 'custom'], 'realm_kind'),
    realm_label: stringValue(source.realm_label, 'realm_label'),
    root_label: stringValue(source.root_label, 'root_label'),
    writable: source.writable,
    disabled_reason: optionalReason(source.disabled_reason),
  };
};

export const parseProjectSummaryDTO = (value: unknown): ProjectSummaryDTO => {
  const source = record(value, 'project');
  exactKeys(
    source,
    [
      'project_id',
      'title',
      'realm_kind',
      'realm_label',
      'root_label',
      'status',
      'last_safe_update',
      'conversation_count',
      'recovery_state',
      'revision',
      'allowed_actions',
    ],
    'project'
  );
  return {
    project_id: stringValue(source.project_id, 'project_id'),
    title: stringValue(source.title, 'title'),
    realm_kind: enumValue(source.realm_kind, ['private', 'business', 'custom'], 'realm_kind'),
    realm_label: stringValue(source.realm_label, 'realm_label'),
    root_label: stringValue(source.root_label, 'root_label'),
    status: enumValue(source.status, ['active', 'archived', 'locked', 'recovery_required'], 'status'),
    last_safe_update: numberValue(source.last_safe_update, 'last_safe_update'),
    conversation_count: numberValue(source.conversation_count, 'conversation_count'),
    recovery_state: enumValue(source.recovery_state, ['none', 'available', 'required'], 'recovery_state'),
    revision: numberValue(source.revision, 'revision'),
    allowed_actions: actions(source.allowed_actions, 'allowed_actions'),
  };
};

export const parseProjectWorkspaceListDTO = (value: unknown): ProjectWorkspaceListDTO => {
  const source = record(value, 'project list');
  exactKeys(
    source,
    [
      'seat_label',
      'seat_context_revision',
      'catalog_revision',
      'automatic_creation_enabled',
      'placements',
      'projects',
      'notice_reason',
    ],
    'project list'
  );
  if (typeof source.automatic_creation_enabled !== 'boolean') {
    throw new UnsafeProjectWorkspaceDTOError('automatic_creation_enabled is invalid');
  }
  if (!Array.isArray(source.placements) || !Array.isArray(source.projects)) {
    throw new UnsafeProjectWorkspaceDTOError('project list collections are invalid');
  }
  return {
    seat_label: stringValue(source.seat_label, 'seat_label'),
    seat_context_revision: numberValue(source.seat_context_revision, 'seat_context_revision'),
    catalog_revision: numberValue(source.catalog_revision, 'catalog_revision'),
    automatic_creation_enabled: source.automatic_creation_enabled,
    placements: source.placements.map(placement),
    projects: source.projects.map(parseProjectSummaryDTO),
    notice_reason: optionalReason(source.notice_reason),
  };
};

export const parseProjectWorkspacePreviewDTO = (value: unknown) => {
  const source = record(value, 'project preview');
  exactKeys(
    source,
    [
      'preview_id',
      'preview_revision',
      'destination_label',
      'project_title',
      'scaffold_summary',
      'semantic_writes',
      'conversation_effect',
      'warnings',
      'expires_at',
    ],
    'project preview'
  );
  if (!Array.isArray(source.warnings)) throw new UnsafeProjectWorkspaceDTOError('warnings is invalid');
  return {
    preview_id: stringValue(source.preview_id, 'preview_id'),
    preview_revision: numberValue(source.preview_revision, 'preview_revision'),
    destination_label: stringValue(source.destination_label, 'destination_label'),
    project_title: stringValue(source.project_title, 'project_title'),
    scaffold_summary: strings(source.scaffold_summary, 'scaffold_summary'),
    semantic_writes: strings(source.semantic_writes, 'semantic_writes'),
    conversation_effect: stringValue(source.conversation_effect, 'conversation_effect'),
    warnings: source.warnings.map((warning) => enumValue(warning, PROJECT_WORKSPACE_REASON_CODES, 'warnings')),
    expires_at: numberValue(source.expires_at, 'expires_at'),
  };
};

export const parseProjectWorkspaceVoidResponse = (value: unknown): void => {
  if (value !== undefined && value !== null) {
    throw new UnsafeProjectWorkspaceDTOError('void response contains unexpected data');
  }
};

export const parseProjectWorkspaceArtifactDTO = (value: unknown): ProjectWorkspaceArtifactDTO => {
  const decoded = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  const source = record(decoded, 'project workspace artifact');
  exactKeys(
    source,
    [
      'artifact_id',
      'state',
      'project_id',
      'intent_summary',
      'intent_summary_i18n',
      'target_label',
      'project_title',
      'delta_summary',
      'question',
      'question_i18n',
      'assignment_finalized_at',
      'reason_code',
      'receipt',
      'safe_follow_ups',
    ],
    'project workspace artifact'
  );
  const receiptSource = source.receipt === undefined ? undefined : record(source.receipt, 'receipt');
  if (receiptSource) exactKeys(receiptSource, ['receipt_id', 'outcome', 'completed_at'], 'receipt');
  const receipt: ProjectWorkspaceArtifactDTO['receipt'] = receiptSource
    ? {
        receipt_id: stringValue(receiptSource.receipt_id, 'receipt_id'),
        outcome: enumValue(receiptSource.outcome, ['completed', 'rejected', 'recovery_required'], 'receipt.outcome'),
        completed_at: numberValue(receiptSource.completed_at, 'receipt.completed_at'),
      }
    : undefined;
  return {
    artifact_id: stringValue(source.artifact_id, 'artifact_id'),
    state: enumValue(source.state, ARTIFACT_STATES, 'state'),
    project_id: source.project_id === undefined ? undefined : stringValue(source.project_id, 'project_id'),
    intent_summary: stringValue(source.intent_summary, 'intent_summary'),
    intent_summary_i18n:
      source.intent_summary_i18n === undefined
        ? undefined
        : i18nRefValue(source.intent_summary_i18n, 'intent_summary_i18n'),
    target_label: stringValue(source.target_label, 'target_label'),
    project_title: stringValue(source.project_title, 'project_title'),
    delta_summary: strings(source.delta_summary, 'delta_summary'),
    question: source.question === undefined ? undefined : stringValue(source.question, 'question'),
    question_i18n: source.question_i18n === undefined ? undefined : i18nRefValue(source.question_i18n, 'question_i18n'),
    assignment_finalized_at:
      source.assignment_finalized_at === undefined
        ? undefined
        : numberValue(source.assignment_finalized_at, 'assignment_finalized_at'),
    reason_code: optionalReason(source.reason_code),
    receipt,
    safe_follow_ups: actions(source.safe_follow_ups, 'safe_follow_ups'),
  };
};

export const parseProjectWorkspaceConversationArtifactDTO = (
  value: unknown
): ProjectWorkspaceConversationArtifactDTO => {
  const source = record(value, 'project workspace conversation artifact');
  exactKeys(
    source,
    ['id', 'conversation_id', 'kind', 'status', 'payload', 'created_at', 'updated_at'],
    'project workspace conversation artifact'
  );
  return {
    id: stringValue(source.id, 'id'),
    conversation_id: stringValue(source.conversation_id, 'conversation_id'),
    kind: enumValue(source.kind, ['project_workspace'], 'kind'),
    status: enumValue(source.status, ['active'], 'status'),
    payload: parseProjectWorkspaceArtifactDTO(source.payload),
    created_at: numberValue(source.created_at, 'created_at'),
    updated_at: numberValue(source.updated_at, 'updated_at'),
  };
};

export const parseProjectWorkspaceReceiptDTO = (value: unknown): ProjectWorkspaceReceiptDTO => {
  const source = record(value, 'receipt');
  exactKeys(source, ['receipt_id', 'outcome', 'completed_at', 'project', 'reason_code', 'safe_follow_ups'], 'receipt');
  return {
    receipt_id: stringValue(source.receipt_id, 'receipt_id'),
    outcome: enumValue(source.outcome, ['completed', 'rejected', 'recovery_required'], 'outcome'),
    completed_at: numberValue(source.completed_at, 'completed_at'),
    project: source.project === undefined ? undefined : parseProjectSummaryDTO(source.project),
    reason_code: optionalReason(source.reason_code),
    safe_follow_ups: actions(source.safe_follow_ups, 'safe_follow_ups'),
  };
};

export const parseProjectWorkspaceAssignmentPreviewDTO = (value: unknown): ProjectWorkspaceAssignmentPreviewDTO => {
  const source = record(value, 'assignment preview');
  exactKeys(
    source,
    [
      'preview_id',
      'preview_revision',
      'conversation_id',
      'artifact_id',
      'artifact_updated_at',
      'catalog_revision',
      'binding_revision',
      'choice',
      'current_project',
      'target_project',
      'will_change',
      'expires_at',
    ],
    'assignment preview'
  );
  if (typeof source.will_change !== 'boolean') {
    throw new UnsafeProjectWorkspaceDTOError('assignment preview will_change is invalid');
  }
  return {
    preview_id: stringValue(source.preview_id, 'assignment preview_id'),
    preview_revision: numberValue(source.preview_revision, 'assignment preview_revision'),
    conversation_id: stringValue(source.conversation_id, 'assignment conversation_id'),
    artifact_id: stringValue(source.artifact_id, 'assignment artifact_id'),
    artifact_updated_at: numberValue(source.artifact_updated_at, 'assignment artifact_updated_at'),
    catalog_revision: numberValue(source.catalog_revision, 'assignment catalog_revision'),
    binding_revision: numberValue(source.binding_revision, 'assignment binding_revision'),
    choice: assignmentChoice(source.choice),
    current_project: source.current_project === undefined ? undefined : parseProjectSummaryDTO(source.current_project),
    target_project: source.target_project === undefined ? undefined : parseProjectSummaryDTO(source.target_project),
    will_change: source.will_change,
    expires_at: numberValue(source.expires_at, 'assignment expires_at'),
  };
};

export const parseProjectWorkspaceAssignmentPreviewResult = (
  value: unknown
): ProjectWorkspaceAssignmentPreviewResult => {
  const source = record(value, 'assignment preview result');
  if (source.ok === true) {
    exactKeys(source, ['ok', 'preview'], 'assignment preview result');
    return { ok: true, preview: parseProjectWorkspaceAssignmentPreviewDTO(source.preview) };
  }
  exactKeys(source, ['ok', 'reason_code'], 'assignment preview result');
  if (source.ok !== false) throw new UnsafeProjectWorkspaceDTOError('assignment preview result ok is invalid');
  return {
    ok: false,
    reason_code: enumValue(source.reason_code, PROJECT_WORKSPACE_REASON_CODES, 'reason_code'),
  };
};

export const parseProjectWorkspaceAssignmentReceiptDTO = (value: unknown): ProjectWorkspaceAssignmentReceiptDTO => {
  const source = record(value, 'assignment receipt');
  exactKeys(
    source,
    ['receipt_id', 'outcome', 'completed_at', 'assignment', 'project', 'artifact', 'reason_code', 'safe_follow_ups'],
    'assignment receipt'
  );
  return {
    receipt_id: stringValue(source.receipt_id, 'assignment receipt_id'),
    outcome: enumValue(source.outcome, ['completed', 'rejected'], 'assignment outcome'),
    completed_at: numberValue(source.completed_at, 'assignment completed_at'),
    assignment: enumValue(source.assignment, ['keep', 'project', 'temporary'], 'assignment'),
    project: source.project === undefined ? undefined : parseProjectSummaryDTO(source.project),
    artifact: source.artifact === undefined ? undefined : parseProjectWorkspaceConversationArtifactDTO(source.artifact),
    reason_code: optionalReason(source.reason_code),
    safe_follow_ups: actions(source.safe_follow_ups, 'safe_follow_ups'),
  };
};
