/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { IGeneratedArtifactType, IGeneratedConversationArtifact } from '@/common/adapter/ipcBridge';
import MarkdownView from '@/renderer/components/Markdown';
import { iconColors } from '@/renderer/styles/colors';
import { Message } from '@arco-design/web-react';
import { FolderOpen, Paperclip, PreviewOpen } from '@icon-park/react';
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

type ArtifactPayload = IGeneratedConversationArtifact['payload'] | Record<string, unknown> | string;

const TEXT_PREVIEW_MAX = 1200;
const SOURCE_URL_KEYS = [
  'url',
  'file_url',
  'fileUrl',
  'href',
  'src',
  'data_url',
  'download_url',
  'output_url',
  'preview_url',
  'thumbnail_url',
  'img_url',
  'image_url',
  'video_url',
  'audio_url',
];
const SOURCE_PATH_KEYS = ['path', 'file_path', 'filePath', 'absolute_path', 'absolutePath'];
const ARTIFACT_ID_KEYS = ['artifact_id', 'artifactId'];
const REQUEST_ID_KEYS = ['request_id', 'requestId'];
const RECEIPT_PATH_KEYS = ['receipt_path', 'receiptPath'];

function parsePayload(payload: ArtifactPayload): Record<string, unknown> {
  if (!payload) return {};
  if (typeof payload !== 'string') return payload;
  try {
    const parsed = JSON.parse(payload) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readString(payload: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function readNumber(payload: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function readRecord(payload: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  }
  return undefined;
}

function getFileName(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\\/g, '/').split('?')[0].split('#')[0];
  return normalized.split('/').filter(Boolean).pop();
}

function pathToFileUrl(path: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return path;
  if (path.startsWith('/')) return new URL(`file://${path}`).href;
  return path;
}

function fileUrlToPath(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') return undefined;
    return decodeURIComponent(parsed.pathname);
  } catch {
    return undefined;
  }
}

function inferType(
  kind: IGeneratedConversationArtifact['kind'],
  payload: Record<string, unknown>
): IGeneratedArtifactType {
  const explicitType = readString(payload, ['artifact_type', 'type', 'kind']);
  if (explicitType === 'image' || explicitType === 'video' || explicitType === 'audio' || explicitType === 'html') {
    return explicitType;
  }
  if (kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'html') return kind;

  const mimeType = readString(payload, ['mime_type', 'media_type', 'mimeType'])?.toLowerCase();
  if (mimeType?.startsWith('image/')) return 'image';
  if (mimeType?.startsWith('video/')) return 'video';
  if (mimeType?.startsWith('audio/')) return 'audio';
  if (mimeType?.includes('html')) return 'html';

  const pathOrUrl = readString(payload, [...SOURCE_PATH_KEYS, ...SOURCE_URL_KEYS]);
  const ext = pathOrUrl?.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase();
  if (ext && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp'].includes(ext)) return 'image';
  if (ext && ['mp4', 'mov', 'webm', 'm4v'].includes(ext)) return 'video';
  if (ext && ['mp3', 'wav', 'm4a', 'ogg', 'aac'].includes(ext)) return 'audio';
  if (ext && ['html', 'htm'].includes(ext)) return 'html';
  return 'file';
}

function formatBytes(bytes?: number): string | undefined {
  if (bytes === undefined) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 100 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
}

function getTypeLabel(t: ReturnType<typeof useTranslation>['t'], type: IGeneratedArtifactType): string {
  switch (type) {
    case 'image':
      return t('messages.artifact.image');
    case 'video':
      return t('messages.artifact.video');
    case 'audio':
      return t('messages.artifact.audio');
    case 'html':
      return t('messages.artifact.html');
    case 'file':
    default:
      return t('messages.artifact.file');
  }
}

function formatReceiptValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return undefined;
}

function buildReceiptSummary(
  t: ReturnType<typeof useTranslation>['t'],
  payload: Record<string, unknown>
): string | undefined {
  const receiptPath = readString(payload, RECEIPT_PATH_KEYS);
  const artifactId = readString(payload, ARTIFACT_ID_KEYS);
  const requestId = readString(payload, REQUEST_ID_KEYS);
  const receipt = readRecord(payload, ['receipt']);
  const items = [
    receiptPath ? `${t('messages.artifact.receiptPath')}: ${receiptPath}` : undefined,
    artifactId ? `${t('messages.artifact.artifactId')}: ${artifactId}` : undefined,
    requestId ? `${t('messages.artifact.requestId')}: ${requestId}` : undefined,
  ];
  if (receipt) {
    for (const [key, value] of Object.entries(receipt)) {
      if (items.filter(Boolean).length >= 4) break;
      const formatted = formatReceiptValue(value);
      if (formatted) items.push(`${key}: ${formatted}`);
    }
  }
  return items.filter((item): item is string => Boolean(item)).join(' · ') || undefined;
}

const MessageGeneratedArtifact: React.FC<{ artifact: IGeneratedConversationArtifact }> = ({ artifact }) => {
  const { t } = useTranslation();
  const payload = useMemo(() => parsePayload(artifact.payload), [artifact.payload]);
  const type = inferType(artifact.kind, payload);
  const typeLabel = getTypeLabel(t, type);
  const path = readString(payload, SOURCE_PATH_KEYS);
  const source = readString(payload, SOURCE_URL_KEYS) || (path ? pathToFileUrl(path) : undefined);
  const title =
    readString(payload, ['title', 'name', 'file_name']) ||
    getFileName(path) ||
    getFileName(source) ||
    t('messages.artifact.generated', { type: typeLabel });
  const description = readString(payload, ['description', 'prompt']);
  const provider = readString(payload, ['provider']);
  const model = readString(payload, ['model']);
  const mimeType = readString(payload, ['mime_type', 'media_type', 'mimeType']);
  const sizeLabel = formatBytes(readNumber(payload, ['size', 'bytes']));
  const error = readString(payload, ['error']);
  const htmlContent = type === 'html' ? readString(payload, ['html', 'content']) : undefined;
  const textContent = type === 'file' ? readString(payload, ['content', 'text']) : undefined;
  const receiptSummary = buildReceiptSummary(t, payload);
  const openPath = path || (source?.startsWith('file:') ? fileUrlToPath(source) : undefined);
  const canOpen = Boolean(openPath || (source && /^https?:/i.test(source)));

  const handleOpen = async () => {
    try {
      if (openPath) {
        await ipcBridge.shell.openFile.invoke(openPath);
        return;
      }
      if (source) {
        await ipcBridge.shell.openExternal.invoke(source);
      }
    } catch (openError) {
      console.error('[MessageGeneratedArtifact] Failed to open artifact:', openError);
      Message.error(t('messages.artifact.openFailed'));
    }
  };

  const handleReveal = async () => {
    if (!openPath) return;
    try {
      await ipcBridge.shell.showItemInFolder.invoke(openPath);
    } catch (revealError) {
      console.error('[MessageGeneratedArtifact] Failed to reveal artifact:', revealError);
      Message.error(t('messages.artifact.revealFailed'));
    }
  };

  return (
    <div data-testid='generated-artifact-card' className='max-w-780px w-full mx-auto'>
      <div
        className='overflow-hidden rd-8px bg-fill-0 b-1 b-solid'
        style={{ borderColor: 'color-mix(in srgb, var(--color-border-2) 70%, transparent)' }}
      >
        <div className='flex items-start gap-10px px-14px py-12px'>
          <Paperclip theme='outline' size={18} fill={iconColors.secondary} className='shrink-0 mt-1px' />
          <div className='min-w-0 flex-1'>
            <div className='flex items-center gap-8px min-w-0'>
              <span className='font-500 text-14px text-t-primary truncate'>{title}</span>
              <span className='shrink-0 text-11px px-6px py-2px rd-999px bg-fill-2 text-t-secondary'>{typeLabel}</span>
            </div>
            {(provider || model || mimeType || sizeLabel) && (
              <div className='mt-3px text-12px text-t-secondary truncate'>
                {[provider, model, mimeType, sizeLabel].filter(Boolean).join(' · ')}
              </div>
            )}
            {description && <div className='mt-6px text-12px text-t-secondary line-clamp-2'>{description}</div>}
            {receiptSummary && (
              <div data-testid='generated-artifact-receipt' className='mt-4px text-11px text-t-tertiary truncate'>
                {t('messages.artifact.receipt')}: {receiptSummary}
              </div>
            )}
          </div>
        </div>

        {error ? (
          <div data-testid='generated-artifact-error' className='mx-14px mb-12px p-10px rd-6px bg-fill-1 text-12px'>
            <span className='text-danger'>{t('messages.artifact.failed')}</span>
            <span className='text-t-secondary'>: {error}</span>
          </div>
        ) : (
          <div className='px-14px pb-12px'>
            {type === 'image' && source && (
              <img
                data-testid='generated-artifact-image'
                src={source}
                alt={title}
                className='block max-w-full max-h-420px rd-6px object-contain bg-bg-2'
              />
            )}
            {type === 'video' && source && (
              <video
                data-testid='generated-artifact-video'
                src={source}
                controls
                className='block w-full max-h-420px rd-6px bg-bg-2'
              />
            )}
            {type === 'audio' && source && (
              <audio data-testid='generated-artifact-audio' src={source} controls className='block w-full' />
            )}
            {type === 'html' && (htmlContent || source) && (
              <iframe
                data-testid='generated-artifact-html'
                title={title}
                sandbox=''
                src={htmlContent ? undefined : source}
                srcDoc={htmlContent}
                className='block w-full h-260px rd-6px bg-bg-2 b-1 b-solid'
                style={{ borderColor: 'var(--color-border-2)' }}
              />
            )}
            {type === 'file' && textContent && (
              <div
                data-testid='generated-artifact-text'
                className='max-h-260px overflow-auto text-12px rd-6px bg-bg-2 p-10px'
              >
                <MarkdownView hiddenCodeCopyButton>
                  {textContent.length > TEXT_PREVIEW_MAX
                    ? `${textContent.slice(0, TEXT_PREVIEW_MAX).trimEnd()}\n...`
                    : textContent}
                </MarkdownView>
              </div>
            )}
            {!source && !htmlContent && !textContent && (
              <div data-testid='generated-artifact-empty' className='text-12px text-t-secondary'>
                {t('messages.artifact.noPreview')}
              </div>
            )}
          </div>
        )}

        {(canOpen || openPath) && (
          <div className='flex items-center gap-8px px-14px py-10px bg-fill-1 b-t-1 b-solid border-border-2'>
            {canOpen && (
              <button
                type='button'
                data-testid='generated-artifact-open'
                className='flex items-center gap-5px px-8px py-5px rd-4px text-12px text-t-primary bg-fill-0 hover:bg-fill-2 transition-colors'
                onClick={() => void handleOpen()}
              >
                <PreviewOpen theme='outline' size={14} fill={iconColors.secondary} />
                <span>{t('messages.artifact.open')}</span>
              </button>
            )}
            {openPath && (
              <button
                type='button'
                data-testid='generated-artifact-reveal'
                className='flex items-center gap-5px px-8px py-5px rd-4px text-12px text-t-primary bg-fill-0 hover:bg-fill-2 transition-colors'
                onClick={() => void handleReveal()}
              >
                <FolderOpen theme='outline' size={14} fill={iconColors.secondary} />
                <span>{t('messages.artifact.reveal')}</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default MessageGeneratedArtifact;
