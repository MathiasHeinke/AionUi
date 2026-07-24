/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';

const DEFAULT_GRANT_TTL_MS = 30 * 60 * 1000;
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
