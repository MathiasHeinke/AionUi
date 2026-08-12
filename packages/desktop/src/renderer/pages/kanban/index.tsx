/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-seat Kanban route (`/kanban`).
 *
 * The default export mounts NativeKanbanBoard, a thin renderer over Hermes
 * 0.20's canonical plugin API and default board. Hermes owns the schema,
 * routes and SQLite lifecycle; Command EVE supplies only the active seat's
 * HERMES_HOME and a fail-closed bridge contract.
 *
 * SEAT-REMOUNT BOUNDARY: the default export is a thin host that keys the real
 * page by useActiveSeatId(). The page seeds its board read in a mount-once
 * effect and does not subscribe to configService; without the key it would keep
 * serving the PRIOR seat's board after an admin seat switch (the documented
 * mount-once-state-leak trap — see useActiveSeatId.ts). Keying the host by the
 * active seat id REMOUNTS the whole subtree on a switch, re-firing the board
 * read under the new seat. On a single-seat / legacy install the id is stable,
 * so it is a no-op remount.
 *
 * The former marketing-specific board stays below as a named compatibility
 * component for its focused tests, but it is no longer a route, workbench tab,
 * or second default board surface.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Empty, Input, Message, Modal, Select, Spin, Tag } from '@arco-design/web-react';
import { bridge } from '@office-ai/platform';
import { COMMAND_EVE_KANBAN_ACP_APPLIED_EVENT } from '@/common/config/kanbanAcpEvents';
import { useActiveSeatId } from '@renderer/hooks/useActiveSeatId';
import { useSeatAccess } from '@renderer/hooks/useSeatAccess';
import { isElectronDesktop } from '@renderer/utils/platform';
import NativeKanbanBoard from './NativeKanbanBoard';
import {
  buildOrderedColumns,
  generateKanbanClientToken,
  KANBAN_LANE_ORDER,
  nextKanbanLane,
  projectKanbanBoardView,
  projectKanbanCardDetail,
  type IKanbanBoardCard,
  type IKanbanBoardColumn,
  type IKanbanBoardModel,
  type IKanbanBoardResult,
  type KanbanCardAction,
  type KanbanLaneKey,
} from './kanbanBoardModel';

// H2 (board-slug unify): the page MUST point at the SAME board EVE's native
// Hermes kanban tools write. Those tools default HERMES_KANBAN_BOARD to 'default'
// (the bundled wheel), which kanbanDbPath maps to HERMES_HOME/kanban.db — the
// physical per-seat board. The page previously hardcoded 'marketing', which maps
// to a DIFFERENT file (HERMES_HOME/kanban/boards/marketing/kanban.db), so the
// operator's board and EVE's board were disconnected out-of-the-box (the core
// operator↔EVE loop was dead). 'default' re-unifies them onto the one DB EVE
// authors. Per-seat isolation stays physical (HERMES_HOME is per-seat).
const KANBAN_BOARD_SLUG = 'default';

interface IBridgeResponse<D = unknown> {
  success: boolean;
  msg?: string;
  data?: D;
}

interface IKanbanBoardEnvelope extends IKanbanBoardResult {
  version: 'command-eve-kanban-marketing-board/v0';
  source: { generated_by: 'command-eve-kanban-marketing-board-core'; hermes_home: string };
}

interface IKanbanCardCreateEnvelope {
  version: 'command-eve-kanban-marketing-card-create/v0';
  ok: boolean;
  status: 'ready' | 'blocked' | 'failed';
  reason_code?: string;
  message?: string;
  card_id?: string;
  model?: IKanbanBoardModel;
  source: { generated_by: 'command-eve-kanban-marketing-board-core'; hermes_home: string };
}

interface IKanbanCardMoveEnvelope {
  version: 'command-eve-kanban-marketing-card-move/v0';
  ok: boolean;
  status: 'ready' | 'blocked' | 'failed';
  reason_code?: string;
  message?: string;
  moved?: boolean;
  model?: IKanbanBoardModel;
  source: { generated_by: 'command-eve-kanban-marketing-board-core'; hermes_home: string };
}

interface IKanbanCardActionEnvelope {
  version: 'command-eve-kanban-marketing-card-action/v0';
  ok: boolean;
  status: 'ready' | 'blocked' | 'failed';
  reason_code?: string;
  message?: string;
  action?: KanbanCardAction;
  model?: IKanbanBoardModel;
  source: { generated_by: 'command-eve-kanban-marketing-board-core'; hermes_home: string };
}

// Any mutation result carries a fresh board model — reuse it to re-project
// without a second read.
interface IKanbanMutationCarrier {
  ok: boolean;
  status: 'ready' | 'blocked' | 'failed';
  reason_code?: string;
  message?: string;
  model?: IKanbanBoardModel;
  source: { generated_by: 'command-eve-kanban-marketing-board-core'; hermes_home: string };
}

