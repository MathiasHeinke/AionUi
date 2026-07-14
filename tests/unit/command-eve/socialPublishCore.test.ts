/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  approveSocialPost,
  buildSocialPostDraft,
  validateSocialPostDraft,
  UPLOAD_POST_BASE_URL,
  type SocialPostDraft,
} from '@/common/config/socialPublishCore';

const textDraft = (over: Partial<SocialPostDraft> = {}): SocialPostDraft => ({
  kind: 'text',
  user: 'operator-profile',
  platforms: ['linkedin'],
  text: 'Ein ehrlicher Beitrag über DSGVO-konforme KI im Marketing.',
  ...over,
});

describe('socialPublishCore — validation', () => {
  it('accepts a well-formed LinkedIn text post', () => {
    expect(validateSocialPostDraft(textDraft())).toEqual({ ok: true });
  });

  it('rejects an unconfigured profile / no platform / empty text', () => {
    const r = validateSocialPostDraft(textDraft({ user: '', platforms: [], text: '' }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.join(' ')).toMatch(/user\/profile/);
      expect(r.errors.join(' ')).toMatch(/no target platform/);
      expect(r.errors.join(' ')).toMatch(/no text/);
    }
  });

  it('rejects a platform that cannot take that content kind (e.g. text → instagram)', () => {
    const r = validateSocialPostDraft(textDraft({ platforms: ['instagram'] as never }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/cannot receive a text post/);
  });

  it('enforces the X 280-char limit', () => {
    const r = validateSocialPostDraft(textDraft({ platforms: ['x'], text: 'a'.repeat(300) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/280 chars for X/);
  });

  it('requires media for a photo post', () => {
    const r = validateSocialPostDraft({ kind: 'photos', user: 'p', platforms: ['linkedin'], text: 'caption' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/no media/);
  });
});

describe('socialPublishCore — the human-gate (no auto-post)', () => {
  it('a fresh draft is pending_approval', () => {
    expect(buildSocialPostDraft(textDraft()).status).toBe('pending_approval');
  });

  it('approveSocialPost THROWS when the post was not approved — the gate cannot be bypassed', () => {
    expect(() => approveSocialPost({ status: 'pending_approval', draft: textDraft() }, 'key')).toThrow(/NOT_APPROVED/);
    expect(() => approveSocialPost({ status: 'rejected', draft: textDraft() }, 'key')).toThrow(/NOT_APPROVED/);
  });

  it('approveSocialPost THROWS on a missing API key (no key, no post)', () => {
    expect(() => approveSocialPost({ status: 'approved', draft: textDraft() }, '')).toThrow(/NO_KEY/);
  });

  it('approveSocialPost THROWS on an invalid approved draft (validation re-checked at the gate)', () => {
    expect(() => approveSocialPost({ status: 'approved', draft: textDraft({ platforms: [] }) }, 'key')).toThrow(
      /INVALID/
    );
  });

  it('builds the upload-post.com request only for an approved, valid, keyed post', () => {
    const req = approveSocialPost({ status: 'approved', draft: textDraft() }, 'sk-upload-123');
    expect(req.url).toBe(`${UPLOAD_POST_BASE_URL}/upload_text`);
    expect(req.headers.Authorization).toBe('Apikey sk-upload-123');
    expect(req.fields.user).toBe('operator-profile');
    expect(req.fields['platform[]']).toEqual(['linkedin']);
    expect(req.fields.title).toMatch(/DSGVO/);
  });

  it('a scheduled post carries scheduled_date (the "every Monday" path)', () => {
    const req = approveSocialPost(
      { status: 'approved', draft: textDraft({ scheduledDate: '2026-06-29T08:00:00.000Z' }) },
      'k'
    );
    expect(req.fields.scheduled_date).toBe('2026-06-29T08:00:00.000Z');
  });

  it('forwards platform options verbatim (e.g. target_linkedin_page_id)', () => {
    const req = approveSocialPost(
      { status: 'approved', draft: textDraft({ platformOptions: { target_linkedin_page_id: 'urn:li:org:123' } }) },
      'k'
    );
    expect(req.fields.target_linkedin_page_id).toBe('urn:li:org:123');
  });
});
