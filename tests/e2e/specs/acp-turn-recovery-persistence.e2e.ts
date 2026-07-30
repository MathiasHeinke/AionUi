import { expect, test, type ElectronApplication, type Page, _electron as electron } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeSharedElectronAppForIsolatedSpec } from '../fixtures';
import { httpDelete, httpGet, httpPost } from '../helpers/httpBridge';

const PRIVATE_SENTINEL = 'SYNTHETIC_PRIVATE_SENTINEL';
const PUBLIC_ERROR = 'The upstream Agent failed while handling the request';
const SUCCESS_RESPONSE = 'Synthetic recovery reply after manual retry.';
const FIRST_USER_MESSAGE = 'Exercise the synthetic accepted-turn failure.';
const SECOND_USER_MESSAGE = 'Exercise the synthetic manual recovery.';

const projectRoot = path.resolve(__dirname, '../../..');
const mainEntry = path.join(projectRoot, 'out', 'main', 'index.js');
const fixturePath = path.join(projectRoot, 'tests', 'fixtures', 'fake-acp-recovery-cli', 'index.js');
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-acp-turn-recovery-e2e-'));
const isolatedHomeDir = path.join(scratchRoot, 'home');
const isolatedUserDataDir = path.join(scratchRoot, 'user-data');
const emptyExtensionsDir = path.join(scratchRoot, 'extensions');
const workspaceDir = path.join(scratchRoot, 'workspace');
const tempDir = path.join(scratchRoot, 'tmp');
const extensionStatesFile = path.join(scratchRoot, 'extension-states.json');
const agentEventsFile = path.join(scratchRoot, 'agent-events.jsonl');
const promptStateFile = path.join(scratchRoot, 'prompt-count.txt');

for (const directory of [isolatedHomeDir, isolatedUserDataDir, emptyExtensionsDir, workspaceDir, tempDir]) {
  fs.mkdirSync(directory, { recursive: true });
}
fs.writeFileSync(agentEventsFile, '');

process.on('exit', () => {
  try {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

type AgentMetadata = {
  id: string;
  name: string;
  agent_source: string;
  agent_type: string;
};

type Conversation = {
  id: string;
};

type SendMessageResponse = {
  msg_id: string;
  turn_id: string;
};

type MessageResponse = {
  id: string;
  msg_id?: string | null;
  type: string;
  content: unknown;
  position?: string | null;
  status?: string | null;
};

type MessageListResponse = {
  items: MessageResponse[];
};

function resolveExactBackendBinary(): string | null {
  const candidate = process.env.AIONUI_BACKEND_BINARY?.trim();
  if (!candidate) return null;
  if (!path.isAbsolute(candidate)) {
    throw new Error('AIONUI_BACKEND_BINARY must be absolute for ACP recovery evidence.');
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(candidate);
  } catch (error) {
    throw new Error(`AIONUI_BACKEND_BINARY does not exist: ${candidate}`, { cause: error });
  }
  if (!stat.isFile()) {
    throw new Error(`AIONUI_BACKEND_BINARY is not a file: ${candidate}`);
  }
  if (process.platform !== 'win32') {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
    } catch (error) {
      throw new Error(`AIONUI_BACKEND_BINARY is not executable: ${candidate}`, { cause: error });
    }
  }

  return candidate;
}

function isDevToolsWindow(page: Page): boolean {
  return page.url().startsWith('devtools://');
}

async function resolveMainWindow(electronApp: ElectronApplication): Promise<Page> {
  const existing = electronApp.windows().find((window) => !isDevToolsWindow(window));
  if (existing) {
    await existing.waitForLoadState('domcontentloaded');
    return existing;
  }

  const resolveWindowBefore = async (deadline: number): Promise<Page> => {
    if (Date.now() >= deadline) {
      throw new Error('Failed to resolve the main renderer window for ACP recovery evidence.');
    }

    const window = await electronApp.waitForEvent('window', { timeout: 1_000 }).catch(() => null);
    if (window && !isDevToolsWindow(window)) {
      await window.waitForLoadState('domcontentloaded');
      return window;
    }

    return resolveWindowBefore(deadline);
  };

  return resolveWindowBefore(Date.now() + 180_000);
}

async function ensureBackendReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const win = window as unknown as { __backendPort?: number };
      return typeof win.__backendPort === 'number' && win.__backendPort > 0;
    },
    undefined,
    { timeout: 60_000 }
  );
}

async function launchRecoveryApp(backendBinary: string): Promise<ElectronApplication> {
  if (!fs.existsSync(mainEntry)) {
    throw new Error(`Built main bundle not found: ${mainEntry}\nRun \`bun run package\` before the ACP recovery E2E.`);
  }
  if (!fs.existsSync(fixturePath)) {
    throw new Error(`ACP recovery fixture not found: ${fixturePath}`);
  }

  const launchArgs = ['.', `--user-data-dir=${isolatedUserDataDir}`];
  if (process.platform === 'linux' && process.env.CI) {
    launchArgs.push('--no-sandbox');
  }

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
    // The process may already have exited after a failed assertion.
  }
  await app.close().catch(() => {});
}

