/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * WorkerAssignmentCard — "Externe Worker" card (CLI-Keystone, 1.2.20).
 *
 * The agent_id PRODUCER. This card was a NO-OP stub through 1.2.18: it invented
 * an agent_id ('claude-code' | 'codex') with no Hermes counterpart and persisted
 * nothing. It now writes a REAL, PERSISTED worker assignment bound to a known
 * roster role (the namespace JOIN) through the existing config service
 * (`commandEve.workerAssignments`), produced + validated by the pure
 * eveWorkerAssignmentCore:
 *
 *   - "Claude" = a per-task ACP delegate worker via the claude-agent-acp adapter
 *     (bunx @agentclientprotocol/claude-agent-acp, or the operator's CLI path).
 *     Auth = the machine-local `claude` login. Labelled "Claude" — NEVER
 *     "Copilot" (the underlying generic-ACP provider is copilot-NAMED only).
 *   - "Codex" = a runtime-MODE toggle: an assigned, version-OK (>=0.125) Codex
 *     flips `model.openai_runtime=codex_app_server` in the Hermes config the
 *     bootstrapper writes. A too-old / unknown version is shown as "not yet
 *     active" — honest, not faked.
 *
 * HONESTY WALL: assigning a worker here does NOT auto-run it. Dispatch stays
 * gated by the existing "Dein Team" status (active/paused/off) AND the permission
 * path (terminal/YOLO = auto-run shell — a newly-assigned CLI worker is never
 * auto-run). The card persists intent + binding; the send-path resolves routing
 * only for an allowed worker and still applies the human-gate before spawning.
 */

import { Button, Input, Message, Modal, Select, Tag } from '@arco-design/web-react';
import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfig } from '@renderer/hooks/config/useConfig';
import { EVE_TEAM_ROSTER, findEveTeamRole } from '@/common/config/eveTeamRoster';
import {
  buildWorkerAssignment,
  looksLikeAbsolutePath,
  resolveWorkerRouting,
  workerKindLabel,
  type EveWorkerAssignment,
  type EveWorkerKind,
} from '@/common/config/eveWorkerAssignmentCore';

const CLI_KINDS: readonly EveWorkerKind[] = ['claude', 'codex'] as const;

