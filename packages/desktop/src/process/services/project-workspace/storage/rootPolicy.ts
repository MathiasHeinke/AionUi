import fs from 'node:fs';
import path from 'node:path';
import type { ProjectWorkspaceReasonCode } from '@/common/types/project-workspace/reasonCodes';

export type CanonicalRoot = { canonical_path: string; comparison_key: string };
export type CanonicalRootResult =
  | ({ ok: true } & CanonicalRoot)
  | { ok: false; reason_code: ProjectWorkspaceReasonCode };

function portableSeparators(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/+$/g, '') || '/';
}

/** APFS-safe comparison projection: realpath input, NFC, separator fold, and Unicode lower-case. */
export function rootComparisonKey(value: string): string {
  return portableSeparators(path.resolve(value).normalize('NFC')).toLocaleLowerCase('en-US');
}

export function canonicalizeRoot(candidatePath: string): CanonicalRootResult {
  if (!path.isAbsolute(candidatePath)) return { ok: false, reason_code: 'root.escape' };
  let lexicalStat: fs.Stats;
  try {
    lexicalStat = fs.lstatSync(candidatePath);
  } catch {
    return { ok: false, reason_code: 'root.not-found' };
  }
  if (lexicalStat.isSymbolicLink()) return { ok: false, reason_code: 'root.symlink' };
  let canonicalPath: string;
  try {
    canonicalPath = fs.realpathSync.native(candidatePath);
    if (!fs.statSync(canonicalPath).isDirectory()) return { ok: false, reason_code: 'root.not-directory' };
    fs.accessSync(canonicalPath, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    return { ok: false, reason_code: 'root.not-writable' };
  }
  return {
    ok: true,
    canonical_path: canonicalPath,
    comparison_key: rootComparisonKey(canonicalPath),
  };
}

function overlaps(left: string, right: string): boolean {
  if (left === right) return true;
  const prefix = left.endsWith('/') ? left : `${left}/`;
  const reversePrefix = right.endsWith('/') ? right : `${right}/`;
  return right.startsWith(prefix) || left.startsWith(reversePrefix);
}

export type RootOwnershipComparable = {
  root_id: string;
  seat_id: string;
  canonical_path: string;
  comparison_key: string;
};

export function findRootOwnershipConflict(
  candidate: RootOwnershipComparable,
  existing: RootOwnershipComparable[]
): { reason_code: 'root.overlap'; owner_root_id: string; owner_seat_id: string } | undefined {
  const conflict = existing.find(
    (record) => record.root_id !== candidate.root_id && overlaps(record.comparison_key, candidate.comparison_key)
  );
  return conflict
    ? { reason_code: 'root.overlap', owner_root_id: conflict.root_id, owner_seat_id: conflict.seat_id }
    : undefined;
}

export type ProjectTargetResult =
  | { ok: true; target_path: string; comparison_key: string }
  | { ok: false; reason_code: ProjectWorkspaceReasonCode };

export function resolveProjectTarget(
  canonicalRoot: string,
  slug: string,
  registeredProjectPaths: string[]
): ProjectTargetResult {
  const root = path.resolve(canonicalRoot);
  const target = path.resolve(root, slug);
  const targetKey = rootComparisonKey(target);
  const projectOverlap = registeredProjectPaths.some((existing) => overlaps(rootComparisonKey(existing), targetKey));
  if (projectOverlap) return { ok: false, reason_code: 'root.project-overlap' };
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(slug)) {
    return { ok: false, reason_code: 'root.escape' };
  }
  const relative = path.relative(root, target);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, reason_code: 'root.escape' };
  }
  if (fs.existsSync(target)) {
    try {
      if (fs.lstatSync(target).isSymbolicLink()) return { ok: false, reason_code: 'root.symlink' };
    } catch {
      return { ok: false, reason_code: 'workspace.io-failed' };
    }
  }
  return { ok: true, target_path: target, comparison_key: targetKey };
}
