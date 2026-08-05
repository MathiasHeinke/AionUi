/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1773 (Package B) — MAIN-side hydration of remote video artifacts.
 *
 * The agent-lane video tool answers with a provider CDN URL; the chat renders
 * a card for it and NOTHING ever downloaded the bytes — an expired URL left a
 * blank, unplayable card and no file on disk. This reconcile is the missing
 * download step: it reads the conversation's persisted transcript (the same
 * loopback pattern the image-bind reconcile uses), finds remote `MEDIA:` video
 * directives, downloads each missing clip ONCE into the durable video artifact
 * store (`~/Downloads/Command EVE Videos/…` bytes + manifest with the origin
 * URL under `source_url`), and reports a bounded summary.
 *
 * Fail-quiet by contract: a fetch failure, a refused body, or a bad write is
 * collected per directive and logged once — never thrown into a turn or a
 * list. Idempotent: a directive whose URL already has a durable record is
 * `alreadyLocal`, so the turn-end relay and the list-time call may race
 * freely. No provider call and no debit path exists here — this downloads a
 * clip the seat already paid to produce.
 */

import crypto, { randomUUID } from 'node:crypto';
import {
  extractRemoteVideoDirectives,
  hasVideoFileSignature,
  planVideoHydration,
  validateVideoDownload,
  VIDEO_HYDRATION_TIMEOUT_MS,
  type RemoteVideoDirective,
} from '@/common/config/videoArtifactHydrationCore';
import {
  hydrateVideoArtifactPayload,
  type CommandEveVideoConversationArtifact,
  type CommandEveVideoConversationArtifactPayload,
} from '@/common/config/videoGenerationRequestCore';
import { listVideoArtifactRecords, saveGeneratedVideoFile, saveVideoArtifactRecord } from './videoArtifactStore';

export type RemoteVideoHydrationSummary = {
  conversationId: string;
  directives: number;
  hydrated: number;
  alreadyLocal: number;
  failed: Array<{ url: string; reason: string }>;
  transcriptFetched: boolean;
};

export interface RemoteVideoHydrationDeps {
  /** The persisted transcript window (session-digest pattern: loopback GET). */
  fetchTranscript: (conversationId: string, window: number) => Promise<unknown>;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  saveVideoFile?: typeof saveGeneratedVideoFile;
  saveArtifactRecord?: typeof saveVideoArtifactRecord;
  listRecords?: typeof listVideoArtifactRecords;
  newArtifactId?: () => string;
  nowMs?: () => number;
  log?: (line: string) => void;
  /** Bounded transcript window (message count). */
  window?: number;
}

const DEFAULT_WINDOW = 50;

/** Pull the text contents out of the loopback transcript's message rows. */
function transcriptTextContents(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  const candidates = [record.messages, record.items, record.data && (record.data as Record<string, unknown>).items];
  const list = candidates.find((value) => Array.isArray(value)) as unknown[] | undefined;
  if (!list) return [];
  return list
    .map((message) => {
      if (!message || typeof message !== 'object') return undefined;
      const content = (message as Record<string, unknown>).content;
      if (typeof content === 'string') return content;
      if (content && typeof content === 'object' && typeof (content as Record<string, unknown>).content === 'string') {
        return (content as Record<string, unknown>).content as string;
      }
      return undefined;
    })
    .filter((value): value is string => typeof value === 'string');
}

const buildHydratedArtifact = (input: {
  conversationId: string;
  artifactId: string;
  directive: RemoteVideoDirective;
  filePath: string;
  bytes: Uint8Array;
  mimeType: string;
  nowMs: number;
}): CommandEveVideoConversationArtifact => {
  const payload: CommandEveVideoConversationArtifactPayload = hydrateVideoArtifactPayload({
    artifact_type: 'video',
    title: input.directive.title,
    description: input.directive.title,
    path: input.filePath,
    mime_type: input.mimeType,
    hash: crypto.createHash('sha256').update(input.bytes).digest('hex'),
    size: input.bytes.length,
    duration_seconds: 0,
    origin_capability: 'video_generation',
    // The origin URL is the dedupe key: the message-derived card is suppressed
    // once a durable record covers it, and the next reconcile skips the download.
    source_url: input.directive.url,
  } as CommandEveVideoConversationArtifactPayload);
  return {
    id: input.artifactId,
    conversation_id: input.conversationId,
    kind: 'video',
    status: 'active',
    payload,
    created_at: input.nowMs,
    updated_at: input.nowMs,
  };
};

