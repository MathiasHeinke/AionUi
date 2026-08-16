import { uuid } from '@/common/utils';
import { useAddEventListener } from '@/renderer/utils/emitter';
import { Message } from '@arco-design/web-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { COMMAND_EVE_PREPARED_CONTEXT_MAX_CHARS } from '@/common/config/evePreparedContextCore';
import { extractCommandEveManagedVisualTurnToken } from '@/common/config/eveManagedVisualTurnCore';
import {
  normalizeCommandEveAttachmentGroundingRequest,
  type CommandEveAttachmentGroundingRequest,
} from '@/common/config/eveAttachmentGroundingCore';
import { configService } from '@/common/config/configService';
import {
  consumeComposerWorkProductSelection,
  selectExplicitComposerWorkProductMode,
  type ComposerWorkProductSelection,
} from '@/common/config/composerWorkProductModeCore';
import {
  captureConversationRuntimeSeatTicket,
  isConversationRuntimeSeatTicketCurrent,
  type ConversationRuntimeSeatTicket,
} from '@/renderer/pages/conversation/runtime/conversationRuntimeViewStore';

export type ConversationCommandQueueItem = {
  id: string;
  conversationId: string;
  input: string;
  /** Files shown back to the user. Internal agent sidecars stay in `files`. */
  displayFiles?: string[];
  /** Private, bounded document evidence injected only into the agent prompt. */
  preparedContext?: string;
  /** Non-authoritative hint; Main reissues and validates visual authority at execution time. */
  managedVisualSourceCount?: number;
  /** Exact source/sidecar hashes that AionCore must receipt before send. */
  attachmentGrounding?: CommandEveAttachmentGroundingRequest;
  /** Explicit, one-shot composer authority retained when a turn is queued. */
  composerSelection?: ComposerWorkProductSelection;
  /** Exact pathless artifact target; valid only with a referenced selection. */
  selectedArtifactId?: string;
  files: string[];
  /** Seat-generation authority captured before any async preparation. */
  seatId: string;
  created_at: number;
};

export type ConversationCommandDispatchResult = 'accepted' | 'rejected' | 'stale';

export type ConversationCommandQueueState = {
  items: ConversationCommandQueueItem[];
  isPaused: boolean;
};

export const MAX_QUEUED_COMMANDS = 20;
export const MAX_QUEUED_COMMAND_INPUT_LENGTH = 20_000;
export const MAX_QUEUED_COMMAND_FILES = 50;
export const MAX_QUEUED_COMMAND_STATE_BYTES = 256 * 1024;

export type QueueValidationFailureReason =
  | 'emptyInput'
  | 'inputTooLong'
  | 'tooManyFiles'
  | 'queueFull'
  | 'queueTooLarge';

type QueueValidationSuccess = {
  ok: true;
  nextStateBytes: number;
};

type QueueValidationFailure = {
  ok: false;
  reason: QueueValidationFailureReason;
};

const COMMAND_QUEUE_LOG_PREFIX = '[conversation-command-queue]';

const summarizeQueuedCommand = (item: ConversationCommandQueueItem): Record<string, unknown> => ({
  id: item.id,
  conversationId: item.conversationId,
  created_at: item.created_at,
  inputLength: item.input.length,
  fileCount: item.files.length,
  displayFileCount: (item.displayFiles ?? item.files).length,
  preparedContextLength: item.preparedContext?.length ?? 0,
  managedVisualSourceCount: item.managedVisualSourceCount ?? 0,
  attachmentGroundingEntries: item.attachmentGrounding?.entries.length ?? 0,
  seatId: item.seatId,
  composerMode: item.composerSelection?.mode ?? 'chat',
  hasSelectedArtifact: item.selectedArtifactId !== undefined,
  preview: item.input.replace(/\s+/g, ' ').trim().slice(0, 120),
});

const logCommandQueue = (conversation_id: string, event: string, payload: Record<string, unknown> = {}): void => {
  console.info(COMMAND_QUEUE_LOG_PREFIX, {
    conversation_id,
    event,
    ...payload,
  });
};

const createDefaultQueueState = (): ConversationCommandQueueState => ({
  items: [],
  isPaused: false,
});

const queueStore = new Map<string, ConversationCommandQueueState>();

const getQueueStoreKey = (seatId: string, conversation_id: string): string => `${seatId}\u0000${conversation_id}`;
const getStorageKey = (seatId: string, conversation_id: string): string =>
  `conversation-command-queue/${seatId}/${conversation_id}`;
const measureQueueStateBytes = (state: ConversationCommandQueueState): number =>
  new TextEncoder().encode(JSON.stringify(state)).length;

const uniqueFiles = (files: string[]): string[] => Array.from(new Set(files.filter(Boolean)));
const isInputEmpty = (input: string): boolean => input.trim().length === 0;
const isGeneratedPdfSidecar = (filePath: string): boolean => {
  const normalizedPath = filePath.replaceAll('\\', '/').toLowerCase();
  return normalizedPath.includes('/document-intelligence/pdf/') && normalizedPath.endsWith('/document.md');
};

