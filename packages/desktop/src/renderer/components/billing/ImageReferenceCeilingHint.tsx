/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * THE REFERENCE-CEILING NOTICE — honest information BEFORE sending, never a
 * second gate.
 *
 * THE DEFECT IT REMOVES. Attach five images, pick Grok Imagine 2 (which takes
 * three), press send: the draft is refused after the fact. Every limit in this
 * lane was enforced and none of them was VISIBLE. The refusal was correct and
 * the experience was not.
 *
 * IT DOES NOT BLOCK, AND THAT IS DELIBERATE. Send stays enabled; the gateway
 * refuses authoritatively at its own parse, before any reserve
 * (image-generation-core.ts, "the lower of the two ceilings wins"). A second
 * gate here would be a client-side rule that can disagree with the server's —
 * two enforcers, one of them wrong the day a ceiling moves. One enforcer, one
 * informer.
 *
 * WHICH NUMBER IT SHOWS. The one that BINDS, which is often not the model's.
 * This lane caps every model at four references, enforced in the bridge
 * policy, the artifact bridge, the managed-image service and the gateway. So
 * gpt-image-2's advertised 16 is not what the operator meets; four is. The
 * sentence names the LANE when the lane binds and the MODEL when the model
 * binds — saying "GPT Image 2 takes at most 4" would be false about the model,
 * and "you may attach 16" would be false about the lane.
 *
 * WHEN IT SAYS NOTHING. No proven registry, no stated ceiling, or a count
 * inside the limit. An unproven ceiling is never guessed: a number the user
 * reads is a promise.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  effectiveImageReferenceCeiling,
  getCommandEveImageModelTierSpec,
  type CommandEveImageModelRegistry,
  type CommandEveImageModelTierId,
} from '@/common/config/eveImageModelRegistryCore';
import { COMMAND_EVE_MANAGED_IMAGE_MAX_REFERENCES } from '@/common/config/eveManagedImageGenerationCore';
import './billing.css';

export type ImageReferenceCeilingHintProps = Readonly<{
  visible: boolean;
  registry: CommandEveImageModelRegistry | null;
  tierId: CommandEveImageModelTierId;
  /** Reference images currently attached to the draft. */
  referenceCount: number;
}>;

const ImageReferenceCeilingHint: React.FC<ImageReferenceCeilingHintProps> = ({
  visible,
  registry,
  tierId,
  referenceCount,
}) => {
  const { t } = useTranslation();
  if (!visible || !registry) return null;

  const bound = effectiveImageReferenceCeiling(registry, tierId, COMMAND_EVE_MANAGED_IMAGE_MAX_REFERENCES);
  if (!bound || referenceCount <= bound.ceiling) return null;

  const modelName = getCommandEveImageModelTierSpec(registry, tierId)?.display_name;
  // A sentence naming a model needs the model's name. Without one, the lane
  // wording is the truthful fallback rather than an invented label.
  const namesTheModel = bound.boundBy === 'model' && typeof modelName === 'string' && modelName.length > 0;

  return (
    <div
      className='image-reference-ceiling-hint'
      role='note'
      aria-live='polite'
      data-testid='image-reference-ceiling-hint'
      data-ceiling={bound.ceiling}
      data-bound-by={bound.boundBy}
    >
      {namesTheModel
        ? t('conversation.workProduct.image.referenceCeilingModel', {
            defaultValue:
              '{{model}} nimmt höchstens {{ceiling}} Referenzbilder. Du hast {{count}} angehängt — entferne {{excess}}, sonst kann das Bild nicht erstellt werden.',
            model: modelName,
            ceiling: bound.ceiling,
            count: referenceCount,
            excess: referenceCount - bound.ceiling,
          })
        : t('conversation.workProduct.image.referenceCeilingLane', {
            defaultValue:
              'Pro Bild sind höchstens {{ceiling}} Referenzbilder möglich. Du hast {{count}} angehängt — entferne {{excess}}, sonst kann das Bild nicht erstellt werden.',
            ceiling: bound.ceiling,
            count: referenceCount,
            excess: referenceCount - bound.ceiling,
          })}
    </div>
  );
};

export default ImageReferenceCeilingHint;
