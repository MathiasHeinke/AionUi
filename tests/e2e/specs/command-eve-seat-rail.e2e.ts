import { expect, test, type ElectronApplication, type Page, _electron as electron } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeSharedElectronAppForIsolatedSpec } from '../fixtures';
import { invokeBridge } from '../helpers/bridge/invoke';
import { httpDelete, httpPost } from '../helpers/httpBridge';

const CLIENT_SEAT_ID = '5f22e4d4-7c85-4f9d-bcc3-4d4f8ad8b781';
const FORBIDDEN_SEAT_ID = '2b7b7997-fc92-4f77-a801-85ee34f33fe7';
const FOUNDER_SEAT_ID = 'seat-1';
const ENABLED_CONVERSATION_KEY = 'aionui:e2e-message-stream-conversation-id';

const projectRoot = path.resolve(__dirname, '../../..');
const mainEntry = path.join(projectRoot, 'out', 'main', 'index.js');
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-seat-rail-e2e-'));
const isolatedHomeDir = path.join(scratchRoot, 'home');
const isolatedUserDataDir = path.join(scratchRoot, 'user-data');
const emptyExtensionsDir = path.join(scratchRoot, 'extensions');
const workspaceDir = path.join(scratchRoot, 'workspace');
const tempDir = path.join(scratchRoot, 'tmp');
const extensionStatesFile = path.join(scratchRoot, 'extension-states.json');
const agentEventsFile = path.join(scratchRoot, 'agent-events.jsonl');

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

type CreatedConversation = {
  id: string;
};

type SeatRailStreamController = {
  beginGenerating: () => void;
  clearGenerating: () => void;
};

type StreamRegistry = {
  controllers: Record<string, SeatRailStreamController>;
};

type SwitchSeatEnvelope = {
  success?: boolean;
  data?: {
    ok?: boolean;
    reason_code?: string;
    active_seat_id?: string;
  };
};

