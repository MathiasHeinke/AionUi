import { expect, test } from '../fixtures';

test.describe('Command EVE backend recovery surface', () => {
  test('keeps the startup failure panel translucent and readable', async ({ page }, testInfo) => {
    test.skip(
      process.env.COMMAND_EVE_E2E_BACKEND_RECOVERY !== '1',
      'Run with an intentionally unavailable aioncore binary.'
    );

    const recovery = page.locator('.eve-backend-recovery');
    const panel = page.locator('.eve-backend-recovery__panel');
    await expect(recovery).toBeVisible({ timeout: 30_000 });
    await expect(panel).toBeVisible();
    await expect(page.getByRole('heading', { name: /lokale KI-Dienst|local AI service/i })).toBeVisible();

    const panelStyle = await panel.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        backdropFilter: style.backdropFilter || style.getPropertyValue('-webkit-backdrop-filter'),
        backgroundColor: style.backgroundColor,
        borderRadius: style.borderRadius,
      };
    });
    expect(panelStyle.backdropFilter).toContain('blur(34px)');
    expect(panelStyle.backgroundColor).not.toBe('rgb(255, 255, 255)');
    expect(Number.parseFloat(panelStyle.borderRadius)).toBeGreaterThanOrEqual(20);

    const screenshotPath = 'tests/e2e/results/command-eve-recovery-glass.png';
    await page.screenshot({ path: screenshotPath });
    await testInfo.attach('command-eve-recovery-glass', {
      path: screenshotPath,
      contentType: 'image/png',
    });
  });
});
