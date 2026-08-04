/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Server-side Command EVE auto-title Edge Function. Main sends only the
 * bounded first exchange plus the CEVE licence bearer; the provider key stays
 * server-side. This route is the sole owner of automatic session/project names
 * and intentionally has no local-model fallback.
 */
export const EVE_TITLE_FUNCTION_URL = 'https://unvbeothoimlzlolxucl.supabase.co/functions/v1/eve-title';

export type CommandEveTitleLocale = 'de-DE' | 'en-US';
