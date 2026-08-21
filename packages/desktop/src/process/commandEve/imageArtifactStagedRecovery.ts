import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isSha256Hex } from '@/common/config/eveOpaqueTokenCore';
import type { CommandEveManagedImageArtifact } from '@/common/config/managedImageArtifactCore';

export type RecoverableStagedImageEditArtifact = {
  record: CommandEveManagedImageArtifact;
  handle: string;
};

type StagedImageRecoveryEntry = {
  handle: string;
  artifact_id: string;
  seat_id: string;
  expires_at_ms: number;
  bound?: boolean;
};

type StagedImageRecoveryDeps = {
  stagedDirectory(dataPath: string): string;
  isValidSeatId(seatId: string): boolean;
  isSafeArtifactId(artifactId: string): boolean;
  readStagedHandleFile(file: string): StagedImageRecoveryEntry | undefined;
  readImageArtifactRecordById(
    dataPath: string,
    artifactId: string,
    expectedSeatId: string
  ): CommandEveManagedImageArtifact | undefined;
  readImageArtifactBytes(dataPath: string, artifactId: string, expectedSeatId: string): Buffer | undefined;
};

/**
 * Read-only recovery scan over staged handles. The store remains responsible
 * for the staged record schema, paths, lifecycle writes and byte persistence.
 */
export function findRecoverableStagedImageEditArtifact(
  dataPath: string,
  input: {
    expectedSeatId: string;
    parentArtifactId: string;
    editRequestSha256: string;
    nowMs?: number;
  },
  deps: StagedImageRecoveryDeps
): RecoverableStagedImageEditArtifact | undefined {
  if (
    !deps.isValidSeatId(input.expectedSeatId) ||
    !deps.isSafeArtifactId(input.parentArtifactId) ||
    !isSha256Hex(input.editRequestSha256)
  ) {
    return undefined;
  }
  const nowMs = input.nowMs ?? Date.now();
  const directory = deps.stagedDirectory(dataPath);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return undefined;
  }

  let recovered: RecoverableStagedImageEditArtifact | undefined;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const staged = deps.readStagedHandleFile(path.join(directory, entry.name));
    if (
      !staged ||
      staged.bound === true ||
      staged.seat_id !== input.expectedSeatId ||
      nowMs > staged.expires_at_ms ||
      entry.name !== `${crypto.createHash('sha256').update(staged.handle).digest('hex')}.json`
    ) {
      continue;
    }
    const record = deps.readImageArtifactRecordById(dataPath, staged.artifact_id, input.expectedSeatId);
    if (
      !record ||
      record.id !== staged.artifact_id ||
      record.seat_id !== staged.seat_id ||
      record.status !== 'staged' ||
      record.conversation_id !== null ||
      record.payload.parent_artifact_id !== input.parentArtifactId ||
      record.payload.edit_request_sha256 !== input.editRequestSha256 ||
      !deps.readImageArtifactBytes(dataPath, record.id, input.expectedSeatId)
    ) {
      continue;
    }
    if (recovered) return undefined;
    recovered = { record, handle: staged.handle };
  }
  return recovered;
}
