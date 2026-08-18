/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * THE REFERENCE-CEILING NOTICE.
 *
 * These tests pin the three things that make it honest rather than merely
 * present:
 *
 *   1. IT SHOWS THE BINDING NUMBER, not the model's advertised one. This lane
 *      caps every model at four references; gpt-image-2 advertises 16. A user
 *      told "16" would attach a fifth and be refused four layers down.
 *   2. IT NAMES THE RIGHT CULPRIT. Model wording only when the model is the
 *      tighter limit (grok, 3), lane wording otherwise.
 *   3. IT STAYS SILENT WHEN IT CANNOT PROVE A NUMBER, and never at or below
 *      the limit.
 *
 * It is a WARNING, not a gate: nothing here disables a send. The gateway
 * refuses authoritatively before any reserve, and a second client-side
 * enforcer would be free to disagree with it.
 */

import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: Record<string, unknown>) => {
      let text = (options?.defaultValue as string) ?? _key;
      if (options) {
        for (const [key, value] of Object.entries(options)) {
          if (key === 'defaultValue') continue;
          text = text.replace(new RegExp(`{{${key}}}`, 'g'), String(value));
        }
      }
      return text;
    },
  }),
}));

import ImageReferenceCeilingHint from '@/renderer/components/billing/ImageReferenceCeilingHint';
import type { CommandEveImageModelRegistry } from '@/common/config/eveImageModelRegistryCore';

const tier = (
  id: string,
  overrides: Partial<CommandEveImageModelRegistry['tiers'][number]> = {}
): CommandEveImageModelRegistry['tiers'][number] =>
  ({
    id,
    slug: `provider/${id}`,
    display_name: id,
    premium: false,
    supports_references: true,
    curated_rank: null,
    max_reference_images: 14,
    honors_resolution: true,
    resolutions: ['1K', '2K'],
    quotes: {
      generate_credits: { '1K': 30, '2K': 60 },
      edit_credits: { '1K': 36, '2K': 72 },
      per_input_reference_credits: 0,
    },
    ...overrides,
  }) as CommandEveImageModelRegistry['tiers'][number];

/** The live ceilings, as the server reads them off the images route. */
const REGISTRY: CommandEveImageModelRegistry = {
  version: 'command-eve-image-model-registry/v1',
  enabled: true,
  default_tier: 'quality',
  tiers: [
    tier('quality', { display_name: 'Nano Banana 2', curated_rank: 1, max_reference_images: 14 }),
    tier('max', { display_name: 'GPT Image 2', curated_rank: 3, max_reference_images: 16 }),
    tier('grok-2', { display_name: 'Grok Imagine 2', max_reference_images: 3 }),
    tier('qwen-3', { display_name: 'Qwen Image 3', max_reference_images: 4 }),
    tier('seedream-lite', { display_name: 'Seedream 5 Lite', supports_references: false, max_reference_images: 0 }),
  ],
};

const hint = () => screen.queryByTestId('image-reference-ceiling-hint');

afterEach(cleanup);

describe('ImageReferenceCeilingHint', () => {
  it('says nothing while the attachments are within the limit', () => {
    // The lane cap is four. Four is AT the limit, not over it — a notice here
    // would be noise on a draft that sends perfectly well.
    render(<ImageReferenceCeilingHint visible registry={REGISTRY} tierId='max' referenceCount={4} />);
    expect(hint()).toBeNull();
  });

  it('names the LANE cap, not the model’s advertised ceiling', () => {
    // GPT Image 2 advertises 16 references. The operator meets 4, because this
    // lane caps every model there — bridge policy, artifact bridge, managed
    // image service, and the gateway's own parse. Printing 16 would invite a
    // fifth attachment that is refused after the fact.
    render(<ImageReferenceCeilingHint visible registry={REGISTRY} tierId='max' referenceCount={6} />);
    const node = hint();
    expect(node).not.toBeNull();
    expect(node).toHaveAttribute('data-ceiling', '4');
    expect(node).toHaveAttribute('data-bound-by', 'lane');
    expect(node?.textContent).toContain('höchstens 4 Referenzbilder');
    expect(node?.textContent).toContain('entferne 2');
    // AND IT DOES NOT NAME THE MODEL when the model is not the limit: "GPT
    // Image 2 nimmt höchstens 4" would be a false statement about the model.
    expect(node?.textContent).not.toContain('GPT Image 2');
  });

  it('names the MODEL when the model is the tighter limit', () => {
    // Grok takes three — below the lane cap, so here the model really is the
    // binding limit and the sentence may say so.
    render(<ImageReferenceCeilingHint visible registry={REGISTRY} tierId='grok-2' referenceCount={4} />);
    const node = hint();
    expect(node).not.toBeNull();
    expect(node).toHaveAttribute('data-ceiling', '3');
    expect(node).toHaveAttribute('data-bound-by', 'model');
    expect(node?.textContent).toContain('Grok Imagine 2');
    expect(node?.textContent).toContain('höchstens 3 Referenzbilder');
    expect(node?.textContent).toContain('entferne 1');
  });

  it('is a warning and not a gate: it renders no control at all', () => {
    // The server enforces the ceiling fail-closed before any reserve. A second
    // enforcer here could disagree with it the day a ceiling moves — so this
    // component offers nothing to press and nothing that could disable a send.
    render(<ImageReferenceCeilingHint visible registry={REGISTRY} tierId='grok-2' referenceCount={9} />);
    const node = hint();
    expect(node).not.toBeNull();
    expect(node?.querySelectorAll('button, input, [role="button"], [disabled]')).toHaveLength(0);
    expect(node).toHaveAttribute('role', 'note');
  });

  it('claims nothing without a proven registry, an unstated ceiling, or a model that takes no references', () => {
    const { rerender } = render(
      <ImageReferenceCeilingHint visible registry={null} tierId='grok-2' referenceCount={9} />
    );
    expect(hint()).toBeNull();

    // A gateway that predates max_reference_images sends null. An unknown
    // ceiling stays unknown — a guessed number is read as a promise.
    const olderGateway: CommandEveImageModelRegistry = {
      ...REGISTRY,
      tiers: REGISTRY.tiers.map((entry) => ({ ...entry, max_reference_images: null })),
    };
    rerender(<ImageReferenceCeilingHint visible registry={olderGateway} tierId='grok-2' referenceCount={9} />);
    expect(hint()).toBeNull();

    // A model that takes no references at all is a different sentence in a
    // different place (the picker already hides it in edit mode); this notice
    // is about a COUNT, so it stays out of it.
    rerender(<ImageReferenceCeilingHint visible registry={REGISTRY} tierId='seedream-lite' referenceCount={9} />);
    expect(hint()).toBeNull();

    // And not in a non-image composer, however many images are attached.
    rerender(<ImageReferenceCeilingHint visible={false} registry={REGISTRY} tierId='grok-2' referenceCount={9} />);
    expect(hint()).toBeNull();
  });
});
