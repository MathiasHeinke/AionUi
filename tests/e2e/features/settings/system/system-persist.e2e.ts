/**
 * System Settings Persistence E2E Tests
 *
 * Verifies that settings survive a page reload (persisted to backend, not just React state).
 * Pattern: record → change → reload → assert persisted → restore.
 * All operations via UI — zero invokeBridge, zero mock.
 */

import { test, expect } from '../../../fixtures';
import { goToSettings, waitForSettle } from '../../../helpers/navigation';

async function reloadAndGoToSystem(page: import('@playwright/test').Page) {
  await page.reload();
  await goToSettings(page, 'system');
  await waitForSettle(page);
}

test.describe('System Settings Persistence', () => {
  test.beforeEach(async ({ page }) => {
    await goToSettings(page, 'system');
    await waitForSettle(page);
  });

  // TC-PERSIST-01: Language switch persists across reload
  test('TC-PERSIST-01: language selection persists after reload', async ({ page }) => {
    const selectTrigger = page.locator('[data-testid="system-preference-language"]').getByRole('combobox');
    await expect(selectTrigger).toBeVisible();
    const rawOriginalLang = (await selectTrigger.textContent())?.trim() || 'Deutsch';
    const originalLang = rawOriginalLang === 'de-DE' ? 'Deutsch' : rawOriginalLang;
    const targetLang = originalLang === 'English' ? 'Deutsch' : 'English';

    await selectTrigger.click();
    const targetOption = page.getByRole('option', { name: targetLang, exact: true });
    await expect(targetOption).toBeVisible();
    await targetOption.click();
    await expect(selectTrigger).toContainText(targetLang, { timeout: 15_000 });

    await reloadAndGoToSystem(page);

    const reloadedSelect = page.locator('[data-testid="system-preference-language"]').getByRole('combobox');
    await expect(reloadedSelect).toBeVisible();
    await expect(reloadedSelect).toContainText(targetLang);

    // Restore
    await reloadedSelect.click();
    const restoreOption = page.getByRole('option', { name: originalLang, exact: true });
    await expect(restoreOption).toBeVisible();
    await restoreOption.click();
    await expect(reloadedSelect).toContainText(originalLang, { timeout: 15_000 });
    await waitForSettle(page);
  });

  // TC-PERSIST-02: closeToTray switch persists across reload.
  test('TC-PERSIST-02: closeToTray toggle persists after reload', async ({ page }) => {
    const closeToTraySwitch = page.locator('[data-testid="system-preference-closeToTray"]').getByRole('switch');
    await expect(closeToTraySwitch).toBeVisible();
    const wasChecked = (await closeToTraySwitch.getAttribute('aria-checked')) === 'true';

    await closeToTraySwitch.click();
    await expect(closeToTraySwitch).toHaveAttribute('aria-checked', String(!wasChecked));

    await reloadAndGoToSystem(page);

    const reloadedSwitch = page.locator('[data-testid="system-preference-closeToTray"]').getByRole('switch');
    await expect(reloadedSwitch).toBeVisible();
    await expect(reloadedSwitch).toHaveAttribute('aria-checked', String(!wasChecked), { timeout: 15_000 });

    // Restore
    await reloadedSwitch.click();
    await expect(reloadedSwitch).toHaveAttribute('aria-checked', String(wasChecked));
  });

  // TC-PERSIST-03: promptTimeout InputNumber persists across reload
  test('TC-PERSIST-03: promptTimeout value persists after reload', async ({ page }) => {
    const wrapper = page
      .locator('.arco-input-number')
      .filter({ has: page.locator('[class*="suffix"]:has-text("s")') })
      .first();
    await expect(wrapper).toBeVisible({ timeout: 15_000 });

    const input = wrapper.locator('input');
    const originalValue = (await input.inputValue()).trim();

    await input.click();
    await page.keyboard.press('Meta+a');
    await input.fill('600');
    await input.blur();
    await waitForSettle(page, 500);
    expect(Number((await input.inputValue()).trim())).toBe(600);

    await reloadAndGoToSystem(page);

    const reloadedWrapper = page
      .locator('.arco-input-number')
      .filter({ has: page.locator('[class*="suffix"]:has-text("s")') })
      .first();
    await expect(reloadedWrapper).toBeVisible({ timeout: 15_000 });
    const reloadedInput = reloadedWrapper.locator('input');

    // Wait for the value to be hydrated from backend
    await page
      .waitForFunction(
        () => {
          const inputs = document.querySelectorAll<HTMLInputElement>('.arco-input-number input');
          for (const el of inputs) {
            if (el.value.trim() === '600') return true;
          }
          return false;
        },
        undefined,
        { timeout: 15_000 }
      )
      .catch(() => {});

    expect(Number((await reloadedInput.inputValue()).trim())).toBe(600);

    // Restore
    await reloadedInput.click();
    await page.keyboard.press('Meta+a');
    await reloadedInput.fill(originalValue || '300');
    await reloadedInput.blur();
    await waitForSettle(page, 500);
  });

  test('TC-PERSIST-04: notification toggle persists after reload', async ({ page }) => {
    const notificationName = /^(Notifications|Benachrichtigungen)$/;
    const cronNotificationName = /^(Scheduled Task Completion|Abschluss geplanter Aufgaben)$/;
    const notifSwitch = page.getByRole('switch', { name: notificationName });
    await expect(notifSwitch).toBeVisible();
    const wasChecked = (await notifSwitch.getAttribute('aria-checked')) === 'true';

    await notifSwitch.click();
    await expect(notifSwitch).toHaveAttribute('aria-checked', String(!wasChecked));

    await reloadAndGoToSystem(page);

    const reloadedNotifSwitch = page.getByRole('switch', { name: notificationName });
    await expect(reloadedNotifSwitch).toBeVisible();
    await expect(reloadedNotifSwitch).toHaveAttribute('aria-checked', String(!wasChecked), { timeout: 15_000 });

    const cronNotificationSwitch = page.getByRole('switch', { name: cronNotificationName });
    if (!wasChecked) {
      await expect(cronNotificationSwitch).toBeVisible();
    } else {
      await expect(cronNotificationSwitch).toHaveCount(0);
    }

    // Restore
    await reloadedNotifSwitch.click();
    await expect(reloadedNotifSwitch).toHaveAttribute('aria-checked', String(wasChecked));
  });
});
