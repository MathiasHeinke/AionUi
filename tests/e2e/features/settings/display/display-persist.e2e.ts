/**
 * Display Settings Persistence E2E Tests
 *
 * Verifies that display settings survive a page reload — i.e. they are
 * persisted to the store, not just held in component state.
 */

import { test, expect } from '../../../fixtures';
import { goToSettings, waitForSettle } from '../../../helpers';

const PERCENT_RE = /^\d{2,3}%$/;

function fontSizeControlLocator(page: import('@playwright/test').Page) {
  return page.locator('.font-scale-slider').locator('..');
}

function percentLabel(page: import('@playwright/test').Page) {
  return fontSizeControlLocator(page).locator('..').locator('span').filter({ hasText: PERCENT_RE });
}

function plusButton(page: import('@playwright/test').Page) {
  return fontSizeControlLocator(page).locator('button:has-text("+")');
}

function resetButton(page: import('@playwright/test').Page) {
  return fontSizeControlLocator(page)
    .locator('..')
    .locator('..')
    .locator('button')
    .filter({ hasNotText: /^[+-]$/ })
    .last();
}

async function currentPercent(page: import('@playwright/test').Page): Promise<number> {
  const text = await percentLabel(page).textContent();
  return parseInt(text!.replace('%', ''), 10);
}

async function reloadAndGoToDisplay(page: import('@playwright/test').Page): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (document.body.textContent?.length ?? 0) > 50, { timeout: 15_000 });
  await goToSettings(page, 'appearance');
  await waitForSettle(page);
}

async function readPersistedVisualPreference(
  page: import('@playwright/test').Page,
  key: 'mode' | 'accent'
): Promise<unknown> {
  return page.evaluate(async (preferenceKey) => {
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
    const raw = (await response.json()) as Record<string, unknown>;
    const settings =
      raw && typeof raw.data === 'object' && raw.data !== null ? (raw.data as Record<string, unknown>) : raw;
    const preferences = settings['commandEve.visualPreferences'];
    return preferences && typeof preferences === 'object'
      ? (preferences as Record<string, unknown>)[preferenceKey]
      : undefined;
  }, key);
}

async function expectVisualPreferencePersisted(
  page: import('@playwright/test').Page,
  key: 'mode' | 'accent',
  expected: string
): Promise<void> {
  await expect
    .poll(() => readPersistedVisualPreference(page, key), {
      timeout: 10_000,
      message: `expected ${key}=${expected} to be durable before reload`,
    })
    .toBe(expected);
}

test.describe('Display settings persistence across reload', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await goToSettings(page, 'appearance');
    await waitForSettle(page);
  });

  test('theme persists after reload', async ({ page }) => {
    const themeGroup = page.locator('[aria-labelledby="eve-appearance-mode-title"]');
    await themeGroup.waitFor({ state: 'visible', timeout: 10_000 });

    const initialTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(initialTheme).toBeTruthy();
    const initialMode = await themeGroup.locator('[role="radio"][aria-checked="true"]').getAttribute('data-testid');
    expect(initialMode).toBeTruthy();

    const targetTheme = initialTheme === 'light' ? 'dark' : 'light';
    const targetButton = page.getByTestId(`eve-appearance-mode-${targetTheme}`);
    await targetButton.click();

    await page.waitForFunction(
      (expected) => document.documentElement.getAttribute('data-theme') === expected,
      targetTheme,
      { timeout: 5_000 }
    );
    await expectVisualPreferencePersisted(page, 'mode', targetTheme);

    await reloadAndGoToDisplay(page);

    const afterReload = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(afterReload).toBe(targetTheme);

    // Restore original theme
    const revertButton = page.getByTestId(initialMode!);
    await revertButton.click();
    await page.waitForFunction(
      (expected) => document.documentElement.getAttribute('data-theme') === expected,
      initialTheme,
      { timeout: 5_000 }
    );
    await expectVisualPreferencePersisted(page, 'mode', initialMode!.replace('eve-appearance-mode-', ''));
  });

  test('zoom scale persists after reload', async ({ page }) => {
    const label = percentLabel(page);
    await expect(label).toBeVisible({ timeout: 5_000 });

    const baseline = await currentPercent(page);

    const plus = plusButton(page);
    if (await plus.isDisabled()) {
      test.skip(true, 'zoom already at max — cannot increase');
      return;
    }
    await plus.click();
    await waitForSettle(page, 1_000);

    const afterClick = await currentPercent(page);
    expect(afterClick).toBeGreaterThan(baseline);

    await reloadAndGoToDisplay(page);

    const afterReload = await currentPercent(page);
    expect(afterReload).toBe(afterClick);

    // Restore via reset button
    const reset = resetButton(page);
    await expect(reset).toBeVisible({ timeout: 5_000 });
    if (await reset.isEnabled()) {
      await reset.click();
      await waitForSettle(page, 1_000);
    }
  });

  test('accent selection persists after reload', async ({ page }) => {
    const active = page.locator('[data-testid^="eve-appearance-accent-"][aria-checked="true"]');
    const initialTestId = await active.getAttribute('data-testid');
    expect(initialTestId).toBeTruthy();
    const targetAccent = initialTestId === 'eve-appearance-accent-emerald' ? 'petrol' : 'emerald';
    const targetTestId = `eve-appearance-accent-${targetAccent}`;

    await page.getByTestId(targetTestId).click();
    await expect(page.getByTestId(targetTestId)).toHaveAttribute('aria-checked', 'true');
    await expectVisualPreferencePersisted(page, 'accent', targetAccent);

    await reloadAndGoToDisplay(page);
    await expect(page.getByTestId(targetTestId)).toHaveAttribute('aria-checked', 'true');

    await page.getByTestId(initialTestId!).click();
    await expect(page.getByTestId(initialTestId!)).toHaveAttribute('aria-checked', 'true');
    await expectVisualPreferencePersisted(page, 'accent', initialTestId!.replace('eve-appearance-accent-', ''));
  });
});