const EveRuntimeWorkerAssignmentCard: React.FC = () => {
  const { t } = useTranslation();
  const [assignments, setAssignments] = useConfig('commandEve.workerAssignments');
  const [statuses] = useConfig('commandEve.teamWorkerStatus');

  const [modalOpen, setModalOpen] = useState(false);
  const [kind, setKind] = useState<EveWorkerKind>('claude');
  const [agentId, setAgentId] = useState<string>('');
  const [cliPath, setCliPath] = useState('');
  const [cliVersion, setCliVersion] = useState('');
  const [testResult, setTestResult] = useState<'idle' | 'ok' | 'invalid'>('idle');

  // Roster roles a CLI worker may bind to (the JOIN target). Governance seats are
  // eligible too (Codex as a runtime-mode for the main turn is a leadership-lane
  // concept), so the whole roster is offered — keyed by stable agent_id.
  const roleOptions = useMemo(
    () => EVE_TEAM_ROSTER.map((r) => ({ label: `${r.displayName} · ${r.title}`, value: r.agent_id })),
    []
  );

  const rows = useMemo(() => Object.entries(assignments ?? {}), [assignments]);

  const openModal = useCallback(() => {
    setKind('claude');
    setAgentId('');
    setCliPath('');
    setCliVersion('');
    setTestResult('idle');
    setModalOpen(true);
  }, []);

  const closeModal = useCallback(() => setModalOpen(false), []);

  const handleTestConnection = useCallback(() => {
    // HONEST: local string validation only (an empty path is allowed — the
    // documented launcher, bunx/codex-on-PATH, is used). We do NOT probe the
    // binary here; whether the CLI truly runs is proven at dispatch.
    const value = cliPath.trim();
    setTestResult(!value || looksLikeAbsolutePath(value) ? 'ok' : 'invalid');
  }, [cliPath]);

  const canSave = useMemo(() => {
    if (!agentId) return false;
    return buildWorkerAssignment({ agent_id: agentId, kind, cli_path: cliPath, cli_version: cliVersion }) !== null;
  }, [agentId, kind, cliPath, cliVersion]);

  const handleSave = useCallback(async () => {
    const assignment = buildWorkerAssignment({
      agent_id: agentId,
      kind,
      cli_path: cliPath,
      cli_version: cliVersion,
    });
    if (!assignment) {
      Message.error(
        t('eveRuntime.workerAssignment.saveInvalid', {
          defaultValue: 'Bitte eine Rolle wählen und (optional) einen gültigen absoluten Pfad angeben.',
        })
      );
      return;
    }
    const next = { ...assignments, [assignment.agent_id]: stripAssignment(assignment) };
    await setAssignments(next);
    Message.success(
      t('eveRuntime.workerAssignment.saved', {
        defaultValue: 'Worker zugewiesen. Einsatz bleibt über „Dein Team“ und die Freigabe-Stufe gesteuert.',
      })
    );
    setModalOpen(false);
  }, [agentId, kind, cliPath, cliVersion, assignments, setAssignments, t]);

  const handleRemove = useCallback(
    async (id: string) => {
      const next = { ...assignments };
      delete next[id];
      await setAssignments(next);
    },
    [assignments, setAssignments]
  );

  return (
    <section className='rounded-16px border border-solid border-[var(--color-border-2)] bg-bg-2 px-18px py-16px'>
      <header className='mb-3'>
        <div className='text-base font-medium text-t-primary'>
          {t('eveRuntime.workerAssignment.title', { defaultValue: 'Externe Worker' })}
        </div>
        <div className='text-sm text-t-secondary'>
          {t('eveRuntime.workerAssignment.subtitle', {
            defaultValue:
              'Du bist der Dirigent. Weise deine eigene Claude- oder Codex-CLI einer Rolle zu — EVE setzt sie als zusätzlichen Worker ein. Der Einsatz bleibt über „Dein Team“ und die Freigabe-Stufe gesteuert.',
          })}
        </div>
      </header>

      <div className='flex flex-wrap gap-2'>
        <Button type='primary' onClick={openModal}>
          {t('eveRuntime.workerAssignment.add', { defaultValue: 'Worker zuweisen' })}
        </Button>
      </div>

      {rows.length === 0 ? (
        <div className='mt-3 rounded-12px border border-dashed border-[var(--color-border-2)] bg-bg-1 px-14px py-12px text-sm text-t-secondary'>
          {t('eveRuntime.workerAssignment.empty', {
            defaultValue:
              'Noch kein externer Worker zugewiesen. EVE nutzt das feste Team. Weise deine Claude- oder Codex-CLI zu, um sie als Worker einzusetzen.',
          })}
        </div>
      ) : (
        <ul className='mt-3 flex list-none flex-col gap-2 p-0'>
          {rows.map(([id, raw]) => {
            const assignment: EveWorkerAssignment = { agent_id: id, ...raw };
            const routing = resolveWorkerRouting(assignment);
            const role = findEveTeamRole(id);
            const status = statuses?.[id] ?? 'active';
            return (
              <li
                key={id}
                className='flex items-center justify-between gap-3 rounded-12px border border-solid border-[var(--color-border-2)] bg-bg-1 px-14px py-10px'
              >
                <div className='flex flex-col gap-1'>
                  <div className='text-sm font-medium text-t-primary'>{workerKindLabel(assignment.kind, role)}</div>
                  <div className='flex flex-wrap items-center gap-2 text-xs text-t-secondary'>
                    {/* status gate (Dein Team) */}
                    <Tag size='small' color={status === 'active' ? 'green' : status === 'paused' ? 'orange' : 'gray'}>
                      {status === 'active'
                        ? t('eveRuntime.workerAssignment.statusActive', { defaultValue: 'aktiv' })
                        : status === 'paused'
                          ? t('eveRuntime.workerAssignment.statusPaused', { defaultValue: 'gedrosselt' })
                          : t('eveRuntime.workerAssignment.statusOff', { defaultValue: 'aus' })}
                    </Tag>
                    {/* CODEX is DEFERRED on the EVE custom-provider cloud build:
                        emitting model.openai_runtime would be a silent no-op (the
                        wheel ignores it for provider=custom), so we show an honest
                        "bald verfügbar" rather than a fake "active". */}
                    {assignment.kind === 'codex' && routing.codexDeferred && (
                      <Tag size='small' color='gold'>
                        {t('eveRuntime.workerAssignment.codexDeferred', {
                          defaultValue: 'Codex: bald verfügbar — noch nicht aktiv',
                        })}
                      </Tag>
                    )}
                    {assignment.kind === 'claude' && (
                      <span>
                        {t('eveRuntime.workerAssignment.claudeAuth', {
                          defaultValue: 'Auth über deinen lokalen claude-Login',
                        })}
                      </span>
                    )}
                  </div>
                </div>
                <Button size='small' status='danger' onClick={() => handleRemove(id)}>
                  {t('eveRuntime.workerAssignment.remove', { defaultValue: 'Entfernen' })}
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <Modal
        title={t('eveRuntime.workerAssignment.modalTitle', { defaultValue: 'Externen Worker zuweisen' })}
        visible={modalOpen}
        onCancel={closeModal}
        footer={
          <div className='flex justify-end gap-2'>
            <Button onClick={closeModal}>{t('common.cancel', { defaultValue: 'Abbrechen' })}</Button>
            <Button type='primary' disabled={!canSave} onClick={handleSave}>
              {t('common.save', { defaultValue: 'Speichern' })}
            </Button>
          </div>
        }
      >
        <div className='flex flex-col gap-3'>
          <div className='flex flex-col gap-1'>
            <label className='text-sm text-t-primary'>
              {t('eveRuntime.workerAssignment.kindLabel', { defaultValue: 'Welche CLI?' })}
            </label>
            <Select value={kind} onChange={(value) => setKind(value as EveWorkerKind)}>
              {CLI_KINDS.map((k) => (
                // Codex is DEFERRED (see CODEX_DEFER_REASON): shown but disabled so
                // the operator can't assign a worker that would silently do nothing.
                <Select.Option key={k} value={k} disabled={k === 'codex'}>
                  {k === 'claude'
                    ? 'Claude (Claude Code CLI)'
                    : t('eveRuntime.workerAssignment.codexOptionSoon', {
                        defaultValue: 'Codex (Codex CLI) — bald verfügbar',
                      })}
                </Select.Option>
              ))}
            </Select>
          </div>

          <div className='flex flex-col gap-1'>
            <label className='text-sm text-t-primary'>
              {t('eveRuntime.workerAssignment.roleLabel', { defaultValue: 'An welche Rolle binden?' })}
            </label>
            <Select
              value={agentId || undefined}
              placeholder={t('eveRuntime.workerAssignment.rolePlaceholder', { defaultValue: 'Rolle wählen' })}
              onChange={(value) => setAgentId(value as string)}
            >
              {roleOptions.map((opt) => (
                <Select.Option key={opt.value} value={opt.value}>
                  {opt.label}
                </Select.Option>
              ))}
            </Select>
          </div>

          <div className='flex flex-col gap-1'>
            <label className='text-sm text-t-primary'>
              {t('eveRuntime.workerAssignment.cliPathLabel', { defaultValue: 'Pfad zur CLI (optional)' })}
            </label>
            <div className='flex items-center gap-2'>
              <Input
                value={cliPath}
                onChange={(value) => {
                  setCliPath(value);
                  setTestResult('idle');
                }}
                placeholder={kind === 'claude' ? '/usr/local/bin/claude' : '/usr/local/bin/codex'}
              />
              <Button onClick={handleTestConnection}>
                {t('eveRuntime.workerAssignment.testConnection', { defaultValue: 'Pfad prüfen' })}
              </Button>
            </div>
            {testResult === 'ok' && (
              <p className='m-0 text-xs text-[var(--color-success-6,#00b42a)]'>
                {t('eveRuntime.workerAssignment.testOk', {
                  defaultValue:
                    'Pfad-Form ok (leer = Standard-Launcher). Ob die CLI wirklich läuft, prüft EVE erst beim Einsatz.',
                })}
              </p>
            )}
            {testResult === 'invalid' && (
              <p className='m-0 text-xs text-[var(--color-danger-6,#f53f3f)]'>
                {t('eveRuntime.workerAssignment.testInvalid', {
                  defaultValue: 'Bitte einen absoluten Pfad angeben (z. B. /usr/local/bin/claude) oder leer lassen.',
                })}
              </p>
            )}
          </div>

          {kind === 'codex' && (
            <div className='flex flex-col gap-1'>
              <p className='m-0 text-xs text-[var(--color-warning-6,#ff7d00)]'>
                {t('eveRuntime.workerAssignment.codexDeferredHint', {
                  defaultValue:
                    'Codex ist auf der EVE-Cloud-Lane noch nicht als Worker verfügbar (die gebündelte Runtime ignoriert den Codex-App-Server bei provider=custom — es würde nichts tun). Sobald es einen sauberen Codex-Delegate-Pfad gibt, wird es hier aktiv. Aktuell: nutze Claude als externen Worker.',
                })}
              </p>
            </div>
          )}

          <p className='m-0 text-xs text-t-secondary'>
            {t('eveRuntime.workerAssignment.modalNote', {
              defaultValue:
                'Zuweisen startet nichts automatisch. Der Einsatz bleibt über „Dein Team“ (aktiv/gedrosselt/aus) und die Freigabe-Stufe gesteuert — eine neu zugewiesene CLI wird nie ohne Freigabe ausgeführt.',
            })}
          </p>
        </div>
      </Modal>
    </section>
  );
};

/** Drop the redundant agent_id (it is the map key) before persisting. */
function stripAssignment(a: EveWorkerAssignment): { kind: EveWorkerKind; cli_path?: string; cli_version?: string } {
  const out: { kind: EveWorkerKind; cli_path?: string; cli_version?: string } = { kind: a.kind };
  if (a.cli_path) out.cli_path = a.cli_path;
  if (a.cli_version) out.cli_version = a.cli_version;
  return out;
}

export default EveRuntimeWorkerAssignmentCard;
