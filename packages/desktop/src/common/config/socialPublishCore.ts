/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE — social publishing core (upload-post.com).
 *
 * WHY upload-post.com: one unified API posts to LinkedIn / X / Instagram / TikTok / Facebook /
 * Threads / Reddit / Bluesky etc. The OPERATOR connects their own accounts at upload-post.com and
 * pastes their API key — so EVE never holds per-platform OAuth tokens and never touches the
 * operator's raw social credentials (DSGVO + invisible-delivery posture intact).
 *
 * THE HARD RULE (founder doctrine: human-gate anything outward-facing / public-publish): EVE never
 * auto-posts. This core builds a draft that is `pending_approval`; the actual upload-post.com request
 * payload is ONLY produced by approveSocialPost() on a draft the operator explicitly approved. The
 * process layer must refuse to call the API for anything that did not pass through approveSocialPost.
 *
 * This module is PURE (no network, no fs): build → validate → (operator approves) → payload. The
 * process layer owns the key (keychain), the fetch, and the approval UI.
 */

// upload-post.com endpoints (base https://api.upload-post.com/api). Chosen by content kind.
export const UPLOAD_POST_BASE_URL = 'https://api.upload-post.com/api';
export const UPLOAD_POST_ENDPOINTS = {
  text: '/upload_text',
  photos: '/upload_photos',
  video: '/upload',
} as const;

// Platforms upload-post.com supports for TEXT posts (the others are media-only).
export const TEXT_CAPABLE_PLATFORMS = [
  'x',
  'linkedin',
  'facebook',
  'threads',
  'reddit',
  'bluesky',
  'discord',
  'telegram',
] as const;
export const PHOTO_CAPABLE_PLATFORMS = [
  'linkedin',
  'facebook',
  'x',
  'instagram',
  'tiktok',
  'threads',
  'pinterest',
  'bluesky',
  'discord',
  'telegram',
] as const;
export const VIDEO_CAPABLE_PLATFORMS = [
  'tiktok',
  'instagram',
  'linkedin',
  'youtube',
  'facebook',
  'x',
  'threads',
  'pinterest',
  'bluesky',
  'discord',
  'telegram',
] as const;

export type SocialPlatform = (typeof VIDEO_CAPABLE_PLATFORMS)[number];
export type SocialPostKind = 'text' | 'photos' | 'video';
export type SocialPostStatus = 'pending_approval' | 'approved' | 'rejected';

export type SocialPostDraft = {
  kind: SocialPostKind;
  /** The upload-post.com profile username the operator connected their accounts under. */
  user: string;
  platforms: SocialPlatform[];
  /** Post text / caption. Required for text; optional caption for media. */
  text?: string;
  /** Public media URLs (photos[] / video). Required for photos/video kinds. */
  mediaUrls?: string[];
  /** ISO-8601 UTC; when set, the post is scheduled instead of posted now. */
  scheduledDate?: string;
  /** Optional per-platform extras (e.g. target_linkedin_page_id). Forwarded verbatim. */
  platformOptions?: Record<string, string>;
};

export type SocialPostValidation = { ok: true } | { ok: false; errors: string[] };

const CAPABILITY: Record<SocialPostKind, readonly string[]> = {
  text: TEXT_CAPABLE_PLATFORMS,
  photos: PHOTO_CAPABLE_PLATFORMS,
  video: VIDEO_CAPABLE_PLATFORMS,
};

// Conservative caps so a draft can't be silently rejected by the platform. X is the binding one.
const TEXT_MAX = 3000;

/** Validate a draft BEFORE it is shown to the operator for approval. Pure. */
export function validateSocialPostDraft(draft: SocialPostDraft): SocialPostValidation {
  const errors: string[] = [];
  if (!draft.user || !draft.user.trim()) errors.push('no upload-post.com user/profile configured');
  if (!Array.isArray(draft.platforms) || draft.platforms.length === 0) errors.push('no target platform selected');
  const allowed = CAPABILITY[draft.kind];
  for (const p of draft.platforms || []) {
    if (!allowed.includes(p)) errors.push(`platform "${p}" cannot receive a ${draft.kind} post`);
  }
  if (draft.kind === 'text') {
    if (!draft.text || !draft.text.trim()) errors.push('text post has no text');
    else if (draft.text.length > TEXT_MAX) errors.push(`text exceeds ${TEXT_MAX} chars (${draft.text.length})`);
    if (draft.platforms?.includes('x' as SocialPlatform) && (draft.text?.length ?? 0) > 280) {
      errors.push('text exceeds 280 chars for X — shorten or drop X');
    }
  }
  if ((draft.kind === 'photos' || draft.kind === 'video') && (!draft.mediaUrls || draft.mediaUrls.length === 0)) {
    errors.push(`${draft.kind} post has no media`);
  }
  if (draft.scheduledDate && Number.isNaN(Date.parse(draft.scheduledDate))) {
    errors.push('scheduledDate is not a valid ISO-8601 date');
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

/** Create a draft in the pending_approval state. The ONLY way to a sendable payload is approve(). */
export function buildSocialPostDraft(draft: SocialPostDraft): {
  status: SocialPostStatus;
  draft: SocialPostDraft;
  validation: SocialPostValidation;
} {
  return { status: 'pending_approval', draft, validation: validateSocialPostDraft(draft) };
}

export type UploadPostRequest = {
  url: string;
  endpoint: (typeof UPLOAD_POST_ENDPOINTS)[SocialPostKind];
  headers: Record<string, string>;
  /** multipart/form fields (upload-post.com takes form-data, platform[] repeated). */
  fields: Record<string, string | string[]>;
};

/**
 * Produce the upload-post.com request for an APPROVED post. Throws if the operator did not approve
 * or the draft is invalid — the human-gate is enforced HERE so no caller can bypass it. `apiKey`
 * is injected by the process layer from the keychain (never stored in this module).
 */
export function approveSocialPost(
  approval: { status: SocialPostStatus; draft: SocialPostDraft },
  apiKey: string
): UploadPostRequest {
  if (approval.status !== 'approved') {
    throw new Error(
      'SOCIAL_POST_NOT_APPROVED: a post must be explicitly approved by the operator before it can be sent'
    );
  }
  const v = validateSocialPostDraft(approval.draft);
  if (v.ok === false) {
    throw new Error(`SOCIAL_POST_INVALID: ${v.errors.join('; ')}`);
  }
  if (!apiKey || !apiKey.trim()) throw new Error('SOCIAL_POST_NO_KEY: upload-post.com API key missing');

  const d = approval.draft;
  const fields: Record<string, string | string[]> = {
    user: d.user,
    'platform[]': d.platforms,
  };
  if (d.text) fields[d.kind === 'text' ? 'title' : 'description'] = d.text;
  if (d.kind === 'photos' && d.mediaUrls) fields['photos[]'] = d.mediaUrls;
  if (d.kind === 'video' && d.mediaUrls?.[0]) fields.video = d.mediaUrls[0];
  if (d.scheduledDate) fields.scheduled_date = d.scheduledDate;
  for (const [k, val] of Object.entries(d.platformOptions || {})) fields[k] = val;

  return {
    url: `${UPLOAD_POST_BASE_URL}${UPLOAD_POST_ENDPOINTS[d.kind]}`,
    endpoint: UPLOAD_POST_ENDPOINTS[d.kind],
    headers: { Authorization: `Apikey ${apiKey}` },
    fields,
  };
}
