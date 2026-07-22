/**
 * E2E: Workspace file operations — expand folder, search, context menu.
 *
 * Seeds a nested directory structure, creates a conversation pointing at it,
 * then drives the workspace panel: expand a folder to reveal children, search
 * by filename, and right-click to open the context menu.
 *
 * Uses test.describe.serial to share a single conversation across all assertions
 * and avoid redundant 30-second conversation creation per test.
 */
import { test, expect } from '../../fixtures';
import { goToGuid } from '../../helpers';
import { openWorkspaceContextPanel } from '../../helpers/workspacePanel';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Locator } from '@playwright/test';

test.describe.serial('Workspace — file operations', () => {
  let workspace: string;
  let panel: Locator | null = null;

  test.beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-e2e-ws-ops-'));
    fs.writeFileSync(path.join(workspace, 'config.json'), '{"name":"test"}');
    fs.mkdirSync(path.join(workspace, 'components'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'components', 'Button.tsx'), '<button>Click</button>');
    fs.writeFileSync(path.join(workspace, 'components', 'Modal.tsx'), '<div>Modal</div>');
    fs.mkdirSync(path.join(workspace, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'lib', 'api.ts'), 'export const fetch = () => {}');
  });

  test.afterAll(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('setup: create conversation with workspace panel', async ({ page }) => {
    test.setTimeout(120_000);

    await goToGuid(page);
    const conversationId = await page.evaluate(async (workspacePath) => {
      const port = (window as Window).__backendPort;
      if (!port) throw new Error('window.__backendPort is not available');
      const response = await fetch(`http://127.0.0.1:${port}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'acp',
          name: `E2E workspace file operations ${Date.now()}`,
          extra: {
            workspace: workspacePath,
            custom_workspace: true,
            backend: 'codex',
            session_mode: 'full-access',
          },
        }),
      });
      if (!response.ok) {
        throw new Error(`Conversation create failed (${response.status}): ${await response.text()}`);
      }
      const result = (await response.json()) as { data?: { id?: string } };
      const id = result.data?.id;
      if (!id) throw new Error('Conversation create response did not include an id');
      window.location.assign(`#/conversation/${id}`);
      return id;
    }, workspace);

    await page.waitForURL(/\/conversation\//, { timeout: 30_000 });
    expect(page.url()).toContain(conversationId);

    // drift: 964c3c97 .chat-workspace now lives behind the collapsed-by-default ShellElementsRail
    // "Kontext" tab — open the rail via the titlebar toggle, then activate the context tab.
    await openWorkspaceContextPanel(page);

    const wsPanel = page.locator('.chat-workspace');
    await expect(wsPanel).toBeVisible({ timeout: 45_000 });

    const tree = wsPanel.locator('.workspace-tree');
    await expect(tree).toBeVisible({ timeout: 30_000 });

    panel = wsPanel;
  });

  test('expand folder node reveals children files', async ({ page }) => {
    test.setTimeout(30_000);
    if (!panel) {
      test.skip(true, 'Workspace panel not available from setup');
      return;
    }

    const componentsNode = panel.getByText('components').first();
    await expect(componentsNode).toBeVisible({ timeout: 10_000 });

    await componentsNode.click();
    await page.waitForTimeout(500);

    await expect(panel.getByText('Button.tsx').first()).toBeVisible({ timeout: 5_000 });
    await expect(panel.getByText('Modal.tsx').first()).toBeVisible({ timeout: 5_000 });

    await page.screenshot({ path: 'tests/e2e/results/ws-ops-01-expanded.png' });
  });

  test('search narrows tree to matching files only', async ({ page }) => {
    test.setTimeout(30_000);
    if (!panel) {
      test.skip(true, 'Workspace panel not available from setup');
      return;
    }

    const searchInput = panel.locator('.workspace-search-input input').first();
    await expect(searchInput).toBeVisible({ timeout: 5_000 });

    await searchInput.fill('Button');
    await expect(panel.getByText('Button.tsx').first()).toBeVisible({ timeout: 5_000 });

    await page.screenshot({ path: 'tests/e2e/results/ws-ops-02-search-button.png' });

    await searchInput.fill('api');
    await expect(panel.getByText('api.ts').first()).toBeVisible({ timeout: 5_000 });

    await searchInput.fill('');
    await page.screenshot({ path: 'tests/e2e/results/ws-ops-03-search-cleared.png' });
  });

  test('right-click file shows context menu with action items', async ({ page }) => {
    test.setTimeout(30_000);
    if (!panel) {
      test.skip(true, 'Workspace panel not available from setup');
      return;
    }

    const configNode = panel.getByText('config.json').first();
    await expect(configNode).toBeVisible({ timeout: 10_000 });
    await configNode.click({ button: 'right' });

    const ctxMenu = page.locator('.fixed.z-100').first();
    await expect(ctxMenu).toBeVisible({ timeout: 3_000 });

    const addToChat = ctxMenu.getByText(/Add to Chat|Zum Chat hinzufügen|添加到对话/i).first();
    const openItem = ctxMenu.getByText(/^(Open|Öffnen|打开)$/i).first();
    expect(
      (await addToChat.isVisible().catch(() => false)) || (await openItem.isVisible().catch(() => false))
    ).toBeTruthy();

    await page.screenshot({ path: 'tests/e2e/results/ws-ops-04-context-menu.png' });

    await page.keyboard.press('Escape');
    await expect(ctxMenu).not.toBeVisible();
  });
});
