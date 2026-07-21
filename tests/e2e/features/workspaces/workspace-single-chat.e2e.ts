/**
 * E2E: Single-chat workspace panel — real user flow.
 *
 * Seeds a directory with known files, creates a conversation bound to it via
 * the conversations API, then opens the ShellElementsRail context tab and
 * verifies the workspace panel renders the seeded files, search works, and
 * tabs switch correctly.
 */
import { test, expect } from '../../fixtures';
import { goToGuid } from '../../helpers';
import { openWorkspaceContextPanel } from '../../helpers/workspacePanel';
import fs from 'fs';
import path from 'path';
import os from 'os';

test.describe('Workspace — single chat', () => {
  let workspace: string;

  test.beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-e2e-ws-single-'));
    fs.writeFileSync(path.join(workspace, 'readme.md'), '# My Project\n\nHello world.');
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'src', 'index.ts'), 'console.log("hello");');
    fs.writeFileSync(path.join(workspace, 'src', 'utils.ts'), 'export const add = (a: number, b: number) => a + b;');
  });

  test.afterAll(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('creates a workspace-bound conversation and sees files in the panel', async ({ page }) => {
    test.setTimeout(240_000);

    await goToGuid(page);

    // drift: 964c3c97 removed the guid workspace selector (GuidWorkspaceFootnote); seed the
    // workspace via POST /api/conversations extra.workspace (API pattern from 1c6716a3).
    // forceLocalCommandEveInference stays HTTP-only and is not needed: no message is sent.
    const conversationId = await page.evaluate(async (workspacePath) => {
      const port = (window as Window).__backendPort;
      if (!port) throw new Error('window.__backendPort is not available');
      const response = await fetch(`http://127.0.0.1:${port}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'acp',
          name: `E2E workspace single chat ${Date.now()}`,
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

    // Workspace panel should mount with our seeded files
    const panel = page.locator('.chat-workspace:visible').last();
    await expect(panel).toBeVisible({ timeout: 30_000 });

    // Title label reflects the workspace directory name
    const title = panel.locator('.workspace-title-label').first();
    await expect(title).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: 'tests/e2e/results/ws-single-01-panel.png' });

    // File tree should show our seeded readme.md
    const tree = panel.locator('.workspace-tree');
    await expect(tree).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByText('readme.md').first()).toBeVisible({ timeout: 10_000 });

    await page.screenshot({ path: 'tests/e2e/results/ws-single-02-tree.png' });

    // Search for "index" → should find src/index.ts
    const searchInput = panel.locator('.workspace-search-input input').first();
    await expect(searchInput).toBeVisible({ timeout: 5_000 });
    await searchInput.fill('index');
    await expect(panel.getByText('index.ts').first()).toBeVisible({ timeout: 5_000 });
    await page.screenshot({ path: 'tests/e2e/results/ws-single-03-search.png' });
    await searchInput.fill('');

    // Switch to Changes tab and back
    const changesTab = panel
      .locator('.arco-tabs-header-title')
      .filter({ hasText: /Changes|Änderungen|更改/ })
      .first();
    await expect(changesTab).toBeVisible({ timeout: 5_000 });
    await changesTab.click();
    await page.screenshot({ path: 'tests/e2e/results/ws-single-04-changes.png' });

    const filesTab = panel
      .locator('.arco-tabs-header-title')
      .filter({ hasText: /Files|Dateien|文件/ })
      .first();
    await expect(filesTab).toBeVisible({ timeout: 5_000 });
    await filesTab.click();
    await expect(panel.getByText('readme.md').first()).toBeVisible({ timeout: 5_000 });
  });
});
