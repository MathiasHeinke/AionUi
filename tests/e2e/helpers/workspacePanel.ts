/**
 * Workspace panel helpers for the 1.8.11+ shell.
 *
 * Since the shell rebuild (964c3c97) the conversation workspace panel
 * (.chat-workspace) lives behind the ShellElementsRail "Kontext" tab and the
 * rail itself starts collapsed. Specs must first open the rail via the
 * titlebar toggle, then activate the context tab, before asserting the panel.
 */
import { expect, type Page } from '@playwright/test';

/**
 * Open the ShellElementsRail context tab so `.chat-workspace` mounts.
 * Uses the sider width as the source of truth (the titlebar's aria-pressed can
 * lag behind a fresh conversation's collapsed default).
 */
export async function openWorkspaceContextPanel(page: Page): Promise<void> {
  const sider = page.locator('.chat-layout-right-sider');
  const isExpanded = async () => ((await sider.boundingBox())?.width ?? 0) > 50;
  if (!(await isExpanded())) {
    const toggle = page.getByTestId('elements-rail-toggle');
    await expect(toggle).toBeVisible({ timeout: 15_000 });
    await toggle.click();
    await expect.poll(isExpanded, { timeout: 15_000 }).toBe(true);
  }
  const contextTab = page.getByTestId('elements-rail-tab-context');
  await expect(contextTab).toBeVisible({ timeout: 15_000 });
  await contextTab.click();
}