const kanbanBoardProvider = bridge.buildProvider<
  IBridgeResponse<IKanbanBoardEnvelope>,
  { boardSlug?: string } | undefined
>('command-eve.kanban-marketing-board');

const kanbanCardCreateProvider = bridge.buildProvider<
  IBridgeResponse<IKanbanCardCreateEnvelope>,
  { title: string; description?: string; lane_key: KanbanLaneKey; client_token: string; boardSlug?: string }
>('command-eve.kanban-marketing-card-create');

const kanbanCardMoveProvider = bridge.buildProvider<
  IBridgeResponse<IKanbanCardMoveEnvelope>,
  { task_id: string; to_lane_key: KanbanLaneKey; boardSlug?: string }
>('command-eve.kanban-marketing-card-move');

const kanbanCardActionProvider = bridge.buildProvider<
  IBridgeResponse<IKanbanCardActionEnvelope>,
  { task_id: string; action: KanbanCardAction; comment?: string; boardSlug?: string }
>('command-eve.kanban-marketing-card-action');

const textOrDash = (value?: string | null): string => {
  const text = String(value ?? '').trim();
  return text || '-';
};

const cardStatusColor = (status: string): 'blue' | 'green' | 'orange' | 'red' | 'gray' => {
  if (['completed', 'done', 'ready'].includes(status)) return 'green';
  if (['blocked', 'failed'].includes(status)) return 'red';
  if (['review'].includes(status)) return 'orange';
  if (['todo', 'triage'].includes(status)) return 'blue';
  return 'gray';
};

// Class-2: format an epoch-ms timestamp for the detail panel, or a dash. Guards a
// zero/NaN value (a synthetic or unset card) so the panel never renders "1970".
const formatTimestamp = (ms?: number | null): string => {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '-';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return '-';
  }
};

const governanceColor = (state: 'read_only' | 'proof_write_recorded' | 'unknown'): 'green' | 'gray' =>
  state === 'proof_write_recorded' ? 'green' : 'gray';

// ── Card detail (Class-2) ─────────────────────────────────────────────────────

// A labeled row inside a detail `<dl>` grid. `value` breaks on any char so long
// ids/run tokens wrap instead of overflowing the narrow card.
const DetailRow: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <>
    <dt className='text-t-tertiary'>{label}</dt>
    <dd className='m-0 break-all text-t-secondary'>{value}</dd>
  </>
);

/**
 * Class-2 (1.7.3) — the expandable, READ-ONLY card detail. Surfaces provenance
 * (owner, draft source, run, timestamps), the generated draft (the quality
 * signal), the governance + audit-event trail, and the marketing ladder. It
 * renders a pure projection of fields already on the card and mutates nothing —
 * no bridge call, no gate. Everything unavailable simply does not render.
 */
