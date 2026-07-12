/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

const STORAGE_PREFIX = 'command-eve.visual-background.';
export const COMMAND_EVE_DEFAULT_BACKGROUND_ASSET_ID = 'builtin:command-eve-default';
export const COMMAND_EVE_OBSIDIAN_BACKGROUND_ASSET_ID = 'builtin:command-eve-obsidian-atrium';
export const COMMAND_EVE_FROSTED_BACKGROUND_ASSET_ID = 'builtin:command-eve-frosted-gallery';
export const MAX_EVE_VISUAL_BACKGROUND_BYTES = 2_000_000;
const MAX_BACKGROUND_DATA_URL_LENGTH = Math.ceil(MAX_EVE_VISUAL_BACKGROUND_BYTES / 3) * 4 + 64;
const IMAGE_DATA_URL = /^data:image\/(?:png|jpe?g|webp|gif|bmp);base64,([A-Za-z0-9+/]+={0,2})$/;
const OPAQUE_ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

export type CommandEveBuiltinBackground = {
  id: string;
  imageUrl: string;
  labelKey:
    | 'settings.commandEveAppearance.backgroundPresetDawnAlloy'
    | 'settings.commandEveAppearance.backgroundPresetFrostedGallery'
    | 'settings.commandEveAppearance.backgroundPresetObsidianAtrium';
};

export const COMMAND_EVE_BUILTIN_BACKGROUNDS: readonly CommandEveBuiltinBackground[] = [
  {
    id: COMMAND_EVE_DEFAULT_BACKGROUND_ASSET_ID,
    imageUrl: new URL('./backgrounds/command-eve-dawn-alloy.png', import.meta.url).toString(),
    labelKey: 'settings.commandEveAppearance.backgroundPresetDawnAlloy',
  },
  {
    id: COMMAND_EVE_FROSTED_BACKGROUND_ASSET_ID,
    imageUrl: new URL('./backgrounds/command-eve-frosted-gallery.png', import.meta.url).toString(),
    labelKey: 'settings.commandEveAppearance.backgroundPresetFrostedGallery',
  },
  {
    id: COMMAND_EVE_OBSIDIAN_BACKGROUND_ASSET_ID,
    imageUrl: new URL('./backgrounds/command-eve-obsidian-atrium.png', import.meta.url).toString(),
    labelKey: 'settings.commandEveAppearance.backgroundPresetObsidianAtrium',
  },
];

const BUILTIN_BACKGROUND_BY_ID = new Map(
  COMMAND_EVE_BUILTIN_BACKGROUNDS.map((background) => [background.id, background] as const)
);

const storageKey = (assetId: string): string => `${STORAGE_PREFIX}${assetId}`;

const validImageDataUrl = (dataUrl: string): boolean => {
  if (dataUrl.length > MAX_BACKGROUND_DATA_URL_LENGTH) return false;
  const match = IMAGE_DATA_URL.exec(dataUrl);
  if (!match) return false;
  const payload = match[1];
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.floor((payload.length * 3) / 4) - padding <= MAX_EVE_VISUAL_BACKGROUND_BYTES;
};

export function storeEveVisualBackground(dataUrl: string, assetId = `bg-${crypto.randomUUID()}`): string {
  if (!OPAQUE_ASSET_ID.test(assetId)) throw new Error('Invalid background asset id');
  if (!validImageDataUrl(dataUrl)) {
    throw new Error('Invalid or oversized background image');
  }
  localStorage.setItem(storageKey(assetId), dataUrl);
  return assetId;
}

export function resolveEveVisualBackground(assetId?: string): string | undefined {
  if (!assetId || !OPAQUE_ASSET_ID.test(assetId)) return undefined;
  const builtin = BUILTIN_BACKGROUND_BY_ID.get(assetId);
  if (builtin) return builtin.imageUrl;
  try {
    const dataUrl = localStorage.getItem(storageKey(assetId)) || undefined;
    return dataUrl && validImageDataUrl(dataUrl) ? dataUrl : undefined;
  } catch {
    return undefined;
  }
}

export function isEveBuiltinBackground(assetId?: string): boolean {
  return Boolean(assetId && BUILTIN_BACKGROUND_BY_ID.has(assetId));
}

export function removeEveVisualBackground(assetId?: string): void {
  if (!assetId || !OPAQUE_ASSET_ID.test(assetId)) return;
  try {
    localStorage.removeItem(storageKey(assetId));
  } catch {
    /* Storage cleanup is best-effort. */
  }
}

export type EveVisualBackgroundSwap = {
  assetId: string;
  rollback: () => void;
};

export function swapEveVisualBackground(dataUrl: string, previousAssetId?: string): EveVisualBackgroundSwap {
  const previousIsCustom = Boolean(previousAssetId && !isEveBuiltinBackground(previousAssetId));
  const previousDataUrl = previousIsCustom ? resolveEveVisualBackground(previousAssetId) : undefined;
  if (previousIsCustom) removeEveVisualBackground(previousAssetId);

  const generatedId = `bg-${crypto.randomUUID()}`;
  const assetId = generatedId === previousAssetId ? `${generatedId}-replacement` : generatedId;
  try {
    storeEveVisualBackground(dataUrl, assetId);
  } catch (error) {
    if (previousAssetId && previousDataUrl) storeEveVisualBackground(previousDataUrl, previousAssetId);
    throw error;
  }

  return {
    assetId,
    rollback: () => {
      removeEveVisualBackground(assetId);
      if (previousAssetId && previousDataUrl) storeEveVisualBackground(previousDataUrl, previousAssetId);
    },
  };
}

export function garbageCollectEveVisualBackgrounds(activeAssetId?: string): void {
  try {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(STORAGE_PREFIX)) continue;
      if (activeAssetId && key === storageKey(activeAssetId)) continue;
      localStorage.removeItem(key);
    }
  } catch {
    /* Storage cleanup is best-effort. */
  }
}