const deriveLegacyDisplayFiles = (files: string[]): string[] => {
  if (!files.some((filePath) => filePath.toLowerCase().endsWith('.pdf'))) {
    return files;
  }
  return files.filter((filePath) => !isGeneratedPdfSidecar(filePath));
};

const SAFE_QUEUED_ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;

const normalizeQueuedComposerSelection = (
  selection: unknown,
  artifactId: unknown
): Pick<ConversationCommandQueueItem, 'composerSelection' | 'selectedArtifactId'> | null => {
  if (selection === undefined && artifactId === undefined) return {};
  const consumed = consumeComposerWorkProductSelection(selection);
  if (!consumed.request) return null;
  const hasReference = consumed.request.hasSelectedReference;
  if (hasReference !== (typeof artifactId === 'string' && SAFE_QUEUED_ARTIFACT_ID.test(artifactId))) return null;
  return {
    composerSelection: selectExplicitComposerWorkProductMode(
      consumed.request.mode,
      hasReference ? { selected: true, kind: consumed.request.selectedReferenceKind } : undefined,
      consumed.request.imageOptions
    ),
    ...(hasReference ? { selectedArtifactId: artifactId as string } : {}),
  };
};

const normalizeQueueItem = (item: unknown): ConversationCommandQueueItem | null => {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const candidate = item as Record<string, unknown>;
  const candidateDisplayFiles = candidate.displayFiles;
  const candidatePreparedContext = candidate.preparedContext;
  const candidateManagedVisualSourceCount = candidate.managedVisualSourceCount;
  const candidateAttachmentGrounding = candidate.attachmentGrounding;
  const attachmentGrounding =
    candidateAttachmentGrounding === undefined
      ? undefined
      : normalizeCommandEveAttachmentGroundingRequest(candidateAttachmentGrounding);
  const queuedComposer = normalizeQueuedComposerSelection(candidate.composerSelection, candidate.selectedArtifactId);
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.conversationId !== 'string' ||
    !candidate.conversationId ||
    typeof candidate.input !== 'string' ||
    !Array.isArray(candidate.files) ||
    !candidate.files.every((file) => typeof file === 'string') ||
    (candidateDisplayFiles !== undefined &&
      (!Array.isArray(candidateDisplayFiles) || !candidateDisplayFiles.every((file) => typeof file === 'string'))) ||
    (candidatePreparedContext !== undefined &&
      (typeof candidatePreparedContext !== 'string' ||
        extractCommandEveManagedVisualTurnToken(candidatePreparedContext) !== undefined)) ||
    (candidateManagedVisualSourceCount !== undefined &&
      (typeof candidateManagedVisualSourceCount !== 'number' ||
        !Number.isInteger(candidateManagedVisualSourceCount) ||
        candidateManagedVisualSourceCount < 1 ||
        candidateManagedVisualSourceCount > 6 ||
        typeof candidatePreparedContext !== 'string' ||
        !candidatePreparedContext.trim())) ||
    (candidateAttachmentGrounding !== undefined && attachmentGrounding === undefined) ||
    typeof candidate.seatId !== 'string' ||
    !candidate.seatId ||
    queuedComposer === null ||
    typeof candidate.created_at !== 'number' ||
    !Number.isFinite(candidate.created_at)
  ) {
    return null;
  }

  const files = uniqueFiles(candidate.files);
  const normalizedItem: ConversationCommandQueueItem = {
    id: candidate.id,
    conversationId: candidate.conversationId,
    input: candidate.input,
    files,
    displayFiles: Array.isArray(candidateDisplayFiles)
      ? uniqueFiles(candidateDisplayFiles)
      : deriveLegacyDisplayFiles(files),
    ...(typeof candidatePreparedContext === 'string' && candidatePreparedContext.trim()
      ? { preparedContext: candidatePreparedContext }
      : {}),
    ...(typeof candidateManagedVisualSourceCount === 'number'
      ? { managedVisualSourceCount: candidateManagedVisualSourceCount }
      : {}),
    ...(attachmentGrounding ? { attachmentGrounding } : {}),
    seatId: candidate.seatId,
    ...queuedComposer,
    created_at: candidate.created_at,
  };

  if (
    isInputEmpty(normalizedItem.input) ||
    normalizedItem.input.length > MAX_QUEUED_COMMAND_INPUT_LENGTH ||
    normalizedItem.files.length > MAX_QUEUED_COMMAND_FILES ||
    (normalizedItem.displayFiles?.length ?? 0) > MAX_QUEUED_COMMAND_FILES ||
    (normalizedItem.preparedContext?.length ?? 0) > COMMAND_EVE_PREPARED_CONTEXT_MAX_CHARS
  ) {
    return null;
  }

  return normalizedItem;
};

