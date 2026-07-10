/**
 * Theme Switching E2E Tests
 *
 * Verifies that toggling light/dark theme via the ThemeSwitcher
 * updates the `data-theme` attribute on `<html>`.
 */

import { test, expect } from '../../../fixtures';
import { goToSettings } from '../../../helpers/navigation';

test.describe('Theme Switching', () => {
  test.beforeEach(async ({ page }) => {
    await goToSettings(page, 'appearance');
  });

  test('switches from current theme to the other and back', async ({ page }) => {
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

    const newTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(newTheme).toBe(targetTheme);

    const revertButton = page.getByTestId(initialMode!);
    await revertButton.click();

    await page.waitForFunction(
      (expected) => document.documentElement.getAttribute('data-theme') === expected,
      initialTheme,
      { timeout: 5_000 }
    );

    const restoredTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(restoredTheme).toBe(initialTheme);
  });

  test('dark button sets data-theme to dark', async ({ page }) => {
    const darkButton = page.getByTestId('eve-appearance-mode-dark');
    await darkButton.waitFor({ state: 'visible', timeout: 10_000 });
    await darkButton.click();

    await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark', {
      timeout: 5_000,
    });

    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(theme).toBe('dark');

    const arcoTheme = await page.evaluate(() => document.body.getAttribute('arco-theme'));
    expect(arcoTheme).toBe('dark');
  });

  test('light button sets data-theme to light', async ({ page }) => {
    const lightButton = page.getByTestId('eve-appearance-mode-light');
    await lightButton.waitFor({ state: 'visible', timeout: 10_000 });
    await lightButton.click();

    await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'light', {
      timeout: 5_000,
    });

    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(theme).toBe('light');

    const arcoTheme = await page.evaluate(() => document.body.getAttribute('arco-theme'));
    expect(arcoTheme).toBe('light');
  });

  test('aria-checked reflects active theme', async ({ page }) => {
    const lightRadio = page.getByTestId('eve-appearance-mode-light');
    const darkRadio = page.getByTestId('eve-appearance-mode-dark');
    await lightRadio.waitFor({ state: 'visible', timeout: 10_000 });
    await lightRadio.click();

    await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'light', {
      timeout: 5_000,
    });

    await expect(lightRadio).toHaveAttribute('aria-checked', 'true');
    await expect(darkRadio).toHaveAttribute('aria-checked', 'false');

    await darkRadio.click();

    await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark', {
      timeout: 5_000,
    });

    await expect(darkRadio).toHaveAttribute('aria-checked', 'true');
    await expect(lightRadio).toHaveAttribute('aria-checked', 'false');

    // Restore to light
    await lightRadio.click();
    await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'light', {
      timeout: 5_000,
    });
  });
});
