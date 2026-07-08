/**
 * Command EVE Skill Library – Electron bridge proof.
 *
 * Verifies the desktop app can render the local runtime skill truth without
 * claiming browser-mode or write-capable setup.
 */
import { test, expect } from '../fixtures';
import { goToSettings } from '../helpers/navigation';

test.describe('Command EVE Skill Library', () => {
  test.setTimeout(120_000);

  test('renders read-only skill runtime truth or a loud local-runtime blocker', async ({ page }, testInfo) => {
    await page.waitForSelector('body', { state: 'visible' });

    await goToSettings(page, 'capabilities');

    await expect(page.getByTestId('command-eve-capability-section')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('ELECTRON_BRIDGE_REQUIRED')).toHaveCount(0);
    await expect(page.getByTestId('my-skills-section')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('skill-filter-chips')).toBeVisible({ timeout: 30_000 });
    await expect(
      page
        .getByText(
          /Runtime-Wahrheit|Runtime truth|RUNTIME_RECONCILIATION_MISSING|RUNTIME_RECONCILIATION_SOURCE_MISSING|Command-EVE-Fähigkeiten|Command EVE capabilities/
        )
        .first()
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByText(/Auto-Decompose|Auto-decompose|Prompt-Label|Prompt label|Disabled|disabled/).first()
    ).toBeVisible({ timeout: 30_000 });

    const screenshotPath = 'tests/e2e/results/command-eve-skill-library.png';
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await testInfo.attach('command-eve-skill-library', {
      path: screenshotPath,
      contentType: 'image/png',
    });
  });
});
