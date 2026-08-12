/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { IFileMetadata, IGeneratedArtifactType, IGeneratedConversationArtifact } from '@/common/adapter/ipcBridge';
import {
  bindTypedUIEnvelopeToArtifact,
  TYPED_UI_MIME_TYPE,
  TYPED_UI_SCHEMA_VERSION,
  validateTypedUIEnvelope,
  type TypedUIActionHost,
  type TypedUIProvenanceAttestation,
} from '@/common/typedUI';
import MarkdownView from '@/renderer/components/Markdown';
import { useConversationContextSafe } from '@/renderer/hooks/context/ConversationContext';
import { usePreviewContext } from '@/renderer/pages/conversation/Preview';
import { iconColors } from '@/renderer/styles/colors';
import { emitter } from '@/renderer/utils/emitter';
import {
  openWorkbenchArtifact,
  registerWorkbenchArtifactResolver,
} from '@/renderer/pages/conversation/Preview/services/workbenchArtifactResolver';
import { Message } from '@arco-design/web-react';
import { FolderOpen, Paperclip, PreviewOpen } from '@icon-park/react';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import PDFPreview from '../../Preview/components/viewers/PDFViewer';
import { secureArtifactHtml } from '../../Preview/components/renderers/htmlArtifactSecurityCore';
import { sanitizeArtifactPreviewSource } from './artifactPreviewSecurityCore';
import { createDefaultTypedUIActionHost, TypedUIRenderer } from './TypedGenerativeUI';

type ArtifactPayload = IGeneratedConversationArtifact['payload'] | Record<string, unknown> | string;
type ArtifactPreviewType = IGeneratedArtifactType | 'pdf';

const TEXT_PREVIEW_MAX = 1200;
const HTML_PREVIEW_MAX = 2 * 1024 * 1024;
// Data URLs are capped at 64 MiB by artifactPreviewSecurityCore. Keep enough
// headroom for base64 expansion and the MIME prefix before loading a local
// audio/video file into renderer memory.
const LOCAL_FILE_PREVIEW_MAX_BYTES = 47 * 1024 * 1024;
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

function readTypedUIContent(payload: Record<string, unknown>): string | undefined {
  const mimeType = readString(payload, ['mime_type', 'media_type', 'mimeType'])?.toLowerCase();
  const candidate = payload.typed_ui ?? payload.typedUi;
  if (typeof candidate === 'string' && candidate.trim()) return candidate;
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return JSON.stringify(candidate);
  if (payload.schema_version === TYPED_UI_SCHEMA_VERSION) return JSON.stringify(payload);
  if (mimeType === TYPED_UI_MIME_TYPE) {
    if (typeof payload.content === 'string') return payload.content;
    if (payload.content && typeof payload.content === 'object' && !Array.isArray(payload.content)) {
      return JSON.stringify(payload.content);
    }
  }
  return undefined;
}

