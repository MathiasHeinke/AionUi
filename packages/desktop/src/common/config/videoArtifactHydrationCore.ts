/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1773 (Package B) — remote video artifact HYDRATION, pure core.
 *
 * The agent-lane video tool (hermes `video_generation`) returns a provider CDN
 * URL; the assistant message carries it as a `MEDIA: https://…` directive and
 * the chat card plays the remote URL directly. Nothing downloaded the bytes:
 * a CDN URL that expires (or needs auth) leaves a blank, unplayable card and
 * no file on disk — the durable `videoArtifactStore` lane never saw the clip.
 *
 * This core owns the DECISIONS, Main owns the I/O: which transcript directives
 * are remote videos, which of them already have a durable local record (by
 * `source_url`), and whether a fetched body is actually a bounded video.
 */

/** Video container extensions recognized as downloadable clips. */
const VIDEO_DIRECTIVE_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v']);

/** Download ceiling — far above any clip this lane produces (1080p/20s ≈ 20MB). */
export const MAX_VIDEO_HYDRATION_BYTES = 128 * 1024 * 1024;
/** Bounded wait for one clip download. */
export const VIDEO_HYDRATION_TIMEOUT_MS = 90_000;

/** One remote video directive found in a transcript. */
export type RemoteVideoDirective = {
  url: string;
  title: string;
};

const DIRECTIVE_LINE_RE = /^[\t ]*(?:\*\*|__)?MEDIA:(?:\*\*|__)?[\t ]*(\S+)[\t ]*$/i;

const isRemoteVideoUrl = (value: string): boolean => {
  if (!/^https:\/\//i.test(value)) return false;
  try {
    const pathname = new URL(value).pathname;
    const extension = pathname.split('/').pop()?.split('.').pop()?.toLowerCase();
    return extension !== undefined && VIDEO_DIRECTIVE_EXTENSIONS.has(extension);
  } catch {
    return false;
  }
};

const titleFromUrl = (url: string): string => {
  try {
    const name = new URL(url).pathname.split('/').pop();
    return name ? decodeURIComponent(name) : url;
  } catch {
    return url;
  }
};

/**
 * Extract remote video `MEDIA:` directives from transcript message contents.
 * Deliberately a NARROW reader of the renderer's directive format (which lives
 * in the renderer and stays there): a directive line with an https URL whose
 * path ends in a video extension. Deduped by URL.
 */
export function extractRemoteVideoDirectives(contents: readonly string[]): RemoteVideoDirective[] {
  const seen = new Set<string>();
  const directives: RemoteVideoDirective[] = [];
  for (const content of contents) {
    if (typeof content !== 'string') continue;
    for (const line of content.split('\n')) {
      const match = DIRECTIVE_LINE_RE.exec(line);
      if (!match) continue;
      const url = match[1].trim();
      if (!isRemoteVideoUrl(url) || seen.has(url)) continue;
      seen.add(url);
      directives.push({ url, title: titleFromUrl(url) });
    }
  }
  return directives;
}

/** The payload field a hydrated record carries its origin URL under. */
export const VIDEO_HYDRATION_SOURCE_URL_KEY = 'source_url';

const recordCoversUrl = (payload: unknown, url: string): boolean => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  return (payload as Record<string, unknown>)[VIDEO_HYDRATION_SOURCE_URL_KEY] === url;
};

export type VideoHydrationPlan =
  | { action: 'already-local'; url: string }
  | { action: 'download'; url: string; title: string };

/**
 * Per directive: skip when a durable record already carries this origin URL
 * (idempotent across reconciles), otherwise download. Records without the
 * marker — e.g. written by the direct lane — never match, so a direct-lane
 * clip is never re-downloaded.
 */
export function planVideoHydration(
  directives: readonly RemoteVideoDirective[],
  existingPayloads: readonly unknown[]
): VideoHydrationPlan[] {
  return directives.map((directive) =>
    existingPayloads.some((payload) => recordCoversUrl(payload, directive.url))
      ? { action: 'already-local', url: directive.url }
      : { action: 'download', url: directive.url, title: directive.title }
  );
}

export type VideoDownloadVerdict = { ok: true } | { ok: false; reason: string };

/** Judge a download response BEFORE the bytes are trusted. */
export function validateVideoDownload(input: {
  status: number;
  contentType: string;
  declaredBytes?: number;
  maxBytes?: number;
}): VideoDownloadVerdict {
  const maxBytes = input.maxBytes ?? MAX_VIDEO_HYDRATION_BYTES;
  if (input.status < 200 || input.status >= 300) return { ok: false, reason: `http_${input.status}` };
  if (
    !input.contentType.toLowerCase().startsWith('video/') &&
    input.contentType.toLowerCase() !== 'application/octet-stream'
  ) {
    return { ok: false, reason: 'not-a-video' };
  }
  if (input.declaredBytes !== undefined && input.declaredBytes > maxBytes) return { ok: false, reason: 'too-large' };
  return { ok: true };
}

/** The bytes themselves must look like a video container (ftyp / EBML). */
export function hasVideoFileSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const ascii = Buffer.from(bytes.subarray(0, 16)).toString('ascii');
  if (ascii.slice(4, 8) === 'ftyp') return true; // mp4/mov/m4v
  return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3; // webm
}
