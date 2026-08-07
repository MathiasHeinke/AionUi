/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Operator-owned provider rows → connected (BYOK) picker groups and routes.
 *
 * Pure. It takes the rows the main process already reads from `/api/providers`
 * and turns them into the two shapes the rest of the system needs. No IO, no
 * discovery, no new settings surface: the operator's provider list IS the truth,
 * and this file only reads it. ACP/CLI agents are deliberately NOT turned into
 * picker entries — that rule predates this change and is a quality rule, not a
 * lock.
 *
 * THE KEY NEVER LEAVES MAIN. {@link buildConnectedProviderGroups} produces the
 * renderer-facing shape and carries no credential at all;
 * {@link resolveConnectedProviderRoute} produces the main-only shape that does.
 * They are separate functions rather than one with a flag, because a flag is
 * exactly the kind of thing that gets passed wrong once.
 */

import { connectedProviderSelectionValue, type EveConnectedProviderGroup } from './eveInferenceCore';

/** The subset of an `IProvider` row this module reads. Structural on purpose. */
export interface ConnectedProviderRow {
  id: string;
  name?: string;
  platform?: string;
  base_url?: string;
  api_key?: string;
  models?: string[];
  enabled?: boolean;
  model_enabled?: Record<string, boolean>;
}

/**
 * Rows the APP owns and writes itself. They are provider rows in the same table,
 * but they are not the operator bringing their own key:
 *   - the local-runtime row IS the loopback shim (offering it would route the
 *     shim at itself), and
 *   - the managed-image row is an internal image lane, not a chat model.
 * Both are written by the two `POST /api/providers` call sites in this repo.
 */
export const APP_OWNED_PROVIDER_IDS: readonly string[] = ['command-eve-local-runtime', 'command-eve-managed-image'];

/** Models this row offers, honouring a per-model disable. */
function usableModels(row: ConnectedProviderRow): string[] {
  const models = Array.isArray(row.models) ? row.models : [];
  return models
    .map((model) => String(model ?? '').trim())
    .filter((model) => model.length > 0 && row.model_enabled?.[model] !== false);
}

/**
 * Is this row usable as a BYOK chat lane?
 *
 * Every condition is a reason the row could not carry a turn, not a policy: no
 * key, no base URL, no model, disabled, or app-owned. A row that fails any of
 * them must produce NO entry rather than a disabled one — an offer that cannot
 * be taken is worse than no offer.
 */
export function isConnectedProviderRow(row: ConnectedProviderRow | null | undefined): boolean {
  if (!row || typeof row !== 'object') return false;
  if (typeof row.id !== 'string' || row.id.trim().length === 0) return false;
  if (APP_OWNED_PROVIDER_IDS.includes(row.id)) return false;
  if (row.enabled === false) return false;
  if (typeof row.api_key !== 'string' || row.api_key.trim().length === 0) return false;
  if (typeof row.base_url !== 'string' || row.base_url.trim().length === 0) return false;
  return usableModels(row).length > 0;
}

/**
 * The renderer-facing group model. CARRIES NO CREDENTIAL — id, label and model
 * only. An operator with no provider configured yields `[]`, and empty groups are
 * already dropped by `buildEvePickerGroups`, so nothing renders an empty heading
 * or a placeholder row.
 */
export function buildConnectedProviderGroups(
  rows: readonly ConnectedProviderRow[] | null | undefined
): EveConnectedProviderGroup[] {
  if (!Array.isArray(rows)) return [];
  return rows.filter(isConnectedProviderRow).map((row) => ({
    kind: 'connected' as const,
    title: (row.name || row.platform || row.id).trim(),
    items: usableModels(row).map((model) => ({
      value: connectedProviderSelectionValue(row.id, model),
      group: 'connected' as const,
      label: model,
      sublabel: row.name || row.platform || undefined,
      disabled: false,
    })),
  }));
}

/** The main-only route. This one DOES carry the key, and never crosses the bridge. */
export interface ConnectedProviderRoute {
  providerId: string;
  providerName: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

/**
 * Resolve one connected selection against the operator's rows.
 *
 * Fail-closed and exact: the row must still exist, still be usable, and still
 * offer THAT model. A model that was removed or disabled since the selection was
 * persisted resolves to null rather than to the row's first model — silently
 * substituting a different model is a different turn at a different price.
 */
export function resolveConnectedProviderRoute(
  parsed: { providerId: string; model: string } | null,
  rows: readonly ConnectedProviderRow[] | null | undefined
): ConnectedProviderRoute | null {
  if (!parsed || !Array.isArray(rows)) return null;
  const row = rows.find((candidate) => candidate?.id === parsed.providerId);
  if (!isConnectedProviderRow(row)) return null;
  const match = usableModels(row as ConnectedProviderRow).find((model) => model === parsed.model);
  if (!match) return null;
  const usable = row as ConnectedProviderRow;
  return {
    providerId: usable.id,
    providerName: (usable.name || usable.platform || usable.id).trim(),
    baseUrl: (usable.base_url as string).trim(),
    model: match,
    apiKey: (usable.api_key as string).trim(),
  };
}
