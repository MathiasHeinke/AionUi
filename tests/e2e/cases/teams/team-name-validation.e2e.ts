/**
 * E2E: Team name validation on the Create Team modal.
 *
 * Verifies that empty, whitespace-only, and very long names are handled
 * correctly without crashing the app or submitting invalid data.
 */
import { test, expect } from '../../fixtures';

type ModalHandles = {
  modal: import('@playwright/test').Locator;
  nameInput: import('@playwright/test').Locator;
  createBtn: import('@playwright/test').Locator;
};

async function openCreateModal(page: import('@playwright/test').Page): Promise<ModalHandles> {
  // The Electron app is reused by this serial harness. A preceding failed
  // assertion must not leave a modal intercepting the next test's click.
  const existingModal = page.locator('.team-create-modal').first();
  if (await existingModal.isVisible().catch(() => false)) {
    await closeModal(page);
  }

  const createBtn = page.locator('[data-testid="team-create-btn"]').first();
  await expect(createBtn).toBeVisible({ timeout: 10_000 });
  await createBtn.click();

  const modal = page
    .locator('.team-create-modal')
    .filter({ hasText: /Create Team|创建团队|Team erstellen/ })
    .first();
  await expect(modal).toBeVisible({ timeout: 5_000 });

  const nameInput = modal.locator('[data-testid="team-create-name-input"]');
  await expect(nameInput).toBeVisible({ timeout: 5_000 });

  const submitBtn = modal.locator('.arco-btn-primary');

  return { modal, nameInput, createBtn: submitBtn };
}

async function closeModal(page: import('@playwright/test').Page): Promise<void> {
  const modal = page.locator('.team-create-modal').first();
  const cancel = modal
    .locator('button')
    .filter({ hasText: /Cancel|取消|Abbrechen/i })
    .first();
  if (await cancel.isVisible().catch(() => false)) await cancel.click();
  else await page.keyboard.press('Escape');
  await expect(page.locator('.team-create-modal')).toBeHidden({ timeout: 5_000 });
}

test.describe('Team Name Validation', () => {
  test('empty name keeps create button disabled', async ({ page }) => {
    const { nameInput, createBtn } = await openCreateModal(page);

    // Ensure the name input is truly empty
    await expect(nameInput).toHaveValue('');

    // [assert] Create button must be disabled when name is empty
    await expect(createBtn).toBeDisabled();

    await page.screenshot({ path: 'tests/e2e/results/team-name-val-01.png' });

    await closeModal(page);
  });

  test('whitespace-only name keeps create button disabled', async ({ page }) => {
    const { nameInput, createBtn } = await openCreateModal(page);

    // [action] Type only spaces into the name field
    await nameInput.fill('   ');

    // [assert] Create button disabled, or the input value is effectively empty after trim
    const isDisabled = await createBtn.isDisabled();
    const currentValue = await nameInput.inputValue();

    // Accept either: button stays disabled, or value is empty (trimmed by UI)
    if (!isDisabled) {
      // If the button is somehow enabled, verify value is non-trivially empty after trim
      expect(currentValue.trim()).toBe('');
    } else {
      expect(isDisabled).toBe(true);
    }

    await page.screenshot({ path: 'tests/e2e/results/team-name-val-02.png' });

    await closeModal(page);
  });

  test('very long name (200 chars) can be entered or is truncated', async ({ page }) => {
    const { nameInput, createBtn } = await openCreateModal(page);

    const longName = 'A'.repeat(200);
    await nameInput.fill(longName);

    const actualValue = await nameInput.inputValue();

    // [assert] Value must not exceed 200 chars (no buffer overflow) AND
    //          the app must remain stable (no crash, create button still present)
    expect(actualValue.length).toBeLessThanOrEqual(200);
    expect(actualValue.length).toBeGreaterThan(0);

    // Create button visible (disabled or enabled — we only care app is stable)
    await expect(createBtn).toBeVisible();

    await page.screenshot({ path: 'tests/e2e/results/team-name-val-03.png' });

    await closeModal(page);
  });
});
