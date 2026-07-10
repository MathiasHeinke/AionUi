import type { Page } from '@playwright/test';
import { invokeBridge } from './bridge/invoke';

type ActiveSeatBridgeResponse = { success?: boolean; data?: { seat_id?: string } } | { seat_id?: string };

export type CommandEveInferenceSettingsSnapshot = {
  selectionKey: string;
  selection: unknown;
  localModelTierId: unknown;
};

function isLegacySeatId(seatId: string | undefined): boolean {
  const trimmed = (seatId || '').trim().toLowerCase();
  return trimmed.length === 0 || trimmed === 'default' || trimmed === 'seat-1';
}

async function activeInferenceSelectionKey(page: Page): Promise<string> {
  const activeSeat = await invokeBridge<ActiveSeatBridgeResponse>(
    page,
    'command-eve.active-seat',
    undefined,
    10_000
  ).catch(() => undefined);
  const seatId =
    (activeSeat && 'data' in activeSeat ? activeSeat.data?.seat_id : undefined) ||
    (activeSeat && 'seat_id' in activeSeat ? activeSeat.seat_id : undefined) ||
    'seat-1';
  return isLegacySeatId(seatId)
    ? 'commandEve.inferenceSelection'
    : `seat:${seatId.trim().toLowerCase()}:commandEve.inferenceSelection`;
}

async function updateClientSettings(page: Page, settings: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (payload) => {
    const win = window as Window & {
      __backendPort?: number;
      __aionBackend?: { getPort?: () => number };
    };
    const dynamicPort = win.__aionBackend?.getPort?.();
    const port = typeof dynamicPort === 'number' && dynamicPort > 0 ? dynamicPort : win.__backendPort;
    if (!port) throw new Error('window.__backendPort is not available');

    const response = await fetch(`http://127.0.0.1:${port}/api/settings/client`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`PUT /api/settings/client failed (${response.status}): ${await response.text()}`);
    }
  }, settings);
}

export async function forceLocalCommandEveInference(page: Page): Promise<CommandEveInferenceSettingsSnapshot> {
  const selectionKey = await activeInferenceSelectionKey(page);
  const settings = await page.evaluate(async () => {
    const win = window as Window & {
      __backendPort?: number;
      __aionBackend?: { getPort?: () => number };
    };
    const dynamicPort = win.__aionBackend?.getPort?.();
    const port = typeof dynamicPort === 'number' && dynamicPort > 0 ? dynamicPort : win.__backendPort;
    if (!port) throw new Error('window.__backendPort is not available');
    const response = await fetch(`http://127.0.0.1:${port}/api/settings/client`);
    if (!response.ok) {
      throw new Error(`GET /api/settings/client failed (${response.status}): ${await response.text()}`);
    }
    return (await response.json()) as Record<string, unknown>;
  });

  await updateClientSettings(page, {
    [selectionKey]: 'command-eve-local:local-standard',
    'commandEve.localModelTierId': 'e4b',
  });
  await page.reload();
  await page.waitForSelector('body', { state: 'visible' });

  return {
    selectionKey,
    selection: settings[selectionKey],
    localModelTierId: settings['commandEve.localModelTierId'],
  };
}

export async function restoreCommandEveInference(
  page: Page,
  snapshot: CommandEveInferenceSettingsSnapshot
): Promise<void> {
  await updateClientSettings(page, {
    [snapshot.selectionKey]: snapshot.selection ?? null,
    'commandEve.localModelTierId': snapshot.localModelTierId ?? null,
  });
  await page.reload();
  await page.waitForSelector('body', { state: 'visible' });
}
