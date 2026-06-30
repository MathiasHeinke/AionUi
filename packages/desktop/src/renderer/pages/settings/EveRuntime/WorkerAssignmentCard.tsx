/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * WorkerAssignmentCard — "Externe Worker" card (HONEST STUB for 1.2.18).
 *
 * Surfaces OUR conductor model: the operator can declare an external CLI worker
 * (Claude Code CLI / Codex CLI) that EVE would dispatch to. In 1.2.18 this is a
 * PURE STUB — per founder decision, persistence + actual dispatch wiring land in
 * 1.2.19. The card MUST NOT fake a capability:
 *
 *   - "Verbindung testen" is CLIENT-SIDE validation only (non-empty + looks like
 *     an absolute path). There is no renderer bridge that does fs.existsSync on an
 *     arbitrary path, so we do NOT claim to actually probe the binary — the button
 *     label and result copy say so honestly.
 *   - "Speichern" is a NO-OP: it does not persist anything. It only console.info's
 *     the intended assignment so 1.2.19 has a record of the shape.
 *   - The worker list renders EMPTY with honest "kommt in 1.2.19" copy.
 *
 * Do NOT invent a backend route here. Do NOT wire this into eveTeamControlsCore /
 * evaluateWorkerDispatch — that is the 1.2.19 integration.
 */

import { Button, Input, Message, Modal } from '@arco-design/web-react';
import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

type WorkerKind = 'claude-code' | 'codex';

/** Pure, client-side path sanity check. Honest: existence is NOT probed here. */
const looksLikeAbsolutePath = (raw: string): boolean => {
  const value = raw.trim();
  if (!value) return false;
  // POSIX (`/usr/local/bin/claude`) or Windows (`C:\...`). EVE ships on macOS,
  // but accept both so the validation isn't subtly wrong on other platforms.
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
};

