/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  COMPOSER_WORK_PRODUCT_ACTION_DESCRIPTORS,
  COMPOSER_WORK_PRODUCT_MODE_DESCRIPTORS,
  consumeComposerWorkProductSelection,
  parseComposerWorkProductMode,
  parseComposerWorkProductSelection,
  renderComposerSelectedArtifactPreparedContext,
  renderComposerWorkProductPreparedContext,
  resolveComposerWorkProductInjectedSkills,
  selectExplicitComposerWorkProductMode,
} from '@/common/config/composerWorkProductModeCore';

describe('explicit composer work-product mode', () => {
  it('parses only the fixed mode allowlist and normalizes harmless casing', () => {
    expect(
      ['chat', 'image', 'video', 'presentation', 'pdf', 'word', 'excel'].map(parseComposerWorkProductMode)
    ).toEqual(['chat', 'image', 'video', 'presentation', 'pdf', 'word', 'excel']);
    expect(parseComposerWorkProductMode('  VIDEO  ')).toBe('video');
  });

  it('fails closed to chat for non-string, unknown and oversized input', () => {
    expect(parseComposerWorkProductMode({ toString: () => 'video' })).toBe('chat');
    expect(parseComposerWorkProductMode('__proto__')).toBe('chat');
    expect(parseComposerWorkProductMode('v'.repeat(33))).toBe('chat');
  });

  it('parses a fresh-chat handoff only when explicit click authority is intact', () => {
    expect(
      parseComposerWorkProductSelection({
        mode: 'video',
        authority: 'explicit_user_selection',
        hasSelectedReference: false,
        selectedReferenceKind: null,
      })
    ).toMatchObject({ mode: 'video', authority: 'explicit_user_selection' });
    expect(parseComposerWorkProductSelection({ mode: 'video', authority: 'none' }).mode).toBe('chat');
    expect(parseComposerWorkProductSelection({ mode: 'unknown', authority: 'explicit_user_selection' }).mode).toBe(
      'chat'
    );
  });

  it('keeps every generative descriptor behind explicit user selection', () => {
    const productDescriptors = COMPOSER_WORK_PRODUCT_MODE_DESCRIPTORS.filter(({ mode }) => mode !== 'chat');
    expect(productDescriptors).toHaveLength(6);
    expect(productDescriptors.every(({ requiresExplicitUserSelection }) => requiresExplicitUserSelection)).toBe(true);
    expect(productDescriptors.every(({ supportsReference }) => supportsReference)).toBe(true);
  });

  it('keeps create and edit armed across turns while ordinary chat stays neutral', () => {
    expect(COMPOSER_WORK_PRODUCT_ACTION_DESCRIPTORS).toEqual([
      { action: 'chat', requiresExplicitUserSelection: false, oneShot: false },
      { action: 'create', requiresExplicitUserSelection: true, oneShot: false },
      { action: 'edit', requiresExplicitUserSelection: true, oneShot: false },
    ]);
  });

  it('keeps the image lane and its output options armed for the next turn', () => {
    const selected = selectExplicitComposerWorkProductMode('image', undefined, {
      tierId: 'max',
      aspectRatio: '1:1',
      resolution: '2K',
    });
    const firstSend = consumeComposerWorkProductSelection(selected);
    const secondSend = consumeComposerWorkProductSelection(firstSend.nextSelection);

    expect(firstSend.request).toMatchObject({
      mode: 'image',
      action: 'create',
      authority: 'explicit_user_selection',
      imageOptions: { tierId: 'max', aspectRatio: '1:1', resolution: '2K' },
    });
    expect(firstSend.request?.preparedContext).toContain('image_tier_id=max');
    expect(firstSend.request?.preparedContext).toContain('image_resolution=2K');
    expect(firstSend.request?.preparedContext).toContain('image_aspect_ratio=1:1');

    // Sticky lane: the operator stays in image mode until they leave it, and the
    // chosen tier/ratio/resolution travel with it — re-picking them every turn
    // was the friction this replaces.
    expect(firstSend.nextSelection.mode).toBe('image');
    expect(firstSend.nextSelection.authority).toBe('explicit_user_selection');
    expect(firstSend.nextSelection.imageOptions).toEqual({
      tierId: 'max',
      aspectRatio: '1:1',
      resolution: '2K',
    });

    // Hermes must see the SAME prepared context on the second turn; a lane that
    // is visible to the operator but invisible to the agent is worse than none.
    expect(secondSend.request).toMatchObject({ mode: 'image', action: 'create' });
    expect(secondSend.request?.preparedContext).toContain('image_tier_id=max');
  });

  it('keeps an EDIT lane armed across turns so "and now make it blue" stays an edit', () => {
    const selected = selectExplicitComposerWorkProductMode('image', { selected: true, kind: 'image' }, undefined);
    expect(selected.hasSelectedReference).toBe(true);

    const firstSend = consumeComposerWorkProductSelection(selected);

    // The turn that was sent carries the edit intent...
    expect(firstSend.request).toMatchObject({ mode: 'image', action: 'edit', hasSelectedReference: true });
    // ...and so does the next one. Dropping the reference here would turn the
    // follow-up sentence into a brand new image built from the words "make it
    // blue"; WHICH artifact it points at is re-pointed by the renderer once a
    // successor exists (founder ruling 2026-08-18, second pass).
    expect(firstSend.nextSelection.mode).toBe('image');
    expect(firstSend.nextSelection.hasSelectedReference).toBe(true);
    expect(firstSend.nextSelection.selectedReferenceKind).toBe('image');

    const secondSend = consumeComposerWorkProductSelection(firstSend.nextSelection);
    expect(secondSend.request).toMatchObject({ mode: 'image', action: 'edit', hasSelectedReference: true });
    // Authority is re-minted through the one constructor on every hop, so a
    // carried reference is still a clicked reference — never text-derived.
    expect(secondSend.nextSelection.authority).toBe('explicit_user_selection');
  });

  it('drops a CREATE reference on send so a second image is never a silent re-edit', () => {
    // The create lane is the one where carrying the artifact forward WOULD be
    // the surprise: an attached reference image is an input to this render, not
    // a target for the next one.
    const created = consumeComposerWorkProductSelection(selectExplicitComposerWorkProductMode('image'));
    expect(created.request).toMatchObject({ mode: 'image', action: 'create', hasSelectedReference: false });
    expect(created.nextSelection.mode).toBe('image');
    expect(created.nextSelection.hasSelectedReference).toBe(false);

    // Image-to-video is a CREATE source too: the still was consumed by the
    // render that used it, so it must not re-render the same clip next turn.
    const imageToVideo = consumeComposerWorkProductSelection(
      selectExplicitComposerWorkProductMode('video', { selected: true, kind: 'image' })
    );
    expect(imageToVideo.request).toMatchObject({ mode: 'video', action: 'create' });
    expect(imageToVideo.nextSelection.hasSelectedReference).toBe(false);
    expect(imageToVideo.nextSelection.selectedReferenceKind).toBeNull();
  });

  it('normalizes malformed image output options to bounded safe defaults', () => {
    const parsed = parseComposerWorkProductSelection({
      mode: 'image',
      authority: 'explicit_user_selection',
      hasSelectedReference: false,
      selectedReferenceKind: null,
      imageOptions: { tierId: 'provider/private-model', aspectRatio: '../../../../private', resolution: '8K' },
    });

    expect(parsed.imageOptions).toEqual({ tierId: 'quality', aspectRatio: '16:9', resolution: '1K' });
    expect(renderComposerWorkProductPreparedContext(parsed)).not.toContain('private');
  });

  it('carries the exact request-scoped output properties for a managed image edit', () => {
    const selected = selectExplicitComposerWorkProductMode(
      'image',
      { selected: true, kind: 'image' },
      { tierId: 'max', aspectRatio: '1:1', resolution: '2K' }
    );
    const request = consumeComposerWorkProductSelection(selected).request;

    expect(request).toMatchObject({
      action: 'edit',
      imageOptions: { tierId: 'max', aspectRatio: '1:1', resolution: '2K' },
    });
    expect(request?.preparedContext).toMatch(/image_resolution=2K[\s\S]*image_aspect_ratio=1:1/);
  });

  it('treats a selected image in video mode as image-to-video creation without leaking artifact identity', () => {
    const selected = {
      ...selectExplicitComposerWorkProductMode('video', { selected: true, kind: 'image' }),
      artifactId: 'secret-artifact-id',
      title: '/Users/person/private/source.png',
      token: 'sk-private-value',
    };
    const consumed = consumeComposerWorkProductSelection(selected);

    expect(consumed.request).toMatchObject({ action: 'create', selectedReferenceKind: 'image' });
    expect(consumed.request?.preparedContext).not.toMatch(/secret-artifact-id|\/Users\/|sk-private-value/);
    expect(consumed.request?.preparedContext).toContain('user_authority=explicit_user_selection');
  });

  it('binds a same-medium selected reference to an immutable edit iteration', () => {
    const selected = selectExplicitComposerWorkProductMode('video', { selected: true, kind: 'video' });
    expect(consumeComposerWorkProductSelection(selected).request).toMatchObject({
      mode: 'video',
      action: 'edit',
      selectedReferenceKind: 'video',
    });
  });

  it.each(['word', 'excel'] as const)(
    'keeps explicit %s create/edit one-shot and deterministically injects office-studio',
    (mode) => {
      const create = consumeComposerWorkProductSelection(selectExplicitComposerWorkProductMode(mode)).request;
      const edit = consumeComposerWorkProductSelection(
        selectExplicitComposerWorkProductMode(mode, { selected: true, kind: mode })
      ).request;

      expect(create).toMatchObject({ mode, action: 'create', selectedReferenceKind: null });
      expect(edit).toMatchObject({ mode, action: 'edit', selectedReferenceKind: mode });
      expect(create?.preparedContext).toContain(`mode=${mode}`);
      expect(edit?.preparedContext).toContain(`reference_kind=${mode}`);
      expect(resolveComposerWorkProductInjectedSkills(mode)).toEqual(['office-studio']);
    }
  );

  it.each(['pdf', 'presentation', 'word', 'excel'] as const)(
    'preserves the explicit max/2K/2:3 image choice across the %s document lane',
    (mode) => {
      const imageOptions = { tierId: 'max' as const, resolution: '2K' as const, aspectRatio: '2:3' as const };
      const selected = selectExplicitComposerWorkProductMode(mode, undefined, imageOptions);
      const parsed = parseComposerWorkProductSelection(selected);
      const firstSend = consumeComposerWorkProductSelection(parsed);
      const secondSend = consumeComposerWorkProductSelection(firstSend.nextSelection);

      expect(selected.imageOptions).toEqual(imageOptions);
      expect(parsed.imageOptions).toEqual(imageOptions);
      expect(firstSend.request).toMatchObject({ mode, action: 'create', imageOptions });
      expect(firstSend.request?.preparedContext).toContain('image_tier_id=max');
      expect(firstSend.request?.preparedContext).toContain('image_resolution=2K');
      expect(firstSend.request?.preparedContext).toContain('image_aspect_ratio=2:3');
      expect(firstSend.request?.preparedContext).toContain(
        'image_prompt_statement=Build a self-contained English image prompt from the established conversation intent plus this turn; never forward only a short follow-up sentence.'
      );
      expect(firstSend.nextSelection).toMatchObject({ mode, imageOptions });
      expect(secondSend.request).toMatchObject({ mode, action: 'create', imageOptions });
    }
  );

  it('injects presentation-studio only for the presentation workflow', () => {
    expect(resolveComposerWorkProductInjectedSkills('presentation')).toEqual(['presentation-studio']);
  });

  it('injects the dedicated PDF skill without inheriting Office or presentation skills', () => {
    expect(resolveComposerWorkProductInjectedSkills('pdf')).toEqual(['editorial-pdf-design']);
  });

  it('does not inject work-product skills for chat, media or malformed input', () => {
    expect(resolveComposerWorkProductInjectedSkills('chat')).toEqual([]);
    expect(resolveComposerWorkProductInjectedSkills('image')).toEqual([]);
    expect(resolveComposerWorkProductInjectedSkills('video')).toEqual([]);
    expect(resolveComposerWorkProductInjectedSkills('__proto__')).toEqual([]);
  });

  it.each(['pdf', 'presentation', 'word', 'excel'] as const)(
    'treats an image selected for %s as an immutable create input, never an edit target',
    (mode) => {
      const consumed = consumeComposerWorkProductSelection(
        selectExplicitComposerWorkProductMode(mode, { selected: true, kind: 'image' })
      );

      expect(consumed.request).toMatchObject({
        mode,
        action: 'create',
        hasSelectedReference: true,
        selectedReferenceKind: 'image',
      });
      expect(consumed.request?.preparedContext).toContain(`mode=${mode}`);
      expect(consumed.request?.preparedContext).toContain('action=create');
      expect(consumed.request?.preparedContext).toContain('reference_kind=image');
      expect(consumed.nextSelection).toMatchObject({
        mode,
        hasSelectedReference: false,
        selectedReferenceKind: null,
      });
    }
  );

  it('refuses a mode-shaped object that lacks explicit click authority', () => {
    const lookalike = { mode: 'pdf', authority: 'none', hasSelectedReference: false };
    expect(consumeComposerWorkProductSelection(lookalike).request).toBeNull();
    expect(renderComposerWorkProductPreparedContext(lookalike)).toBe('');
  });

  it('renders only a bounded pathless exact artifact target and rejects traversal-shaped ids', () => {
    const context = renderComposerSelectedArtifactPreparedContext('artifact:child_01', 'pdf');
    expect(context).toContain('artifact_id=artifact:child_01');
    expect(context).toContain('reference_kind=pdf');
    expect(context).not.toMatch(/path|url|base64/i);
    expect(renderComposerSelectedArtifactPreparedContext('../private/report.pdf', 'pdf')).toBe('');
  });
});
