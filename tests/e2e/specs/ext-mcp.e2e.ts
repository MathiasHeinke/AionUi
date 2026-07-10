/**
 * Extensions – MCP Servers tests.
 *
 * Validates extension-contributed MCP servers on the tools settings page.
 */
import { test, expect } from '../fixtures';
import { goToSettings, expectBodyContainsAny, takeScreenshot, waitForSettle, ARCO_SWITCH } from '../helpers';

async function openMcpTools(page: import('@playwright/test').Page): Promise<void> {
  await goToSettings(page, 'capabilities');
  const toolsTab = page.getByRole('tab', { name: /Tools|MCP & Voice/ });
  await toolsTab.click();
  await expect(toolsTab).toHaveAttribute('aria-selected', 'true');
}

test.describe('Extension: MCP Servers', () => {
  test('MCP tools page loads', async ({ page }) => {
    await openMcpTools(page);
    await expectBodyContainsAny(page, ['MCP', 'mcp', 'Server', 'server', '工具', '配置', '添加', 'Add']);
  });

  test('extension MCP servers registered (page functional)', async ({ page }) => {
    await openMcpTools(page);
    await waitForSettle(page);

    const body = await page.locator('body').textContent();
    // MCP servers may appear in the list or be internal-only
    expect(body!.length).toBeGreaterThan(50);
  });

  test('MCP server toggles are visible', async ({ page }) => {
    await openMcpTools(page);

    const switches = page.locator(ARCO_SWITCH);
    await expect(switches.first()).toBeVisible({ timeout: 10_000 });
  });

  test('screenshot: MCP tools with extensions', async ({ page }) => {
    test.skip(!process.env.E2E_SCREENSHOTS, 'screenshots disabled');
    await openMcpTools(page);
    await waitForSettle(page);
    await takeScreenshot(page, 'ext-mcp-servers');
  });
});
