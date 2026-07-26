/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_GRANT_TTL_MS = 30 * 60 * 1000;
const APP_UPLOAD_GRANT_TTL_MS = 5 * 60 * 1000;
const MAX_ACTIVE_GRANTS = 256;
const MAX_PATH_LENGTH = 4096;

type FileSelectionGrant = {
  seatId: string;
  expiresAt: number;
  purpose: 'read' | 'write';
};

const fileSelectionGrants = new Map<string, FileSelectionGrant>();

function normalizeGrantedPath(filePath: unknown): string | null {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > MAX_PATH_LENGTH) return null;
  if (filePath.includes('\0') || !path.isAbsolute(filePath)) return null;
  return path.resolve(filePath);
}

function removeExpired(nowMs: number): void {
  for (const [grantKey, grant] of fileSelectionGrants) {
    if (grant.expiresAt <= nowMs) fileSelectionGrants.delete(grantKey);
  }
}

function grantKey(purpose: 'read' | 'write', normalizedPath: string): string {
  return `${purpose}\0${normalizedPath}`;
}

export function registerCommandEveFileSelectionGrant(input: {
  filePath: unknown;
  seatId: string;
  purpose: 'read' | 'write';
  nowMs?: number;
  ttlMs?: number;
}): boolean {
  const normalized = normalizeGrantedPath(input.filePath);
  const seatId = String(input.seatId || '').trim();
  const nowMs = input.nowMs ?? Date.now();
  const ttlMs = input.ttlMs ?? DEFAULT_GRANT_TTL_MS;
  if (
    !normalized ||
    !seatId ||
    !['read', 'write'].includes(input.purpose) ||
    !Number.isFinite(ttlMs) ||
    ttlMs <= 0 ||
    ttlMs > DEFAULT_GRANT_TTL_MS
  )
    return false;

  removeExpired(nowMs);
  const key = grantKey(input.purpose, normalized);
  if (!fileSelectionGrants.has(key) && fileSelectionGrants.size >= MAX_ACTIVE_GRANTS) {
    const oldest = fileSelectionGrants.keys().next().value;
    if (oldest) fileSelectionGrants.delete(oldest);
  }
  fileSelectionGrants.set(key, { seatId, expiresAt: nowMs + ttlMs, purpose: input.purpose });
  return true;
}

/**
 * Grant a file created by AionCore's HTTP upload endpoint without trusting a
 * renderer-supplied path. AionCore stores those files below
 * `<tempDir>/aionui/{general|conversation-id}`. Main resolves both the root and
 * candidate through the filesystem, rejects links/non-files, and only then
 * records the same seat-bound read grant used for native file selections.
 */
export function registerCommandEveAppOwnedUploadGrant(input: {
  filePath: unknown;
  tempDir: string;
  seatId: string;
  nowMs?: number;
}): boolean {
  const normalized = normalizeGrantedPath(input.filePath);
  const tempDir = String(input.tempDir || '').trim();
  if (!normalized || !tempDir || !path.isAbsolute(tempDir)) return false;

  try {
    const uploadRootPath = path.resolve(tempDir, 'aionui');
    const uploadRootStats = fs.lstatSync(uploadRootPath);
    if (!uploadRootStats.isDirectory() || uploadRootStats.isSymbolicLink()) return false;
    const uploadRoot = fs.realpathSync.native(uploadRootPath);
    const stats = fs.lstatSync(normalized);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) return false;

    const realFilePath = fs.realpathSync.native(normalized);
    const relative = path.relative(uploadRoot, realFilePath);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      return false;
    }

    return registerCommandEveFileSelectionGrant({
      // Keep the exact normalized path returned by AionCore as the grant key.
      // On macOS realpath expands /var to /private/var; the renderer later
      // presents the original /var path, so keying on realFilePath would make
      // a successfully attested upload fail the subsequent grant lookup.
      filePath: normalized,
      seatId: input.seatId,
      purpose: 'read',
      nowMs: input.nowMs,
      ttlMs: APP_UPLOAD_GRANT_TTL_MS,
    });
  } catch {
    return false;
  }
}

export function areCommandEveFileSelectionPathsGranted(input: {
  filePaths: readonly string[];
  seatId: string;
  purpose: 'read' | 'write';
  nowMs?: number;
}): boolean {
  const seatId = String(input.seatId || '').trim();
  const nowMs = input.nowMs ?? Date.now();
  if (!seatId || input.filePaths.length === 0) return false;
  removeExpired(nowMs);
  return input.filePaths.every((filePath) => {
    const normalized = normalizeGrantedPath(filePath);
    if (!normalized) return false;
    const grant = fileSelectionGrants.get(grantKey(input.purpose, normalized));
    return Boolean(grant && grant.purpose === input.purpose && grant.seatId === seatId && grant.expiresAt > nowMs);
  });
}

export function consumeCommandEveFileSelectionPathGrant(input: {
  filePath: string;
  seatId: string;
  purpose: 'read' | 'write';
  nowMs?: number;
}): boolean {
  if (
    !areCommandEveFileSelectionPathsGranted({
      filePaths: [input.filePath],
      seatId: input.seatId,
      purpose: input.purpose,
      nowMs: input.nowMs,
    })
  ) {
    return false;
  }
  const normalized = normalizeGrantedPath(input.filePath);
  if (!normalized) return false;
  fileSelectionGrants.delete(grantKey(input.purpose, normalized));
  return true;
}

export function clearCommandEveFileSelectionGrantsForTests(): void {
  fileSelectionGrants.clear();
}
