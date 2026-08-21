/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Private managed-image input resolver for document-producing agent turns.
 *
 * The renderer supplies only an exact conversation/artifact pair. Main proves
 * that the active record belongs to the current seat and
 * named conversation, verifies its bytes through the managed-image
 * canonical-or-recovery seam, and materializes or reuses a create-only
 * immutable copy inside the authoritative ACP conversation workspace. The
 * absolute path is IPC-only and must be passed as an `agentFile`; only the safe
 * workspace-relative `bilder/...` path may enter prepared grounding.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type CommandEveManagedArtifactInputRequest,
  type CommandEveManagedArtifactInputResolution,
} from '@/common/config/managedArtifactInputCore';
import { isSafeOpaqueRecordId } from '@/common/config/eveOpaqueTokenCore';
import { readApprovedGeneratedArtifactPreview } from '@process/bridge/generatedArtifactPreviewCore';
import { readImageArtifactBytes, readImageArtifactRecordById } from '@process/commandEve/imageArtifactStore';
import { registerCommandEveFileSelectionGrant } from '@process/commandEve/fileSelectionGrantCore';
import { getActiveSeatContextRevision, getActiveSeatId } from '@process/commandEve/seatContextCore';
import {
  resolveCommandEveOfficeConversationAuthority,
  type CommandEveOfficeConversationAuthority,
} from '@process/commandEve/officeArtifactAttachmentCore';
import { writePrivateDocumentImmutable } from '@process/commandEve/document/privateDocumentCache';
import {
  adoptManagedImageArtifactProjectPlacement,
  isSafeManagedImageArtifactPath,
  readManagedImageArtifactWorkspace,
  TEMPORARY_IMAGE_ARTIFACT_NOTICE,
} from '@process/commandEve/visual/managedImageArtifactPlacement';
import {
  canonicalArtifactSlug,
  publishCanonicalArtifact,
  verifyCanonicalArtifact,
} from '@process/services/project-workspace/storage/canonicalArtifactPlacement';
import { getDataPath } from '@process/utils/utils';

const IMAGE_FILE_EXTENSIONS: Readonly<Record<string, '.png' | '.jpg' | '.webp'>> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

export interface CommandEveManagedArtifactInputResolverDeps {
  getDataPath: typeof getDataPath;
  getActiveSeatId: typeof getActiveSeatId;
  getActiveSeatContextRevision: typeof getActiveSeatContextRevision;
  readRecord: typeof readImageArtifactRecordById;
  readBytes: typeof readImageArtifactBytes;
  resolveConversationAuthority: typeof resolveCommandEveOfficeConversationAuthority;
  publishCanonicalArtifact: typeof publishCanonicalArtifact;
  verifyCanonicalArtifact: typeof verifyCanonicalArtifact;
  registerFileSelectionGrant: typeof registerCommandEveFileSelectionGrant;
  readGeneratedArtifactPreview: typeof readApprovedGeneratedArtifactPreview;
  getDownloadsRoot: () => string;
  getBackendPort: () => number | undefined;
  fetch: typeof fetch;
  adoptProjectPlacement?: typeof adoptManagedImageArtifactProjectPlacement;
}