export const normalizeQueueState = (state: unknown): ConversationCommandQueueState => {
  if (!state || typeof state !== 'object') {
    return createDefaultQueueState();
  }

  const candidate = state as Partial<ConversationCommandQueueState>;
  const normalizedItems = Array.isArray(candidate.items)
    ? candidate.items.map(normalizeQueueItem).filter((item): item is ConversationCommandQueueItem => item !== null)
    : [];
  const items: ConversationCommandQueueItem[] = [];

  for (const item of normalizedItems.slice(0, MAX_QUEUED_COMMANDS)) {
    const nextItems = [...items, item];
    const nextState = {
      items: nextItems,
      isPaused: Boolean(candidate.isPaused),
    };

    if (measureQueueStateBytes(nextState) > MAX_QUEUED_COMMAND_STATE_BYTES) {
      break;
    }

    items.push(item);
  }

  return {
    items,
    isPaused: items.length > 0 ? Boolean(candidate.isPaused) : false,
  };
};

export const estimateQueueStateBytes = (state: ConversationCommandQueueState): number =>
  measureQueueStateBytes(normalizeQueueState(state));

export const createQueuedCommandItem = ({
  input,
  files,
  displayFiles,
  preparedContext,
  managedVisualSourceCount,
  attachmentGrounding,
  composerSelection,
  selectedArtifactId,
  seatTicket,
}: Pick<
  ConversationCommandQueueItem,
  | 'input'
  | 'files'
  | 'displayFiles'
  | 'preparedContext'
  | 'managedVisualSourceCount'
  | 'attachmentGrounding'
  | 'composerSelection'
  | 'selectedArtifactId'
> & { seatTicket: ConversationRuntimeSeatTicket }): ConversationCommandQueueItem => ({
  id: uuid(),
  conversationId: seatTicket.conversationId,
  input,
  files: uniqueFiles(files),
  ...(displayFiles ? { displayFiles: uniqueFiles(displayFiles) } : {}),
  ...(preparedContext?.trim() ? { preparedContext } : {}),
  ...(managedVisualSourceCount ? { managedVisualSourceCount } : {}),
  ...(attachmentGrounding ? { attachmentGrounding } : {}),
  seatId: seatTicket.seatId,
  ...(composerSelection ? { composerSelection } : {}),
  ...(selectedArtifactId ? { selectedArtifactId } : {}),
  created_at: Date.now(),
});

export const isQueuedCommandCurrent = (item: ConversationCommandQueueItem, conversationId?: string): boolean =>
  item.conversationId.length > 0 &&
  (conversationId === undefined || item.conversationId === conversationId) &&
  item.seatId === configService.getCurrentSeatId();

const filterQueueStateForCurrentSeat = (
  state: ConversationCommandQueueState,
  conversationId?: string
): ConversationCommandQueueState => {
  const items = state.items.filter((item) => isQueuedCommandCurrent(item, conversationId));
  return {
    items,
    isPaused: items.length > 0 ? state.isPaused : false,
  };
};

const getQueueValidationFailureReason = (state: ConversationCommandQueueState): QueueValidationFailureReason | null => {
  if (state.items.length > MAX_QUEUED_COMMANDS) {
    return 'queueFull';
  }

  if (state.items.some((item) => isInputEmpty(item.input))) {
    return 'emptyInput';
  }

  if (state.items.some((item) => item.input.length > MAX_QUEUED_COMMAND_INPUT_LENGTH)) {
    return 'inputTooLong';
  }

  if (
    state.items.some(
      (item) =>
        (item.preparedContext?.length ?? 0) > COMMAND_EVE_PREPARED_CONTEXT_MAX_CHARS ||
        extractCommandEveManagedVisualTurnToken(item.preparedContext) !== undefined
    )
  ) {
    return 'queueTooLarge';
  }

  if (
    state.items.some(
      (item) =>
        item.files.length > MAX_QUEUED_COMMAND_FILES || (item.displayFiles?.length ?? 0) > MAX_QUEUED_COMMAND_FILES
    )
  ) {
    return 'tooManyFiles';
  }

  if (measureQueueStateBytes(state) > MAX_QUEUED_COMMAND_STATE_BYTES) {
    return 'queueTooLarge';
  }

  return null;
};

export const validateQueuedCommandItem = (
  item: ConversationCommandQueueItem,
  state: ConversationCommandQueueState
): QueueValidationSuccess | QueueValidationFailure => {
  const nextState = {
    ...state,
    items: [...state.items, item],
  };
  const failureReason = getQueueValidationFailureReason(nextState);
  if (failureReason) {
    return { ok: false, reason: failureReason };
  }
  const nextStateBytes = measureQueueStateBytes(nextState);
  return { ok: true, nextStateBytes };
};

const isQueueValidationFailure = (
  validation: QueueValidationSuccess | QueueValidationFailure
): validation is QueueValidationFailure => !validation.ok;

