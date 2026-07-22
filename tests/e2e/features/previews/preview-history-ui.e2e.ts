/**
 * E2E: Preview history and view mode toggle — real user flow.
 *
 * Seeds a workspace with files, opens a preview via file click, then
 * exercises the Editor/Preview toggle and history dropdown.
 */
import { test, expect } from '../../fixtures';
import { goToGuid } from '../../helpers';
import { openWorkspaceContextPanel } from '../../helpers/workspacePanel';
import fs from 'fs';
import path from 'path';
import os from 'os';

test.describe('Preview — history and view toggle', () => {
  let workspace: string;

  test.beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-e2e-preview-hist-'));
    fs.writeFileSync(path.join(workspace, 'app.html'), '<!DOCTYPE html><html><body><h1>Version 1</h1></body></html>');
    fs.writeFileSync(path.join(workspace, 'style.css'), 'body { margin: 0; }');
  });

  test.afterAll(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  /** Create conversation with workspace, click a file, return preview panel or null. */
  async function openPreviewViaFileClick(page: import('@playwright/test').Page, fileName: string) {
    await goToGuid(page);

    // 1.8.11 removed the guid workspace picker from the public shell. Seed the
    // workspace through the same local conversations API used by the current
    // workspace specs; no installed raw-agent pill or LLM response is required.
    await page.evaluate(async (workspacePath) => {
      const port = (window as Window).__backendPort;
      if (!port) throw new Error('window.__backendPort is not available');
      const response = await fetch(`http://127.0.0.1:${port}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'acp',
          name: `E2E preview history ${Date.now()}`,
          extra: { workspace: workspacePath, custom_workspace: true, backend: 'codex', session_mode: 'full-access' },
        }),
      });
      if (!response.ok) throw new Error(`Conversation create failed (${response.status}): ${await response.text()}`);
      const result = (await response.json()) as { data?: { id?: string } };
      const id = result.data?.id;
      if (!id) throw new Error('Conversation create response did not include an id');
      window.location.assign(`#/conversation/${id}`);
    }, workspace);
    await page.waitForURL(/\/conversation\//, { timeout: 30_000 });

    await openWorkspaceContextPanel(page);

    const wsPanel = page.locator('.chat-workspace:visible').last();
    await expect(wsPanel).toBeVisible({ timeout: 30_000 });

    const tree = wsPanel.locator('.workspace-tree');
    await expect(tree).toBeVisible({ timeout: 15_000 });

    const fileNode = wsPanel.getByText(fileName).first();
    await expect(fileNode).toBeVisible({ timeout: 10_000 });
    await fileNode.click();

    const previewPanel = page.locator('.preview-panel:visible').last();
    await expect(previewPanel).toBeVisible({ timeout: 15_000 });

    return previewPanel;
  }

  test('Editor/Preview toggle switches view mode', async ({ page }) => {
    test.setTimeout(120_000);

    const panel = await openPreviewViaFileClick(page, 'app.html');

    // The current DE/EN shell exposes these as accessible tabs (Code/Quelle
    // and Vorschau/Preview), not the old free-text "Editor" labels.
    const editorToggle = panel.getByRole('tab', { name: /^(Code|Quelle|Source|Editor|编辑器)$/i }).first();
    const previewToggle = panel.getByRole('tab', { name: /^(Vorschau|Preview|预览)$/i }).first();

    await expect(editorToggle).toBeVisible({ timeout: 5_000 });

    // Switch to Editor mode
    await editorToggle.click();
    await page.waitForTimeout(500);

    // Editor mode should show a code editor (CodeMirror or textarea)
    const editor = panel.locator('.cm-editor, textarea, [class*="editor"]').first();
    const hasEditor = await editor.isVisible({ timeout: 5_000 }).catch(() => false);
    await page.screenshot({ path: 'tests/e2e/results/preview-hist-01-editor.png' });

    // Switch to Preview mode
    if (await previewToggle.isVisible().catch(() => false)) {
      await previewToggle.click();
      await page.waitForTimeout(500);

      // Preview mode should show rendered content (iframe or viewer)
      const viewer = panel.locator('iframe, [class*="viewer"]').first();
      const hasViewer = await viewer.isVisible({ timeout: 5_000 }).catch(() => false);
      await page.screenshot({ path: 'tests/e2e/results/preview-hist-02-preview.png' });

      // At least one mode should have content
      expect(hasEditor || hasViewer).toBeTruthy();
    }
  });

  test('snapshot and history controls stay hidden while the product flag is off', async ({ page }) => {
    test.setTimeout(120_000);

    const panel = await openPreviewViaFileClick(page, 'app.html');

    // PreviewToolbar intentionally keeps SHOW_SNAPSHOT_HISTORY=false. Pin the
    // public contract instead of silently skipping a control that is not meant
    // to ship in 1.818.
    await expect(panel.getByRole('button', { name: /history|verlauf|版本|历史/i })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: /snapshot|schnappschuss|快照/i })).toHaveCount(0);
  });
});
