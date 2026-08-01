/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Local, desktop-owned durability for managed video artifacts.
 *
 * AionCore owns the conversation transcript and its own
 * `/api/conversations/:id/artifacts` store, but managed video generation is a
 * direct Main -> gateway call, outside any agent turn — AionCore never sees it
 * and exposes no create endpoint a client can call. Without a durable record of
 * our own, a generated video would live only in the renderer's in-memory
 * `ConversationArtifactProvider` state and disappear the moment the
 * conversation view remounts (switching away and back, or an app restart) —
 * exactly the "ephemeral, does not survive reload" failure this lane must not
 * repeat.
 *
 * This mirrors the local-JSON-manifest artifact pattern already used for the
 * same class of problem in the project-workspace runtime (one JSON file per
 * artifact, keyed by conversation id, under a private app data directory), just
 * scoped to command-eve managed video instead. The renderer's
 * `ConversationArtifactProvider` merges these in alongside AionCore's own list.
 *
 * The video BYTES are saved under `~/Downloads`, the one local root the
 * existing `readGeneratedArtifactPreview` bridge already trusts for generated
 * media outside the active workspace (see `generatedArtifactPreviewCore.ts`) —
 * reusing it needs no change to that boundary.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CommandEveVideoConversationArtifact } from '@/common/config/videoGenerationRequestCore';
import { hydrateVideoArtifactPayload } from '@/common/config/videoGenerationRequestCore';

const VIDEO_ARTIFACT_MANIFEST_DIR = 'command-eve-video-artifacts';
const VIDEO_DOWNLOADS_SUBDIR = 'Command EVE Videos';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const FALLBACK_DIR_NAME = 'unknown-conversation';

const MIME_TO_EXTENSION: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writeJsonAtomic(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const tempFile = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempFile, file);
}

function manifestDirectory(dataPath: string, conversationId: string): string {
  return path.join(dataPath, VIDEO_ARTIFACT_MANIFEST_DIR, conversationId);
}

/** Save the generated video bytes to a stable, previewable local file. */
export function saveGeneratedVideoFile(input: {
  conversationId: string;
  artifactId: string;
  dataBase64: string;
  mimeType: string;
  /** Test-only override for the Downloads root; production always uses `~/Downloads`. */
  downloadsRoot?: string;
}): string {
  const extension = MIME_TO_EXTENSION[input.mimeType] ?? 'mp4';
  const safeConversationId = SAFE_ID.test(input.conversationId) ? input.conversationId : FALLBACK_DIR_NAME;
  const directory = path.join(
    input.downloadsRoot ?? path.join(os.homedir(), 'Downloads'),
    VIDEO_DOWNLOADS_SUBDIR,
    safeConversationId
  );
  ensureDir(directory);
  const filePath = path.join(directory, `${input.artifactId}.${extension}`);
  fs.writeFileSync(filePath, Buffer.from(input.dataBase64, 'base64'), { mode: 0o600 });
  return filePath;
}

/** Persist the artifact record so it survives a reload of this conversation. */
export function saveVideoArtifactRecord(dataPath: string, artifact: CommandEveVideoConversationArtifact): void {
  if (!SAFE_ID.test(artifact.id) || !SAFE_ID.test(artifact.conversation_id)) return;
  writeJsonAtomic(path.join(manifestDirectory(dataPath, artifact.conversation_id), `${artifact.id}.json`), artifact);
}

function parseArtifactRecord(value: unknown): CommandEveVideoConversationArtifact | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const payload = record.payload;
  if (
    typeof record.id !== 'string' ||
    typeof record.conversation_id !== 'string' ||
    record.kind !== 'video' ||
    record.status !== 'active' ||
    typeof record.created_at !== 'number' ||
    typeof record.updated_at !== 'number' ||
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    typeof (payload as Record<string, unknown>).path !== 'string' ||
    typeof (payload as Record<string, unknown>).mime_type !== 'string'
  ) {
    return undefined;
  }
  const artifact = record as unknown as CommandEveVideoConversationArtifact;
  // Hydrate on the way OUT, not at the call sites. Records written before the
  // registry fields existed are still on disk, and every caller from here on is
  // entitled to a record whose declared fields are actually present. Recovering
  // it once, here, is the difference between a type that describes the data and
  // one that only describes the newest data.
  return { ...artifact, payload: hydrateVideoArtifactPayload(artifact.payload) };
}

/** List every locally-durable video artifact for this conversation, oldest first. */
export function listVideoArtifactRecords(
  dataPath: string,
  conversationId: string
): CommandEveVideoConversationArtifact[] {
  if (!SAFE_ID.test(conversationId)) return [];
  const directory = manifestDirectory(dataPath, conversationId);
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => {
      try {
        return parseArtifactRecord(JSON.parse(fs.readFileSync(path.join(directory, entry.name), 'utf8')));
      } catch {
        return undefined;
      }
    })
    .filter((record): record is CommandEveVideoConversationArtifact => Boolean(record))
    .toSorted((a, b) => a.created_at - b.created_at);
}
