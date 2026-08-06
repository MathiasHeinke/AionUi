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
 * list. No provider call and no debit path exists here — this downloads a
 * clip the seat already paid to produce.
 *
 * IDEMPOTENT IN TWO LAYERS, because one was not enough. A directive whose URL
 * already has a durable record is `alreadyLocal` and never re-downloaded — but
 * that check reads a SNAPSHOT of the store, so the turn-end relay and the
 * list-time call could both observe "not local" and both save under a fresh
 * `randomUUID()`: two manifest files, two cards, one clip. This comment used to
 * claim the two "may race freely"; they may not, and did not. The second layer
 * closes it: the artifact id is a DIGEST OF THE ORIGIN URL
 * (`hydratedVideoArtifactId`), so a racing pair collapses onto one filename —
 * the loser overwrites the winner with byte-identical content instead of adding
 * a duplicate. The race still costs a redundant download; it no longer corrupts
 * the list.
 *
 * BOUNDED: the body is read through `readBoundedBody`, which counts what it
 * actually receives. `content-length` is a claim — absent on any chunked
 * response and free to lie — so it is used only as a cheap early reject, never
 * as the ceiling.
 */

import crypto from 'node:crypto';
import {
  extractRemoteVideoDirectives,
  hasVideoFileSignature,
  MAX_VIDEO_HYDRATION_BYTES,
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
  /**
   * Overrides the artifact id. Production omits it and takes the DETERMINISTIC
   * `hydratedVideoArtifactId(sourceUrl)` — see the module docstring: a random id
   * is what turned a benign relay/list race into two records for one clip.
   */
  newArtifactId?: (sourceUrl: string) => string;
  nowMs?: () => number;
  log?: (line: string) => void;
  /** Bounded transcript window (message count). */
  window?: number;
  /**
   * Download ceiling in bytes. Production omits it and takes
   * `MAX_VIDEO_HYDRATION_BYTES`; tests inject a few bytes so the bound is
   * exercised without allocating 128 MB.
   */
  maxBytes?: number;
}

const DEFAULT_WINDOW = 50;

/**
 * The DETERMINISTIC artifact id for a hydrated clip: a digest of its origin URL.
 *
 * Idempotency here cannot rest on the plan-time store snapshot alone — two
 * reconciles in flight both read "not local" and both save. Deriving the id from
 * the one thing that identifies the clip across those two runs makes the second
 * write land on the SAME manifest filename (the store keys by `artifact.id`), so
 * a race overwrites rather than duplicates.
 *
 * Truncated to 32 hex chars: 128 bits of a SHA-256 is far past collision concern
 * for the handful of clips in one conversation, and the prefix keeps the id
 * self-describing on disk. The result satisfies the store's `SAFE_ID` allowlist.
 */
export function hydratedVideoArtifactId(sourceUrl: string): string {
  return `vidhy-${crypto.createHash('sha256').update(sourceUrl).digest('hex').slice(0, 32)}`;
}

/**
 * Read a response body, refusing anything past `maxBytes`.
 *
 * STREAMS when the platform hands us a reader, so an oversized clip is abandoned
 * mid-transfer instead of being materialised first — the point of the ceiling is
 * to never hold the bytes, and a post-hoc check has already lost. Returns `null`
 * once the ceiling is crossed; the caller reports `too-large`.
 *
 * The buffered branch is the fallback for a body with no stream (a test double,
 * an older runtime). It is LENGTH-CHECKED too, so it is not a hole of its own.
 */
async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const buffered = await response.arrayBuffer();
    return buffered.byteLength > maxBytes ? null : new Uint8Array(buffered);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      // Stop the transfer rather than draining it — cancelling is the whole
      // reason this streams.
      await reader.cancel().catch((): void => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

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
  const newArtifactId = deps.newArtifactId ?? hydratedVideoArtifactId;
  const nowMs = deps.nowMs ?? (() => Date.now());
  const maxBytes = deps.maxBytes ?? MAX_VIDEO_HYDRATION_BYTES;

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
        //
        // `redirect: 'error'` is the F-05 doctrine this repo already applies to
        // its upstream lanes (`ollamaOpenAiShim.fetchOllama`): "never follow
        // redirects … no shim lane has a legitimate redirect". It matters more
        // here than there, because THIS url came from model output — a 30x would
        // walk the request to a host the directive never named. A provider whose
        // signed URL genuinely redirects will surface as a refusal here rather
        // than as silent off-host egress.
        // eslint-disable-next-line no-await-in-loop
        response = await fetchImpl(plan.url, { redirect: 'error', signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      const declared = Number(response.headers.get('content-length') ?? NaN);
      const verdict = validateVideoDownload({
        status: response.status,
        contentType: response.headers.get('content-type') ?? 'application/octet-stream',
        maxBytes,
        ...(Number.isFinite(declared) ? { declaredBytes: declared } : {}),
      });
      if (verdict.ok === false) {
        summary.failed.push({ url: plan.url, reason: verdict.reason });
        continue;
      }
      // The declared size above is a cheap early reject, NOT the ceiling: it is
      // absent on a chunked response and free to lie. This is the ceiling.
      // eslint-disable-next-line no-await-in-loop
      const bytes = await readBoundedBody(response, maxBytes);
      if (bytes === null) {
        summary.failed.push({ url: plan.url, reason: 'too-large' });
        continue;
      }
      if (!hasVideoFileSignature(bytes)) {
        summary.failed.push({ url: plan.url, reason: 'bad-signature' });
        continue;
      }
      const mimeType = (response.headers.get('content-type') ?? 'video/mp4').split(';')[0].trim() || 'video/mp4';
      const artifactId = newArtifactId(plan.url);
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
