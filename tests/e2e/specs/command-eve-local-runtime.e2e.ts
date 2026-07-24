/**
 * Command EVE Local Runtime – Electron bridge proof.
 *
 * Verifies the desktop app renders the local Runtime truth surface from the
 * packaged Command EVE runtime manifest without exposing model mutation.
 */
import { test, expect } from '../fixtures';
import { goToSettings } from '../helpers';

test.describe('Command EVE Local Runtime', () => {
  test.setTimeout(120_000);

  test('renders the managed local AI status without exposing internal runtime wiring', async ({ page }, testInfo) => {
    await page.waitForSelector('body', { state: 'visible' });

    await goToSettings(page, 'runtime');

    await expect(page.getByRole('heading', { name: /Lokale KI|Local AI/ })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Lokale Ausführung|Local execution/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Wird automatisch von EVE verwaltet|Managed automatically by EVE/).first()).toBeVisible(
      {
        timeout: 30_000,
      }
    );
    await expect(page.getByText(/Hermes|hermes-agent/)).toHaveCount(0);
    await expect(page.getByText(/127\.0\.0\.1|gemma4:/)).toHaveCount(0);
    await expect(page.getByText(/Schnell und effizient|Fast and efficient/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Planung und Analyse|Planning and analysis/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Lokale Aufgaben|Local tasks/)).toHaveCount(0);
    await expect(page.getByText(/Module bereit|modules ready/)).toHaveCount(0);
    await expect(page.getByText(/Startprüfung|Startup check/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: /Warm-up|warm-up|Modellwechsel|model switching/ })).toHaveCount(0);

    const screenshotPath = 'tests/e2e/results/command-eve-local-runtime.png';
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await testInfo.attach('command-eve-local-runtime', {
      path: screenshotPath,
      contentType: 'image/png',
    });
  });
});
