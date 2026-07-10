/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

const STORAGE_PREFIX = 'command-eve.visual-background.';
const MAX_BACKGROUND_DATA_URL_LENGTH = 4_500_000;
const IMAGE_DATA_URL = /^data:image\/(?:png|jpe?g|webp|gif|bmp);base64,[A-Za-z0-9+/=]+$/;
const OPAQUE_ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

const storageKey = (assetId: string): string => `${STORAGE_PREFIX}${assetId}`;

export function storeEveVisualBackground(dataUrl: string, assetId = `bg-${crypto.randomUUID()}`): string {
  if (!OPAQUE_ASSET_ID.test(assetId)) throw new Error('Invalid background asset id');
  if (dataUrl.length > MAX_BACKGROUND_DATA_URL_LENGTH || !IMAGE_DATA_URL.test(dataUrl)) {
    throw new Error('Invalid or oversized background image');
  }
  localStorage.setItem(storageKey(assetId), dataUrl);
  return assetId;
}

export function resolveEveVisualBackground(assetId?: string): string | undefined {
  if (!assetId || !OPAQUE_ASSET_ID.test(assetId)) return undefined;
  const dataUrl = localStorage.getItem(storageKey(assetId)) || undefined;
  return dataUrl && dataUrl.length <= MAX_BACKGROUND_DATA_URL_LENGTH && IMAGE_DATA_URL.test(dataUrl)
    ? dataUrl
    : undefined;
}

export function removeEveVisualBackground(assetId?: string): void {
  if (!assetId || !OPAQUE_ASSET_ID.test(assetId)) return;
  localStorage.removeItem(storageKey(assetId));
}
