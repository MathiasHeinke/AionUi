/**
 * Native Command EVE Kanban in the single-chat workbench.
 *
 * Provider-free: HTTP creates one empty local conversation only. Every board
 * mutation is driven through visible UI and Hermes' canonical default board.
 * The second launch reuses the exact profile to prove both SQLite and workbench
 * tab identity survive a clean desktop restart. Computer Use is status-only in
 * this fixture; the spec never clicks install, grant, capture, or action gates.
 */
import { expect, test, type ElectronApplication, type Page, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeSharedElectronAppForIsolatedSpec } from '../fixtures';
import { resolveAioncoreBinary } from '../helpers/aioncoreBinary';
import { httpGet, httpPost } from '../helpers/httpBridge';

const projectRoot = path.resolve(__dirname, '../../..');
const mainEntry = path.join(projectRoot, 'out', 'main', 'index.js');
let scratchRoot = '';
let isolatedHomeDir = '';
let isolatedUserDataDir = '';
let emptyExtensionsDir = '';
let workspaceDir = '';
let tempDir = '';
let extensionStatesFile = '';
let agentEventsFile = '';

type Conversation = { id: string };
type MessageList = { items: unknown[] };
type PersistedTab = {
  id?: unknown;
  content_type?: unknown;
  metadata?: { conversation_id?: unknown };
};

function isDevToolsWindow(page: Page): boolean {
  return page.url().startsWith('devtools://');
}

async function resolveMainWindow(app: ElectronApplication): Promise<Page> {
  const existing = app.windows().find((window) => !isDevToolsWindow(window));
  if (existing) {
    await existing.waitForLoadState('domcontentloaded');
    return existing;
  }

  const resolveBefore = async (deadline: number): Promise<Page> => {
    if (Date.now() >= deadline) throw new Error('Failed to resolve the native Kanban Electron window.');
    const window = await app.waitForEvent('window', { timeout: 1_000 }).catch(() => null);
    if (window && !isDevToolsWindow(window)) {
      await window.waitForLoadState('domcontentloaded');
      return window;
    }
    return resolveBefore(deadline);
  };
  return resolveBefore(Date.now() + 180_000);
}

async function launchApp(): Promise<ElectronApplication> {
  if (!fs.existsSync(mainEntry)) {
    throw new Error(`Built main bundle not found: ${mainEntry}\nRun \`bun run package\` before this E2E gate.`);
  }
  const backendBinary = resolveAioncoreBinary({ cwd: projectRoot });
  const launchArgs = ['.', `--user-data-dir=${isolatedUserDataDir}`];
  if (process.platform === 'linux' && process.env.CI) launchArgs.push('--no-sandbox');

  return electron.launch({
    args: launchArgs,
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: isolatedHomeDir,
      XDG_CONFIG_HOME: path.join(isolatedHomeDir, '.config'),
      XDG_CACHE_HOME: path.join(isolatedHomeDir, '.cache'),
      XDG_DATA_HOME: path.join(isolatedHomeDir, '.local', 'share'),
      XDG_STATE_HOME: path.join(isolatedHomeDir, '.local', 'state'),
      TMPDIR: tempDir,
      TMP: tempDir,
      TEMP: tempDir,
      PATH: `${path.dirname(backendBinary)}${path.delimiter}${process.env.PATH || ''}`,
      AIONUI_BACKEND_BINARY: backendBinary,
      AIONUI_EXTENSIONS_PATH: emptyExtensionsDir,
      AIONUI_EXTENSION_STATES_FILE: extensionStatesFile,
      AIONUI_DISABLE_AUTO_UPDATE: '1',
      AIONUI_DISABLE_DEVTOOLS: '1',
      AIONUI_E2E_TEST: '1',
      AIONUI_MULTI_INSTANCE: '1',
      AIONUI_CDP_PORT: '0',
      COMMAND_EVE_AGENT_EVENTS_PATH: agentEventsFile,
      COMMAND_EVE_REGISTRATION_REQUIRED: '0',
      NODE_ENV: 'development',
    },
    timeout: 180_000,
  });
}

async function closeApp(app: ElectronApplication | null): Promise<void> {
  if (!app) return;
  try {
    await app.evaluate(async ({ app: electronApp }) => electronApp.exit(0));
  } catch {
    // The app may already be closed after a failed assertion.
  }
  await app.close().catch(() => {});
}

async function ensureBackendReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __backendPort?: number }).__backendPort === 'number',
    undefined,
    { timeout: 60_000 }
  );
}

async function openConversation(page: Page, conversationId: string): Promise<void> {
  const baseUrl = page.url().split('#')[0];
  await page.goto(`${baseUrl}#/conversation/${conversationId}`);
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator(`[id="eve-chat-pane-${conversationId}"]`)).toHaveCount(1);
  await expect(page.getByTestId('message-list-scroller')).toBeVisible({ timeout: 30_000 });
}

async function openKanbanWorkbench(page: Page): Promise<void> {
  const launcher = page.getByRole('button', { name: /Open workbench|Arbeitsfläche öffnen/i });
  await expect(launcher).toBeVisible({ timeout: 30_000 });
  await launcher.click();
  const entry = page
    .getByRole('menuitem')
    .filter({ hasText: /Tasks|Aufgaben/i })
    .first();
  await expect(entry).toBeVisible({ timeout: 10_000 });
  await entry.click();
  await expect(page.getByTestId('native-kanban-board')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-testid^="native-kanban-column-"]')).toHaveCount(8);
  await expect(page.getByTestId('native-computer-use-panel')).toBeVisible();
}