const readPersistedQueueState = (seatId: string, conversation_id: string): ConversationCommandQueueState => {
  const storeKey = getQueueStoreKey(seatId, conversation_id);
  if (queueStore.has(storeKey)) {
    return queueStore.get(storeKey) ?? createDefaultQueueState();
  }

  if (typeof window === 'undefined') {
    return createDefaultQueueState();
  }

  try {
    const stored = window.sessionStorage.getItem(getStorageKey(seatId, conversation_id));
    if (!stored) {
      return createDefaultQueueState();
    }

    const parsed = JSON.parse(stored) as unknown;
    const normalized = filterQueueStateForCurrentSeat(normalizeQueueState(parsed), conversation_id);
    queueStore.set(storeKey, normalized);
    logCommandQueue(conversation_id, 'restored', {
      itemCount: normalized.items.length,
      isPaused: normalized.isPaused,
    });
    return normalized;
  } catch (error) {
    console.warn('[conversation-command-queue] Failed to read persisted queue state:', error);
    return createDefaultQueueState();
  }
};

const removePersistedQueueState = (seatId: string, conversation_id: string): void => {
  queueStore.delete(getQueueStoreKey(seatId, conversation_id));
  if (typeof window !== 'undefined') {
    try {
      window.sessionStorage.removeItem(getStorageKey(seatId, conversation_id));
    } catch (error) {
      console.warn('[conversation-command-queue] Failed to remove persisted queue state:', error);
    }
  }
};

const persistQueueState = (seatId: string, conversation_id: string, state: ConversationCommandQueueState): void => {
  const normalized = filterQueueStateForCurrentSeat(normalizeQueueState(state), conversation_id);

  if (normalized.items.length === 0 && !normalized.isPaused) {
    removePersistedQueueState(seatId, conversation_id);
    return;
  }

  queueStore.set(getQueueStoreKey(seatId, conversation_id), normalized);
  if (typeof window !== 'undefined') {
    try {
      window.sessionStorage.setItem(getStorageKey(seatId, conversation_id), JSON.stringify(normalized));
    } catch (error) {
      console.warn('[conversation-command-queue] Failed to persist queue state:', error);
    }
  }
};

export const removeQueuedCommand = (
  items: ConversationCommandQueueItem[],
  commandId: string
): ConversationCommandQueueItem[] => items.filter((item) => item.id !== commandId);

export const reorderQueuedCommand = (
  items: ConversationCommandQueueItem[],
  activeCommandId: string,
  overCommandId: string
): ConversationCommandQueueItem[] => {
  const fromIndex = items.findIndex((item) => item.id === activeCommandId);
  const targetIndex = items.findIndex((item) => item.id === overCommandId);

  if (fromIndex === -1 || targetIndex === -1 || fromIndex === targetIndex) {
    return items;
  }

  const nextItems = [...items];
  const [movedItem] = nextItems.splice(fromIndex, 1);
  nextItems.splice(targetIndex, 0, movedItem);
  return nextItems;
};

export const restoreQueuedCommand = (
  items: ConversationCommandQueueItem[],
  failedItem: ConversationCommandQueueItem
): ConversationCommandQueueItem[] => [failedItem, ...removeQueuedCommand(items, failedItem.id)];

export const updateQueuedCommand = (
  items: ConversationCommandQueueItem[],
  commandId: string,
  updates: Partial<Pick<ConversationCommandQueueItem, 'input' | 'files' | 'displayFiles'>>
): ConversationCommandQueueItem[] =>
  items.map((item) =>
    item.id === commandId
      ? {
          ...item,
          ...updates,
          files: updates.files ? uniqueFiles(updates.files) : item.files,
          displayFiles: updates.displayFiles ? uniqueFiles(updates.displayFiles) : item.displayFiles,
        }
      : item
  );

export const shouldEnqueueConversationCommand = ({
  enabled = true,
  isBusy,
  hasPendingCommands,
}: {
  enabled?: boolean;
  isBusy: boolean;
  hasPendingCommands: boolean;
}): boolean => enabled && (isBusy || hasPendingCommands);

export type ConversationBusyControlMode = 'queue' | 'steer';

export type ConversationBusyControlCommand = {
  mode: ConversationBusyControlMode;
  input: string;
};

const BUSY_CONTROL_COMMAND_RE = /^\/(queue|q|steer)\b([\s\S]*)$/i;

export const resolveConversationBusyControlCommand = (input: string): ConversationBusyControlCommand | null => {
  const trimmedInput = input.trim();
  if (!trimmedInput) {
    return null;
  }

  const match = trimmedInput.match(BUSY_CONTROL_COMMAND_RE);
  if (!match) {
    return null;
  }

  const command = match[1].toLowerCase();
  const args = match[2].trim();
  if (!args) {
    return null;
  }

  const mode: ConversationBusyControlMode = command === 'steer' ? 'steer' : 'queue';
  return {
    mode,
    input: `/${mode} ${args}`,
  };
};

export const buildConversationBusyControlCommand = ({
  input,
  mode,
}: {
  input: string;
  mode: ConversationBusyControlMode;
}): ConversationBusyControlCommand | null => {
  const explicitCommand = resolveConversationBusyControlCommand(input);
  if (explicitCommand) {
    return explicitCommand;
  }

  const trimmedInput = input.trim();
  if (!trimmedInput || mode !== 'steer') {
    return null;
  }

  return {
    mode: 'steer',
    input: `/steer ${trimmedInput}`,
  };
};

export type ConversationCommandQueueRuntimeGate = {
  hydrated: boolean;
  canSendMessage: boolean;
  isProcessing: boolean;
};

