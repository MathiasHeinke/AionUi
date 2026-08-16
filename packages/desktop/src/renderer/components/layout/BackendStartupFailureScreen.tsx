/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from 'react';
import { Button } from '@arco-design/web-react';
import { Caution, Download, FileText, Refresh } from '@renderer/components/icons';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type { BackendStartupFailureInfo } from '@/common/types/platform/electron';
import CommandEveGlyph from '@/renderer/components/commandEve/CommandEveGlyph';
import {
  COMMAND_EVE_BUILTIN_BACKGROUNDS,
  COMMAND_EVE_DEFAULT_BACKGROUND_ASSET_ID,
  COMMAND_EVE_OBSIDIAN_BACKGROUND_ASSET_ID,
} from '@/renderer/theme/visualBackgroundAssets';
import { openDownloadLatest } from './InstallationIntegrityDialog';

type PrimaryRecoveryAction = 'download' | 'restart' | 'none';
type DiagnosticsState = 'idle' | 'saving' | 'saved' | 'failed';

const backgroundUrlById = new Map(
  COMMAND_EVE_BUILTIN_BACKGROUNDS.map((background) => [background.id, background.imageUrl] as const)
);

export function getBackendStartupRecoveryAction(failure: BackendStartupFailureInfo): PrimaryRecoveryAction {
  if (
    failure.reason === 'backend_component_mismatch' ||
    failure.reason === 'backend_incomplete_installation' ||
    failure.reason === 'backend_package_architecture_mismatch'
  ) {
    return 'download';
  }
  if (failure.reason === 'backend_startup_failed' || failure.reason === 'backend_instance_conflict') {
    return 'restart';
  }
  return 'none';
}

function triggerDiagnosticsDownload(filename: string, data: number[]): void {
  const bytes = new Uint8Array(data);
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/gzip' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const BackendStartupFailureScreen: React.FC<{ failure: BackendStartupFailureInfo }> = ({ failure }) => {
  const { t } = useTranslation();
  const [diagnosticsState, setDiagnosticsState] = useState<DiagnosticsState>('idle');
  const primaryAction = getBackendStartupRecoveryAction(failure);
  const isDark = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const backgroundUrl =
    backgroundUrlById.get(
      isDark ? COMMAND_EVE_OBSIDIAN_BACKGROUND_ASSET_ID : COMMAND_EVE_DEFAULT_BACKGROUND_ASSET_ID
    ) ?? '';

  const copy = useMemo(() => {
    if (failure.reason === 'backend_component_mismatch') {
      return {
        title: t('common.backendStartup.componentMismatch.title'),
        description: t('common.backendStartup.componentMismatch.description'),
      };
    }
    if (failure.reason === 'backend_incomplete_installation') {
      return {
        title: t('common.backendStartup.incompleteInstallation.title'),
        description: t('common.backendStartup.incompleteInstallation.description'),
      };
    }
    if (failure.reason === 'backend_instance_conflict') {
      return {
        title: t('common.backendStartup.instanceConflict.title'),
        description: t('common.backendStartup.instanceConflict.description'),
      };
    }
    if (failure.reason === 'backend_package_architecture_mismatch') {
      return {
        title: t('common.backendStartup.packageArchitectureMismatch.title'),
        description: t('common.backendStartup.packageArchitectureMismatch.description', {
          packageArch: failure.packageArch ?? 'x64',
          deviceArch: failure.deviceArch ?? 'arm64',
          expectedArch: failure.expectedDownloadArch ?? 'arm64',
        }),
      };
    }
    if (failure.reason === 'backend_incompatible_runtime') {
      return {
        title: t('common.backendStartup.incompatibleRuntime.title'),
        description: t('common.backendStartup.incompatibleRuntime.description'),
      };
    }
    return {
      title: t('common.backendStartup.startupFailed.title'),
      description: t('common.backendStartup.startupFailed.description'),
    };
  }, [failure, t]);

  const saveDiagnostics = async () => {
    setDiagnosticsState('saving');
    try {
      const logs = await window.electronAPI?.collectFeedbackLogs?.();
      if (!logs) throw new Error('diagnostics-unavailable');
      triggerDiagnosticsDownload(logs.filename, logs.data);
      setDiagnosticsState('saved');
    } catch {
      setDiagnosticsState('failed');
    }
  };

  const requiredVersions = failure.requiredVersions?.map((version) => `GLIBC_${version}`).join(', ');
  const diagnosticMessage =
    diagnosticsState === 'saved'
      ? t('common.backendStartup.recovery.diagnosticsSaved')
      : diagnosticsState === 'failed'
        ? t('common.backendStartup.recovery.diagnosticsFailed')
        : null;

  return (
    <main
      className='eve-backend-recovery'
      style={{ '--eve-recovery-background': `url("${backgroundUrl}")` } as React.CSSProperties}
    >
      <section className='eve-backend-recovery__panel' role='alert' aria-labelledby='eve-backend-recovery-title'>
        <header className='eve-backend-recovery__header'>
          <CommandEveGlyph size={34} decorative={false} />
          <span>{t('common.backendStartup.recovery.eyebrow')}</span>
        </header>

        <div className='eve-backend-recovery__status-icon' aria-hidden='true'>
          <Caution size={22} />
        </div>

        <div className='eve-backend-recovery__copy'>
          <h1 id='eve-backend-recovery-title'>{copy.title}</h1>
          <p>{copy.description}</p>
          {requiredVersions ? (
            <p className='eve-backend-recovery__technical'>
              {t('common.backendStartup.incompatibleRuntime.requiredVersions', { versions: requiredVersions })}
            </p>
          ) : null}
          {failure.unsupportedArgument ? (
            <p className='eve-backend-recovery__technical'>
              <code>{failure.unsupportedArgument}</code>
            </p>
          ) : null}
        </div>

        <p className='eve-backend-recovery__data-safe'>{t('common.backendStartup.recovery.dataSafe')}</p>

        <footer className='eve-backend-recovery__actions'>
          <Button
            className='eve-backend-recovery__diagnostics'
            type='text'
            icon={<FileText size={16} />}
            loading={diagnosticsState === 'saving'}
            onClick={() => void saveDiagnostics()}
          >
            {t('common.backendStartup.recovery.saveDiagnostics')}
          </Button>
          <div className='eve-backend-recovery__primary-actions'>
            {primaryAction === 'download' ? (
              <Button
                className='eve-backend-recovery__primary'
                type='primary'
                size='large'
                icon={<Download size={17} />}
                onClick={openDownloadLatest}
              >
                {t('common.backendStartup.incompleteInstallation.downloadLatest')}
              </Button>
            ) : null}
            {primaryAction === 'restart' ? (
              <Button
                className='eve-backend-recovery__primary'
                type='primary'
                size='large'
                icon={<Refresh size={17} />}
                onClick={() => void ipcBridge.application.restart.invoke()}
              >
                {t('common.backendStartup.recovery.restart')}
              </Button>
            ) : null}
          </div>
        </footer>
        <span className='eve-backend-recovery__diagnostic-status' role='status' aria-live='polite'>
          {diagnosticMessage}
        </span>
      </section>
    </main>
  );
};

export default BackendStartupFailureScreen;
