/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { isSafeOpaqueRecordId } from '@/common/config/eveOpaqueTokenCore';
import {
  parseManagedImageArtifactRecord,
  type CommandEveActiveImageArtifact,
} from '@/common/config/managedImageArtifactCore';
import { sanitizeSeatId } from '@/common/config/seatConfigKeyCore';
import { writeJsonAtomic } from '@process/services/project-workspace/storage/atomicJson';
import { verifyCanonicalArtifact } from '@process/services/project-workspace/storage/canonicalArtifactPlacement';

const MANAGED_IMAGE_ARTIFACT_DIR = 'command-eve-managed-image-artifacts';
export const MANAGED_IMAGE_ARTIFACT_RECORDS_SUBDIR = 'records';
export const MANAGED_IMAGE_ARTIFACT_BLOBS_SUBDIR = 'blobs';
const LOCATIONS_SUBDIR = 'locations';

export const TEMPORARY_IMAGE_ARTIFACT_NOTICE =
  'Dieses Bild gehört zu dieser Unterhaltung und ist nur temporär abgelegt. Ordne die Unterhaltung einem Projekt zu, um es dauerhaft im Projektordner zu sichern.';

export function managedImageArtifactStoreRoot(dataPath: string): string {
  return path.join(path.resolve(dataPath), MANAGED_IMAGE_ARTIFACT_DIR);
}

export function managedImageArtifactRecordFile(dataPath: string, artifactId: string): string {
  return path.join(
    managedImageArtifactStoreRoot(dataPath),
    MANAGED_IMAGE_ARTIFACT_RECORDS_SUBDIR,
    `${artifactId}.json`
  );
}

export function managedImageArtifactBlobFile(dataPath: string, artifactId: string): string {
  return path.join(managedImageArtifactStoreRoot(dataPath), MANAGED_IMAGE_ARTIFACT_BLOBS_SUBDIR, artifactId);
}

export function managedImageArtifactLocationFile(dataPath: string, artifactId: string): string {
  return path.join(managedImageArtifactStoreRoot(dataPath), LOCATIONS_SUBDIR, `${artifactId}.json`);
}

export function isSafeManagedImageArtifactPath(value: string): boolean {
  if (!value || value.length > 256 || value.includes('\0') || value.includes('\\') || /\p{Cc}/u.test(value)) {
    return false;
  }
  const normalized = path.posix.normalize(value);
  return (
    normalized === value &&
    normalized.startsWith('bilder/') &&
    normalized.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
  );
}

export function readManagedImageArtifactWorkspace(dataPath: string, artifactId: string): string | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(managedImageArtifactLocationFile(dataPath, artifactId), 'utf8')) as Record<
      string,
      unknown
    >;
    return typeof value.workspace === 'string' && path.isAbsolute(value.workspace) ? value.workspace : undefined;
  } catch {
    return undefined;
  }
}

/** Adopt an already verified immutable workspace copy as the active project placement. */
export function adoptManagedImageArtifactProjectPlacement(
  dataPath: string,
  input: {
    artifactId: string;
    conversationId: string;
    expectedSeatId: string;
    workspaceRoot: string;
    relativePath: string;
    nowMs?: number;
  }
): boolean {
  if (
    !isSafeOpaqueRecordId(input.artifactId) ||
    !isSafeOpaqueRecordId(input.conversationId) ||
    sanitizeSeatId(input.expectedSeatId) !== input.expectedSeatId ||
    !path.isAbsolute(input.workspaceRoot) ||
    !isSafeManagedImageArtifactPath(input.relativePath)
  ) {
    return false;
  }
  try {
    const record = parseManagedImageArtifactRecord(
      JSON.parse(fs.readFileSync(managedImageArtifactRecordFile(dataPath, input.artifactId), 'utf8')) as unknown
    );
    if (
      !record ||
      record.status !== 'active' ||
      record.id !== input.artifactId ||
      record.seat_id !== input.expectedSeatId ||
      record.conversation_id !== input.conversationId
    ) {
      return false;
    }
    const verified = verifyCanonicalArtifact({
      workspaceRoot: input.workspaceRoot,
      relativePath: input.relativePath,
      sha256: record.payload.sha256,
      size: record.payload.size,
    });
    if (!verified.ok) return false;

    const { cleanup_notice: cleanupNotice, ...payload } = record.payload;
    const remainingNotice = cleanupNotice?.replace(TEMPORARY_IMAGE_ARTIFACT_NOTICE, '').trim();
    const nextRecord: CommandEveActiveImageArtifact = {
      ...record,
      conversation_id: input.conversationId,
      status: 'active',
      payload: {
        ...payload,
        path: input.relativePath,
        ...(remainingNotice ? { cleanup_notice: remainingNotice } : {}),
      },
      updated_at: Math.max(input.nowMs ?? Date.now(), record.updated_at + 1),
    };
    writeJsonAtomic(managedImageArtifactLocationFile(dataPath, record.id), { workspace: input.workspaceRoot });
    writeJsonAtomic(managedImageArtifactRecordFile(dataPath, record.id), nextRecord);
    return true;
  } catch {
    return false;
  }
}