async function persistedKanbanTab(page: Page, conversationId: string): Promise<PersistedTab | null> {
  return page.evaluate((expectedConversationId) => {
    try {
      const parsed = JSON.parse(localStorage.getItem('aionui_preview_tabs') || '[]') as PersistedTab[];
      return (
        parsed.find(
          (tab) => tab.content_type === 'kanban' && tab.metadata?.conversation_id === expectedConversationId
        ) ?? null
      );
    } catch {
      return null;
    }
  }, conversationId);
}

test.describe.serial('Command EVE native public Kanban', () => {
  test.setTimeout(480_000);

  test.beforeAll(async () => {
    await closeSharedElectronAppForIsolatedSpec();
    scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-native-kanban-e2e-'));
    isolatedHomeDir = path.join(scratchRoot, 'home');
    isolatedUserDataDir = path.join(scratchRoot, 'user-data');
    emptyExtensionsDir = path.join(scratchRoot, 'extensions');
    workspaceDir = path.join(scratchRoot, 'workspace');
    tempDir = path.join(scratchRoot, 'tmp');
    extensionStatesFile = path.join(scratchRoot, 'extension-states.json');
    agentEventsFile = path.join(scratchRoot, 'agent-events.jsonl');
    for (const directory of [isolatedHomeDir, isolatedUserDataDir, emptyExtensionsDir, workspaceDir, tempDir]) {
      fs.mkdirSync(directory, { recursive: true });
    }
    fs.writeFileSync(agentEventsFile, '');
  });

  test.afterAll(() => {
    if (scratchRoot) fs.rmSync(scratchRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test('creates, edits, moves and restores one canonical card beside one chat', async () => {
    let app: ElectronApplication | null = null;
    let page: Page | null = null;
    try {
      app = await launchApp();
      page = await resolveMainWindow(app);
      await ensureBackendReady(page);

      const conversation = await httpPost<Conversation>(page, '/api/conversations', {
        type: 'acp',
        name: 'Native Kanban E2E',
        extra: {
          workspace: workspaceDir,
          custom_workspace: true,
          backend: 'codex',
          session_mode: 'full-access',
        },
      });
      expect(conversation.id).toBeTruthy();
      await openConversation(page, conversation.id);
      await openKanbanWorkbench(page);

      const createdTitle = `Native durable goal ${Date.now().toString(36)}`;
      const editedTitle = `${createdTitle} edited`;
      await page.getByTestId('native-kanban-create').click();
      await page.getByTestId('native-kanban-create-title').fill(createdTitle);
      await page.getByTestId('native-kanban-create-body').fill('Provider-free restart proof');
      await page.getByTestId('native-kanban-create-kind').click();
      await page
        .locator('.arco-select-option')
        .filter({ hasText: /Goal|Ziel/i })
        .first()
        .click();
      await page.locator('.arco-modal:visible').last().locator('.arco-btn-primary').click();

      const createdCard = page.locator('article').filter({ hasText: createdTitle }).first();
      await expect(createdCard).toBeVisible({ timeout: 30_000 });
      await expect(createdCard).toHaveAttribute('data-record-kind', 'goal');
      const taskTestId = await createdCard.getAttribute('data-testid');
      expect(taskTestId).toMatch(/^native-kanban-task-t_/);
      const taskId = String(taskTestId).replace('native-kanban-task-', '');

      await page.getByTestId(`native-kanban-edit-${taskId}`).click();
      await page.getByTestId('native-kanban-edit-title').fill(editedTitle);
      await page.locator('.arco-modal:visible').last().locator('.arco-btn-primary').click();
      await expect(page.getByTestId(`native-kanban-task-${taskId}`)).toContainText(editedTitle, { timeout: 30_000 });

      await page.getByTestId(`native-kanban-move-${taskId}`).click();
      await page
        .locator('.arco-select-option')
        .filter({ hasText: /To do|Zu tun/i })
        .first()
        .click();
      await expect(
        page.getByTestId('native-kanban-column-todo').getByTestId(`native-kanban-task-${taskId}`)
      ).toBeVisible({
        timeout: 30_000,
      });

      let tabId = '';
      await expect
        .poll(async () => {
          const tab = await persistedKanbanTab(page as Page, conversation.id);
          tabId = typeof tab?.id === 'string' ? tab.id : '';
          return tabId;
        })
        .toMatch(/^kanban-/);

      await closeApp(app);
      app = null;
      page = null;

      app = await launchApp();
      page = await resolveMainWindow(app);
      await ensureBackendReady(page);
      await openConversation(page, conversation.id);

      await expect.poll(async () => (await persistedKanbanTab(page as Page, conversation.id))?.id).toBe(tabId);
      await openKanbanWorkbench(page);
      await expect(
        page.getByTestId('native-kanban-column-todo').getByTestId(`native-kanban-task-${taskId}`)
      ).toContainText(editedTitle, { timeout: 60_000 });
      await expect.poll(async () => (await persistedKanbanTab(page as Page, conversation.id))?.id).toBe(tabId);

      const messages = await httpGet<MessageList>(
        page,
        `/api/conversations/${encodeURIComponent(conversation.id)}/messages?limit=20&content_mode=full`
      );
      expect(messages.items).toHaveLength(0);
      await expect(page.locator(`[id="eve-chat-pane-${conversation.id}"]`)).toHaveCount(1);
    } finally {
      await closeApp(app);
    }
  });
});