export type CommandQueueExecutionGate = {
  hydrated: boolean;
  canExecute: boolean;
  isProcessing: boolean;
};

export const getCommandQueueExecutionGate = ({
  isBusy,
  isHydrated = true,
  runtimeGate,
}: {
  isBusy: boolean;
  isHydrated?: boolean;
  runtimeGate?: ConversationCommandQueueRuntimeGate;
}): CommandQueueExecutionGate => {
  if (runtimeGate) {
    return {
      hydrated: runtimeGate.hydrated,
      canExecute: runtimeGate.canSendMessage && !runtimeGate.isProcessing,
      isProcessing: runtimeGate.isProcessing,
    };
  }

  return {
    hydrated: isHydrated,
    canExecute: !isBusy,
    isProcessing: isBusy,
  };
};

type UseConversationCommandQueueOptions = {
  conversation_id: string;
  enabled?: boolean;
  isBusy: boolean;
  isHydrated?: boolean;
  runtimeGate?: ConversationCommandQueueRuntimeGate;
  onExecute: (
    item: ConversationCommandQueueItem,
    ticket: ConversationRuntimeSeatTicket
  ) => Promise<ConversationCommandDispatchResult>;
};

type EnqueueCommandInput = Pick<
  ConversationCommandQueueItem,
  | 'input'
  | 'files'
  | 'displayFiles'
  | 'preparedContext'
  | 'managedVisualSourceCount'
  | 'attachmentGrounding'
  | 'composerSelection'
  | 'selectedArtifactId'
> & { seatTicket?: ConversationRuntimeSeatTicket };
type UpdateCommandInput = Pick<ConversationCommandQueueItem, 'input'>;

const getQueueValidationMessage = (
  t: (key: string, options?: Record<string, unknown>) => string,
  reason: QueueValidationFailureReason
): string => {
  const warningKeyMap = {
    emptyInput: 'conversation.commandQueue.emptyInput',
    queueFull: 'conversation.commandQueue.queueFull',
    inputTooLong: 'conversation.commandQueue.inputTooLong',
    tooManyFiles: 'conversation.commandQueue.tooManyFiles',
    queueTooLarge: 'conversation.commandQueue.queueTooLarge',
  } as const;
  const defaultValueMap = {
    emptyInput: 'Queued commands cannot be empty.',
    queueFull: 'Queue is full. Remove a command before adding more.',
    inputTooLong: 'This queued command is too long. Shorten it before sending.',
    tooManyFiles: 'Too many files are attached to this queued command.',
    queueTooLarge: 'Queue data is too large to persist safely. Remove some queued commands first.',
  } as const;

  return t(warningKeyMap[reason], {
    count: MAX_QUEUED_COMMANDS,
    files: MAX_QUEUED_COMMAND_FILES,
    defaultValue: defaultValueMap[reason],
  });
};