function readPromptCount(): number {
  try {
    const count = Number.parseInt(fs.readFileSync(promptStateFile, 'utf8').trim(), 10);
    return Number.isSafeInteger(count) ? count : 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

async function listMessages(page: Page, conversationId: string): Promise<MessageResponse[]> {
  const response = await httpGet<MessageListResponse>(
    page,
    `/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=100&content_mode=full`
  );
  return response.items;
}

function parseTipContent(message: MessageResponse): Record<string, unknown> | null {
  if (message.type !== 'tips') return null;
  if (message.content && typeof message.content === 'object' && !Array.isArray(message.content)) {
    return message.content as Record<string, unknown>;
  }
  if (typeof message.content !== 'string') return null;

  try {
    const parsed = JSON.parse(message.content) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function messageText(message: MessageResponse): string {
  if (typeof message.content === 'string') return message.content;
  if (!message.content || typeof message.content !== 'object' || Array.isArray(message.content)) return '';
  const content = (message.content as Record<string, unknown>).content;
  return typeof content === 'string' ? content : '';
}

function assertPrivateSentinelAbsent(messages: MessageResponse[]): void {
  expect(JSON.stringify(messages)).not.toContain(PRIVATE_SENTINEL);
}

function isStructuredTerminalErrorTip(message: MessageResponse): boolean {
  const content = parseTipContent(message);
  return (
    message.type === 'tips' &&
    message.position === 'left' &&
    message.status === 'error' &&
    content?.type === 'error' &&
    content.error !== null &&
    typeof content.error === 'object'
  );
}

function assertFailedLogicalTurnHistory(messages: MessageResponse[]): void {
  const acceptedUserRows = messages.filter(
    (message) => message.type === 'text' && message.position === 'right' && messageText(message) === FIRST_USER_MESSAGE
  );
  expect(acceptedUserRows).toHaveLength(1);

  const assistantRows = messages.filter((message) => message.type === 'text' && message.position === 'left');
  expect(assistantRows).toHaveLength(0);

  const errorTips = messages.filter(isStructuredTerminalErrorTip);
  expect(errorTips).toHaveLength(1);

  const tip = parseTipContent(errorTips[0]);
  expect(tip).toMatchObject({
    content: PUBLIC_ERROR,
    type: 'error',
    error: {
      message: PUBLIC_ERROR,
      code: 'UNKNOWN_UPSTREAM_ERROR',
      ownership: 'unknown_upstream',
      retryable: true,
    },
  });
  expect(tip).not.toHaveProperty('source');
  const structuredError = tip?.error;
  expect(structuredError && typeof structuredError === 'object' ? structuredError.detail : null).toBeNull();
  assertPrivateSentinelAbsent(messages);
}

async function openConversation(page: Page, conversationId: string): Promise<void> {
  const baseUrl = page.url().split('#')[0];
  await page.goto(`${baseUrl}#/conversation/${conversationId}`);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('[data-testid="message-list-scroller"]', { timeout: 30_000 });
}

test.describe.serial('Synthetic generic ACP accepted-turn recovery', () => {
  test.setTimeout(360_000);

  test.beforeAll(async () => {
    await closeSharedElectronAppForIsolatedSpec();
  });

  test.afterAll(async () => {
    fs.rmSync(scratchRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test('persists one safe terminal error across relaunch and recovers on a manual turn', async () => {
    const backendBinary = resolveExactBackendBinary();
    test.skip(
      !backendBinary,
      'Synthetic ACP recovery evidence requires an explicit absolute AIONUI_BACKEND_BINARY; bundled/PATH fallback is forbidden.'
    );

    let app: ElectronApplication | null = null;
    let page: Page | null = null;
    let conversationId: string | null = null;
    let agentId: string | null = null;

    try {
      app = await launchRecoveryApp(backendBinary as string);
      page = await resolveMainWindow(app);
      await ensureBackendReady(page);

      const agent = await httpPost<AgentMetadata>(page, '/api/agents/custom', {
        name: 'E2E Recovery ACP',
        command: process.execPath,
        args: [fixturePath],
        env: [{ name: 'E2E_ACP_STATE_FILE', value: promptStateFile }],
      });
      expect(agent).toMatchObject({
        name: 'E2E Recovery ACP',
        agent_source: 'custom',
        agent_type: 'acp',
      });
      expect(agent.id).toBeTruthy();
      agentId = agent.id;
      expect(readPromptCount()).toBe(0);

      const conversation = await httpPost<Conversation>(page, '/api/conversations', {
        type: 'acp',
        name: 'E2E ACP accepted-turn recovery',
        extra: {
          workspace: workspaceDir,
          custom_workspace: true,
          backend: 'acp',
          agent_name: agent.name,
          agent_id: agent.id,
        },
      });
      expect(conversation.id).toBeTruthy();
      conversationId = conversation.id;

      const firstSend = await httpPost<SendMessageResponse>(
        page,
        `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
        { content: FIRST_USER_MESSAGE }
      );
      expect(firstSend.msg_id).toBeTruthy();
      expect(firstSend.turn_id).toBeTruthy();

      await expect
        .poll(() => readPromptCount(), {
          timeout: 60_000,
          message: 'Waiting for the clean failure and one automatic ACP replay',
        })
        .toBe(2);

      let firstHistory: MessageResponse[] = [];
      await expect
        .poll(
          async () => {
            firstHistory = await listMessages(page as Page, conversationId as string);
            return firstHistory.filter(isStructuredTerminalErrorTip).length;
          },
          { timeout: 60_000, message: 'Waiting for exactly one durable public terminal error tip' }
        )
        .toBe(1);
      assertFailedLogicalTurnHistory(firstHistory);

      await openConversation(page, conversationId);
      const renderedTip = page.locator('[data-testid="message-tips-left"]').last();
      await expect(renderedTip).toBeVisible({ timeout: 30_000 });
      await expect(renderedTip).toContainText(PUBLIC_ERROR);
      await expect(page.locator('body')).not.toContainText(PRIVATE_SENTINEL);

      await closeApp(app);
      app = null;
      page = null;

      app = await launchRecoveryApp(backendBinary as string);
      page = await resolveMainWindow(app);
      await ensureBackendReady(page);

      const reloadedHistory = await listMessages(page, conversationId);
      assertFailedLogicalTurnHistory(reloadedHistory);
      expect(readPromptCount()).toBe(2);

      await openConversation(page, conversationId);
      await expect(
        page.locator('[data-testid="message-text-right"]').filter({ hasText: FIRST_USER_MESSAGE })
      ).toHaveCount(1);
      await expect(page.locator('[data-testid="message-tips-left"]')).toHaveCount(1);
      await expect(page.locator('[data-testid="message-tips-left"]').last()).toContainText(PUBLIC_ERROR);
      await expect(page.locator('body')).not.toContainText(PRIVATE_SENTINEL);

      const secondSend = await httpPost<SendMessageResponse>(
        page,
        `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
        { content: SECOND_USER_MESSAGE }
      );
      expect(secondSend.msg_id).toBeTruthy();
      expect(secondSend.turn_id).toBeTruthy();

      await expect
        .poll(() => readPromptCount(), {
          timeout: 60_000,
          message: 'Waiting for the manual follow-up prompt after relaunch',
        })
        .toBe(3);

      let recoveredHistory: MessageResponse[] = [];
      await expect
        .poll(
          async () => {
            recoveredHistory = await listMessages(page as Page, conversationId as string);
            return recoveredHistory.filter(
              (message) =>
                message.type === 'text' && message.position === 'left' && messageText(message) === SUCCESS_RESPONSE
            ).length;
          },
          { timeout: 60_000, message: 'Waiting for the successful manual recovery response' }
        )
        .toBe(1);

      expect(
        recoveredHistory.filter(
          (message) =>
            message.type === 'text' && message.position === 'right' && messageText(message) === SECOND_USER_MESSAGE
        )
      ).toHaveLength(1);
      expect(recoveredHistory.filter(isStructuredTerminalErrorTip)).toHaveLength(1);
      assertPrivateSentinelAbsent(recoveredHistory);

      await page.reload({ waitUntil: 'domcontentloaded' });
      await ensureBackendReady(page);
      await openConversation(page, conversationId);
      const renderedRecovery = page.locator('[data-testid="message-text-left"]');
      await expect(renderedRecovery).toHaveCount(1);
      await expect
        .poll(
          async () =>
            page.evaluate(() => {
              const message = document.querySelector('[data-testid="message-text-left"]');
              const markdown = message?.querySelector('.markdown-shadow');
              return markdown?.shadowRoot?.textContent?.trim() ?? message?.textContent?.trim() ?? '';
            }),
          { timeout: 30_000, message: 'Waiting for the rendered recovery response inside the Markdown shadow root' }
        )
        .toContain(SUCCESS_RESPONSE);
      await expect(page.locator('body')).not.toContainText(PRIVATE_SENTINEL);
    } finally {
      if (page && conversationId) {
        await httpDelete(page, `/api/conversations/${encodeURIComponent(conversationId)}`).catch(() => {});
      }
      if (page && agentId) {
        await httpDelete(page, `/api/agents/custom/${encodeURIComponent(agentId)}`).catch(() => {});
      }
      await closeApp(app);
    }
  });
});