const EveRuntimeWorkerAssignmentCard: React.FC = () => {
  const { t } = useTranslation();
  const [modalKind, setModalKind] = useState<WorkerKind | null>(null);
  const [cliPath, setCliPath] = useState('');
  const [testResult, setTestResult] = useState<'idle' | 'ok' | 'invalid'>('idle');

  const kindLabel = useMemo<Record<WorkerKind, string>>(
    () => ({
      'claude-code': t('eveRuntime.workerAssignment.claudeCode', { defaultValue: 'Claude Code CLI' }),
      codex: t('eveRuntime.workerAssignment.codex', { defaultValue: 'Codex CLI' }),
    }),
    [t]
  );

  const openModal = useCallback((kind: WorkerKind) => {
    setModalKind(kind);
    setCliPath('');
    setTestResult('idle');
  }, []);

  const closeModal = useCallback(() => {
    setModalKind(null);
    setCliPath('');
    setTestResult('idle');
  }, []);

  const handleTestConnection = useCallback(() => {
    // HONEST: this is local string validation only — we do NOT verify the binary
    // exists or is runnable. There is no path-probe bridge in 1.2.18.
    const valid = looksLikeAbsolutePath(cliPath);
    setTestResult(valid ? 'ok' : 'invalid');
  }, [cliPath]);

  const handleSave = useCallback(() => {
    if (modalKind === null) return;
    // STUB: no persistence. 1.2.19 wires this into the worker registry + dispatch.
    // We only log the intended assignment shape so the integration has a record.
    // eslint-disable-next-line no-console
    console.info('[EveRuntime] (stub) intended external worker assignment — NOT persisted', {
      kind: modalKind,
      agent_id: modalKind, // intended agent_id placeholder for 1.2.19
      cli_path: cliPath.trim(),
      persisted: false,
      shipsIn: '1.2.19',
    });
    Message.info(
      t('eveRuntime.workerAssignment.savedStub', {
        defaultValue: 'Vorgemerkt (noch nicht gespeichert) — Worker-Zuweisung kommt in 1.2.19.',
      })
    );
    closeModal();
  }, [modalKind, cliPath, t, closeModal]);

  return (
    <section className='rounded-16px border border-solid border-[var(--color-border-2)] bg-bg-2 px-18px py-16px'>
      <header className='mb-3'>
        <div className='text-base font-medium text-t-primary'>
          {t('eveRuntime.workerAssignment.title', { defaultValue: 'Externe Worker' })}
        </div>
        <div className='text-sm text-t-secondary'>
          {t('eveRuntime.workerAssignment.subtitle', {
            defaultValue:
              'Du bist der Dirigent. EVE orchestriert das Team — hier weist du später deine eigene Claude Code / Codex CLI als zusätzlichen Worker zu.',
          })}
        </div>
      </header>

      <div className='flex flex-wrap gap-2'>
        <Button onClick={() => openModal('claude-code')}>
          {t('eveRuntime.workerAssignment.addClaudeCode', { defaultValue: 'Claude Code CLI hinzufügen' })}
        </Button>
        <Button onClick={() => openModal('codex')}>
          {t('eveRuntime.workerAssignment.addCodex', { defaultValue: 'Codex CLI hinzufügen' })}
        </Button>
      </div>

      {/* Empty list — HONEST 1.2.19 copy. No fake "connected" rows. */}
      <div className='mt-3 rounded-12px border border-dashed border-[var(--color-border-2)] bg-bg-1 px-14px py-12px text-sm text-t-secondary'>
        {t('eveRuntime.workerAssignment.stub', {
          defaultValue:
            'Kommt in 1.2.19 — EVE nutzt vorerst das feste Team. Dein Claude Code / Codex CLI wird als Worker zuweisbar, sobald die Backend-Integration steht.',
        })}
      </div>

      <Modal
        title={
          modalKind
            ? t('eveRuntime.workerAssignment.modalTitle', {
                defaultValue: `${kindLabel[modalKind]} als Worker hinzufügen`,
              })
            : ''
        }
        visible={modalKind !== null}
        onCancel={closeModal}
        footer={
          <div className='flex justify-end gap-2'>
            <Button onClick={closeModal}>{t('common.cancel', { defaultValue: 'Abbrechen' })}</Button>
            <Button type='primary' disabled={!looksLikeAbsolutePath(cliPath)} onClick={handleSave}>
              {t('common.save', { defaultValue: 'Speichern' })}
            </Button>
          </div>
        }
      >
        <div className='flex flex-col gap-2'>
          <label className='text-sm text-t-primary'>
            {t('eveRuntime.workerAssignment.cliPathLabel', { defaultValue: 'Pfad zur CLI' })}
          </label>
          <div className='flex items-center gap-2'>
            <Input
              value={cliPath}
              onChange={(value) => {
                setCliPath(value);
                setTestResult('idle');
              }}
              placeholder={t('eveRuntime.workerAssignment.cliPathPlaceholder', {
                defaultValue: '/usr/local/bin/claude',
              })}
            />
            <Button onClick={handleTestConnection}>
              {t('eveRuntime.workerAssignment.testConnection', { defaultValue: 'Verbindung testen' })}
            </Button>
          </div>

          {testResult === 'ok' && (
            <p className='m-0 text-xs text-[var(--color-success-6,#00b42a)]'>
              {t('eveRuntime.workerAssignment.testOk', {
                defaultValue: 'Sieht nach einem gültigen Pfad aus. Hinweis: ob die CLI wirklich läuft, prüft EVE erst in 1.2.19.',
              })}
            </p>
          )}
          {testResult === 'invalid' && (
            <p className='m-0 text-xs text-[var(--color-danger-6,#f53f3f)]'>
              {t('eveRuntime.workerAssignment.testInvalid', {
                defaultValue: 'Bitte einen absoluten Pfad angeben (z. B. /usr/local/bin/claude).',
              })}
            </p>
          )}

          <p className='m-0 mt-1 text-xs text-t-secondary'>
            {t('eveRuntime.workerAssignment.modalStub', {
              defaultValue:
                'Reiner Platzhalter: „Verbindung testen“ prüft nur die Pfad-Form, „Speichern“ merkt die Zuweisung vor, speichert sie aber noch nicht. Aktivierung folgt in 1.2.19.',
            })}
          </p>
        </div>
      </Modal>
    </section>
  );
};

export default EveRuntimeWorkerAssignmentCard;