export const useConversationCommandQueue = ({
  conversation_id,
  enabled = true,
  isBusy,
  isHydrated = true,
  runtimeGate,
  onExecute,
}: UseConversationCommandQueueOptions) => {
  const { t } = useTranslation();
  const [queueSeatId, setQueueSeatId] = useState(() => configService.getCurrentSeatId());
  const executionGate = getCommandQueueExecutionGate({ isBusy, isHydrated, runtimeGate });
  const { data = createDefaultQueueState(), mutate } = useSWR(
    [`/conversation-command-queue/${queueSeatId}/${conversation_id}`, queueSeatId, conversation_id, enabled],
    ([, seatId, id, is_enabled]) => (is_enabled ? readPersistedQueueState(seatId, id) : createDefaultQueueState())
  );

  const stateRef = useRef(data);
  const pausedRef = useRef(data.isPaused);
  const waitingForTurnStartRef = useRef(false);
  const waitingForTurnCompletionRef = useRef(false);
  const executeResolvedBeforeTurnStartRef = useRef(false);
  const interactionLockedRef = useRef(false);
  const activeExecutionItemRef = useRef<ConversationCommandQueueItem | null>(null);
  const activeExecutionTicketRef = useRef<ConversationRuntimeSeatTicket | null>(null);
  const [isInteractionLocked, setIsInteractionLocked] = useState(false);
  const [executionGateVersion, setExecutionGateVersion] = useState(0);

  useEffect(() => {
    stateRef.current = data;
  }, [data]);

  useEffect(() => {
    if (waitingForTurnStartRef.current && executionGate.isProcessing) {
      waitingForTurnStartRef.current = false;
      waitingForTurnCompletionRef.current = true;
      executeResolvedBeforeTurnStartRef.current = false;
      logCommandQueue(conversation_id, 'turn-started', {
        pendingItemCount: stateRef.current.items.length,
      });
      return;
    }

    if (
      waitingForTurnStartRef.current &&
      executeResolvedBeforeTurnStartRef.current &&
      executionGate.hydrated &&
      executionGate.canExecute
    ) {
      waitingForTurnStartRef.current = false;
      executeResolvedBeforeTurnStartRef.current = false;
      logCommandQueue(conversation_id, 'turn-finished-before-start-observed', {
        pendingItemCount: stateRef.current.items.length,
      });
      return;
    }

    if (waitingForTurnCompletionRef.current && executionGate.hydrated && executionGate.canExecute) {
      waitingForTurnCompletionRef.current = false;
      logCommandQueue(conversation_id, 'turn-finished', {
        pendingItemCount: stateRef.current.items.length,
      });
    }
  }, [
    conversation_id,
    executionGate.canExecute,
    executionGate.hydrated,
    executionGate.isProcessing,
    executionGateVersion,
  ]);

  useEffect(() => {
    pausedRef.current = data.isPaused;
  }, [data.isPaused]);

  useEffect(() => {
    interactionLockedRef.current = isInteractionLocked;
  }, [isInteractionLocked]);

  useEffect(() => {
    if (enabled) {
      return;
    }

    waitingForTurnStartRef.current = false;
    waitingForTurnCompletionRef.current = false;
    executeResolvedBeforeTurnStartRef.current = false;
    pausedRef.current = false;
    interactionLockedRef.current = false;
    stateRef.current = createDefaultQueueState();
    setIsInteractionLocked(false);
    removePersistedQueueState(queueSeatId, conversation_id);
    void mutate(createDefaultQueueState(), { revalidate: false });
  }, [conversation_id, enabled, mutate, queueSeatId]);

  const updateState = useCallback(
    (
      updater: (state: ConversationCommandQueueState) => ConversationCommandQueueState
    ): Promise<ConversationCommandQueueState | undefined> => {
      if (!enabled) {
        const nextState = createDefaultQueueState();
        stateRef.current = nextState;
        pausedRef.current = false;
        removePersistedQueueState(queueSeatId, conversation_id);
        return Promise.resolve(nextState);
      }

      return mutate(
        (current) => {
          const nextState = filterQueueStateForCurrentSeat(
            normalizeQueueState(
              updater(filterQueueStateForCurrentSeat(current ?? createDefaultQueueState(), conversation_id))
            ),
            conversation_id
          );
          stateRef.current = nextState;
          pausedRef.current = nextState.isPaused;
          persistQueueState(queueSeatId, conversation_id, nextState);
          return nextState;
        },
        { revalidate: false }
      );
    },
    [conversation_id, enabled, mutate, queueSeatId]
  );

  const clear = useCallback(() => {
    waitingForTurnStartRef.current = false;
    waitingForTurnCompletionRef.current = false;
    executeResolvedBeforeTurnStartRef.current = false;
    pausedRef.current = false;
    logCommandQueue(conversation_id, 'cleared');
    void updateState(() => createDefaultQueueState());
  }, [conversation_id, updateState]);

  useAddEventListener(
    'conversation.deleted',
    (deletedConversationId) => {
      if (deletedConversationId !== conversation_id) {
        return;
      }
      clear();
      removePersistedQueueState(queueSeatId, conversation_id);
    },
    [clear, conversation_id, queueSeatId]
  );

  useEffect(
    () =>
      configService.onSeatRebind((nextSeatId) => {
        waitingForTurnStartRef.current = false;
        waitingForTurnCompletionRef.current = false;
        executeResolvedBeforeTurnStartRef.current = false;
        pausedRef.current = false;
        interactionLockedRef.current = false;
        activeExecutionItemRef.current = null;
        activeExecutionTicketRef.current = null;
        stateRef.current = createDefaultQueueState();
        setIsInteractionLocked(false);
        setQueueSeatId(nextSeatId);
      }),
    []
  );

  const enqueue = useCallback(
    ({
      input,
      files,
      displayFiles,
      preparedContext,
      managedVisualSourceCount,
      attachmentGrounding,
      composerSelection,
      selectedArtifactId,
      seatTicket,
    }: EnqueueCommandInput) => {
      if (!enabled) {
        return null;
      }

      const effectiveSeatTicket = seatTicket ?? captureConversationRuntimeSeatTicket(conversation_id);
      if (
        effectiveSeatTicket.conversationId !== conversation_id ||
        !isConversationRuntimeSeatTicketCurrent(effectiveSeatTicket)
      ) {
        logCommandQueue(conversation_id, 'enqueue-stale-seat');
        return null;
      }
      const currentState = filterQueueStateForCurrentSeat(normalizeQueueState(stateRef.current), conversation_id);
      const item = createQueuedCommandItem({
        input,
        files,
        displayFiles,
        preparedContext,
        managedVisualSourceCount,
        attachmentGrounding,
        composerSelection,
        selectedArtifactId,
        seatTicket: effectiveSeatTicket,
      });
      const validation = validateQueuedCommandItem(item, currentState);

      if (isQueueValidationFailure(validation)) {
        const reason: QueueValidationFailureReason = validation.reason;
        logCommandQueue(conversation_id, 'enqueue-rejected', {
          reason,
          item: summarizeQueuedCommand(item),
          currentItemCount: currentState.items.length,
        });
        Message.warning(getQueueValidationMessage(t, reason));
        return null;
      }

      const nextState: ConversationCommandQueueState = {
        ...currentState,
        items: [...currentState.items, item],
      };
      stateRef.current = nextState;
      logCommandQueue(conversation_id, 'enqueued', {
        item: summarizeQueuedCommand(item),
        currentItemCount: currentState.items.length,
      });
      void updateState(() => nextState);
      return item;
    },
    [conversation_id, enabled, t, updateState]
  );

  const update = useCallback(
    (commandId: string, { input }: UpdateCommandInput) => {
      if (!enabled) {
        return false;
      }

      const currentState = normalizeQueueState(stateRef.current);
      const currentItem = currentState.items.find((item) => item.id === commandId);
      if (!currentItem) {
        return false;
      }

      const nextItems = updateQueuedCommand(currentState.items, commandId, { input });
      const nextState: ConversationCommandQueueState = {
        isPaused: false,
        items: nextItems,
      };
      const failureReason = getQueueValidationFailureReason(nextState);

      if (failureReason) {
        logCommandQueue(conversation_id, 'update-rejected', {
          reason: failureReason,
          commandId,
          inputLength: input.length,
        });
        Message.warning(getQueueValidationMessage(t, failureReason));
        return false;
      }

      stateRef.current = nextState;
      logCommandQueue(conversation_id, 'updated', {
        commandId,
        inputLength: input.length,
      });
      void updateState(() => nextState);
      return true;
    },
    [conversation_id, enabled, t, updateState]
  );

  const remove = useCallback(
    (commandId: string) => {
      if (!enabled) {
        return Promise.resolve(undefined);
      }

      logCommandQueue(conversation_id, 'removed', {
        commandId,
      });
      return updateState((state) => {
        const nextItems = removeQueuedCommand(state.items, commandId);
        return {
          items: nextItems,
          isPaused: false,
        };
      });
    },
    [conversation_id, enabled, updateState]
  );

  const restore = useCallback(
    (item: ConversationCommandQueueItem) => {
      if (!enabled) {
        return Promise.resolve(undefined);
      }

      logCommandQueue(conversation_id, 'restored-after-promotion-failure', {
        item: summarizeQueuedCommand(item),
      });
      return updateState((state) => ({
        items: restoreQueuedCommand(state.items, item),
        isPaused: state.isPaused,
      }));
    },
    [conversation_id, enabled, updateState]
  );

  const reorder = useCallback(
    (activeCommandId: string, overCommandId: string) => {
      if (!enabled) {
        return;
      }

      logCommandQueue(conversation_id, 'reordered', {
        activeCommandId,
        overCommandId,
      });
      void updateState((state) => ({
        isPaused: false,
        items: reorderQueuedCommand(state.items, activeCommandId, overCommandId),
      }));
    },
    [conversation_id, enabled, updateState]
  );

  const pause = useCallback(() => {
    if (!enabled) {
      return;
    }

    pausedRef.current = true;
    waitingForTurnStartRef.current = false;
    waitingForTurnCompletionRef.current = false;
    executeResolvedBeforeTurnStartRef.current = false;
    logCommandQueue(conversation_id, 'paused', {
      itemCount: data.items.length,
    });
    void updateState((state) => {
      if (state.items.length === 0) {
        pausedRef.current = false;
        return createDefaultQueueState();
      }
      return {
        ...state,
        isPaused: true,
      };
    });
  }, [conversation_id, data.items.length, enabled, updateState]);

  const resume = useCallback(() => {
    if (!enabled) {
      return;
    }

    pausedRef.current = false;
    logCommandQueue(conversation_id, 'resumed', {
      itemCount: data.items.length,
    });
    void updateState((state) => ({
      ...state,
      isPaused: state.items.length > 0 ? false : state.isPaused,
    }));
  }, [conversation_id, data.items.length, enabled, updateState]);

  const lockInteraction = useCallback(() => {
    if (!enabled) {
      return;
    }

    interactionLockedRef.current = true;
    logCommandQueue(conversation_id, 'interaction-locked', {
      itemCount: stateRef.current.items.length,
    });
    setIsInteractionLocked(true);
  }, [conversation_id, enabled]);

  const unlockInteraction = useCallback(() => {
    if (!enabled) {
      return;
    }

    interactionLockedRef.current = false;
    logCommandQueue(conversation_id, 'interaction-unlocked', {
      itemCount: stateRef.current.items.length,
    });
    setIsInteractionLocked(false);
  }, [conversation_id, enabled]);

  const resetActiveExecution = useCallback(
    (reason: 'stop' | 'external-reset') => {
      const hadPendingTurn = waitingForTurnStartRef.current || waitingForTurnCompletionRef.current;
      waitingForTurnStartRef.current = false;
      waitingForTurnCompletionRef.current = false;
      executeResolvedBeforeTurnStartRef.current = false;

      if (!hadPendingTurn) {
        return;
      }

      logCommandQueue(conversation_id, 'execution-reset', {
        reason,
        pendingItemCount: stateRef.current.items.length,
      });
      setExecutionGateVersion((version) => version + 1);
    },
    [conversation_id]
  );

  useEffect(() => {
    if (
      !enabled ||
      !executionGate.hydrated ||
      pausedRef.current ||
      !executionGate.canExecute ||
      waitingForTurnStartRef.current ||
      waitingForTurnCompletionRef.current ||
      interactionLockedRef.current ||
      data.items.length === 0
    ) {
      return;
    }

    const [nextCommand, ...remainingCommands] = data.items;
    const executionTicket = captureConversationRuntimeSeatTicket(conversation_id);
    if (
      !isQueuedCommandCurrent(nextCommand, conversation_id) ||
      executionTicket.conversationId !== conversation_id ||
      !isConversationRuntimeSeatTicketCurrent(executionTicket)
    ) {
      logCommandQueue(conversation_id, 'discarded-stale-seat', {
        item: summarizeQueuedCommand(nextCommand),
      });
      void updateState(() => ({ items: remainingCommands, isPaused: false }));
      return;
    }
    waitingForTurnStartRef.current = true;
    activeExecutionItemRef.current = nextCommand;
    activeExecutionTicketRef.current = executionTicket;
    executeResolvedBeforeTurnStartRef.current = false;
    logCommandQueue(conversation_id, 'dequeued', {
      item: summarizeQueuedCommand(nextCommand),
      remainingItemCount: remainingCommands.length,
    });
    void updateState(() => ({
      items: remainingCommands,
      isPaused: false,
    }));

    void onExecute(nextCommand, executionTicket)
      .then((result) => {
        if (
          activeExecutionItemRef.current?.id !== nextCommand.id ||
          activeExecutionTicketRef.current !== executionTicket
        ) {
          return;
        }
        if (result === 'stale' || !isQueuedCommandCurrent(nextCommand, conversation_id)) {
          waitingForTurnStartRef.current = false;
          waitingForTurnCompletionRef.current = false;
          executeResolvedBeforeTurnStartRef.current = false;
          activeExecutionItemRef.current = null;
          activeExecutionTicketRef.current = null;
          setExecutionGateVersion((version) => version + 1);
          return;
        }
        if (result === 'rejected') {
          waitingForTurnStartRef.current = false;
          waitingForTurnCompletionRef.current = false;
          executeResolvedBeforeTurnStartRef.current = false;
          activeExecutionItemRef.current = null;
          activeExecutionTicketRef.current = null;
          pausedRef.current = true;
          void updateState((state) => ({
            items: restoreQueuedCommand(state.items, nextCommand),
            isPaused: true,
          }));
          Message.warning(
            t('conversation.commandQueue.pausedAfterFailure', {
              defaultValue: 'The next queued command could not start. Edit, reorder, or remove it to continue.',
            })
          );
          return;
        }
        if (!waitingForTurnStartRef.current) {
          return;
        }

        executeResolvedBeforeTurnStartRef.current = true;
        activeExecutionItemRef.current = null;
        activeExecutionTicketRef.current = null;
        setExecutionGateVersion((version) => version + 1);
      })
      .catch((error) => {
        if (
          activeExecutionItemRef.current?.id !== nextCommand.id ||
          activeExecutionTicketRef.current !== executionTicket
        ) {
          return;
        }
        if (!isQueuedCommandCurrent(nextCommand, conversation_id)) {
          waitingForTurnStartRef.current = false;
          waitingForTurnCompletionRef.current = false;
          executeResolvedBeforeTurnStartRef.current = false;
          activeExecutionItemRef.current = null;
          activeExecutionTicketRef.current = null;
          setExecutionGateVersion((version) => version + 1);
          return;
        }
        console.error('[conversation-command-queue] Failed to execute queued command:', error);
        logCommandQueue(conversation_id, 'execute-failed', {
          item: summarizeQueuedCommand(nextCommand),
          error: error instanceof Error ? error.message : String(error),
        });
        waitingForTurnStartRef.current = false;
        waitingForTurnCompletionRef.current = false;
        executeResolvedBeforeTurnStartRef.current = false;
        activeExecutionItemRef.current = null;
        activeExecutionTicketRef.current = null;
        pausedRef.current = true;
        void updateState((state) => ({
          items: restoreQueuedCommand(state.items, nextCommand),
          isPaused: true,
        }));
        Message.warning(
          t('conversation.commandQueue.pausedAfterFailure', {
            defaultValue: 'The next queued command could not start. Edit, reorder, or remove it to continue.',
          })
        );
      });
  }, [
    conversation_id,
    data.items,
    enabled,
    executionGateVersion,
    executionGate.canExecute,
    executionGate.hydrated,
    isInteractionLocked,
    onExecute,
    t,
    updateState,
  ]);

  return {
    items: enabled ? data.items : [],
    isPaused: enabled ? data.isPaused : false,
    isInteractionLocked,
    hasPendingCommands: enabled ? data.items.length > 0 : false,
    enqueue,
    update,
    remove,
    restore,
    clear,
    reorder,
    pause,
    resume,
    lockInteraction,
    unlockInteraction,
    resetActiveExecution,
  };
};