const productionDeps: CommandEveManagedArtifactInputResolverDeps = {
  getDataPath,
  getActiveSeatId,
  getActiveSeatContextRevision,
  readRecord: readImageArtifactRecordById,
  readBytes: readImageArtifactBytes,
  resolveConversationAuthority: resolveCommandEveOfficeConversationAuthority,
  publishCanonicalArtifact,
  verifyCanonicalArtifact,
  registerFileSelectionGrant: registerCommandEveFileSelectionGrant,
  readGeneratedArtifactPreview: readApprovedGeneratedArtifactPreview,
  getDownloadsRoot: () => path.join(os.homedir(), 'Downloads'),
  getBackendPort: () => (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort,
  fetch: (input, init) => globalThis.fetch(input, init),
};

type ReadyConversationAuthority = Extract<CommandEveOfficeConversationAuthority, { status: 'ready' }>;

type CommandEveManagedArtifactInputResolveOptions = Readonly<{
  authority?: ReadyConversationAuthority;
  grantReadAccess?: boolean;
}>;

function extensionForManagedImageMimeType(mimeType: string): '.png' | '.jpg' | '.webp' | undefined {
  return IMAGE_FILE_EXTENSIONS[mimeType];
}

class SeatChangedDuringMaterialization extends Error {}

function resolveTemporaryConversationWorkspace(dataPath: string, conversationId: string): string | null {
  const workspaceName = `hermes-temp-${conversationId}`;
  const namedConversationsRoot = path.join(path.resolve(dataPath), 'conversations');
  try {
    // The app-data conversations directory may itself be the maintained CLI
    // compatibility symlink. Resolve that parent once, then require the exact
    // conversation child to remain inside the same real directory.
    const realConversationsRoot = fs.realpathSync.native(namedConversationsRoot);
    const realWorkspace = fs.realpathSync.native(path.join(namedConversationsRoot, workspaceName));
    const stat = fs.lstatSync(realWorkspace);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      path.dirname(realWorkspace) !== realConversationsRoot ||
      path.basename(realWorkspace) !== workspaceName
    ) {
      return null;
    }
    return realWorkspace;
  } catch {
    return null;
  }
}