function bindTypedUIContentToArtifact(
  content: string | undefined,
  artifact: IGeneratedConversationArtifact,
  sourceMessageId: string | undefined
): string | undefined {
  if (!content || !sourceMessageId) return undefined;
  try {
    const raw = validateTypedUIEnvelope(JSON.parse(content) as unknown);
    if (!raw.ok) return undefined;
    const bound = bindTypedUIEnvelopeToArtifact(raw.value, {
      artifact_id: artifact.id,
      conversation_id: artifact.conversation_id,
      source_message_id: sourceMessageId,
      created_at: artifact.created_at,
    });
    const validation = validateTypedUIEnvelope(bound);
    return validation.ok ? JSON.stringify(validation.value) : undefined;
  } catch {
    return undefined;
  }
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

const WINDOWS_ABSOLUTE_PATH_RE = /^[a-z]:[\\/]/i;

function resolveArtifactFilePath(filePath: string, workspace?: string): string {
  if (!workspace || filePath.startsWith('/') || WINDOWS_ABSOLUTE_PATH_RE.test(filePath)) return filePath;
  const normalizedWorkspace = workspace.replace(/[\\/]+$/, '').replace(/\\/g, '/');
  const normalizedFilePath = filePath.replace(/^\.?[\\/]+/, '').replace(/\\/g, '/');
  return `${normalizedWorkspace}/${normalizedFilePath}`.replace(/\/+/g, '/');
}

export function pathToFileUrl(path: string): string {
  if (WINDOWS_ABSOLUTE_PATH_RE.test(path)) {
    const fileUrl = new URL('file:///');
    fileUrl.pathname = `/${path.replaceAll('\\', '/')}`;
    return fileUrl.href;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return path;
  if (path.startsWith('/')) return new URL(`file://${path}`).href;
  return path;
}

export function fileUrlToPath(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') return undefined;
    const decodedPath = decodeURIComponent(parsed.pathname);
    return /^\/[a-z]:\//i.test(decodedPath) ? decodedPath.slice(1) : decodedPath;
  } catch {
    return undefined;
  }
}

export function isDirectoryMetadata(metadata: IFileMetadata): boolean {
  return Boolean(metadata.isDirectory || metadata.is_directory);
}

function inferLocalMediaMime(
  type: Extract<ArtifactPreviewType, 'image' | 'video' | 'audio'>,
  path: string,
  declaredMime?: string,
  metadataMime?: string
): string | undefined {
  const expectedPrefix = `${type}/`;
  for (const candidate of [declaredMime, metadataMime]) {
    const normalized = candidate?.trim().toLowerCase();
    if (normalized?.startsWith(expectedPrefix)) return normalized;
  }

  const extension = path.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase();
  const mimeByExtension: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    m4v: 'video/x-m4v',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    ogg: 'audio/ogg',
    aac: 'audio/aac',
  };
  const inferred = extension ? mimeByExtension[extension] : undefined;
  return inferred?.startsWith(expectedPrefix) ? inferred : undefined;
}

function inferType(
  kind: IGeneratedConversationArtifact['kind'],
  payload: Record<string, unknown>
): ArtifactPreviewType {
  const explicitType = readString(payload, ['artifact_type', 'type', 'kind']);
  if (explicitType === 'image' || explicitType === 'video' || explicitType === 'audio' || explicitType === 'html') {
    return explicitType;
  }
  if (kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'html') return kind;

  const mimeType = readString(payload, ['mime_type', 'media_type', 'mimeType'])?.toLowerCase();
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType?.startsWith('image/')) return 'image';
  if (mimeType?.startsWith('video/')) return 'video';
  if (mimeType?.startsWith('audio/')) return 'audio';
  if (mimeType?.includes('html')) return 'html';

  const pathOrUrl = readString(payload, [...SOURCE_PATH_KEYS, ...SOURCE_URL_KEYS]);
  const ext = pathOrUrl?.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase();
  if (ext === 'pdf') return 'pdf';
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