const KanbanCardDetailPanel: React.FC<{ card: IKanbanBoardCard }> = ({ card }) => {
  const { t } = useTranslation();
  const { provenance, draft, audit, ladder } = projectKanbanCardDetail(card);
  const ladderStageLabel = (stage: string): string => t(`kanban.ladder.${stage}`, { defaultValue: stage });
  return (
    <div
      data-testid={`kanban-card-detail-${card.card_id}`}
      className='mt-8px rounded-8px border border-solid border-[var(--color-border-2)] bg-fill-1 px-10px py-8px'
    >
      {/* Provenance */}
      <div className='text-11px font-600 leading-16px text-t-secondary'>
        {t('kanban.card.detail.provenanceTitle', { defaultValue: 'Origin' })}
      </div>
      <dl className='mt-4px grid grid-cols-[auto_1fr] gap-x-8px gap-y-2px text-11px leading-16px'>
        <DetailRow
          label={t('kanban.card.detail.owner', { defaultValue: 'Owner' })}
          value={textOrDash(provenance.assignee)}
        />
        {provenance.draftSource ? (
          <DetailRow
            label={t('kanban.card.detail.source', { defaultValue: 'Source' })}
            value={provenance.draftSource}
          />
        ) : null}
        {provenance.linkedRunId ? (
          <DetailRow label={t('kanban.card.detail.run', { defaultValue: 'Run' })} value={provenance.linkedRunId} />
        ) : null}
        <DetailRow
          label={t('kanban.card.detail.created', { defaultValue: 'Created' })}
          value={formatTimestamp(provenance.createdAt)}
        />
        {provenance.updatedAt ? (
          <DetailRow
            label={t('kanban.card.detail.updated', { defaultValue: 'Updated' })}
            value={formatTimestamp(provenance.updatedAt)}
          />
        ) : null}
      </dl>

      {/* Draft = quality signal */}
      {draft ? (
        <div className='mt-8px'>
          <div className='text-11px font-600 leading-16px text-t-secondary'>
            {t('kanban.card.detail.draftTitle', { defaultValue: 'Draft' })}
          </div>
          <dl className='mt-4px grid grid-cols-[auto_1fr] gap-x-8px gap-y-2px text-11px leading-16px'>
            {draft.source ? (
              <DetailRow label={t('kanban.card.detail.source', { defaultValue: 'Source' })} value={draft.source} />
            ) : null}
            {draft.at ? (
              <DetailRow label={t('kanban.card.detail.at', { defaultValue: 'At' })} value={formatTimestamp(draft.at)} />
            ) : null}
          </dl>
          {draft.text ? (
            <pre
              data-testid={`kanban-card-detail-draft-${card.card_id}`}
              className='mt-4px max-h-160px overflow-auto whitespace-pre-wrap break-words rounded-6px bg-fill-2 px-8px py-6px text-11px leading-16px text-t-secondary'
            >
              {draft.text}
            </pre>
          ) : null}
        </div>
      ) : null}

      {/* Governance & audit trail */}
      <div className='mt-8px'>
        <div className='text-11px font-600 leading-16px text-t-secondary'>
          {t('kanban.card.detail.auditTitle', { defaultValue: 'Governance & audit' })}
        </div>
        <dl className='mt-4px grid grid-cols-[auto_1fr] gap-x-8px gap-y-2px text-11px leading-16px'>
          <DetailRow
            label={t('kanban.card.detail.governance', { defaultValue: 'Governance' })}
            value={
              <Tag color={governanceColor(audit.governanceState)} size='small'>
                {t(`kanban.governance.${audit.governanceState}`, { defaultValue: audit.governanceState })}
              </Tag>
            }
          />
          {audit.linkedAuditEventId ? (
            <DetailRow
              label={t('kanban.card.detail.auditEvent', { defaultValue: 'Audit event' })}
              value={audit.linkedAuditEventId}
            />
          ) : null}
          {audit.draftAuditEventId ? (
            <DetailRow
              label={t('kanban.card.detail.draftAudit', { defaultValue: 'Draft audit' })}
              value={audit.draftAuditEventId}
            />
          ) : null}
          {audit.controllerReviewStatus ? (
            <DetailRow
              label={t('kanban.card.detail.controllerReview', { defaultValue: 'Controller review' })}
              value={textOrDash(audit.controllerReviewAuditEventId || audit.controllerReviewStatus)}
            />
          ) : null}
          {audit.controllerDecisionStatus ? (
            <DetailRow
              label={t('kanban.card.detail.controllerDecision', { defaultValue: 'Controller decision' })}
              value={`${audit.controllerDecisionStatus}${audit.controllerDecisionAuditEventId ? ` · ${audit.controllerDecisionAuditEventId}` : ''}`}
            />
          ) : null}
        </dl>
        {!audit.hasAnyAuditEvent ? (
          <div className='mt-2px text-11px leading-16px text-t-tertiary'>
            {t('kanban.card.detail.noAudit', { defaultValue: 'No audit records linked yet.' })}
          </div>
        ) : null}
      </div>

      {/* Progress / ladder */}
      {ladder ? (
        <div className='mt-8px'>
          <div className='text-11px font-600 leading-16px text-t-secondary'>
            {t('kanban.card.detail.ladderTitle', { defaultValue: 'Progress' })}
          </div>
          <dl className='mt-4px grid grid-cols-[auto_1fr] gap-x-8px gap-y-2px text-11px leading-16px'>
            <DetailRow
              label={t('kanban.card.detail.highestStage', { defaultValue: 'Highest stage' })}
              value={ladder.highestStage ? ladderStageLabel(ladder.highestStage) : '-'}
            />
            <DetailRow
              label={t('kanban.card.detail.executorPromoted', { defaultValue: 'Executor promoted' })}
              value={
                ladder.executorPromoted
                  ? t('kanban.card.detail.yes', { defaultValue: 'Yes' })
                  : t('kanban.card.detail.no', { defaultValue: 'No' })
              }
            />
          </dl>
          {ladder.recordedStages.length > 0 ? (
            <div className='mt-4px flex flex-wrap gap-4px' data-testid={`kanban-card-detail-ladder-${card.card_id}`}>
              {ladder.recordedStages.map((stage) => (
                <Tag key={stage} color='blue' size='small'>
                  {ladderStageLabel(stage)}
                </Tag>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

// ── Card ──────────────────────────────────────────────────────────────────────

const KanbanCardView: React.FC<{
  card: IKanbanBoardCard;
  busy: boolean;
  // H1 belt-and-suspenders: writes are fenced in MAIN during a seat switch; the
  // renderer disables the buttons too so the operator never fires a doomed write.
  locked?: boolean;
  onMoveNext: (card: IKanbanBoardCard, toLane: KanbanLaneKey) => void;
  onOpenComment: (card: IKanbanBoardCard) => void;
  onApplyAction: (card: IKanbanBoardCard, action: Exclude<KanbanCardAction, 'comment'>) => void;
}> = ({ card, busy, locked = false, onMoveNext, onOpenComment, onApplyAction }) => {
  const { t } = useTranslation();
  const nextLane = nextKanbanLane(card.lane_key);
  const blocked = card.card_status === 'blocked';
  const completed = card.card_status === 'completed';
  // Class-2: per-card expand state. Read-only detail — independent of `busy`/
  // `locked` (viewing provenance/audit is always safe, even during a seat switch).
  const [expanded, setExpanded] = useState(false);
  return (
    <article
      data-testid={`kanban-card-${card.card_id}`}
      className='rounded-10px border border-solid border-[var(--color-border-2)] bg-fill-2 px-12px py-10px'
    >
      <div className='flex items-start justify-between gap-8px'>
        <div className='min-w-0'>
          <div className='truncate text-13px font-600 leading-20px text-t-primary'>{textOrDash(card.card_title)}</div>
          <div className='mt-2px truncate text-11px leading-16px text-t-tertiary'>{textOrDash(card.card_id)}</div>
        </div>
        <Tag color={cardStatusColor(card.card_status)}>{textOrDash(card.card_status)}</Tag>
      </div>
      <dl className='mt-8px grid grid-cols-2 gap-x-8px gap-y-4px text-11px leading-16px'>
        <dt className='text-t-tertiary'>{t('kanban.card.owner', { defaultValue: 'Owner' })}</dt>
        <dd className='m-0 truncate text-t-secondary'>{textOrDash(card.card_assignee)}</dd>
        <dt className='text-t-tertiary'>{t('kanban.card.audit', { defaultValue: 'Audit' })}</dt>
        <dd className='m-0 truncate text-t-secondary'>{textOrDash(card.linked_audit_event_id)}</dd>
      </dl>
      <div className='mt-6px'>
        <Button
          size='mini'
          type='text'
          data-testid={`kanban-card-detail-toggle-${card.card_id}`}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded
            ? t('kanban.card.detail.hide', { defaultValue: 'Hide details ▴' })
            : t('kanban.card.detail.show', { defaultValue: 'Show details ▾' })}
        </Button>
      </div>
      {expanded ? <KanbanCardDetailPanel card={card} /> : null}
      <div className='mt-8px flex flex-wrap items-center justify-end gap-6px'>
        <Button
          size='mini'
          shape='round'
          disabled={busy || locked}
          data-testid={`kanban-card-comment-${card.card_id}`}
          onClick={() => onOpenComment(card)}
        >
          {t('kanban.actions.comment', { defaultValue: 'Comment' })}
        </Button>
        <Button
          size='mini'
          shape='round'
          loading={busy && !blocked}
          disabled={busy || locked || blocked || completed}
          data-testid={`kanban-card-block-${card.card_id}`}
          onClick={() => onApplyAction(card, 'block')}
        >
          {t('kanban.actions.block', { defaultValue: 'Block' })}
        </Button>
        <Button
          size='mini'
          shape='round'
          loading={busy && blocked}
          disabled={busy || locked || !blocked}
          data-testid={`kanban-card-unblock-${card.card_id}`}
          onClick={() => onApplyAction(card, 'unblock')}
        >
          {t('kanban.actions.unblock', { defaultValue: 'Unblock' })}
        </Button>
        <Button
          size='mini'
          shape='round'
          loading={busy && !completed}
          disabled={busy || locked || completed}
          data-testid={`kanban-card-complete-${card.card_id}`}
          onClick={() => onApplyAction(card, 'complete')}
        >
          {t('kanban.actions.complete', { defaultValue: 'Complete' })}
        </Button>
        {nextLane ? (
          <Button
            size='mini'
            shape='round'
            type='outline'
            loading={busy}
            disabled={busy || locked}
            data-testid={`kanban-card-move-${card.card_id}`}
            onClick={() => onMoveNext(card, nextLane)}
          >
            {`${t('kanban.actions.moveNext', { defaultValue: 'Next' })} → ${t(`kanban.columns.${nextLane}`, {
              defaultValue: nextLane,
            })}`}
          </Button>
        ) : (
          <span className='text-11px leading-16px text-t-tertiary' data-testid={`kanban-card-final-${card.card_id}`}>
            {t('kanban.actions.finalLane', { defaultValue: 'Final lane' })}
          </span>
        )}
      </div>
    </article>
  );
};

// ── Column ──────────────────────────────────────────────────────────────────

const KanbanColumnView: React.FC<{
  column: IKanbanBoardColumn;
  busyCardId: string | null;
  // H1: forwarded to each card so a seat switch disables every write control.
  locked?: boolean;
  onMoveNext: (card: IKanbanBoardCard, toLane: KanbanLaneKey) => void;
  onOpenComment: (card: IKanbanBoardCard) => void;
  onApplyAction: (card: IKanbanBoardCard, action: Exclude<KanbanCardAction, 'comment'>) => void;
}> = ({ column, busyCardId, locked = false, onMoveNext, onOpenComment, onApplyAction }) => {
  const { t } = useTranslation();
  return (
    <div
      data-testid={`kanban-lane-${column.key}`}
      className='flex min-h-180px flex-col gap-10px rounded-12px border border-solid border-[var(--color-border-2)] bg-fill-1 px-12px py-12px'
    >
      <div className='flex items-center justify-between gap-8px'>
        <h3 className='m-0 text-13px font-600 leading-20px text-t-primary'>
          {t(`kanban.columns.${column.key}`, { defaultValue: column.key })}
        </h3>
        <Tag color='gray'>{String(column.cards.length)}</Tag>
      </div>
      {column.cards.length > 0 ? (
        <div className='flex flex-col gap-8px'>
          {column.cards.map((card) => (
            <KanbanCardView
              key={`${column.key}-${card.card_id}`}
              card={card}
              busy={busyCardId === card.card_id}
              locked={locked}
              onMoveNext={onMoveNext}
              onOpenComment={onOpenComment}
              onApplyAction={onApplyAction}
            />
          ))}
        </div>
      ) : (
        <div className='flex flex-1 items-center justify-center rounded-8px border border-dashed border-border-2 px-10px py-18px text-center text-12px leading-18px text-t-tertiary'>
          {t('kanban.emptyColumn', { defaultValue: 'No cards' })}
        </div>
      )}
    </div>
  );
};

// ── Create modal ──────────────────────────────────────────────────────────────

const KanbanCardCreateModal: React.FC<{
  visible: boolean;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (input: { title: string; description: string; lane_key: KanbanLaneKey }) => void;
}> = ({ visible, submitting, onCancel, onSubmit }) => {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [laneKey, setLaneKey] = useState<KanbanLaneKey>(KANBAN_LANE_ORDER[0]);
  const [titleError, setTitleError] = useState(false);

  useEffect(() => {
    if (visible) {
      setTitle('');
      setDescription('');
      setLaneKey(KANBAN_LANE_ORDER[0]);
      setTitleError(false);
    }
  }, [visible]);

  const handleSubmit = (): void => {
    const trimmed = title.trim();
    if (!trimmed) {
      setTitleError(true);
      return;
    }
    onSubmit({ title: trimmed, description: description.trim(), lane_key: laneKey });
  };

  return (
    <Modal
      title={t('kanban.create.title', { defaultValue: 'New card' })}
      visible={visible}
      onCancel={onCancel}
      footer={null}
      maskClosable={!submitting}
      escToExit={!submitting}
      unmountOnExit
    >
      <div className='flex flex-col gap-14px' data-testid='kanban-card-create-modal'>
        <div className='flex flex-col gap-6px'>
          <span className='text-12px leading-18px text-t-secondary'>
            {t('kanban.create.titleLabel', { defaultValue: 'Title' })}
          </span>
          <Input
            value={title}
            onChange={(value) => {
              setTitle(value);
              if (value.trim()) setTitleError(false);
            }}
            placeholder={t('kanban.create.titlePlaceholder', { defaultValue: 'What needs doing?' })}
            data-testid='kanban-card-create-title'
            status={titleError ? 'error' : undefined}
            disabled={submitting}
          />
          {titleError ? (
            <span className='text-11px leading-16px text-danger-6' data-testid='kanban-card-create-title-error'>
              {t('kanban.create.titleRequired', { defaultValue: 'A title is required' })}
            </span>
          ) : null}
        </div>
        <div className='flex flex-col gap-6px'>
          <span className='text-12px leading-18px text-t-secondary'>
            {t('kanban.create.descriptionLabel', { defaultValue: 'Description' })}
          </span>
          <Input.TextArea
            value={description}
            onChange={(value) => setDescription(value)}
            placeholder={t('kanban.create.descriptionPlaceholder', { defaultValue: 'Optional details' })}
            autoSize={{ minRows: 3, maxRows: 6 }}
            data-testid='kanban-card-create-description'
            disabled={submitting}
          />
        </div>
        <div className='flex flex-col gap-6px'>
          <span className='text-12px leading-18px text-t-secondary'>
            {t('kanban.create.laneLabel', { defaultValue: 'Column' })}
          </span>
          <Select
            value={laneKey}
            onChange={(value) => setLaneKey(value as KanbanLaneKey)}
            data-testid='kanban-card-create-lane'
            disabled={submitting}
          >
            {KANBAN_LANE_ORDER.map((lane) => (
              <Select.Option key={lane} value={lane}>
                {t(`kanban.columns.${lane}`, { defaultValue: lane })}
              </Select.Option>
            ))}
          </Select>
        </div>
        <div className='flex items-center justify-end gap-8px'>
          <Button shape='round' onClick={onCancel} disabled={submitting} data-testid='kanban-card-create-cancel'>
            {t('kanban.create.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button
            shape='round'
            type='primary'
            loading={submitting}
            onClick={handleSubmit}
            data-testid='kanban-card-create-submit'
          >
            {t('kanban.create.submit', { defaultValue: 'Create' })}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

// ── Comment modal ─────────────────────────────────────────────────────────────

const KanbanCardCommentModal: React.FC<{
  card: IKanbanBoardCard | null;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (comment: string) => void;
}> = ({ card, submitting, onCancel, onSubmit }) => {
  const { t } = useTranslation();
  const [comment, setComment] = useState('');
  const [commentError, setCommentError] = useState(false);

  useEffect(() => {
    if (card) {
      setComment('');
      setCommentError(false);
    }
  }, [card]);

  const handleSubmit = (): void => {
    const trimmed = comment.trim();
    if (!trimmed) {
      setCommentError(true);
      return;
    }
    onSubmit(trimmed);
  };

  return (
    <Modal
      title={t('kanban.comment.title', { defaultValue: 'Add comment' })}
      visible={Boolean(card)}
      onCancel={onCancel}
      footer={null}
      maskClosable={!submitting}
      escToExit={!submitting}
      unmountOnExit
    >
      <div className='flex flex-col gap-14px' data-testid='kanban-card-comment-modal'>
        <p className='m-0 text-12px leading-18px text-t-secondary'>
          {card ? `${t('kanban.comment.card', { defaultValue: 'Card' })}: ${card.card_title}` : ''}
        </p>
        <Input.TextArea
          value={comment}
          onChange={(value) => {
            setComment(value);
            if (value.trim()) setCommentError(false);
          }}
          placeholder={t('kanban.comment.placeholder', { defaultValue: 'Your note' })}
          autoSize={{ minRows: 3, maxRows: 6 }}
          data-testid='kanban-card-comment-input'
          status={commentError ? 'error' : undefined}
          disabled={submitting}
        />
        {commentError ? (
          <span className='text-11px leading-16px text-danger-6' data-testid='kanban-card-comment-error'>
            {t('kanban.comment.required', { defaultValue: 'A note is required' })}
          </span>
        ) : null}
        <div className='flex items-center justify-end gap-8px'>
          <Button shape='round' onClick={onCancel} disabled={submitting} data-testid='kanban-card-comment-cancel'>
            {t('kanban.create.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button
            shape='round'
            type='primary'
            loading={submitting}
            onClick={handleSubmit}
            data-testid='kanban-card-comment-submit'
          >
            {t('kanban.comment.submit', { defaultValue: 'Save' })}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

// ── Page (the seat-scoped body; remounted by the host on a seat switch) ────────

const KanbanBoardPage: React.FC = () => {
  const { t } = useTranslation();
  // H1 belt-and-suspenders: while an admin seat switch is in flight, disable every
  // write control. The MAIN process also refuses the write (SEAT_SWITCH_IN_PROGRESS)
  // — the renderer guard just keeps the operator from firing a doomed click. On a
  // single-seat / legacy install `switching` is never true (no-op).
  const { switching } = useSeatAccess();
  const [loading, setLoading] = useState(true);
  const [boardResult, setBoardResult] = useState<IKanbanBoardEnvelope | null>(null);
  const [createModalVisible, setCreateModalVisible] = useState(false);
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [commentCard, setCommentCard] = useState<IKanbanBoardCard | null>(null);
  const [commentSubmitting, setCommentSubmitting] = useState(false);
  const [busyCardId, setBusyCardId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    if (!isElectronDesktop()) {
      setBoardResult({
        version: 'command-eve-kanban-marketing-board/v0',
        ok: false,
        status: 'blocked',
        reason_code: 'KANBAN_BOARD_ELECTRON_BRIDGE_REQUIRED',
        message: t('kanban.blocked.electronBridgeRequired', {
          defaultValue: 'The board is only available in the desktop app.',
        }),
        source: { generated_by: 'command-eve-kanban-marketing-board-core', hermes_home: '' },
      });
      setLoading(false);
      return;
    }
    try {
      const response = await kanbanBoardProvider.invoke({ boardSlug: KANBAN_BOARD_SLUG });
      setBoardResult(response.data ?? null);
    } catch (loadError) {
      setBoardResult({
        version: 'command-eve-kanban-marketing-board/v0',
        ok: false,
        status: 'failed',
        reason_code: 'KANBAN_BOARD_UI_LOAD_FAILED',
        message:
          loadError instanceof Error
            ? loadError.message
            : t('kanban.errors.loadFailed', { defaultValue: 'Load failed.' }),
        source: { generated_by: 'command-eve-kanban-marketing-board-core', hermes_home: '' },
      });
    } finally {
      setLoading(false);
    }
  }, [t]);

  // Mount-once seat read — correct because the HOST keys us by the active seat id
  // (see default export), so a seat switch remounts us and re-fires this effect.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onGovernedAcpApplied = (): void => {
      void refresh();
    };
    window.addEventListener(COMMAND_EVE_KANBAN_ACP_APPLIED_EVENT, onGovernedAcpApplied);
    return () => window.removeEventListener(COMMAND_EVE_KANBAN_ACP_APPLIED_EVENT, onGovernedAcpApplied);
  }, [refresh]);

  const applyMutationBoard = useCallback(
    async (carrier: IKanbanMutationCarrier | null) => {
      if (carrier?.model) {
        setBoardResult({
          version: 'command-eve-kanban-marketing-board/v0',
          ok: carrier.ok,
          status: carrier.status,
          reason_code: carrier.reason_code,
          message: carrier.message,
          model: carrier.model,
          source: carrier.source,
        });
        return;
      }
      await refresh();
    },
    [refresh]
  );

  const view = useMemo(() => projectKanbanBoardView(boardResult, loading), [boardResult, loading]);

  const submitCreateCard = useCallback(
    async (input: { title: string; description: string; lane_key: KanbanLaneKey }) => {
      if (!isElectronDesktop()) return;
      setCreateSubmitting(true);
      try {
        const response = await kanbanCardCreateProvider.invoke({
          title: input.title,
          description: input.description || undefined,
          lane_key: input.lane_key,
          client_token: generateKanbanClientToken(),
          boardSlug: KANBAN_BOARD_SLUG,
        });
        const data = response.data ?? null;
        await applyMutationBoard(data);
        if (data?.ok) {
          setCreateModalVisible(false);
          Message.success(t('kanban.create.success', { defaultValue: 'Card created.' }));
        } else {
          Message.warning(data?.reason_code || t('kanban.create.failed', { defaultValue: 'Create failed.' }));
        }
      } catch (createError) {
        Message.error(
          createError instanceof Error
            ? createError.message
            : t('kanban.create.failed', { defaultValue: 'Create failed.' })
        );
      } finally {
        setCreateSubmitting(false);
      }
    },
    [applyMutationBoard, t]
  );

  const moveCardNext = useCallback(
    async (card: IKanbanBoardCard, toLane: KanbanLaneKey) => {
      if (!isElectronDesktop()) return;
      setBusyCardId(card.card_id);
      try {
        const response = await kanbanCardMoveProvider.invoke({
          task_id: card.card_id,
          to_lane_key: toLane,
          boardSlug: KANBAN_BOARD_SLUG,
        });
        const data = response.data ?? null;
        await applyMutationBoard(data);
        if (data?.ok) {
          Message.success(t('kanban.move.success', { defaultValue: 'Card moved.' }));
        } else {
          Message.warning(data?.reason_code || t('kanban.move.failed', { defaultValue: 'Move failed.' }));
        }
      } catch (moveError) {
        Message.error(
          moveError instanceof Error ? moveError.message : t('kanban.move.failed', { defaultValue: 'Move failed.' })
        );
      } finally {
        setBusyCardId(null);
      }
    },
    [applyMutationBoard, t]
  );

  const applyCardAction = useCallback(
    async (card: IKanbanBoardCard, action: KanbanCardAction, comment?: string): Promise<boolean> => {
      if (!isElectronDesktop()) return false;
      setBusyCardId(card.card_id);
      try {
        const response = await kanbanCardActionProvider.invoke({
          task_id: card.card_id,
          action,
          comment,
          boardSlug: KANBAN_BOARD_SLUG,
        });
        const data = response.data ?? null;
        await applyMutationBoard(data);
        if (data?.ok) {
          Message.success(t('kanban.action.success', { defaultValue: 'Updated.' }));
          return true;
        }
        Message.warning(data?.reason_code || t('kanban.action.failed', { defaultValue: 'Action failed.' }));
        return false;
      } catch (actionError) {
        Message.error(
          actionError instanceof Error
            ? actionError.message
            : t('kanban.action.failed', { defaultValue: 'Action failed.' })
        );
        return false;
      } finally {
        setBusyCardId(null);
      }
    },
    [applyMutationBoard, t]
  );

  const applyNonCommentAction = useCallback(
    (card: IKanbanBoardCard, action: Exclude<KanbanCardAction, 'comment'>) => {
      void applyCardAction(card, action);
    },
    [applyCardAction]
  );

  const submitComment = useCallback(
    async (comment: string) => {
      if (!commentCard) return;
      setCommentSubmitting(true);
      const ok = await applyCardAction(commentCard, 'comment', comment);
      setCommentSubmitting(false);
      if (ok) setCommentCard(null);
    },
    [applyCardAction, commentCard]
  );

  const boardReady = view.kind === 'ready';

  return (
    <div className='size-full overflow-y-auto bg-fill-0'>
      <div className='mx-auto flex max-w-1280px flex-col gap-16px px-20px py-20px'>
        {/* Header */}
        <div className='flex flex-wrap items-start justify-between gap-12px'>
          <div className='min-w-0'>
            <h1 className='m-0 text-20px font-700 leading-28px text-t-primary'>
              {t('kanban.title', { defaultValue: 'Aufgaben' })}
            </h1>
            <p className='m-0 mt-4px max-w-720px text-12px leading-18px text-t-secondary'>
              {t('kanban.subtitle', { defaultValue: 'Das Board dieses Seats — läuft auf dem nativen Hermes-Kanban.' })}
            </p>
          </div>
          <div className='flex items-center gap-8px'>
            <Button shape='round' onClick={() => void refresh()} data-testid='kanban-refresh'>
              {t('kanban.refresh', { defaultValue: 'Refresh' })}
            </Button>
            <Button
              type='primary'
              shape='round'
              disabled={!boardReady || switching}
              data-testid='kanban-card-create-open'
              onClick={() => setCreateModalVisible(true)}
            >
              {t('kanban.create.open', { defaultValue: 'Neue Aufgabe' })}
            </Button>
          </div>
        </div>

        {/* Body */}
        {view.kind === 'loading' ? (
          <div className='flex min-h-240px items-center justify-center' data-testid='kanban-loading'>
            <Spin />
          </div>
        ) : view.kind === 'unavailable' ? (
          <div
            className='flex min-h-240px flex-col items-center justify-center gap-8px px-16px py-24px text-center'
            data-testid='kanban-unavailable'
          >
            <Empty
              description={
                <div className='flex flex-col gap-4px'>
                  <span className='text-13px font-600 text-t-primary'>{textOrDash(view.reasonCode)}</span>
                  <span className='text-12px text-t-secondary'>
                    {view.message || t('kanban.unavailable.description', { defaultValue: 'The board is unavailable.' })}
                  </span>
                </div>
              }
            />
          </div>
        ) : view.kind === 'noBoard' ? (
          <div
            className='flex min-h-240px flex-col items-center justify-center gap-8px px-16px py-24px text-center'
            data-testid='kanban-empty-no-board'
          >
            <Empty
              description={
                <div className='flex flex-col gap-4px'>
                  <span className='text-13px font-600 text-t-primary'>
                    {t('kanban.empty.title', { defaultValue: 'Noch kein Board in diesem Seat' })}
                  </span>
                  <span className='max-w-420px text-12px text-t-secondary'>
                    {t('kanban.empty.description', {
                      defaultValue: 'EVE kann eins anlegen — frag sie im Chat.',
                    })}
                  </span>
                </div>
              }
            />
          </div>
        ) : (
          <>
            <div className='flex flex-wrap items-center gap-8px text-12px leading-18px text-t-secondary'>
              <Tag color='gray' data-testid='kanban-board-slug'>
                {`${t('kanban.labels.board', { defaultValue: 'Board' })}: ${view.model.board.slug}`}
              </Tag>
              <Tag color='gray' data-testid='kanban-board-total'>
                {`${t('kanban.labels.cards', { defaultValue: 'Cards' })}: ${view.totalCards}`}
              </Tag>
              <Tag color='green'>HG-2.5</Tag>
            </div>
            <div
              className='grid gap-12px'
              style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))' }}
              data-testid='kanban-columns'
            >
              {view.columns.map((column) => (
                <KanbanColumnView
                  key={column.key}
                  column={column}
                  busyCardId={busyCardId}
                  locked={switching}
                  onMoveNext={moveCardNext}
                  onOpenComment={setCommentCard}
                  onApplyAction={applyNonCommentAction}
                />
              ))}
            </div>
          </>
        )}

        <KanbanCardCreateModal
          visible={createModalVisible}
          submitting={createSubmitting}
          onCancel={() => {
            if (!createSubmitting) setCreateModalVisible(false);
          }}
          onSubmit={submitCreateCard}
        />
        <KanbanCardCommentModal
          card={commentCard}
          submitting={commentSubmitting}
          onCancel={() => {
            if (!commentSubmitting) setCommentCard(null);
          }}
          onSubmit={submitComment}
        />
      </div>
    </div>
  );
};

/**
 * Default export — the seat-remount host. Keying the native board by the active
 * seat id remounts its read/status effects after a switch. A stable id is a
 * no-op for single-seat installs.
 */
const KanbanBoardHost: React.FC = () => {
  const activeSeatId = useActiveSeatId();
  return <NativeKanbanBoard key={activeSeatId} />;
};

export default KanbanBoardHost;

// Re-exported for unit tests (pure mapping is in kanbanBoardModel.ts, but these
// are the component seams the DOM tests exercise).
export { KanbanBoardPage as LegacyMarketingKanbanBoardPage, KanbanColumnView, buildOrderedColumns };