function findReusableWorkspaceImage(input: {
  workspaceRoot: string;
  title: string;
  extension: '.png' | '.jpg' | '.webp';
  sha256: string;
  size: number;
  declaredRelativePath?: string;
  verify: typeof verifyCanonicalArtifact;
}): { relativePath: string; absolutePath: string } | null {
  const candidates: string[] = [];
  if (input.declaredRelativePath && isSafeManagedImageArtifactPath(input.declaredRelativePath)) {
    candidates.push(input.declaredRelativePath);
  }

  const extension = input.extension.slice(1);
  const stableStem = canonicalArtifactSlug(
    `${input.title}-${input.sha256.slice(0, 12)}`,
    `bild-${input.sha256.slice(0, 12)}`
  );
  const imagesDirectory = path.join(input.workspaceRoot, 'bilder');
  try {
    for (const entry of fs.readdirSync(imagesDirectory, { withFileTypes: true }).slice(0, 10_000)) {
      if (!entry.isFile() || entry.name.includes('\0')) continue;
      if (!entry.name.startsWith(`${stableStem}-`) || !entry.name.toLowerCase().endsWith(`.${extension}`)) continue;
      candidates.push(path.posix.join('bilder', entry.name));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  for (const relativePath of new Set(candidates)) {
    const verified = input.verify({
      workspaceRoot: input.workspaceRoot,
      relativePath,
      sha256: input.sha256,
      size: input.size,
    });
    if (verified.ok) return { relativePath, absolutePath: verified.absolutePath };
  }
  return null;
}

function isSafePdfSourcePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\0')) return false;
  if (path.extname(value).toLowerCase() !== '.pdf') return false;
  if (path.isAbsolute(value)) return true;
  return value
    .split(/[\\/]/)
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..' && !/\p{Cc}/u.test(segment));
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function normalizeRelativePath(value: string): string {
  return value.split(/[\\/]/).join('/');
}

function pdfSourcePathsMatch(requested: string, stored: string): boolean {
  if (path.isAbsolute(requested) || path.isAbsolute(stored)) {
    return path.isAbsolute(requested) && path.isAbsolute(stored) && path.resolve(requested) === path.resolve(stored);
  }
  return normalizeRelativePath(requested) === normalizeRelativePath(stored);
}

async function readStoredPdfArtifactPath(input: {
  fetch: typeof fetch;
  backendPort: number;
  conversationId: string;
  artifactId: string;
}): Promise<string | null> {
  try {
    const response = await input.fetch(
      `http://127.0.0.1:${input.backendPort}/api/conversations/${encodeURIComponent(input.conversationId)}/artifacts`,
      { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5_000) }
    );
    if (!response.ok) return null;
    const body = recordOf(await response.json());
    const artifacts = Array.isArray(body?.data) ? body.data : null;
    if (!artifacts) return null;
    const matches = artifacts.map(recordOf).filter((artifact) => artifact?.id === input.artifactId);
    if (matches.length !== 1) return null;
    const artifact = matches[0];
    const payload = recordOf(artifact?.payload);
    if (
      !artifact ||
      !payload ||
      artifact.conversation_id !== input.conversationId ||
      !['active', 'saved'].includes(String(artifact.status)) ||
      (artifact.kind !== 'file' && payload.artifact_type !== 'file')
    ) {
      return null;
    }
    const sourcePath = readString(payload, [
      'path',
      'file_path',
      'filePath',
      'absolute_path',
      'absolutePath',
      'relative_path',
    ]);
    return sourcePath && isSafePdfSourcePath(sourcePath) ? sourcePath : null;
  } catch {
    return null;
  }
}

async function resolveApprovedPdfInput(input: {
  sourcePath: string;
  workspaceRoot: string | null;
  downloadsRoot: string;
  readPreview: typeof readApprovedGeneratedArtifactPreview;
}): Promise<string | null> {
  const roots = [...(input.workspaceRoot ? [input.workspaceRoot] : []), input.downloadsRoot];
  const candidates = roots.flatMap((root) => {
    const candidate = path.isAbsolute(input.sourcePath)
      ? input.sourcePath
      : input.workspaceRoot === root
        ? path.resolve(root, ...input.sourcePath.split(/[\\/]/))
        : null;
    return candidate ? [{ candidate, root }] : [];
  });
  const verified = await Promise.all(
    candidates.map(async ({ candidate, root }) => ({
      candidate,
      approved: (await input.readPreview({ path: candidate, kind: 'pdf' }, root)) !== null,
    }))
  );
  return verified.find(({ approved }) => approved)?.candidate ?? null;
}

/**
 * Resolve exactly one active managed image to a private immutable attachment.
 * Any disagreement about seat, conversation, source bytes or on-disk identity
 * fails closed and exposes no path.
 */
export async function resolveCommandEveManagedArtifactInput(
  request: CommandEveManagedArtifactInputRequest | undefined,
  deps: CommandEveManagedArtifactInputResolverDeps = productionDeps,
  options: CommandEveManagedArtifactInputResolveOptions = {}
): Promise<CommandEveManagedArtifactInputResolution> {
  if (
    !request ||
    !isSafeOpaqueRecordId(request.conversationId) ||
    !isSafeOpaqueRecordId(request.artifactId) ||
    (request.sourcePath !== undefined && !isSafePdfSourcePath(request.sourcePath))
  ) {
    return { status: 'refused', reasonCode: 'invalid-request' };
  }

  try {
    const dataPath = deps.getDataPath();
    const capturedSeatId = deps.getActiveSeatId();
    const capturedSeatContextRevision = deps.getActiveSeatContextRevision();
    const seatStillMatches = () =>
      deps.getActiveSeatId() === capturedSeatId && deps.getActiveSeatContextRevision() === capturedSeatContextRevision;

    if (request.sourcePath !== undefined) {
      const authority = options.authority ?? (await deps.resolveConversationAuthority(request.conversationId));
      if (!seatStillMatches()) return { status: 'refused', reasonCode: 'seat-changed' };
      if (authority.status === 'refused') {
        return {
          status: 'refused',
          reasonCode: authority.reasonCode === 'seat-changed' ? 'seat-changed' : 'artifact-unavailable',
        };
      }
      if (authority.seatId !== capturedSeatId || authority.seatContextRevision !== capturedSeatContextRevision) {
        return { status: 'refused', reasonCode: 'seat-changed' };
      }
      const workspaceRoot =
        authority.status === 'ready'
          ? authority.workspace
          : resolveTemporaryConversationWorkspace(dataPath, request.conversationId);
      const backendPort = authority.status === 'ready' ? authority.backendPort : deps.getBackendPort();
      if (!backendPort) return { status: 'refused', reasonCode: 'artifact-unavailable' };
      const storedSourcePath = await readStoredPdfArtifactPath({
        fetch: deps.fetch,
        backendPort,
        conversationId: request.conversationId,
        artifactId: request.artifactId,
      });
      if (!storedSourcePath || !pdfSourcePathsMatch(request.sourcePath, storedSourcePath)) {
        return { status: 'refused', reasonCode: 'artifact-unavailable' };
      }
      if (!seatStillMatches()) return { status: 'refused', reasonCode: 'seat-changed' };
      const agentFilePath = await resolveApprovedPdfInput({
        sourcePath: storedSourcePath,
        workspaceRoot,
        downloadsRoot: deps.getDownloadsRoot(),
        readPreview: deps.readGeneratedArtifactPreview,
      });
      if (!agentFilePath) return { status: 'refused', reasonCode: 'source-unsafe' };
      if (!seatStillMatches()) return { status: 'refused', reasonCode: 'seat-changed' };
      if (
        options.grantReadAccess !== false &&
        !deps.registerFileSelectionGrant({
          filePath: agentFilePath,
          seatId: capturedSeatId,
          purpose: 'read',
        })
      ) {
        return { status: 'refused', reasonCode: 'stage-failed' };
      }
      if (!seatStillMatches()) return { status: 'refused', reasonCode: 'seat-changed' };
      return { status: 'ready', agentFilePath };
    }

    const record = deps.readRecord(dataPath, request.artifactId, capturedSeatId);
    if (
      !record ||
      record.id !== request.artifactId ||
      record.status !== 'active' ||
      record.seat_id !== capturedSeatId ||
      record.conversation_id !== request.conversationId
    ) {
      return { status: 'refused', reasonCode: 'artifact-unavailable' };
    }

    const extension = extensionForManagedImageMimeType(record.payload.mime_type);
    if (!extension) return { status: 'refused', reasonCode: 'source-unsafe' };

    const sourceBytes = deps.readBytes(dataPath, request.artifactId, capturedSeatId);
    if (!sourceBytes || sourceBytes.length !== record.payload.size) {
      return { status: 'refused', reasonCode: 'source-unsafe' };
    }
    const observedSha256 = crypto.createHash('sha256').update(sourceBytes).digest('hex');
    if (observedSha256 !== record.payload.sha256) {
      return { status: 'refused', reasonCode: 'source-unsafe' };
    }
    if (!seatStillMatches()) return { status: 'refused', reasonCode: 'seat-changed' };

    const authority = options.authority ?? (await deps.resolveConversationAuthority(request.conversationId));
    if (!seatStillMatches()) return { status: 'refused', reasonCode: 'seat-changed' };
    if (authority.status === 'refused') {
      return {
        status: 'refused',
        reasonCode: authority.reasonCode === 'seat-changed' ? 'seat-changed' : 'artifact-unavailable',
      };
    }
    if (authority.seatId !== capturedSeatId || authority.seatContextRevision !== capturedSeatContextRevision) {
      return { status: 'refused', reasonCode: 'seat-changed' };
    }
    const persistedWorkspace =
      authority.status === 'temporary' && !record.payload.cleanup_notice?.includes(TEMPORARY_IMAGE_ARTIFACT_NOTICE)
        ? readManagedImageArtifactWorkspace(dataPath, record.id)
        : undefined;
    const persistedPlacement =
      persistedWorkspace && record.payload.path && isSafeManagedImageArtifactPath(record.payload.path)
        ? findReusableWorkspaceImage({
            workspaceRoot: persistedWorkspace,
            title: record.payload.title,
            extension,
            sha256: observedSha256,
            size: record.payload.size,
            declaredRelativePath: record.payload.path,
            verify: deps.verifyCanonicalArtifact,
          })
        : null;
    const workspaceRoot = persistedPlacement
      ? persistedWorkspace
      : authority.status === 'ready'
        ? authority.workspace
        : resolveTemporaryConversationWorkspace(dataPath, request.conversationId);
    if (!workspaceRoot) return { status: 'refused', reasonCode: 'stage-failed' };

    let placement =
      persistedPlacement ??
      findReusableWorkspaceImage({
        workspaceRoot,
        title: record.payload.title,
        extension,
        sha256: observedSha256,
        size: record.payload.size,
        declaredRelativePath: record.payload.path,
        verify: deps.verifyCanonicalArtifact,
      });
    if (!placement && record.payload.path && isSafeManagedImageArtifactPath(record.payload.path)) {
      try {
        const absolutePath = path.resolve(workspaceRoot, ...record.payload.path.split('/'));
        writePrivateDocumentImmutable(workspaceRoot, absolutePath, sourceBytes);
        const verified = deps.verifyCanonicalArtifact({
          workspaceRoot,
          relativePath: record.payload.path,
          sha256: observedSha256,
          size: record.payload.size,
        });
        if (verified.ok) placement = { relativePath: record.payload.path, absolutePath: verified.absolutePath };
      } catch {
        // A conflicting or unsafe target must never be replaced. The normal
        // canonical publisher below may choose a fresh immutable filename.
      }
    }
    if (!placement) {
      const published = deps.publishCanonicalArtifact({
        dataPath,
        workspaceRoot,
        folder: 'bilder',
        nameHint: `${record.payload.title}-${observedSha256.slice(0, 12)}`,
        fallbackName: `bild-${observedSha256.slice(0, 12)}`,
        extension: extension.slice(1),
        bytes: sourceBytes,
        beforePublish: () => {
          if (!seatStillMatches()) throw new SeatChangedDuringMaterialization();
        },
      });
      const verified = deps.verifyCanonicalArtifact({
        workspaceRoot,
        relativePath: published.relativePath,
        sha256: observedSha256,
        size: record.payload.size,
      });
      if (!verified.ok) return { status: 'refused', reasonCode: 'stage-failed' };
      placement = { relativePath: published.relativePath, absolutePath: verified.absolutePath };
    }

    const agentFilePath = placement.absolutePath;

    if (!seatStillMatches()) return { status: 'refused', reasonCode: 'seat-changed' };
    if (
      authority.status === 'ready' &&
      !(deps.adoptProjectPlacement ?? adoptManagedImageArtifactProjectPlacement)(dataPath, {
        artifactId: record.id,
        conversationId: request.conversationId,
        expectedSeatId: capturedSeatId,
        workspaceRoot,
        relativePath: placement.relativePath,
      })
    ) {
      return { status: 'refused', reasonCode: 'stage-failed' };
    }
    if (!seatStillMatches()) return { status: 'refused', reasonCode: 'seat-changed' };
    if (
      options.grantReadAccess !== false &&
      !deps.registerFileSelectionGrant({
        filePath: agentFilePath,
        seatId: capturedSeatId,
        purpose: 'read',
      })
    ) {
      return { status: 'refused', reasonCode: 'stage-failed' };
    }
    if (!seatStillMatches()) return { status: 'refused', reasonCode: 'seat-changed' };
    return {
      status: 'ready',
      agentFilePath,
    };
  } catch (error) {
    if (error instanceof SeatChangedDuringMaterialization) {
      return { status: 'refused', reasonCode: 'seat-changed' };
    }
    return { status: 'refused', reasonCode: 'stage-failed' };
  }
}

/**
 * Persist one already-managed image in a Main-attested project workspace.
 * Project assignment needs the ordinary copy/verify/adopt path, but it is not
 * itself an agent file-read request and therefore mints no read grant.
 */
export function materializeCommandEveManagedImageInProject(
  request: Pick<CommandEveManagedArtifactInputRequest, 'conversationId' | 'artifactId'>,
  authority: ReadyConversationAuthority,
  deps: CommandEveManagedArtifactInputResolverDeps = productionDeps
): Promise<CommandEveManagedArtifactInputResolution> {
  return resolveCommandEveManagedArtifactInput(request, deps, {
    authority,
    grantReadAccess: false,
  });
}