function getTypeLabel(t: ReturnType<typeof useTranslation>['t'], type: ArtifactPreviewType): string {
  switch (type) {
    case 'pdf':
      return 'PDF';
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

const MessageGeneratedArtifact: React.FC<{
  artifact: IGeneratedConversationArtifact;
  typedUIAttestation?: TypedUIProvenanceAttestation;
}> = ({ artifact, typedUIAttestation }) => {
  const { t } = useTranslation();
  const conversationContext = useConversationContextSafe();
  const preview = usePreviewContext();
  const workspace = conversationContext?.workspace?.trim() || undefined;
  const payload = useMemo(() => parsePayload(artifact.payload), [artifact.payload]);
  const rawTypedUIContent = useMemo(() => readTypedUIContent(payload), [payload]);
  const type = inferType(artifact.kind, payload);
  const typeLabel = getTypeLabel(t, type);
  const path = readString(payload, SOURCE_PATH_KEYS);
  const pathFromFileUrl = path?.startsWith('file:') ? fileUrlToPath(path) : path;
  const resolvedPath =
    pathFromFileUrl && (pathFromFileUrl.startsWith('/') || WINDOWS_ABSOLUTE_PATH_RE.test(pathFromFileUrl) || workspace)
      ? resolveArtifactFilePath(pathFromFileUrl, workspace)
      : undefined;
  const rawSource = readString(payload, SOURCE_URL_KEYS) || (resolvedPath ? pathToFileUrl(resolvedPath) : undefined);
  const source = sanitizeArtifactPreviewSource(rawSource, type === 'pdf' ? 'file' : type);
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
  const sourceMessageId = readString(payload, ['source_message_id', 'sourceMessageId']);
  const typedUIContent = useMemo(
    () => bindTypedUIContentToArtifact(rawTypedUIContent, artifact, sourceMessageId),
    [artifact, rawTypedUIContent, sourceMessageId]
  );
  const openPath = resolvedPath || (source?.startsWith('file:') ? fileUrlToPath(source) : undefined);
  const [pathHtmlContent, setPathHtmlContent] = useState<string>();
  const [pathHtmlLoading, setPathHtmlLoading] = useState(false);
  const [localFilePreviewSource, setLocalFilePreviewSource] = useState<string>();
  const [localFilePreviewLoading, setLocalFilePreviewLoading] = useState(false);
  const [managedImagePreviewSource, setManagedImagePreviewSource] = useState<string>();

  // 1.820.3 — a MANAGED GENERATED image carries NO path and NO URL by
  // contract: its bytes live in Main's private store. The card resolves its
  // preview BY ARTIFACT ID over the `commandEve.imageArtifactPreview` bridge,
  // which re-verifies the conversation and the SHA-256 on every read.
  const isManagedImage = type === 'image' && payload.managed_image === true && !source;
  useEffect(() => {
    if (!isManagedImage) {
      setManagedImagePreviewSource(undefined);
      return;
    }
    let active = true;
    setManagedImagePreviewSource(undefined);
    void (async () => {
      try {
        const response = await ipcBridge.commandEve.imageArtifactPreview.invoke({
          conversationId: artifact.conversation_id,
          artifactId: artifact.id,
        });
        const preview = response?.data;
        if (!active || !preview) return;
        setManagedImagePreviewSource(
          sanitizeArtifactPreviewSource(`data:${preview.mime_type};base64,${preview.data_base64}`, 'image')
        );
      } catch {
        // The card stays truthful without an inline preview — the artifact
        // itself is listed and described either way.
      }
    })();
    return () => {
      active = false;
    };
  }, [artifact.conversation_id, artifact.id, isManagedImage]);

  useEffect(() => {
    if (type !== 'html' || htmlContent || !openPath) {
      setPathHtmlContent(undefined);
      setPathHtmlLoading(false);
      return;
    }

    let active = true;
    setPathHtmlContent(undefined);
    setPathHtmlLoading(true);
    void (async () => {
      try {
        let content: string | null | undefined;
        if (workspace) {
          try {
            const metadata = await ipcBridge.fs.getFileMetadata.invoke({ path: openPath, workspace });
            if (!metadata || isDirectoryMetadata(metadata) || metadata.size > HTML_PREVIEW_MAX) return;
            content = await ipcBridge.fs.readFile.invoke({ path: openPath, workspace });
          } catch {
            // A generated output may intentionally live in Downloads rather
            // than the active workspace. The desktop fallback is rooted and
            // bounded in the main process.
          }
        }
        if (typeof content !== 'string') {
          const approved = await ipcBridge.application.readGeneratedArtifactPreview.invoke({
            path: openPath,
            kind: 'html',
          });
          content = approved?.encoding === 'utf8' ? approved.data : undefined;
        }
        if (!active) return;
        if (typeof content === 'string' && content.length <= HTML_PREVIEW_MAX) {
          setPathHtmlContent(content);
        }
      } catch {
        // Keep the artifact actions available when a preview cannot be loaded.
      } finally {
        if (active) setPathHtmlLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [htmlContent, openPath, type, workspace]);

  useEffect(() => {
    const isLocalFilePreview =
      (type === 'image' || type === 'video' || type === 'audio' || type === 'pdf') &&
      Boolean(openPath) &&
      source?.startsWith('file:');
    if (
      !isLocalFilePreview ||
      !openPath ||
      (type !== 'image' && type !== 'video' && type !== 'audio' && type !== 'pdf')
    ) {
      setLocalFilePreviewSource(undefined);
      setLocalFilePreviewLoading(false);
      return;
    }

    let active = true;
    setLocalFilePreviewSource(undefined);
    setLocalFilePreviewLoading(true);

    void (async () => {
      try {
        let candidate: string | null = null;
        if (workspace) {
          try {
            const metadata = await ipcBridge.fs.getFileMetadata.invoke({ path: openPath, workspace });
            if (!metadata || isDirectoryMetadata(metadata) || metadata.size > LOCAL_FILE_PREVIEW_MAX_BYTES) return;
            if (type === 'image') {
              candidate = await ipcBridge.fs.getImageBase64.invoke({ path: openPath, workspace });
            } else {
              const encoded = await ipcBridge.fs.readFileBuffer.invoke({ path: openPath, workspace });
              if (type === 'pdf') {
                if (encoded) candidate = `data:application/pdf;base64,${encoded}`;
              } else {
                const localMime = inferLocalMediaMime(type, openPath, mimeType, metadata.type);
                if (encoded && localMime) candidate = `data:${localMime};base64,${encoded}`;
              }
            }
          } catch {
            // Try the read-only Downloads artifact bridge below.
          }
        }

        if (!candidate) {
          const approved = await ipcBridge.application.readGeneratedArtifactPreview.invoke({
            path: openPath,
            kind: type,
          });
          if (approved?.encoding === 'base64') {
            if (type === 'pdf') {
              candidate = `data:application/pdf;base64,${approved.data}`;
            } else if (approved.mimeType.startsWith(`${type}/`)) {
              candidate = `data:${approved.mimeType};base64,${approved.data}`;
            }
          }
        }

        if (active) {
          setLocalFilePreviewSource(
            type === 'pdf' ? (candidate ?? undefined) : sanitizeArtifactPreviewSource(candidate ?? undefined, type)
          );
        }
      } catch {
        // The artifact remains openable/revealable even when an inline preview
        // cannot be loaded or exceeds the bounded renderer-memory budget.
      } finally {
        if (active) setLocalFilePreviewLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [mimeType, openPath, source, type, workspace]);

  const securedHtmlContent = useMemo(() => {
    const content = htmlContent || pathHtmlContent;
    return content ? secureArtifactHtml(content) : undefined;
  }, [htmlContent, pathHtmlContent]);
  const previewSource = managedImagePreviewSource ?? (source?.startsWith('file:') ? localFilePreviewSource : source);
  const pdfPreviewSource = openPath ? localFilePreviewSource : source;
  const canOpen = Boolean(openPath || (source && /^https?:/i.test(source)));
  const hasPreview =
    ((type === 'image' || type === 'video' || type === 'audio') && Boolean(previewSource)) ||
    (type === 'pdf' && Boolean(pdfPreviewSource)) ||
    (type === 'html' && Boolean(securedHtmlContent)) ||
    (type === 'file' && Boolean(textContent));

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

  const typedUIHost = useMemo(
    () =>
      createDefaultTypedUIActionHost({
        provenanceArtifact: {
          artifact_id: artifact.id,
          conversation_id: artifact.conversation_id,
          created_at: artifact.created_at,
          source_message_id: sourceMessageId || '',
        },
        openArtifact: (kind, artifactId) =>
          openWorkbenchArtifact({ kind, artifactId, conversationId: artifact.conversation_id }),
        replyWithState: (text) => {
          emitter.emit('sendbox.fill', text);
        },
      }),
    [artifact.conversation_id, artifact.created_at, artifact.id, sourceMessageId]
  );
  const [typedUIResolverGate, setTypedUIResolverGate] = useState<{
    attestation?: TypedUIProvenanceAttestation;
    content: string;
    state: 'checking' | 'verified' | 'rejected';
  }>();

  useEffect(() => {
    if (!typedUIContent || !sourceMessageId) {
      setTypedUIResolverGate(undefined);
      return;
    }
    let active = true;
    const content = typedUIContent;
    setTypedUIResolverGate({ content, state: 'checking' });
    if (
      typedUIAttestation?.status === 'verified' &&
      typedUIAttestation.artifact_id === artifact.id &&
      typedUIAttestation.conversation_id === artifact.conversation_id &&
      typedUIAttestation.source_message_id === sourceMessageId
    ) {
      setTypedUIResolverGate({ content, state: 'verified', attestation: typedUIAttestation });
      return () => {
        active = false;
      };
    }
    let envelope;
    try {
      const validated = validateTypedUIEnvelope(JSON.parse(content) as unknown);
      if (!validated.ok) {
        setTypedUIResolverGate({ content, state: 'rejected' });
        return;
      }
      envelope = validated.value;
    } catch {
      setTypedUIResolverGate({ content, state: 'rejected' });
      return;
    }
    void typedUIHost
      .attestProvenance(envelope)
      .then((attestation) => {
        if (!active) return;
        setTypedUIResolverGate({
          content,
          attestation:
            attestation.status === 'verified' &&
            attestation.artifact_id === artifact.id &&
            attestation.conversation_id === artifact.conversation_id &&
            attestation.source_message_id === sourceMessageId
              ? attestation
              : undefined,
          state:
            attestation.status === 'verified' &&
            attestation.artifact_id === artifact.id &&
            attestation.conversation_id === artifact.conversation_id &&
            attestation.source_message_id === sourceMessageId
              ? 'verified'
              : 'rejected',
        });
      })
      .catch(() => {
        if (active) setTypedUIResolverGate({ content, state: 'rejected' });
      });
    return () => {
      active = false;
    };
  }, [artifact.conversation_id, artifact.id, sourceMessageId, typedUIAttestation, typedUIContent, typedUIHost]);

  const typedUIResolverState =
    typedUIResolverGate && typedUIResolverGate.content === typedUIContent ? typedUIResolverGate.state : 'checking';
  const typedUIResolverVerified = typedUIResolverState === 'verified';
  const typedUIVerifiedAttestation =
    typedUIResolverGate && typedUIResolverGate.content === typedUIContent && typedUIResolverGate.state === 'verified'
      ? typedUIResolverGate.attestation
      : undefined;
  const typedUIRendererHost = useMemo<TypedUIActionHost>(
    () =>
      typedUIVerifiedAttestation
        ? {
            ...typedUIHost,
            attestProvenance: () => Promise.resolve(typedUIVerifiedAttestation),
          }
        : typedUIHost,
    [typedUIHost, typedUIVerifiedAttestation]
  );

  useEffect(() => {
    if (!typedUIContent || !typedUIResolverVerified) return;
    return registerWorkbenchArtifactResolver({
      id: `typed-ui-${artifact.conversation_id}-${artifact.id}`,
      priority: 100,
      canResolve(reference) {
        return (
          reference.kind === 'chat' &&
          reference.conversationId === artifact.conversation_id &&
          reference.artifactId === artifact.id
        );
      },
      open(reference) {
        if (
          reference.kind !== 'chat' ||
          reference.conversationId !== artifact.conversation_id ||
          reference.artifactId !== artifact.id
        ) {
          throw new Error('artifact_not_resolved');
        }
        preview.openPreview(typedUIContent, 'typed-ui', {
          title,
          conversation_id: artifact.conversation_id,
          artifact_id: artifact.id,
          artifact_kind: 'chat',
          artifact_created_at: artifact.created_at,
          ...(sourceMessageId ? { source_message_id: sourceMessageId } : {}),
        });
      },
    });
  }, [
    artifact.conversation_id,
    artifact.created_at,
    artifact.id,
    preview,
    sourceMessageId,
    title,
    typedUIContent,
    typedUIResolverVerified,
  ]);

  if (typedUIContent) {
    if (!typedUIResolverVerified) {
      return (
        <div
          className='max-w-780px w-full mx-auto'
          data-testid={`typed-ui-provenance-${typedUIResolverState}`}
          role='status'
          aria-live='polite'
        >
          {typedUIResolverState === 'checking'
            ? t('messages.typedUI.provenance.checking')
            : t('messages.typedUI.provenance.rejected')}
        </div>
      );
    }
    return (
      <div data-testid='generated-artifact-card' className='max-w-780px w-full mx-auto'>
        <TypedUIRenderer
          content={typedUIContent}
          mode='compact'
          host={typedUIRendererHost}
          receiptContext={{
            artifactId: artifact.id,
            conversationId: artifact.conversation_id,
            sourceMessageId: sourceMessageId || '',
          }}
          onOpenWorkbench={() => typedUIHost.openArtifact('chat', artifact.id)}
        />
      </div>
    );
  }

  return (
    <div data-testid='generated-artifact-card' className='max-w-780px w-full mx-auto'>
      <div className='eve-artifact-card overflow-hidden rd-8px'>
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
            {localFilePreviewLoading &&
              (type === 'image' || type === 'video' || type === 'audio' || type === 'pdf') && (
                <div className='eve-artifact-preview flex h-160px items-center justify-center rd-6px text-12px text-t-secondary'>
                  {t('preview.loading')}
                </div>
              )}
            {type === 'image' && previewSource && (
              <img
                data-testid='generated-artifact-image'
                src={previewSource}
                alt={title}
                className='block max-w-full max-h-420px rd-6px object-contain bg-bg-2'
              />
            )}
            {type === 'video' && previewSource && (
              <video
                data-testid='generated-artifact-video'
                src={previewSource}
                controls
                className='block w-full max-h-420px rd-6px bg-bg-2'
              />
            )}
            {type === 'audio' && previewSource && (
              <audio data-testid='generated-artifact-audio' src={previewSource} controls className='block w-full' />
            )}
            {type === 'pdf' && pdfPreviewSource && (
              <div data-testid='generated-artifact-pdf' className='eve-artifact-preview h-360px overflow-hidden rd-6px'>
                <PDFPreview content={pdfPreviewSource} hideToolbar />
              </div>
            )}
            {type === 'html' && pathHtmlLoading && (
              <div className='eve-artifact-preview flex h-160px items-center justify-center rd-6px text-12px text-t-secondary'>
                {t('preview.loading')}
              </div>
            )}
            {type === 'html' && securedHtmlContent && (
              <iframe
                data-testid='generated-artifact-html'
                title={title}
                sandbox=''
                srcDoc={securedHtmlContent}
                className='eve-artifact-preview block w-full h-300px rd-6px'
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
            {!hasPreview && !localFilePreviewLoading && (
              <div data-testid='generated-artifact-empty' className='text-12px text-t-secondary'>
                {canOpen ? t('messages.artifact.previewUnavailable') : t('messages.artifact.noPreview')}
              </div>
            )}
          </div>
        )}

        {(canOpen || openPath) && (
          <div className='eve-artifact-actions flex items-center gap-8px px-14px py-10px'>
            {canOpen && (
              <button
                type='button'
                data-testid='generated-artifact-open'
                className='eve-artifact-action flex items-center gap-6px px-10px text-12px'
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
                className='eve-artifact-action flex items-center gap-6px px-10px text-12px'
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
