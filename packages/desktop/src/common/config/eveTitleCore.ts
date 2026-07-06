/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Server-side Command EVE auto-title Edge Function. The desktop calls this from
 * MAIN with the CEVE license bearer; the function owns the OpenRouter org key.
 * No OpenRouter key is ever shipped in the app bundle.
 */
export const EVE_TITLE_FUNCTION_URL = 'https://unvbeothoimlzlolxucl.supabase.co/functions/v1/eve-title';

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
