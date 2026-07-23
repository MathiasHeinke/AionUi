import { expect, type Page } from '@playwright/test';

type ElectronApi = {
  emit?: (name: string, data: unknown) => Promise<unknown>;
};

/**
 * Exercise a founder-only Office AI provider with the exact production wire
 * envelope and prove that the customer-mode main process rejects it.
 *
 * This deliberately bypasses the legacy broad E2E helper: R4 validates the
 * provider invocation id before authorization, so a malformed test envelope
 * would only prove schema rejection instead of the HG-3 customer boundary.
 */
export async function expectFounderOnlyBridgeDenied(page: Page, providerKey: string, data?: unknown): Promise<void> {
  await expect(
    page.evaluate(
      async ({ key, payload }) => {
        const api = (window as unknown as { electronAPI?: ElectronApi }).electronAPI;
        if (!api?.emit) throw new Error('electronAPI bridge is unavailable in renderer context');
        const nonce = Date.now().toString(16).slice(-8);
        const envelope = payload === undefined ? { id: `${key}${nonce}` } : { id: `${key}${nonce}`, data: payload };
        await api.emit(`subscribe-${key}`, envelope);
      },
      { key: providerKey, payload: data }
    )
  ).rejects.toThrow(/founder-only adapter bridge event/i);
}
