/**
 * E2E: auto-open Office preview tabs when new files appear in the workspace.
 *
 * This exercises the end-to-end watcher flow:
 *   1. open a conversation with a selected workspace
 *   2. backend starts `/api/fs/office-watch/start`
 *   3. test creates a new Office file in that workspace
 *   4. renderer receives `workspaceOfficeWatch.fileAdded`
 *   5. PreviewPanel opens the matching tab automatically
 *
 * We assert tab creation only. The embedded office preview may still render an
 * install hint when `officecli` is unavailable, but the auto-open behavior must
 * still work.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { test, expect } from '../../fixtures';
import { goToGuid } from '../../helpers';
import { openWorkspaceContextPanel } from '../../helpers/workspacePanel';

async function enableAutoPreviewOfficeFiles(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    const port = (window as Window).__backendPort;
    if (!port) {
      throw new Error('window.__backendPort is not available');
    }

    const response = await fetch(`http://127.0.0.1:${port}/api/settings/client`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoPreviewOfficeFiles: true }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`PUT /api/settings/client failed (${response.status}): ${body}`);
    }
  });
}

async function installWorkspaceOfficeWatchDebug(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const win = window as Window & {
      __backendPort?: number;
      __previewAutoOpenDebug?: {
        status: string;
        events: Array<{ name: string; data: unknown }>;
      };
      __previewAutoOpenDebugWs?: WebSocket;
    };

    if (win.__previewAutoOpenDebugWs) {
      win.__previewAutoOpenDebugWs.close();
    }

    const port = win.__backendPort;
    if (!port) {
      throw new Error('window.__backendPort is not available');
    }

    const debug = { status: 'connecting', events: [] as Array<{ name: string; data: unknown }> };
    win.__previewAutoOpenDebug = debug;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    win.__previewAutoOpenDebugWs = ws;

    ws.addEventListener('open', () => {
      debug.status = 'open';
    });

    ws.addEventListener('close', () => {
      debug.status = 'closed';
    });

    ws.addEventListener('error', () => {
      debug.status = 'error';
    });

    ws.addEventListener('message', (event) => {
      try {
        const parsed = JSON.parse(String(event.data)) as {
          name?: string;
          event?: string;
          data?: unknown;
          payload?: unknown;
        };

        const name = parsed.name ?? parsed.event ?? 'unknown';
        const data = parsed.data ?? parsed.payload;

        // drift: f43ed0be AionCore drops clients that do not answer its application-level
        // heartbeat ping with a pong — the debug channel must answer like the app does.
        if (name === 'ping') {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ name: 'pong', data: data ?? {} }));
          }
          return;
        }

        debug.events.push({ name, data });
      } catch {
        debug.events.push({ name: 'non-json', data: String(event.data) });
      }
    });
  });
}

async function getWorkspaceOfficeWatchDebug(
  page: import('@playwright/test').Page,
  workspace: string
): Promise<{
  configValue: unknown;
  wsStatus: string;
  workspaceFiles: string[];
  officeEvents: Array<{ name: string; data: unknown }>;
}> {
  return page.evaluate(
    async ({ workspacePath }) => {
      const win = window as Window & {
        __backendPort?: number;
        __previewAutoOpenDebug?: {
          status: string;
          events: Array<{ name: string; data: unknown }>;
        };
      };

      const port = win.__backendPort;
      if (!port) {
        throw new Error('window.__backendPort is not available');
      }

      const [settingsResponse, filesResponse] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/api/settings/client`),
        fetch(`http://127.0.0.1:${port}/api/fs/list`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ root: workspacePath }),
        }),
      ]);

      const settingsText = await settingsResponse.text();
      const filesText = await filesResponse.text();
      const settingsJson = settingsText ? (JSON.parse(settingsText) as { data?: Record<string, unknown> }) : undefined;
      const filesJson = filesText ? (JSON.parse(filesText) as { data?: Array<{ fullPath?: string }> }) : undefined;
      const events = win.__previewAutoOpenDebug?.events ?? [];

      return {
        configValue: settingsJson?.data?.autoPreviewOfficeFiles,
        wsStatus: win.__previewAutoOpenDebug?.status ?? 'missing',
        workspaceFiles: (filesJson?.data ?? []).map((file) => file.fullPath ?? '').filter(Boolean),
        officeEvents: events.filter((event) => event.name === 'workspaceOfficeWatch.fileAdded'),
      };
    },
    { workspacePath: workspace }
  );
}

async function createConversationWithWorkspace(
  page: import('@playwright/test').Page,
  workspace: string
): Promise<string> {
  await goToGuid(page);
  await enableAutoPreviewOfficeFiles(page);
  await installWorkspaceOfficeWatchDebug(page);

  const conversationId = await page.evaluate(
    async ({ workspacePath }) => {
      const port = (window as unknown as { __backendPort?: number }).__backendPort;
      if (!port) {
        throw new Error('window.__backendPort is not available');
      }

      const response = await fetch(`http://127.0.0.1:${port}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'acp',
          name: `E2E preview auto-open ${Date.now()}`,
          extra: {
            workspace: workspacePath,
            custom_workspace: true,
            backend: 'claude',
          },
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`POST /api/conversations failed (${response.status}): ${body}`);
      }

      const json = (await response.json()) as { data?: { id?: string } };
      const id = json?.data?.id;
      if (!id) {
        throw new Error('Conversation create response did not include an id');
      }

      window.location.assign(`#/conversation/${id}`);
      return id;
    },
    { workspacePath: workspace }
  );

  await page.waitForFunction((id) => window.location.hash === `#/conversation/${id}`, conversationId, {
    timeout: 15_000,
  });

  // drift: 964c3c97 .chat-workspace now lives behind the collapsed-by-default ShellElementsRail
  // "Kontext" tab — open the rail via the titlebar toggle, then activate the context tab.
  await openWorkspaceContextPanel(page);

  await expect(page.locator('.chat-workspace')).toBeVisible({ timeout: 30_000 });
  return conversationId;
}

async function deleteConversation(page: import('@playwright/test').Page, conversationId: string): Promise<void> {
  await page.evaluate(
    async ({ id }) => {
      const port = (window as unknown as { __backendPort?: number }).__backendPort;
      if (!port) return;

      await fetch(`http://127.0.0.1:${port}/api/conversations/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }).catch(() => {});
    },
    { id: conversationId }
  );
}

test.describe('Preview auto-open for Office files', () => {
  const cases = [
    { ext: 'docx', fileName: 'auto-open-report.docx' },
    { ext: 'pptx', fileName: 'auto-open-slides.pptx' },
    { ext: 'xlsx', fileName: 'auto-open-sheet.xlsx' },
  ] as const;

  for (const { ext, fileName } of cases) {
    test(`new .${ext} file auto-opens a preview tab`, async ({ page }) => {
      test.setTimeout(120_000);

      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `aionui-e2e-office-auto-${ext}-`));
      const browserLogs: string[] = [];
      fs.writeFileSync(path.join(workspace, 'seed.txt'), 'seed');
      let conversationId: string | null = null;
      const consoleListener = (message: import('@playwright/test').ConsoleMessage) => {
        browserLogs.push(`[${message.type()}] ${message.text()}`);
        if (browserLogs.length > 60) {
          browserLogs.shift();
        }
      };
      page.on('console', consoleListener);

      try {
        conversationId = await createConversationWithWorkspace(page, workspace);
        // Give the renderer enough time to start the backend watcher and record
        // the initial baseline before we create the new office file.
        // drift: the passive debug WebSocket is dropped by the backend's connection
        // management even when answering pings, so it is kept for diagnostics only —
        // the feature proof is the preview tab opening via the app's own WS channel.
        await page.waitForTimeout(2_000);

        const targetFile = path.join(workspace, fileName);
        fs.writeFileSync(targetFile, 'stub');

        const previewPanel = page.locator('.preview-panel');
        try {
          await expect(previewPanel).toBeVisible({ timeout: 20_000 });
          await expect(previewPanel.getByText(fileName)).toBeVisible({ timeout: 20_000 });
        } catch (error) {
          const debug = await getWorkspaceOfficeWatchDebug(page, workspace);
          throw new Error(
            `Preview did not auto-open for ${fileName}. wsStatus=${debug.wsStatus}; autoPreviewOfficeFiles=${JSON.stringify(debug.configValue)}; workspaceFiles=${JSON.stringify(debug.workspaceFiles)}; officeEvents=${JSON.stringify(debug.officeEvents)}; browserLogs=${JSON.stringify(browserLogs)}; originalError=${String(error)}`,
            { cause: error }
          );
        }
      } finally {
        page.off('console', consoleListener);
        if (conversationId) {
          await deleteConversation(page, conversationId);
        }
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    });
  }
});
