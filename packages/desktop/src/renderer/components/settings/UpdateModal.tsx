/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Progress, Message } from '@arco-design/web-react';
import { CheckOne, Download, FolderOpen, Refresh, CloseOne, Install } from '@icon-park/react';
import { ipcBridge } from '@/common';
import { COMMAND_EVE_SHELL_ENABLED, formatCommandEveDisplayVersion } from '@/common/config/commandEveShell';
import AionModal from '@/renderer/components/base/AionModal';
import MarkdownView from '@/renderer/components/Markdown';
import type { UpdateDownloadProgressEvent, UpdateReleaseInfo } from '@/common/update/updateTypes';
import {
  getAutoUpdateStatusSnapshot,
  useAutoUpdateStatus,
  type AutoUpdateUiSnapshot,
} from '@/renderer/hooks/system/useAutoUpdateStatus';
import { useTranslation } from 'react-i18next';

declare const __APP_VERSION__: string;
const APP_VERSION = formatCommandEveDisplayVersion(typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0');

type UpdateStatus =
  | 'checking'
  | 'upToDate'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'success'
  | 'error';

type UpdateInfo = UpdateReleaseInfo;

const formatSpeed = (bytesPerSecond: number) => {
  if (bytesPerSecond > 1024 * 1024) {
    return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
  }
  return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
};

const formatSize = (bytes: number) => {
  if (bytes > 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / 1024).toFixed(1)} KB`;
};

const UpdateModal: React.FC = () => {
  const { t } = useTranslation();
  const downloadFailedLabel = t('update.downloadFailed');
  const autoUpdateStatus = useAutoUpdateStatus();
  const [visible, setVisible] = useState(false);
  const [status, setStatus] = useState<UpdateStatus>('checking');
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string>(APP_VERSION);
  const [downloadId, setDownloadId] = useState<string | null>(null);
  const [progress, setProgress] = useState({ percent: 0, speed: '', total: 0, transferred: 0 });
  const [errorMsg, setErrorMsg] = useState('');
  const [downloadPath, setDownloadPath] = useState('');
  const [releasePageUrl, setReleasePageUrl] = useState('');
  // Whether electron-updater auto-update is available (determined automatically, not user-controllable)
  const [autoUpdateAvailable, setAutoUpdateAvailable] = useState(false);
  const [autoUpdateInfo, setAutoUpdateInfo] = useState<{ version: string; releaseNotes?: string } | null>(null);

  const resetState = useCallback(() => {
    setStatus('checking');
    setUpdateInfo(null);
    setCurrentVersion(APP_VERSION);
    setDownloadId(null);
    setProgress({ percent: 0, speed: '', total: 0, transferred: 0 });
    setErrorMsg('');
    setDownloadPath('');
    setReleasePageUrl('');
    setAutoUpdateAvailable(false);
    setAutoUpdateInfo(null);
  }, []);

  const includePrerelease = useMemo(() => localStorage.getItem('update.includePrerelease') === 'true', [visible]);
  const hasCompatibleManualAsset = Boolean(updateInfo?.recommendedAsset);
  const manualInfoMatchesAuto = !autoUpdateInfo || !updateInfo || autoUpdateInfo.version === updateInfo.version;
  const displayedUpdateVersion = formatCommandEveDisplayVersion(autoUpdateInfo?.version || updateInfo?.version || '');
  const displayedReleaseName = manualInfoMatchesAuto ? updateInfo?.name : undefined;
  const displayedReleaseNotes = autoUpdateInfo?.releaseNotes || (manualInfoMatchesAuto ? updateInfo?.body : undefined);

  const openReleasePage = () => {
    if (!releasePageUrl) return;
    void ipcBridge.shell.openExternal.invoke(releasePageUrl).catch((error) => {
      console.error('Failed to open release page:', error);
    });
  };

  const checkForUpdates = useCallback(async () => {
    setStatus('checking');
    try {
      // Try auto-update (electron-updater) first
      let autoUpdateOk = false;
      try {
        const res = await ipcBridge.autoUpdate.check.invoke({ includePrerelease });
        if (res?.success && res.data?.updateInfo) {
          autoUpdateOk = true;
          setAutoUpdateInfo({
            version: res.data.updateInfo.version,
            releaseNotes: res.data.updateInfo.releaseNotes,
          });
        } else if (res?.msg) {
          console.warn('Auto-update check failed, using manual mode:', res.msg);
        }
      } catch (err) {
        console.warn('Auto-update check error, using manual mode:', err);
      }
      setAutoUpdateAvailable(autoUpdateOk);

      // The manual check (ipcBridge.update.check) hits the GitHub Releases API.
      // For Command EVE that repo is PRIVATE, so this call 404s/throws — it must
      // NOT surface as a UI error when the generic (electron-updater / R2) feed is
      // the authoritative source. We only use the manual result to ENRICH the
      // display (CDN-rewritten asset, release notes, html release page); the
      // generic feed already decided update-available / up-to-date.
      //
      // Treat the manual check as best-effort (non-fatal) whenever the generic
      // feed is active — either it just reported an update (autoUpdateOk) or this
      // is a Command EVE shell build (where the feed is the generic R2 bucket and
      // the GitHub manual path is structurally unavailable). Only in the pure
      // upstream/manual mode (no generic feed) is a manual-check failure fatal.
      const genericFeedActive = autoUpdateOk || COMMAND_EVE_SHELL_ENABLED;
      let res: Awaited<ReturnType<typeof ipcBridge.update.check.invoke>> | null = null;
      try {
        res = await ipcBridge.update.check.invoke({ includePrerelease });
      } catch (manualErr) {
        if (!genericFeedActive) throw manualErr;
        console.warn('Manual GitHub update check failed; tolerated (generic feed active):', manualErr);
      }
      if (res && !res.success) {
        if (!genericFeedActive) {
          throw new Error(res.msg || t('update.checkFailed'));
        }
        console.warn('Manual GitHub update check returned failure; tolerated (generic feed active):', res.msg);
        res = null;
      }
      if (res?.data?.currentVersion) {
        setCurrentVersion(formatCommandEveDisplayVersion(res.data.currentVersion));
      }

      if (autoUpdateOk) {
        // Auto-update available — use manual check data for display only when it
        // succeeded; otherwise the auto-update info (version/release notes) drives
        // the available state on its own.
        if (res?.data?.latest) {
          setUpdateInfo(res.data.latest);
          setReleasePageUrl(res.data.latest.htmlUrl || '');
        }
        setStatus(COMMAND_EVE_SHELL_ENABLED ? 'downloading' : 'available');
        return;
      }

      // Generic feed active (CE shell) but it reported no update AND the manual
      // GitHub path is unavailable: the feed is the source of truth, so this is a
      // clean "up to date", never a GitHub 404 error.
      if (genericFeedActive && !res) {
        setStatus('upToDate');
        return;
      }

      // Manual mode (pure upstream / GitHub path). `res` is non-null here: the
      // only paths that null it out already returned above (genericFeedActive),
      // and pure manual mode rethrows on a failed manual check.
      if (res?.data?.updateAvailable && res.data.latest) {
        setUpdateInfo(res.data.latest);
        setReleasePageUrl(res.data.latest.htmlUrl || '');
        if (!res.data.latest.recommendedAsset) {
          setErrorMsg(t('update.noCompatibleAssetManual'));
        }
        setStatus('available');
        return;
      }

      setUpdateInfo(res?.data?.latest || null);
      setReleasePageUrl(res?.data?.latest?.htmlUrl || '');
      setStatus('upToDate');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Update check failed:', err);
      setErrorMsg(msg);
      setStatus('error');
    }
  }, [includePrerelease, t]);

  const startDownload = async () => {
    if (!updateInfo && !autoUpdateAvailable) return;
    setStatus('downloading');
    try {
      // Prefer the manual path so the URL is the CDN-rewritten asset.url.
      // Fall back to electron-updater (GitHub) only when the GitHub API manual check failed
      // but the yml-based auto-update check succeeded — a rare edge case.
      // 优先走手动路径（URL 是重写后的 CDN 地址）。仅当 GitHub API 失败但 electron-updater 检查成功时，
      // 回退到 electron-updater 的下载（走 GitHub），保证用户能升级。
      if (updateInfo?.recommendedAsset) {
        const asset = updateInfo.recommendedAsset;
        const res = await ipcBridge.update.download.invoke({
          url: asset.url,
          fallbackUrl: asset.fallbackUrl,
          file_name: asset.name,
        });
        if (!res?.success || !res.data) {
          throw new Error(res?.msg || t('update.downloadStartFailed'));
        }
        setDownloadId(res.data.downloadId);
        setDownloadPath(res.data.file_path);
        return;
      }

      if (autoUpdateAvailable) {
        const res = await ipcBridge.autoUpdate.download.invoke();
        if (!res?.success) {
          throw new Error(res?.msg || t('update.downloadStartFailed'));
        }
        return;
      }

      throw new Error(t('update.noCompatibleAssetManual'));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Download failed:', err);
      setErrorMsg(msg);
      setStatus('error');
    }
  };

  const quitAndInstall = async () => {
    // Immediate feedback: spinning up the native MacUpdater + quitting takes ~1s, during
    // which nothing visibly happened (felt hung). Switch to the 'installing' spinner FIRST.
    setStatus('installing');
    try {
      await ipcBridge.autoUpdate.quitAndInstall.invoke();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Install failed:', err);
      Message.error(msg);
      setStatus('downloaded'); // revert so the user can retry the install
    }
  };

  const applyAutoUpdateStatus = useCallback(
    (snapshot: AutoUpdateUiSnapshot): boolean => {
      if (snapshot.status === 'idle') return false;
      setCurrentVersion(APP_VERSION);

      if ('version' in snapshot && snapshot.version) {
        setAutoUpdateAvailable(true);
        setAutoUpdateInfo({
          version: snapshot.version,
          releaseNotes: snapshot.releaseNotes,
        });
      }

      switch (snapshot.status) {
        case 'checking':
          setStatus('checking');
          return true;
        case 'available':
          setStatus(COMMAND_EVE_SHELL_ENABLED ? 'downloading' : 'available');
          return true;
        case 'downloading':
          setStatus('downloading');
          if (snapshot.progress) {
            setProgress({
              percent: Math.round(snapshot.progress.percent),
              speed: formatSpeed(snapshot.progress.bytesPerSecond),
              total: snapshot.progress.total,
              transferred: snapshot.progress.transferred,
            });
          }
          return true;
        case 'downloaded':
          setStatus('downloaded');
          return true;
        case 'error':
        case 'cancelled':
          setStatus('error');
          setErrorMsg(snapshot.error || downloadFailedLabel);
          return true;
        case 'not-available':
          setStatus('upToDate');
          return false;
      }
    },
    [downloadFailedLabel]
  );

  const handleOpenUpdateModal = useCallback(() => {
    const durableStatus = getAutoUpdateStatusSnapshot();
    setVisible(true);
    if (applyAutoUpdateStatus(durableStatus)) return;
    resetState();
    void checkForUpdates();
  }, [applyAutoUpdateStatus, checkForUpdates, resetState]);

  useEffect(() => {
    const removeOpenListener = ipcBridge.update.open.on(handleOpenUpdateModal);
    window.addEventListener('aionui-open-update-modal', handleOpenUpdateModal);

    return () => {
      removeOpenListener();
      window.removeEventListener('aionui-open-update-modal', handleOpenUpdateModal);
    };
  }, [handleOpenUpdateModal]);

  useEffect(() => {
    if (!visible) return;
    applyAutoUpdateStatus(autoUpdateStatus);
  }, [applyAutoUpdateStatus, autoUpdateStatus, visible]);

  useEffect(() => {
    const removeProgressListener = ipcBridge.update.downloadProgress.on((evt: UpdateDownloadProgressEvent) => {
      if (!evt) return;
      if (!downloadId || evt.downloadId !== downloadId) return;

      setProgress({
        percent: Math.round(evt.percent ?? 0),
        speed: formatSpeed(evt.bytesPerSecond ?? 0),
        total: evt.totalBytes ?? 0,
        transferred: evt.receivedBytes ?? 0,
      });

      if (evt.status === 'completed') {
        setStatus('success');
        if (evt.file_path) {
          setDownloadPath(evt.file_path);
        }
      } else if (evt.status === 'error' || evt.status === 'cancelled') {
        setStatus('error');
        setErrorMsg(evt.error || t('update.downloadFailed'));
      }
    });

    return () => {
      removeProgressListener();
    };
  }, [downloadId, t]);

  const handleClose = () => {
    setVisible(false);
  };

  const openFile = () => {
    if (!downloadPath) return;
    void ipcBridge.shell.openFile.invoke(downloadPath).catch((error) => {
      console.error('Failed to open file:', error);
    });
  };

  const showInFolder = () => {
    if (!downloadPath) return;
    void ipcBridge.shell.showItemInFolder.invoke(downloadPath).catch((error) => {
      console.error('Failed to show item in folder:', error);
    });
  };

  const renderContent = () => {
    switch (status) {
      case 'checking':
        return (
          <div className='flex flex-col items-center justify-center py-48px'>
            <div className='w-48px h-48px mb-20px relative'>
              <div className='absolute inset-0 border-3 border-fill-3 rounded-full' />
              <div className='absolute inset-0 border-3 border-primary border-t-transparent rounded-full animate-spin' />
            </div>
            <div className='text-15px text-t-primary font-500'>{t('update.checking')}</div>
          </div>
        );

      case 'upToDate':
        return (
          <div className='flex flex-col items-center justify-center py-48px'>
            <div className='w-56px h-56px bg-[rgb(var(--success-6))]/12 rounded-full flex items-center justify-center mb-20px'>
              <CheckOne theme='filled' size='28' fill='rgb(var(--success-6))' />
            </div>
            <div className='text-16px text-t-primary font-600 mb-8px'>{t('update.upToDateTitle')}</div>
            <div className='text-13px text-t-tertiary'>
              {t('update.currentVersion', { version: currentVersion || '-' })}
            </div>
          </div>
        );

      case 'available':
        return (
          <div className='flex flex-col h-full'>
            {/* Version info header */}
            <div className='flex items-center justify-between px-24px py-16px border-b border-border-2 bg-fill-1'>
              <div className='flex items-center gap-12px'>
                <div className='w-40px h-40px bg-[rgb(var(--primary-6))]/12 rounded-10px flex items-center justify-center'>
                  <Download size='20' fill='rgb(var(--primary-6))' />
                </div>
                <div>
                  <div className='text-15px font-600 text-t-primary'>{t('update.availableTitle')}</div>
                  <div className='text-12px text-t-tertiary mt-2px'>
                    {currentVersion} →{' '}
                    <span className='text-[rgb(var(--primary-6))] font-500'>{displayedUpdateVersion}</span>
                  </div>
                </div>
              </div>
              <div className='flex items-center gap-12px'>
                {!hasCompatibleManualAsset && !autoUpdateAvailable && releasePageUrl ? (
                  <Button type='primary' size='small' onClick={openReleasePage} className='!px-16px'>
                    {t('update.goToRelease')}
                  </Button>
                ) : autoUpdateAvailable ? (
                  <Button type='primary' size='small' onClick={startDownload} className='!px-16px'>
                    {t('update.downloadAndInstall')}
                  </Button>
                ) : (
                  <Button type='primary' size='small' onClick={startDownload} className='!px-16px'>
                    {t('update.downloadButton')}
                  </Button>
                )}
              </div>
            </div>

            {!hasCompatibleManualAsset && !autoUpdateAvailable && (
              <div className='mx-24px mt-12px px-12px py-10px text-12px rounded-8px bg-[rgb(var(--warning-6))]/10 text-[rgb(var(--warning-6))]'>
                {t('update.noCompatibleAssetManual')}
              </div>
            )}

            {/* Release notes content */}
            <div className='flex-1 min-h-0 overflow-y-auto px-24px py-16px custom-scrollbar'>
              {displayedReleaseName && (
                <div className='text-14px font-500 text-t-primary mb-12px'>{displayedReleaseName}</div>
              )}
              {displayedReleaseNotes ? (
                <div className='text-13px text-t-secondary leading-relaxed'>
                  <MarkdownView>{displayedReleaseNotes}</MarkdownView>
                </div>
              ) : (
                <div className='text-13px text-t-tertiary italic'>{t('update.noReleaseNotes')}</div>
              )}
            </div>
          </div>
        );

      case 'downloading':
        return (
          <div className='flex flex-col items-center justify-center py-48px px-32px'>
            <div className='w-56px h-56px bg-[rgb(var(--primary-6))]/12 rounded-full flex items-center justify-center mb-20px'>
              <Download size='24' fill='rgb(var(--primary-6))' className='animate-bounce' />
            </div>
            <div className='text-16px text-t-primary font-600 mb-20px'>{t('update.downloadingTitle')}</div>
            <div className='w-full max-w-320px'>
              <Progress
                percent={progress.percent}
                status='normal'
                showText={false}
                strokeWidth={6}
                className='!mb-12px'
              />
              <div className='flex justify-between text-12px text-t-tertiary'>
                <span>
                  {formatSize(progress.transferred)} / {formatSize(progress.total)}
                </span>
                <span className='text-[rgb(var(--primary-6))] font-500'>{progress.speed}</span>
              </div>
            </div>
            <div className='mt-20px max-w-360px text-center text-12px leading-18px text-t-tertiary'>
              {t('update.backgroundDownloadActive')}
            </div>
          </div>
        );

      case 'downloaded':
        return (
          <div className='flex h-full min-h-0 flex-col'>
            <div className='flex items-start gap-14px px-24px py-18px'>
              <div className='mt-1px flex h-42px w-42px flex-none items-center justify-center rounded-10px bg-[color-mix(in_srgb,var(--eve-accent)_14%,transparent)] text-[var(--eve-accent)]'>
                <CheckOne theme='filled' size='22' fill='currentColor' />
              </div>
              <div className='min-w-0 flex-1'>
                <div className='text-16px font-600 leading-22px text-t-primary'>{t('update.readyToInstall')}</div>
                <div className='mt-4px text-13px leading-19px text-t-secondary'>
                  {t('update.versionTransition', {
                    currentVersion,
                    targetVersion: displayedUpdateVersion || '-',
                  })}
                </div>
                <div className='mt-4px text-12px leading-18px text-t-tertiary'>
                  {t('update.includesSkippedUpdates')}
                </div>
              </div>
            </div>

            <div className='mx-24px border-t border-[var(--glass-overlay-border)]' />

            <div className='min-h-0 flex-1 overflow-y-auto px-24px py-16px custom-scrollbar'>
              <div className='mb-10px text-12px font-600 uppercase text-t-tertiary'>{t('update.whatsNew')}</div>
              {displayedReleaseNotes ? (
                <div className='text-13px leading-relaxed text-t-secondary'>
                  <MarkdownView>{displayedReleaseNotes}</MarkdownView>
                </div>
              ) : (
                <div className='text-13px text-t-tertiary'>{t('update.noReleaseNotes')}</div>
              )}
            </div>

            <div className='flex flex-wrap items-center justify-between gap-12px border-t border-[var(--glass-overlay-border)] px-24px py-16px'>
              <div className='max-w-300px text-12px leading-18px text-t-tertiary'>{t('update.restartDescription')}</div>
              <div className='flex items-center gap-10px'>
                <Button type='text' size='small' onClick={handleClose} className='!px-12px'>
                  {t('update.later')}
                </Button>
                <Button
                  type='primary'
                  size='small'
                  onClick={quitAndInstall}
                  icon={<Install size='14' />}
                  className='!px-16px'
                >
                  {t('update.installNow')}
                </Button>
              </div>
            </div>
          </div>
        );

      case 'installing':
        return (
          <div className='flex flex-col items-center justify-center py-48px'>
            <div className='w-48px h-48px mb-20px relative'>
              <div className='absolute inset-0 border-3 border-fill-3 rounded-full' />
              <div className='absolute inset-0 border-3 border-primary border-t-transparent rounded-full animate-spin' />
            </div>
            <div className='text-15px text-t-primary font-500'>{t('update.installing')}</div>
          </div>
        );

      case 'success':
        return (
          <div className='flex flex-col items-center justify-center py-48px px-32px'>
            <div className='w-56px h-56px bg-[rgb(var(--success-6))]/12 rounded-full flex items-center justify-center mb-20px'>
              <CheckOne theme='filled' size='28' fill='rgb(var(--success-6))' />
            </div>
            <div className='text-16px text-t-primary font-600 mb-8px'>{t('update.downloadCompleteTitle')}</div>
            <div className='text-12px text-t-tertiary mb-24px text-center max-w-360px break-all line-clamp-2'>
              {downloadPath}
            </div>
            <div className='flex gap-12px'>
              <Button size='small' onClick={showInFolder} icon={<FolderOpen size='14' />} className='!px-16px'>
                {t('update.showInFolder')}
              </Button>
              <Button type='primary' size='small' onClick={openFile} className='!px-16px'>
                {t('update.openFile')}
              </Button>
            </div>
          </div>
        );

      case 'error':
        return (
          <div className='flex flex-col items-center justify-center py-48px px-32px'>
            <div className='w-56px h-56px bg-[rgb(var(--danger-6))]/12 rounded-full flex items-center justify-center mb-20px'>
              <CloseOne theme='filled' size='28' fill='rgb(var(--danger-6))' />
            </div>
            <div className='text-16px text-t-primary font-600 mb-8px'>{t('update.errorTitle')}</div>
            <div className='text-13px text-t-tertiary mb-24px text-center max-w-360px'>{errorMsg}</div>
            <div className='flex gap-12px'>
              <Button size='small' onClick={checkForUpdates} icon={<Refresh size='14' />} className='!px-16px'>
                {t('common.retry')}
              </Button>
              {releasePageUrl && (
                <Button type='primary' size='small' onClick={openReleasePage} className='!px-16px'>
                  {t('update.goToRelease')}
                </Button>
              )}
            </div>
          </div>
        );
    }
  };

  return (
    <AionModal
      visible={visible}
      onCancel={handleClose}
      size={status === 'available' || status === 'downloaded' ? 'medium' : 'small'}
      header={{
        title: status === 'downloaded' ? t('update.readyTitle') : t('update.modalTitle'),
        showClose: true,
      }}
      footer={{ render: () => null }}
      contentStyle={{
        height: status === 'available' || status === 'downloaded' ? '420px' : 'auto',
        padding: 0,
        overflow: 'hidden',
      }}
    >
      <div className='flex flex-col h-full w-full'>{renderContent()}</div>
    </AionModal>
  );
};

export default UpdateModal;
