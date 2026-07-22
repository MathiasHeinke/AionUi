/**
 * E2E: Preview panel — file click triggers preview.
 *
 * Seeds a workspace with an HTML file and a Markdown file, creates a
 * conversation pointing at it, then clicks the file in the workspace tree
 * to trigger the preview panel. Verifies the preview renders content and
 * the toolbar shows action buttons.
 *
 * This is deterministic — no dependency on agent output.
 */
import { test, expect } from '../../fixtures';
import { goToGuid } from '../../helpers';
import { openWorkspaceContextPanel } from '../../helpers/workspacePanel';
import fs from 'fs';
import path from 'path';
import os from 'os';

const HTML_CONTENT = `<!DOCTYPE html>
<html><head><title>E2E Preview</title></head>
<body><h1>Hello Preview</h1><p>This is a test page.</p></body>
</html>`;

const MD_CONTENT = `# Preview Test\n\nThis is **bold** and *italic*.\n\n- Item 1\n- Item 2\n`;

test.describe('Preview — file click triggers preview', () => {
  let workspace: string;

  test.beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-e2e-preview-'));
    fs.writeFileSync(path.join(workspace, 'page.html'), HTML_CONTENT);
    fs.writeFileSync(path.join(workspace, 'notes.md'), MD_CONTENT);
    fs.writeFileSync(path.join(workspace, 'data.json'), '{"key":"value","count":42}');
  });

  test.afterAll(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  async function openWorkspaceConversation(page: import('@playwright/test').Page): Promise<void> {
    await goToGuid(page);
    await page.evaluate(async (workspacePath) => {
      const port = (window as Window).__backendPort;
      if (!port) throw new Error('window.__backendPort is not available');
      const response = await fetch(`http://127.0.0.1:${port}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'acp',
          name: `E2E preview conversation ${Date.now()}`,
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
  }

  test('clicking HTML file in workspace tree opens preview panel', async ({ page }) => {
    test.setTimeout(120_000);

    await openWorkspaceConversation(page);

    // Wait for workspace panel and file tree
    const wsPanel = page.locator('.chat-workspace:visible').last();
    await expect(wsPanel).toBeVisible({ timeout: 30_000 });

    const tree = wsPanel.locator('.workspace-tree');
    await expect(tree).toBeVisible({ timeout: 15_000 });

    // Click page.html in the tree → should trigger preview
    const htmlFile = wsPanel.getByText('page.html').first();
    await expect(htmlFile).toBeVisible({ timeout: 10_000 });
    await htmlFile.click();

    await page.screenshot({ path: 'tests/e2e/results/preview-conv-01-clicked.png' });

    // Preview panel should appear
    const previewPanel = page.locator('.preview-panel:visible').last();
    await expect(previewPanel).toBeVisible({ timeout: 15_000 });

    // Preview should have content (iframe for HTML, or viewer)
    const content = previewPanel.locator('iframe, [class*="viewer"], [class*="editor"], pre, .cm-editor').first();
    await expect(content).toBeVisible({ timeout: 10_000 });

    await page.screenshot({ path: 'tests/e2e/results/preview-conv-02-preview.png' });

    // Toolbar actions are exposed through accessible names; title-only English
    // selectors drifted when the DE shell became the default locale.
    await expect(
      previewPanel
        .getByRole('button', {
          name: /Datei herunterladen|Download file|In System-App öffnen|Open in system|下载|打开/i,
        })
        .first()
    ).toBeVisible();
  });

  test('clicking markdown file opens preview with rendered content', async ({ page }) => {
    test.setTimeout(120_000);

    await openWorkspaceConversation(page);

    const wsPanel = page.locator('.chat-workspace:visible').last();
    await expect(wsPanel).toBeVisible({ timeout: 30_000 });

    const tree = wsPanel.locator('.workspace-tree');
    await expect(tree).toBeVisible({ timeout: 15_000 });

    // Click notes.md
    const mdFile = wsPanel.getByText('notes.md').first();
    await expect(mdFile).toBeVisible({ timeout: 10_000 });
    await mdFile.click();

    const previewPanel = page.locator('.preview-panel:visible').last();
    await expect(previewPanel).toBeVisible({ timeout: 15_000 });

    // Assert the user-visible Markdown result rather than an implementation
    // class; the current renderer produces semantic HTML directly.
    await expect(previewPanel.getByRole('heading', { name: 'Preview Test' })).toBeVisible({ timeout: 10_000 });
    await expect(previewPanel.getByText('Item 1', { exact: true })).toBeVisible({ timeout: 10_000 });

    await page.screenshot({ path: 'tests/e2e/results/preview-conv-03-markdown.png' });
  });
});
