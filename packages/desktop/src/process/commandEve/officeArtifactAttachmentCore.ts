/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto, { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import yauzl from 'yauzl';
import { parseHermesMediaDirectives } from '@/common/config/hermesMediaDirectiveCore';
import {
  COMMAND_EVE_OFFICE_ORIGIN_CAPABILITY,
  commandEveOfficeExtension,
  commandEveOfficeFingerprint,
  commandEveOfficeMimeType,
  isCommandEveOfficeArtifactMode,
  type CommandEveOfficeArtifactMode,
  type CommandEveOfficeArtifactRefusalReason,
  type CommandEveOfficeConversationArtifact,
  type CommandEveOfficeConversationArtifactPayload,
} from '@/common/types/office/artifactLineage';
import { getDataPath } from '@process/utils/utils';
import {
  getActiveSeatContextRevision,
  getActiveSeatId,
  resolveSeatHermesHome,
} from '@process/commandEve/seatContextCore';
import { isSafeOpaqueRecordId } from '@/common/config/eveOpaqueTokenCore';
import {
  ensurePrivateDocumentDirectory,
  writePrivateDocumentAtomic,
  writePrivateDocumentImmutable,
} from '@process/commandEve/document/privateDocumentCache';
import {
  commandEveOfficeArtifactRelativePath,
  commandEveOfficeSourceOperationId,
  ProjectWorkspaceConversationArtifactStore,
} from '@process/services/project-workspace/storage/conversationArtifactStore';
import { publishCanonicalArtifact } from '@process/services/project-workspace/storage/canonicalArtifactPlacement';

export type { CommandEveOfficeArtifactMode, CommandEveOfficeArtifactRefusalReason };

export type CommandEveOfficeArtifactAttachment =
  | Readonly<{ status: 'ready'; path: string }>
  | Readonly<{
      status: 'refused';
      reasonCode: CommandEveOfficeArtifactRefusalReason;
    }>;

export type CommandEveOfficeArtifactResolution =
  | Readonly<{
      status: 'ready';
      path: string;
      parentArtifactId: string;
      sourceSha256: string;
      sourceSize: number;
      sourceFingerprint: string;
      seatId: string;
      seatContextRevision: number;
    }>
  | Extract<CommandEveOfficeArtifactAttachment, { status: 'refused' }>;

export type CommandEveOfficeConversationAuthority =
  | Readonly<{
      status: 'ready';
      backendPort: number;
      workspace: string;
      seatId: string;
      seatContextRevision: number;
    }>
  | Readonly<{
      /** A real conversation may intentionally run without a project workspace. */
      status: 'temporary';
      seatId: string;
      seatContextRevision: number;
    }>
  | Readonly<{ status: 'refused'; reasonCode: CommandEveOfficeArtifactRefusalReason }>;

export interface CommandEveOfficeArtifactAttachmentRequest {
  conversationId: string;
  artifactId: string;
  mode: CommandEveOfficeArtifactMode;
}

export interface CommandEveOfficeArtifactAttachmentDeps {
  fetch: typeof fetch;
  getBackendPort: () => number | undefined;
  getDataPath: typeof getDataPath;
  getActiveSeatId: typeof getActiveSeatId;
  getActiveSeatContextRevision: typeof getActiveSeatContextRevision;
  resolveSeatHermesHome: typeof resolveSeatHermesHome;
  newId: () => string;
}

const OFFICE_SOURCE_MAX_BYTES = 64 * 1024 * 1024;
const OFFICE_PACKAGE_MAX_ENTRIES = 10_000;
const OFFICE_PACKAGE_MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const OFFICE_LOOKUP_TIMEOUT_MS = 5_000;
const TERMINAL_MESSAGE_STATUSES = new Set(['finish', 'finished', 'completed', 'complete', 'done']);

type ImportedOfficeSourceProvenance =
  | {
      sourceTool: 'office_transcript_import';
      messageId: string;
      turnId: string;
      directiveIndex: number;
    }
  | {
      sourceTool: 'aioncore_artifact_import';
      messageId: null;
      turnId: null;
      directiveIndex: null;
    };

type ResolvedImportedOfficeSource = {
  path: string;
  provenance: ImportedOfficeSourceProvenance;
};

const productionDeps: CommandEveOfficeArtifactAttachmentDeps = {
  fetch,
  getBackendPort: () => (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort,
  getDataPath,
  getActiveSeatId,
  getActiveSeatContextRevision,
  resolveSeatHermesHome,
  newId: randomUUID,
};

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown> | null, keys: readonly string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\0');
}

function extensionForMode(mode: CommandEveOfficeArtifactMode): string {
  return commandEveOfficeExtension(mode);
}

function isDocumentArtifactMode(value: unknown): value is CommandEveOfficeArtifactMode {
  return isCommandEveOfficeArtifactMode(value);
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  );
}

