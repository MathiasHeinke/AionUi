/*
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1769 (requirement 9) — local, desktop-owned durability for IMAGES THE
 * USER SENT, so a follow-up ("das Bild", "the second one") resolves the latest
 * visible image artifact natively from the artifact registry WITHOUT
 * reattachment.
 *
 * THE GAP THIS CLOSES. The artifact context envelope (MAT-1747) re-lists VIDEO
 * artifacts on every turn from `videoArtifactStore`, and it names the images
 * pending on the DRAFT as `reference_image` entries (MAT-1753) — but only on
 * the turn that carries them. One turn later the attached image had no durable
 * record at all: the agent could only hope its own scrollback still held the
 * earlier envelope. This store is the image counterpart of the video manifest
 * directory: one JSON record per sent image, keyed by conversation, under the
 * private app data directory.
 *
 * WHAT A RECORD DELIBERATELY IS NOT. It is a REFERENCE, not a copy: no image
 * bytes and no filesystem path are stored. The envelope's no-path rule is
 * absolute, and a record that cannot outlive its purpose carries nothing a
 * later reader could misuse. Identity is the SHA-256 of the bytes Main already
 * hashed for the reference entries, so re-sending the same image (a restored
 * draft, a retried send) is idempotent — one record, first-write wins.
 *
 * GENERATED images are out of scope here on purpose: the managed image
 * generation lane is agent-mediated through the Ollama shim and produces no
 * Main-side conversation artifact record in this build, so there is nothing
 * truthful to register. The slice that exists — attached-and-sent images — is
 * registered where it is seen: the artifact-context-envelope handler.
 */

import fs from 'node:fs';
import path from 'node:path';

const IMAGE_ARTIFACT_MANIFEST_DIR = 'command-eve-image-artifacts';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export type CommandEveImageArtifactRecord = {
  /** `image-<first 16 hex of the content hash>` — stable, opaque, filesystem-safe. */
  id: string;
  conversation_id: string;
  sha256: string;
  mimeType: string;
  created_at: number;
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
  return path.join(dataPath, IMAGE_ARTIFACT_MANIFEST_DIR, conversationId);
}

/**
 * The mime type the envelope may state, derived from the file extension only.
 * Reading magic bytes would be a second read of every attachment on the send
 * path for no decision this record makes; the extension is what the local
 * image boundary already accepted, and anything else stays `image/*`.
 */
export function imageMimeTypeFromPath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    default:
      return 'image/*';
  }
}

/** The stable record id for one image's content hash. */
export function imageArtifactIdForSha256(sha256: string): string {
  return `image-${sha256.slice(0, 16)}`;
}

/**
 * Persist the record for one sent image. FIRST-WRITE WINS: an existing record
 * for the same content hash keeps its original `created_at`, so a retried or
 * restored send never reorders the registry. An unsafe id or conversation is
 * refused silently — a record we cannot name safely is worse than none.
 */
export function saveImageArtifactRecord(dataPath: string, record: CommandEveImageArtifactRecord): void {
  if (
    !SAFE_ID.test(record.id) ||
    !SAFE_ID.test(record.conversation_id) ||
    !SHA256_RE.test(record.sha256) ||
    typeof record.created_at !== 'number' ||
    !Number.isFinite(record.created_at)
  ) {
    return;
  }
  const file = path.join(manifestDirectory(dataPath, record.conversation_id), `${record.id}.json`);
  if (fs.existsSync(file)) return;
  writeJsonAtomic(file, record);
}

function parseImageArtifactRecord(value: unknown): CommandEveImageArtifactRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    !SAFE_ID.test(record.id) ||
    typeof record.conversation_id !== 'string' ||
    typeof record.sha256 !== 'string' ||
    !SHA256_RE.test(record.sha256) ||
    typeof record.mimeType !== 'string' ||
    typeof record.created_at !== 'number' ||
    !Number.isFinite(record.created_at)
  ) {
    return undefined;
  }
  return {
    id: record.id,
    conversation_id: record.conversation_id,
    sha256: record.sha256,
    mimeType: record.mimeType,
    created_at: record.created_at,
  };
}

/** Every locally-durable sent-image record for this conversation, oldest first. */
export function listImageArtifactRecords(dataPath: string, conversationId: string): CommandEveImageArtifactRecord[] {
  if (!SAFE_ID.test(conversationId)) return [];
  const directory = manifestDirectory(dataPath, conversationId);
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => {
      try {
        return parseImageArtifactRecord(JSON.parse(fs.readFileSync(path.join(directory, entry.name), 'utf8')));
      } catch {
        return undefined;
      }
    })
    .filter((record): record is CommandEveImageArtifactRecord => Boolean(record))
    .toSorted((a, b) => a.created_at - b.created_at);
}
