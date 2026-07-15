import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { BonsaiPinnedArtifact } from './bonsaiManifest';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type BonsaiArtifactVerification = Readonly<{
  ok: boolean;
  actualSizeBytes: number;
  actualSha256: string;
  error?: string;
}>;

export type BonsaiResumeDecision = Readonly<{
  append: boolean;
  offset: number;
  headers: Readonly<Record<string, string>>;
}>;

export function assertPinnedHttpsArtifact(artifact: BonsaiPinnedArtifact): void {
  const parsed = new URL(artifact.url);
  if (parsed.protocol !== 'https:') throw new Error(`Refused non-HTTPS Bonsai artifact URL for ${artifact.id}.`);
  if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes <= 0) {
    throw new Error(`Invalid pinned byte size for Bonsai artifact ${artifact.id}.`);
  }
  if (!SHA256_PATTERN.test(artifact.sha256)) {
    throw new Error(`Invalid pinned SHA256 for Bonsai artifact ${artifact.id}.`);
  }
}

export function buildResumeDecision(args: {
  partialSizeBytes: number;
  expectedSizeBytes: number;
  etag?: string;
}): BonsaiResumeDecision {
  const partial = Math.max(0, Math.floor(args.partialSizeBytes));
  if (partial <= 0 || partial >= args.expectedSizeBytes || !args.etag?.trim()) {
    return { append: false, offset: 0, headers: {} };
  }
  return {
    append: true,
    offset: partial,
    headers: {
      range: `bytes=${partial}-`,
      'if-range': args.etag.trim(),
    },
  };
}

export function isSafeArchiveEntry(entry: string): boolean {
  if (!entry || entry.includes('\0') || entry.includes('\\')) return false;
  const normalizedInput = entry.replace(/^\.\//, '');
  if (!normalizedInput || normalizedInput === '.') return true;
  if (path.posix.isAbsolute(normalizedInput)) return false;
  const normalized = path.posix.normalize(normalizedInput);
  return normalized !== '..' && !normalized.startsWith('../') && !normalized.includes('/../');
}

export function isSafeSymlinkTarget(root: string, symlinkPath: string, target: string): boolean {
  if (!target || path.isAbsolute(target)) return false;
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(path.dirname(symlinkPath), target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

export async function sha256File(filePath: string): Promise<string> {
  const digest = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return digest.digest('hex');
}

export async function verifyPinnedArtifactFile(
  filePath: string,
  artifact: BonsaiPinnedArtifact
): Promise<BonsaiArtifactVerification> {
  assertPinnedHttpsArtifact(artifact);
  let actualSizeBytes = 0;
  try {
    actualSizeBytes = fs.statSync(filePath).size;
  } catch {
    return { ok: false, actualSizeBytes, actualSha256: '', error: 'missing' };
  }
  if (actualSizeBytes !== artifact.sizeBytes) {
    return {
      ok: false,
      actualSizeBytes,
      actualSha256: '',
      error: `size mismatch: expected ${artifact.sizeBytes}, got ${actualSizeBytes}`,
    };
  }
  const actualSha256 = await sha256File(filePath);
  if (actualSha256 !== artifact.sha256) {
    return { ok: false, actualSizeBytes, actualSha256, error: 'sha256 mismatch' };
  }
  return { ok: true, actualSizeBytes, actualSha256 };
}

export function availableBytesForPath(targetPath: string): number {
  let cursor = path.resolve(targetPath);
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const stats = fs.statfsSync(cursor);
  return Number(stats.bavail) * Number(stats.bsize);
}
