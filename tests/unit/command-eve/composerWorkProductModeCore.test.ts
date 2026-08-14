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
  selectExplicitComposerWorkProductMode,
} from '@/common/config/composerWorkProductModeCore';

describe('explicit composer work-product mode', () => {
  it('parses only the fixed mode allowlist and normalizes harmless casing', () => {
    expect(['chat', 'image', 'video', 'presentation', 'pdf'].map(parseComposerWorkProductMode)).toEqual([
      'chat',
      'image',
      'video',
      'presentation',
      'pdf',
    ]);
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
    expect(productDescriptors).toHaveLength(4);
    expect(productDescriptors.every(({ requiresExplicitUserSelection }) => requiresExplicitUserSelection)).toBe(true);
    expect(productDescriptors.every(({ supportsReference }) => supportsReference)).toBe(true);
  });

  it('marks create and edit as one-shot actions while ordinary chat stays neutral', () => {
    expect(COMPOSER_WORK_PRODUCT_ACTION_DESCRIPTORS).toEqual([
      { action: 'chat', requiresExplicitUserSelection: false, oneShot: false },
      { action: 'create', requiresExplicitUserSelection: true, oneShot: true },
      { action: 'edit', requiresExplicitUserSelection: true, oneShot: true },
    ]);
  });

  it('consumes a create selection for one send and returns the next turn to chat', () => {
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
    expect(firstSend.nextSelection.mode).toBe('chat');
    expect(secondSend.request).toBeNull();
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

  it('does not override inherited output properties for a managed image edit', () => {
    const selected = selectExplicitComposerWorkProductMode(
      'image',
      { selected: true, kind: 'image' },
      { tierId: 'max', aspectRatio: '1:1', resolution: '2K' }
    );
    const request = consumeComposerWorkProductSelection(selected).request;

    expect(request).toMatchObject({ action: 'edit', imageOptions: null });
    expect(request?.preparedContext).not.toMatch(/image_resolution|image_aspect_ratio/);
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