export async function reconcileConversationRemoteVideos(
  dataPath: string,
  conversationId: string,
  deps: RemoteVideoHydrationDeps
): Promise<RemoteVideoHydrationSummary> {
  const summary: RemoteVideoHydrationSummary = {
    conversationId,
    directives: 0,
    hydrated: 0,
    alreadyLocal: 0,
    failed: [],
    transcriptFetched: false,
  };
  const log = deps.log ?? ((): void => {});
  if (typeof conversationId !== 'string' || conversationId.trim().length === 0) return summary;

  const fetchImpl = deps.fetchImpl ?? fetch;
  const saveFile = deps.saveVideoFile ?? saveGeneratedVideoFile;
  const saveRecord = deps.saveArtifactRecord ?? saveVideoArtifactRecord;
  const listRecords = deps.listRecords ?? listVideoArtifactRecords;
  const newArtifactId = deps.newArtifactId ?? randomUUID;
  const nowMs = deps.nowMs ?? (() => Date.now());

  let transcript: unknown;
  try {
    transcript = await deps.fetchTranscript(conversationId, deps.window ?? DEFAULT_WINDOW);
    summary.transcriptFetched = true;
  } catch (error) {
    log(`[VideoHydration] transcript fetch failed for ${conversationId}: ${String(error)}`);
    return summary;
  }

  const directives = extractRemoteVideoDirectives(transcriptTextContents(transcript));
  summary.directives = directives.length;
  if (directives.length === 0) return summary;

  let existingPayloads: unknown[];
  try {
    existingPayloads = listRecords(dataPath, conversationId).map((record) => record.payload);
  } catch {
    existingPayloads = [];
  }

  const plans = planVideoHydration(directives, existingPayloads);
  for (const plan of plans) {
    if (plan.action === 'already-local') {
      summary.alreadyLocal += 1;
      continue;
    }
    const directive = directives.find((entry) => entry.url === plan.url)!;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), VIDEO_HYDRATION_TIMEOUT_MS);
      let response: Response;
      try {
        // Sequential by design: a conversation carries at most a handful of
        // clips, and parallel CDN pulls buy nothing but flakiness here.
        // eslint-disable-next-line no-await-in-loop
        response = await fetchImpl(plan.url, { redirect: 'follow', signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      const declared = Number(response.headers.get('content-length') ?? NaN);
      const verdict = validateVideoDownload({
        status: response.status,
        contentType: response.headers.get('content-type') ?? 'application/octet-stream',
        ...(Number.isFinite(declared) ? { declaredBytes: declared } : {}),
      });
      if (verdict.ok === false) {
        summary.failed.push({ url: plan.url, reason: verdict.reason });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!hasVideoFileSignature(bytes)) {
        summary.failed.push({ url: plan.url, reason: 'bad-signature' });
        continue;
      }
      const mimeType = (response.headers.get('content-type') ?? 'video/mp4').split(';')[0].trim() || 'video/mp4';
      const artifactId = newArtifactId();
      const filePath = saveFile({
        conversationId,
        artifactId,
        dataBase64: Buffer.from(bytes).toString('base64'),
        mimeType,
      });
      const artifact = buildHydratedArtifact({
        conversationId,
        artifactId,
        directive,
        filePath,
        bytes,
        mimeType,
        nowMs: nowMs(),
      });
      saveRecord(dataPath, artifact);
      summary.hydrated += 1;
    } catch (error) {
      summary.failed.push({ url: plan.url, reason: error instanceof Error ? error.name : 'unknown' });
    }
  }

  if (summary.failed.length > 0) {
    log(
      `[VideoHydration] ${conversationId}: ${summary.hydrated} hydrated, ${summary.failed.length} failed (${summary.failed
        .map((failure) => failure.reason)
        .join(', ')})`
    );
  }
  return summary;
}