function resolveExactBackendBinary(): string | null {
  const candidate = process.env.AIONUI_BACKEND_BINARY?.trim();
  if (!candidate) return null;
  if (!path.isAbsolute(candidate)) {
    throw new Error('AIONUI_BACKEND_BINARY must be absolute for SeatRail lifecycle evidence.');
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
      throw new Error('Failed to resolve the main renderer window for SeatRail lifecycle evidence.');
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

function resolvePackagedExecutable(): string | null {
  const candidate = process.env.COMMAND_EVE_E2E_PACKAGED_EXECUTABLE?.trim();
  if (!candidate) return null;
  if (!path.isAbsolute(candidate)) {
    throw new Error('COMMAND_EVE_E2E_PACKAGED_EXECUTABLE must be absolute.');
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(candidate);
  } catch (error) {
    throw new Error(`COMMAND_EVE_E2E_PACKAGED_EXECUTABLE does not exist: ${candidate}`, { cause: error });
  }
  if (!stat.isFile()) {
    throw new Error(`COMMAND_EVE_E2E_PACKAGED_EXECUTABLE is not a file: ${candidate}`);
  }
  if (process.platform !== 'win32') {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
    } catch (error) {
      throw new Error(`COMMAND_EVE_E2E_PACKAGED_EXECUTABLE is not executable: ${candidate}`, { cause: error });
    }
  }

  return candidate;
}

async function launchSeatRailApp(backendBinary: string): Promise<ElectronApplication> {
  const packagedExecutable = resolvePackagedExecutable();
  if (!packagedExecutable && !fs.existsSync(mainEntry)) {
    throw new Error(`Built main bundle not found: ${mainEntry}\nRun \`bun run package\` before the SeatRail E2E.`);
  }

  const launchArgs = packagedExecutable
    ? [`--user-data-dir=${isolatedUserDataDir}`]
    : ['.', `--user-data-dir=${isolatedUserDataDir}`];
  if (packagedExecutable && process.platform === 'darwin') {
    launchArgs.push('--use-mock-keychain');
  }
  if (process.platform === 'linux' && process.env.CI) {
    launchArgs.push('--no-sandbox');
  }

  return electron.launch({
    ...(packagedExecutable ? { executablePath: packagedExecutable } : {}),
    args: launchArgs,
    cwd:
      packagedExecutable && process.platform === 'darwin'
        ? path.resolve(path.dirname(packagedExecutable), '../../..')
        : packagedExecutable
          ? path.dirname(packagedExecutable)
          : projectRoot,
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
      ...(packagedExecutable ? { COMMAND_EVE_E2E_PACKAGED_ATTACHMENT: '1' } : {}),
      COMMAND_EVE_AGENT_EVENTS_PATH: agentEventsFile,
      COMMAND_EVE_E2E_SEAT_ROSTER: 'founder-client',
      COMMAND_EVE_REGISTRATION_REQUIRED: '0',
      NODE_ENV: packagedExecutable ? 'production' : 'development',
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

async function createAcpConversation(page: Page): Promise<string> {
  const conversation = await httpPost<CreatedConversation>(page, '/api/conversations', {
    type: 'acp',
    name: `E2E SeatRail running-turn guard ${Date.now()}`,
    extra: {
      workspace: workspaceDir,
      custom_workspace: true,
      backend: 'codex',
      session_mode: 'full-access',
    },
  });

  if (!conversation?.id) {
    throw new Error('POST /api/conversations succeeded but did not return a conversation id');
  }

  return conversation.id;
}

async function openConversationWithInjector(page: Page, conversationId: string): Promise<void> {
  await page.evaluate(
    ({ currentConversationId, storageKey }) => {
      window.sessionStorage.setItem(storageKey, currentConversationId);
    },
    { currentConversationId: conversationId, storageKey: ENABLED_CONVERSATION_KEY }
  );

  const baseUrl = page.url().split('#')[0];
  await page.goto(`${baseUrl}#/conversation/${conversationId}`);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('[data-testid="message-list-scroller"]', { timeout: 30_000 });
  await page.waitForFunction(
    (id) => {
      const registry = (
        window as typeof window & {
          __AIONUI_E2E_MESSAGE_STREAM__?: StreamRegistry;
        }
      ).__AIONUI_E2E_MESSAGE_STREAM__;
      return Boolean(registry?.controllers[id]);
    },
    conversationId,
    { timeout: 15_000 }
  );
}

async function beginGenerating(page: Page, conversationId: string): Promise<void> {
  await page.evaluate((id) => {
    const registry = (
      window as typeof window & {
        __AIONUI_E2E_MESSAGE_STREAM__?: StreamRegistry;
      }
    ).__AIONUI_E2E_MESSAGE_STREAM__;
    const controller = registry?.controllers[id];
    if (!controller) {
      throw new Error(`No E2E stream controller registered for conversation ${id}`);
    }
    controller.beginGenerating();
  }, conversationId);
}

async function waitForActiveSeat(page: Page, seatId: string): Promise<void> {
  await expect(page.locator(`[data-testid="seat-rail-seat-${seatId}"]`)).toHaveAttribute('aria-current', 'true', {
    timeout: 120_000,
  });
  await expect(page.locator('[data-testid="seat-rail"]')).not.toHaveAttribute('aria-busy', 'true', {
    timeout: 120_000,
  });
}

test.describe.serial('Command EVE authoritative SeatRail lifecycle', () => {
  test.setTimeout(360_000);

  test.beforeAll(async () => {
    await closeSharedElectronAppForIsolatedSpec();
  });

  test.afterAll(async () => {
    fs.rmSync(scratchRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test('keeps Founder and client navigation visible and preserves the running-turn and membership gates', async () => {
    const backendBinary = resolveExactBackendBinary();
    test.skip(
      !backendBinary,
      'SeatRail lifecycle evidence requires an explicit absolute AIONUI_BACKEND_BINARY; bundled/PATH fallback is forbidden.'
    );

    let app: ElectronApplication | null = null;
    let page: Page | null = null;
    let conversationId: string | null = null;

    try {
      app = await launchSeatRailApp(backendBinary as string);
      page = await resolveMainWindow(app);
      await page.setViewportSize({ width: 1200, height: 800 });
      await ensureBackendReady(page);

      const rail = page.locator('[data-testid="seat-rail"]');
      const founderSeat = page.locator(`[data-testid="seat-rail-seat-${FOUNDER_SEAT_ID}"]`);
      const clientSeat = page.locator(`[data-testid="seat-rail-seat-${CLIENT_SEAT_ID}"]`);
      await expect(rail).toBeVisible({ timeout: 60_000 });
      await expect(founderSeat).toBeVisible();
      await expect(clientSeat).toBeVisible();
      await expect(founderSeat).toHaveAttribute('aria-current', 'true');
      await expect(clientSeat).not.toHaveAttribute('aria-current', 'true');

      await expect(rail).toHaveClass(/command-eve-seat-rail--expanded/);
      await page.locator('[data-testid="seat-rail-toggle"]').click();
      await expect(rail).toHaveClass(/command-eve-seat-rail--collapsed/);
      await page.locator('[data-testid="seat-rail-toggle"]').click();
      await expect(rail).toHaveClass(/command-eve-seat-rail--expanded/);

      conversationId = await createAcpConversation(page);
      await openConversationWithInjector(page, conversationId);
      await beginGenerating(page, conversationId);

      await clientSeat.click();
      const firstModal = page.locator('.arco-modal').filter({ hasText: 'Antwort läuft noch' }).last();
      await expect(firstModal).toBeVisible({ timeout: 15_000 });
      await expect(firstModal).toContainText('Trotzdem wechseln');
      await expect(firstModal).toContainText('Abbrechen');
      await firstModal.getByRole('button', { name: 'Abbrechen' }).click();
      await expect(firstModal).not.toBeVisible();
      await expect(founderSeat).toHaveAttribute('aria-current', 'true');
      await expect(clientSeat).not.toHaveAttribute('aria-current', 'true');

      await clientSeat.click();
      const secondModal = page.locator('.arco-modal').filter({ hasText: 'Antwort läuft noch' }).last();
      await expect(secondModal).toBeVisible({ timeout: 15_000 });
      await secondModal.getByRole('button', { name: 'Trotzdem wechseln' }).click();
      await waitForActiveSeat(page, CLIENT_SEAT_ID);
      await ensureBackendReady(page);

      await founderSeat.click();
      await waitForActiveSeat(page, FOUNDER_SEAT_ID);
      await ensureBackendReady(page);

      const forbidden = await invokeBridge<SwitchSeatEnvelope>(
        page,
        'command-eve.switch-seat',
        { seatId: FORBIDDEN_SEAT_ID },
        30_000
      );
      expect(forbidden.success).toBe(false);
      expect(forbidden.data?.ok).toBe(false);
      expect(forbidden.data?.reason_code).toBe('SWITCH_SEAT_FORBIDDEN');
      expect(forbidden.data?.active_seat_id).toBe(FOUNDER_SEAT_ID);
      await expect(founderSeat).toHaveAttribute('aria-current', 'true');

      await page.setViewportSize({ width: 700, height: 800 });
      await expect(rail).toHaveClass(/command-eve-seat-rail--compact/);
      await expect(founderSeat).toBeVisible();
      await expect(clientSeat).toBeVisible();
      await expect(page.locator('[data-testid="seat-rail-add"]')).toBeVisible();
    } finally {
      if (page && conversationId) {
        await httpDelete(page, `/api/conversations/${encodeURIComponent(conversationId)}`).catch(() => {});
      }
      await closeApp(app);
    }
  });
});