function isSafePackageEntry(rawName: string): boolean {
  if (!rawName || rawName.includes('\\') || /\p{Cc}/u.test(rawName)) return false;
  if (rawName.startsWith('/') || rawName.includes('//') || /^[A-Za-z]:/.test(rawName)) return false;
  const segments = rawName.split('/');
  if (rawName.endsWith('/')) segments.pop();
  return segments.length > 0 && segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function isActiveOfficePackagePart(name: string): boolean {
  return /(?:^|\/)(?:vbaProject\.bin|activeX\/|externalLinks\/)/i.test(name);
}

export function validateOfficePackageBuffer(buffer: Buffer, mode: CommandEveOfficeArtifactMode): Promise<boolean> {
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) return Promise.resolve(false);
  const requiredPart = mode === 'word' ? 'word/document.xml' : 'xl/workbook.xml';

  return new Promise((resolve) => {
    yauzl.fromBuffer(
      buffer,
      { lazyEntries: true, autoClose: true, decodeStrings: true, validateEntrySizes: true },
      (openError, zipFile) => {
        if (openError || !zipFile) {
          resolve(false);
          return;
        }

        let entries = 0;
        let uncompressedBytes = 0;
        let hasContentTypes = false;
        let hasRequiredPart = false;
        let settled = false;
        const entryNames = new Set<string>();
        const finish = (valid: boolean) => {
          if (settled) return;
          settled = true;
          zipFile.close();
          resolve(valid);
        };

        zipFile.on('error', () => finish(false));
        zipFile.on('entry', (entry) => {
          entries += 1;
          uncompressedBytes += entry.uncompressedSize;
          const name = entry.fileName;
          if (
            entries > OFFICE_PACKAGE_MAX_ENTRIES ||
            uncompressedBytes > OFFICE_PACKAGE_MAX_UNCOMPRESSED_BYTES ||
            !isSafePackageEntry(name) ||
            entryNames.has(name) ||
            isActiveOfficePackagePart(name) ||
            (entry.generalPurposeBitFlag & 0x1) !== 0
          ) {
            finish(false);
            return;
          }
          entryNames.add(name);
          if (name === '[Content_Types].xml') hasContentTypes = true;
          if (name === requiredPart) hasRequiredPart = true;
          zipFile.readEntry();
        });
        zipFile.on('end', () => finish(hasContentTypes && hasRequiredPart));
        zipFile.readEntry();
      }
    );
  });
}

async function validateDocumentArtifactBuffer(buffer: Buffer, mode: CommandEveOfficeArtifactMode): Promise<boolean> {
  return validateOfficePackageBuffer(buffer, mode);
}

