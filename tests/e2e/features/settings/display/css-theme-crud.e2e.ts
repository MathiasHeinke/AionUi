import { test, expect } from '../../../fixtures';
import { goToSettings, waitForSettle } from '../../../helpers';

const ACCENT_SELECTOR = '[data-testid^="eve-appearance-accent-"]';

async function navigateToAppearance(page: import('@playwright/test').Page) {
  await goToSettings(page, 'appearance');
  await expect(page.getByTestId('eve-appearance-mode-system')).toBeVisible({ timeout: 15_000 });
}

test.describe('Command EVE appearance controls', () => {
  test.beforeEach(async ({ page }) => {
    await navigateToAppearance(page);
  });

  test('exposes bounded appearance controls without the legacy raw CSS editor', async ({ page }) => {
    await expect(page.getByTestId('eve-appearance-mode-light')).toBeVisible();
    await expect(page.getByTestId('eve-appearance-mode-dark')).toBeVisible();
    await expect(page.locator(ACCENT_SELECTOR)).toHaveCount(4);
    await expect(page.locator('.eve-background-empty')).toBeVisible();
    await expect(page.locator('.cm-editor')).toHaveCount(0);
  });

  test('accent selection updates the public theme token', async ({ page }) => {
    const active = page.locator(`${ACCENT_SELECTOR}[aria-checked="true"]`);
    const initialTestId = await active.getAttribute('data-testid');
    expect(initialTestId).toBeTruthy();

    const targetAccent = initialTestId === 'eve-appearance-accent-emerald' ? 'petrol' : 'emerald';
    const target = page.getByTestId(`eve-appearance-accent-${targetAccent}`);
    const before = await page.evaluate(() => document.documentElement.style.getPropertyValue('--eve-accent').trim());

    await target.click();
    await expect(target).toHaveAttribute('aria-checked', 'true');
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--eve-accent').trim()))
      .not.toBe(before);

    await page.getByTestId(initialTestId!).click();
    await expect(page.getByTestId(initialTestId!)).toHaveAttribute('aria-checked', 'true');
  });

  test('reduced effects updates the root contract and disables glass blur', async ({ page }) => {
    const effectsSection = page.locator('[aria-labelledby="eve-appearance-glass-title"]');
    const toggle = effectsSection.locator('.arco-switch');
    const blurSlider = effectsSection.getByRole('slider').nth(1);
    const initiallyReduced =
      (await page.evaluate(() => document.documentElement.getAttribute('data-eve-reduced-effects'))) === 'true';

    if (initiallyReduced) {
      await toggle.click();
      await expect.poll(() => blurSlider.isEnabled()).toBe(true);
    }

    await toggle.click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-eve-reduced-effects')))
      .toBe('true');
    await expect(blurSlider).toBeDisabled();

    await toggle.click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.hasAttribute('data-eve-reduced-effects')))
      .toBe(false);
    await expect(blurSlider).toBeEnabled();
    await waitForSettle(page, 500);
  });
});
