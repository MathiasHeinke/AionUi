/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { redactCommandEveSensitiveText } from '@/common/api/egressBoundaryCore';

/**
 * Server-side Command EVE auto-title Edge Function. The desktop calls this from
 * MAIN with the CEVE license bearer; the function owns the OpenRouter org key.
 * No OpenRouter key is ever shipped in the app bundle.
 */
export const EVE_TITLE_FUNCTION_URL = 'https://unvbeothoimlzlolxucl.supabase.co/functions/v1/eve-title';
export const COMMAND_EVE_CLOUD_TITLE_TEXT_MAX_CHARS = 1000;

export type CommandEveTitleLocale = 'de-DE' | 'en-US';

export interface CommandEveCloudTitleRequest {
  text: string;
  locale?: CommandEveTitleLocale;
}

export interface CommandEveCloudTitleResult {
  ok: boolean;
  title?: string;
  reason_code?: string;
}

export function prepareCommandEveCloudTitleText(exchangeText: string): string | null {
  const redacted = redactCommandEveSensitiveText(exchangeText)
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, COMMAND_EVE_CLOUD_TITLE_TEXT_MAX_CHARS)
    .trim();
  return redacted || null;
}