async function fetchApiData(
  deps: CommandEveOfficeArtifactAttachmentDeps,
  port: number,
  pathname: string
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OFFICE_LOOKUP_TIMEOUT_MS);
  try {
    const response = await deps.fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = recordOf(await response.json());
    return body?.data ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function mediaArtifactIdentity(artifactId: string): { messageId: string; index: number } | null {
  const match = /^hermes-media-(.+)-(\d+)$/.exec(artifactId);
  if (!match) return null;
  const index = Number(match[2]);
  return Number.isSafeInteger(index) && index >= 0 && index < 100 ? { messageId: match[1], index } : null;
}

async function resolveTranscriptArtifactSource(
  deps: CommandEveOfficeArtifactAttachmentDeps,
  port: number,
  request: CommandEveOfficeArtifactAttachmentRequest
): Promise<ResolvedImportedOfficeSource | null> {
  const identity = mediaArtifactIdentity(request.artifactId);
  if (!identity) return null;
  const data = await fetchApiData(
    deps,
    port,
    `/api/conversations/${encodeURIComponent(request.conversationId)}/messages/${encodeURIComponent(identity.messageId)}`
  );
  const message = recordOf(data);
  const content = recordOf(message?.content);
  if (
    message?.id !== identity.messageId ||
    message?.conversation_id !== request.conversationId ||
    message?.position !== 'left' ||
    message?.type !== 'text' ||
    message?.hidden === true ||
    typeof message?.status !== 'string' ||
    !TERMINAL_MESSAGE_STATUSES.has(message.status.trim().toLowerCase()) ||
    typeof message?.turn_id !== 'string' ||
    !isSafeOpaqueRecordId(message.turn_id) ||
    typeof content?.content !== 'string'
  ) {
    return null;
  }

  const directive = parseHermesMediaDirectives(content.content).directives[identity.index];
  if (!directive || directive.artifactType !== 'file') return null;
  return `hermes-media-${identity.messageId}-${identity.index}` === request.artifactId
    ? {
        path: directive.source,
        provenance: {
          sourceTool: 'office_transcript_import',
          messageId: identity.messageId,
          turnId: message.turn_id,
          directiveIndex: identity.index,
        },
      }
    : null;
}

async function resolveStoredArtifactSource(
  deps: CommandEveOfficeArtifactAttachmentDeps,
  port: number,
  request: CommandEveOfficeArtifactAttachmentRequest
): Promise<ResolvedImportedOfficeSource | null> {
  const data = await fetchApiData(
    deps,
    port,
    `/api/conversations/${encodeURIComponent(request.conversationId)}/artifacts`
  );
  if (!Array.isArray(data)) return null;
  const artifact = data.map(recordOf).find((candidate) => candidate?.id === request.artifactId) ?? null;
  const payload = recordOf(artifact?.payload);
  if (
    !artifact ||
    artifact.conversation_id !== request.conversationId ||
    !['active', 'saved'].includes(String(artifact.status)) ||
    (artifact.kind !== 'file' && payload?.artifact_type !== 'file')
  ) {
    return null;
  }
  const sourcePath = readString(payload, ['path', 'file_path', 'absolute_path']);
  return sourcePath
    ? {
        path: sourcePath,
        provenance: {
          sourceTool: 'aioncore_artifact_import',
          messageId: null,
          turnId: null,
          directiveIndex: null,
        },
      }
    : null;
}

export async function readBoundedOfficeSource(
  workspaceRoot: string,
  sourcePath: string,
  mode: CommandEveOfficeArtifactMode
): Promise<{ buffer: Buffer; sha256: string } | null> {
  if (
    !path.isAbsolute(sourcePath) ||
    sourcePath.includes('\0') ||
    path.extname(sourcePath).toLowerCase() !== extensionForMode(mode)
  ) {
    return null;
  }

  try {
    const [canonicalWorkspace, workspaceStat, sourceLstat] = await Promise.all([
      fs.realpath(workspaceRoot),
      fs.lstat(workspaceRoot),
      fs.lstat(sourcePath),
    ]);
    if (
      !workspaceStat.isDirectory() ||
      sourceLstat.isSymbolicLink() ||
      !sourceLstat.isFile() ||
      sourceLstat.nlink !== 1 ||
      sourceLstat.size <= 0 ||
      sourceLstat.size > OFFICE_SOURCE_MAX_BYTES
    ) {
      return null;
    }

    const canonicalSource = await fs.realpath(sourcePath);
    if (!isContainedPath(canonicalWorkspace, canonicalSource)) return null;

    const handle = await fs.open(canonicalSource, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.size !== sourceLstat.size ||
        before.dev !== sourceLstat.dev ||
        before.ino !== sourceLstat.ino
      ) {
        return null;
      }
      const buffer = await handle.readFile();
      const after = await handle.stat();
      if (
        buffer.length !== before.size ||
        after.size !== before.size ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        !(await validateDocumentArtifactBuffer(buffer, mode))
      ) {
        return null;
      }
      return { buffer, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

export async function resolveCommandEveOfficeConversationAuthority(
  conversationId: string,
  deps: CommandEveOfficeArtifactAttachmentDeps = productionDeps
): Promise<CommandEveOfficeConversationAuthority> {
  if (!validOpaqueId(conversationId)) return { status: 'refused', reasonCode: 'invalid-request' };
  const backendPort = deps.getBackendPort();
  if (!backendPort) return { status: 'refused', reasonCode: 'backend-unavailable' };
  const seatId = deps.getActiveSeatId();
  const seatContextRevision = deps.getActiveSeatContextRevision();
  const conversationData = recordOf(
    await fetchApiData(deps, backendPort, '/api/conversations/' + encodeURIComponent(conversationId))
  );
  const workspace = readString(recordOf(conversationData?.extra), ['workspace']);
  if (conversationData?.id !== conversationId) {
    return { status: 'refused', reasonCode: 'conversation-unavailable' };
  }
  if (deps.getActiveSeatId() !== seatId || deps.getActiveSeatContextRevision() !== seatContextRevision) {
    return { status: 'refused', reasonCode: 'seat-changed' };
  }
  if (!workspace) return { status: 'temporary', seatId, seatContextRevision };
  if (!path.isAbsolute(workspace)) return { status: 'refused', reasonCode: 'conversation-unavailable' };
  return { status: 'ready', backendPort, workspace, seatId, seatContextRevision };
}

function cleanOfficeFileName(sourcePath: string, mode: CommandEveOfficeArtifactMode): string {
  const fallback = mode === 'word' ? 'document.docx' : 'workbook.xlsx';
  const candidate = path
    .basename(sourcePath)
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  return candidate.toLowerCase().endsWith(commandEveOfficeExtension(mode)) ? candidate : fallback;
}

function persistImportedOfficeParent(input: {
  dataPath: string;
  workspace: string;
  seatId: string;
  seatContextRevision: number;
  conversationId: string;
  artifactId: string;
  mode: CommandEveOfficeArtifactMode;
  sourcePath: string;
  source: { buffer: Buffer; sha256: string };
  provenance: ImportedOfficeSourceProvenance;
}): CommandEveOfficeConversationArtifact {
  const store = new ProjectWorkspaceConversationArtifactStore({
    state_root: path.join(input.dataPath, 'project-workspace'),
  });
  const fileName = cleanOfficeFileName(input.sourcePath, input.mode);
  const placement = publishCanonicalArtifact({
    dataPath: input.dataPath,
    workspaceRoot: input.workspace,
    folder: 'dokumente',
    nameHint: fileName,
    fallbackName: input.mode === 'word' ? 'dokument' : 'tabelle',
    extension: commandEveOfficeExtension(input.mode),
    bytes: input.source.buffer,
  });
  const relativePath = placement.relativePath;
  const operationId = commandEveOfficeSourceOperationId({
    seatId: input.seatId,
    seatContextRevision: input.seatContextRevision,
    conversationId: input.conversationId,
    artifactId: input.artifactId,
    mode: input.mode,
    resultSha256: input.source.sha256,
    resultSize: input.source.buffer.length,
    sourceTool: input.provenance.sourceTool,
    sourceMessageId: input.provenance.messageId,
    sourceTurnId: input.provenance.turnId,
    sourceDirectiveIndex: input.provenance.directiveIndex,
  });
  const fingerprint = commandEveOfficeFingerprint(input.mode, input.source.sha256, input.source.buffer.length);
  const payload: CommandEveOfficeConversationArtifactPayload = {
    artifact_type: 'file',
    artifact_id: input.artifactId,
    title: fileName,
    file_name: fileName,
    mime_type: commandEveOfficeMimeType(input.mode),
    path: relativePath,
    ...(placement.cleanupNotice === undefined ? {} : { cleanup_notice: placement.cleanupNotice }),
    size: input.source.buffer.length,
    hash: input.source.sha256,
    managed_office: true,
    office_mode: input.mode,
    origin_capability: COMMAND_EVE_OFFICE_ORIGIN_CAPABILITY,
    origin_action: 'source',
    parent_artifact_id: null,
    source_sha256: input.source.sha256,
    source_size: input.source.buffer.length,
    source_fingerprint: fingerprint,
    result_sha256: input.source.sha256,
    result_fingerprint: fingerprint,
    operation_id: operationId,
    seat_id: input.seatId,
    seat_context_revision: input.seatContextRevision,
    source_message_id: input.provenance.messageId,
    source_turn_id: input.provenance.turnId,
    source_directive_index: input.provenance.directiveIndex,
    source_tool: input.provenance.sourceTool,
  };
  return store.createOfficeArtifact({
    seat_id: input.seatId,
    conversation_id: input.conversationId,
    artifact_id: input.artifactId,
    payload,
  });
}

/**
 * Resolve an explicit document edit target entirely in Main. The renderer passes
 * only conversation/artifact identity and a mode; Main re-reads the persisted
 * artifact source, confines it to the authoritative workspace, verifies the
 * OOXML package, then returns a private immutable staging copy.
 */
export async function resolveCommandEveOfficeArtifactAttachment(
  request: CommandEveOfficeArtifactAttachmentRequest,
  deps: CommandEveOfficeArtifactAttachmentDeps = productionDeps
): Promise<CommandEveOfficeArtifactResolution> {
  if (
    !validOpaqueId(request?.conversationId) ||
    !validOpaqueId(request?.artifactId) ||
    !isDocumentArtifactMode(request?.mode)
  ) {
    return { status: 'refused', reasonCode: 'invalid-request' };
  }

  const authority = await resolveCommandEveOfficeConversationAuthority(request.conversationId, deps);
  if (authority.status === 'temporary') return { status: 'refused', reasonCode: 'conversation-unavailable' };
  if (authority.status !== 'ready') return authority;
  const { backendPort: port, workspace, seatId: capturedSeatId, seatContextRevision: capturedSeatRevision } = authority;
  const seatStillMatches = () =>
    deps.getActiveSeatId() === capturedSeatId && deps.getActiveSeatContextRevision() === capturedSeatRevision;

  try {
    const dataPath = deps.getDataPath();
    const store = new ProjectWorkspaceConversationArtifactStore({
      state_root: path.join(dataPath, 'project-workspace'),
    });
    let parent = store.readOfficeArtifactWithVerifiedRecordLineage(
      capturedSeatId,
      request.conversationId,
      request.artifactId
    );
    let sourcePath: string;
    let source: { buffer: Buffer; sha256: string };
    if (parent) {
      if (
        parent.conversation_id !== request.conversationId ||
        parent.payload.seat_id !== capturedSeatId ||
        parent.payload.office_mode !== request.mode
      ) {
        return { status: 'refused', reasonCode: 'artifact-unavailable' };
      }
      sourcePath = path.resolve(workspace, ...parent.payload.path.split('/'));
      const verified = await readBoundedOfficeSource(workspace, sourcePath, request.mode);
      if (
        !verified ||
        verified.sha256 !== parent.payload.result_sha256 ||
        verified.buffer.length !== parent.payload.size ||
        commandEveOfficeFingerprint(request.mode, verified.sha256, verified.buffer.length) !==
          parent.payload.result_fingerprint
      ) {
        return { status: 'refused', reasonCode: 'source-unsafe' };
      }
      source = verified;
    } else {
      const resolvedSource =
        (await resolveTranscriptArtifactSource(deps, port, request)) ??
        (await resolveStoredArtifactSource(deps, port, request));
      if (!resolvedSource) return { status: 'refused', reasonCode: 'artifact-unavailable' };
      const resolvedSourcePath = resolvedSource.path;
      if (
        !path.isAbsolute(resolvedSourcePath) ||
        path.extname(resolvedSourcePath).toLowerCase() !== extensionForMode(request.mode)
      ) {
        return { status: 'refused', reasonCode: 'source-format-mismatch' };
      }
      const verified = await readBoundedOfficeSource(workspace, resolvedSourcePath, request.mode);
      if (!verified) return { status: 'refused', reasonCode: 'source-unsafe' };
      if (!seatStillMatches()) return { status: 'refused', reasonCode: 'seat-changed' };
      sourcePath = resolvedSourcePath;
      source = verified;
      parent = persistImportedOfficeParent({
        dataPath,
        workspace,
        seatId: capturedSeatId,
        seatContextRevision: capturedSeatRevision,
        conversationId: request.conversationId,
        artifactId: request.artifactId,
        mode: request.mode,
        sourcePath,
        source,
        provenance: resolvedSource.provenance,
      });
    }
    if (!seatStillMatches()) return { status: 'refused', reasonCode: 'seat-changed' };

    const hermesHome = deps.resolveSeatHermesHome(deps.getDataPath(), capturedSeatId);
    const stageDirectory = path.join(hermesHome, 'office-edit-sources', source.sha256.slice(0, 2));
    ensurePrivateDocumentDirectory(hermesHome, stageDirectory);
    const stagedPath = path.join(stageDirectory, source.sha256 + '-' + deps.newId() + extensionForMode(request.mode));
    writePrivateDocumentAtomic(hermesHome, stagedPath, source.buffer);
    if (!seatStillMatches()) return { status: 'refused', reasonCode: 'seat-changed' };
    return {
      status: 'ready',
      path: stagedPath,
      parentArtifactId: parent.id,
      sourceSha256: source.sha256,
      sourceSize: source.buffer.length,
      sourceFingerprint: commandEveOfficeFingerprint(request.mode, source.sha256, source.buffer.length),
      seatId: capturedSeatId,
      seatContextRevision: capturedSeatRevision,
    };
  } catch {
    return { status: 'refused', reasonCode: 'source-unsafe' };
  }
}
