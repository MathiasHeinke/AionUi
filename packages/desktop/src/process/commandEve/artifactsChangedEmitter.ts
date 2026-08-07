/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ONE emitter for "this conversation's artifacts changed, reload them".
 *
 * It existed as a lazy private getter inside `commandEveBridge.ts`, which was
 * fine while the image bind was the only thing that fired it. The video-edit
 * lanes need the same signal, and two modules each minting their own emitter for
 * the same channel is how a channel quietly ends up with two half-owners.
 *
 * THE NAME IS `image-artifacts-changed` AND IT IS NOT ONLY ABOUT IMAGES. The
 * renderer's single handler (`Messages/artifacts.tsx`) responds by calling
 * `loadArtifacts()`, which re-reads the remote artifacts, `videoArtifactsList`
 * and `imageArtifactsList` together — so in behaviour it has always been "all
 * artifacts changed". The channel name is kept because renaming it would touch
 * the renderer subscription and every bridge mock without changing what any of
 * them do; this file is where that decision is written down instead of being
 * left for the next reader to rediscover.
 *
 * THE PAYLOAD IS A CONVERSATION ID AND NOTHING ELSE. No path, no filename, no
 * artifact body. It travels to the renderer, never toward a model, so the
 * no-paths contract of the model-facing envelopes is unaffected by construction
 * rather than by care.
 */

import { bridge } from '@office-ai/platform';

/**
 * Built on FIRST USE, not at import.
 *
 * The bridge-registration test harnesses mock the platform bridge with a
 * `buildProvider`-only fake, long before any emitter can exist. A module-level
 * `buildEmitter()` would throw during their import; the renderer subscribes to
 * the channel NAME rather than to an instance, so the lazy timing is invisible
 * to it.
 */
let artifactsChangedEmitter: { emit: (payload: { conversation_id: string }) => void } | undefined;

export function getCommandEveArtifactsChangedEmitter(): {
  emit: (payload: { conversation_id: string }) => void;
} {
  if (!artifactsChangedEmitter) {
    artifactsChangedEmitter = bridge.buildEmitter<{ conversation_id: string }>('command-eve.image-artifacts-changed');
  }
  return artifactsChangedEmitter;
}

/**
 * Fire the refresh for one conversation. Best-effort by contract: the durable
 * store is the authority and the next load finds the artifact regardless, so a
 * failed notify costs the same-turn refresh and never the saved clip.
 */
export function emitCommandEveArtifactsChanged(conversationId: string): void {
  const id = typeof conversationId === 'string' ? conversationId.trim() : '';
  if (!id) return;
  getCommandEveArtifactsChangedEmitter().emit({ conversation_id: id });
}
