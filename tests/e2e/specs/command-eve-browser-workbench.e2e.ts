import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { _electron as electron, type ElectronApplication } from 'playwright';
import { WebSocket } from 'ws';

import { closeSharedElectronAppForIsolatedSpec, expect, test } from '../fixtures';
import { goToGuid } from '../helpers';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(__dirname, '../../..');
const fixtureHtml = fs.readFileSync(path.join(projectRoot, 'tests/e2e/assets/browser-workbench.html'));
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-browser-workbench-e2e-'));
const workspaceDir = path.join(scratchRoot, 'workspace');
fs.mkdirSync(workspaceDir, { recursive: true });

let fixtureServer: Server | null = null;
let fixtureUrl = '';
const fixtureRequests: string[] = [];

type BrowserRuntimeContext = {
  schema_version: 'command-eve-browser-use-runtime/v1';
  context_id: string;
  control_epoch: string;
  daemon_name: string;
  cdp_url: string;
  runtime_dir: string;
  tmp_dir: string;
};

type PackagedRestartContract = {
  executablePath: string;
  cwd: string;
  userDataDir: string;
  env: Record<string, string>;
};

function readBrowserRuntimeContext(contextFile: string): BrowserRuntimeContext {
  const value = JSON.parse(fs.readFileSync(contextFile, 'utf8')) as Partial<BrowserRuntimeContext>;
  if (
    value.schema_version !== 'command-eve-browser-use-runtime/v1' ||
    !value.context_id ||
    !value.control_epoch ||
    !value.daemon_name ||
    !value.cdp_url ||
    !value.runtime_dir ||
    !value.tmp_dir
  ) {
    throw new Error('MAIN browser runtime context file is incomplete');
  }
  return value as BrowserRuntimeContext;
}

async function resolveMainWindow(electronApp: ElectronApplication): Promise<import('@playwright/test').Page> {
  const visible = electronApp.windows().find((candidate) => !candidate.url().startsWith('devtools://'));
  if (visible) return visible;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const candidate = await electronApp.waitForEvent('window', { timeout: 1_000 }).catch(() => null);
    if (candidate && !candidate.url().startsWith('devtools://')) return candidate;
  }
  throw new Error('Packaged restart did not create a main window');
}

async function closeElectronApp(electronApp: ElectronApplication | null): Promise<void> {
  if (!electronApp) return;
  try {
    await electronApp.evaluate(({ app }) => app.exit(0));
  } catch {
    // The app may already be closed after a failing assertion.
  }
  await electronApp.close().catch(() => undefined);
}

async function launchPackagedRestart(
  contract: PackagedRestartContract,
  accountId: string,
  seedId: string
): Promise<{ electronApp: ElectronApplication; page: import('@playwright/test').Page }> {
  const args = [`--user-data-dir=${contract.userDataDir}`];
  if (process.platform === 'darwin') args.push('--use-mock-keychain');
  const electronApp = await electron.launch({
    executablePath: contract.executablePath,
    args,
    cwd: contract.cwd,
    env: {
      ...contract.env,
      AIONUI_E2E_TEST: '1',
      AIONUI_MULTI_INSTANCE: '1',
      AIONUI_CDP_PORT: '0',
      AIONUI_DISABLE_AUTO_UPDATE: '1',
      AIONUI_DISABLE_DEVTOOLS: '1',
      COMMAND_EVE_E2E_PACKAGED_ATTACHMENT: '1',
      COMMAND_EVE_REGISTRATION_REQUIRED: '0',
      COMMAND_EVE_E2E_BROWSER_ACCOUNT_ID: accountId,
      COMMAND_EVE_E2E_BROWSER_SEED_ID: seedId,
      NODE_ENV: 'production',
    },
    timeout: 180_000,
  });
  return { electronApp, page: await resolveMainWindow(electronApp) };
}

async function sendCdpCommand(
  cdpUrl: string,
  request: { id: number; method: string; params?: Record<string, unknown>; sessionId?: string }
): Promise<Record<string, unknown>> {
  const versionResponse = await fetch(`${cdpUrl}/json/version`);
  expect(versionResponse.ok).toBe(true);
  const version = (await versionResponse.json()) as { webSocketDebuggerUrl?: string };
  if (!version.webSocketDebuggerUrl) throw new Error('CDP version response has no WebSocket endpoint');
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP command ${request.method} timed out`)), 10_000);
      socket.on('message', (frame) => {
        const payload = JSON.parse(frame.toString()) as Record<string, unknown>;
        if (payload.id !== request.id) return;
        clearTimeout(timer);
        resolve(payload);
      });
      socket.send(JSON.stringify(request));
    });
  } finally {
    socket.close();
  }
}

async function createConversation(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(
    async ({ workspace }) => {
      const port = (window as typeof window & { __backendPort?: number }).__backendPort;
      if (!port) throw new Error('Command EVE backend port is unavailable');
      const response = await fetch(`http://127.0.0.1:${port}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'acp',
          name: 'Browser Workbench E2E',
          extra: {
            workspace,
            custom_workspace: true,
            backend: 'codex',
            session_mode: 'full-access',
          },
        }),
      });
      if (!response.ok) throw new Error(`Conversation creation failed: ${response.status} ${await response.text()}`);
      const envelope = (await response.json()) as { id?: string; data?: { id?: string } };
      const id = envelope.data?.id ?? envelope.id;
      if (!id) throw new Error('Conversation creation returned no id');

      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const readback = await fetch(`http://127.0.0.1:${port}/api/conversations/${id}`);
        if (readback.ok) {
          const readEnvelope = (await readback.json()) as { id?: string; data?: { id?: string } };
          if ((readEnvelope.data?.id ?? readEnvelope.id) === id) return id;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`Conversation ${id} was not readable after creation`);
    },
    { workspace: workspaceDir }
  );
}

async function openConversationRoute(page: import('@playwright/test').Page, conversationId: string): Promise<void> {
  // A packaged cold start can expose the backend bridge before React Router has
  // finished its first route mount. Enter the canonical new-chat route first,
  // then require the actual single-chat pane instead of treating a hash write as
  // UI readiness.
  await goToGuid(page);
  await page.evaluate((id) => window.location.assign(`#/conversation/${id}`), conversationId);
  await page.waitForFunction((id) => window.location.hash === `#/conversation/${id}`, conversationId, {
    timeout: 30_000,
  });
  await page.locator(`#eve-chat-pane-${conversationId}`).waitFor({ state: 'attached', timeout: 120_000 });
}

async function revealBrowserWorkbench(page: import('@playwright/test').Page): Promise<void> {
  const visibleTab = page.getByRole('tab', { name: 'Browser' }).first();
  if (await visibleTab.isVisible().catch(() => false)) {
    await visibleTab.click();
    return;
  }
  const launcher = page.locator(
    '[data-testid="eve-workbench-tabs"][data-launcher-only="true"] button[aria-haspopup="menu"]'
  );
  await launcher.click({ timeout: 120_000 });
  await page.getByRole('menuitem', { name: /^Browser$/ }).click();
  await page.locator('.aion-url-viewer-toolbar--workbench .toolbar-input').waitFor({ state: 'visible' });
}

async function waitForVisibleTarget(cdpUrl: string, expectedUrl = fixtureUrl): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${cdpUrl}/json/list`);
    const targets = (await response.json()) as Array<Record<string, unknown>>;
    if (targets.length === 1 && targets[0]?.url === expectedUrl) return targets[0];
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('The EVE CDP bridge never advertised the visible workbench browser');
}

function boxesOverlap(
  a: NonNullable<Awaited<ReturnType<import('@playwright/test').Locator['boundingBox']>>>,
  b: typeof a
) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

async function invokeRendererBridge<T>(
  page: import('@playwright/test').Page,
  providerKey: string,
  data?: unknown
): Promise<T> {
  return page.evaluate(
    async ({ key, bridgeData }) => {
      if (!window.electronAPI?.emit) throw new Error('Electron renderer bridge is unavailable');
      const id = `${key}${Date.now().toString(16).slice(-8)}`;
      const callbackName = `subscribe.callback-${key}${id}`;
      const envelope = bridgeData === undefined ? { id } : { id, data: bridgeData };
      return await new Promise<T>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error(`Provider ${key} did not answer`)), 10_000);
        const off = window.electronAPI!.on((event) => {
          try {
            const payload = JSON.parse(event.value) as { name?: string; data?: T };
            if (payload.name !== callbackName) return;
            window.clearTimeout(timer);
            if (typeof off === 'function') off();
            resolve(payload.data as T);
          } catch {
            // Ignore unrelated bridge events.
          }
        }) as unknown as (() => void) | undefined;
        void window.electronAPI!.emit(`subscribe-${key}`, envelope);
      });
    },
    { key: providerKey, bridgeData: data }
  );
}

async function runBrowserUse(
  hermesPython: string,
  hermesRoot: string,
  contextFile: string,
  browserUseCode: string
): Promise<string> {
  const runtime = readBrowserRuntimeContext(contextFile);
  const pythonProgram = [
    'from tools.browser_use_cli import browser_exec',
    `code = ${JSON.stringify(browserUseCode)}`,
    'print(browser_exec(code, task_id="eve-browser-workbench-e2e"))',
  ].join('\n');

  try {
    const proof = await execFileAsync(hermesPython, ['-c', pythonProgram], {
      cwd: hermesRoot,
      env: {
        ...process.env,
        COMMAND_EVE_BROWSER_CONTEXT_FILE: contextFile,
      },
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return proof.stdout;
  } finally {
    await execFileAsync('uvx', ['browser-use==0.13.7', '--reload'], {
      env: {
        ...process.env,
        BU_CDP_URL: runtime.cdp_url,
        BU_NAME: runtime.daemon_name,
        BH_RUNTIME_DIR: runtime.runtime_dir,
        BH_TMP_DIR: runtime.tmp_dir,
      },
      timeout: 30_000,
    }).catch(() => undefined);
  }
}

test.describe.serial('Command EVE browser, desktop and sidecar workbench', () => {
  test.setTimeout(900_000);

  test.beforeAll(async () => {
    fixtureRequests.length = 0;
    fixtureServer = http.createServer((request, response) => {
      fixtureRequests.push(request.url ?? '');
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': fixtureHtml.byteLength,
        'Cache-Control': 'no-store',
      });
      response.end(fixtureHtml);
    });
    await new Promise<void>((resolve, reject) => {
      fixtureServer!.once('error', reject);
      fixtureServer!.listen(0, '127.0.0.1', resolve);
    });
    const address = fixtureServer.address() as AddressInfo;
    fixtureUrl = `http://127.0.0.1:${address.port}/browser-workbench.html`;
  });

  test.afterAll(async () => {
    if (fixtureServer) await new Promise<void>((resolve) => fixtureServer!.close(() => resolve()));
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  });

  test('keeps one chat beside the workbench and lets official Hermes Browser Use drive the visible tab', async ({
    electronApp,
    page,
  }, testInfo) => {
    const hermesRoot = process.env.COMMAND_EVE_HERMES_SOURCE_ROOT?.trim();
    const hermesPython = process.env.COMMAND_EVE_HERMES_PYTHON?.trim();
    test.skip(!hermesRoot || !hermesPython, 'Set COMMAND_EVE_HERMES_SOURCE_ROOT and COMMAND_EVE_HERMES_PYTHON.');
    if (!hermesRoot || !hermesPython) return;

    await page.waitForFunction(
      () => Number((window as typeof window & { __backendPort?: number }).__backendPort) > 0,
      undefined,
      { timeout: 180_000 }
    );
    const contextPreflight = await invokeRendererBridge<{
      success: boolean;
      msg?: string;
      data?: { context_id: string; persistent: boolean };
    }>(page, 'app.get-browser-context');
    expect(contextPreflight.success, contextPreflight.msg).toBe(true);
    expect(contextPreflight.data?.persistent).toBe(true);
    const conversationId = await createConversation(page);
    await openConversationRoute(page, conversationId);

    await revealBrowserWorkbench(page);

    const addressInput = page.locator('.aion-url-viewer-toolbar--workbench .toolbar-input');
    await addressInput.waitFor({ state: 'visible', timeout: 30_000 });
    await addressInput.fill(fixtureUrl);
    await page.waitForTimeout(250);
    await addressInput.press('Enter');

    const mainState = await electronApp.evaluate(() => ({
      cdpUrl: process.env.BROWSER_CDP_URL ?? '',
      contextFile: process.env.COMMAND_EVE_BROWSER_CONTEXT_FILE ?? '',
      appWidePort: process.env.AIONUI_CDP_PORT ?? '',
    }));
    expect(mainState.cdpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/session\/[a-f0-9]{48}$/);
    expect(path.isAbsolute(mainState.contextFile)).toBe(true);
    const runtimeContext = readBrowserRuntimeContext(mainState.contextFile);
    expect(runtimeContext.cdp_url).toBe(mainState.cdpUrl);
    expect(runtimeContext.control_epoch).toMatch(/^[a-f0-9]{32}$/);
    if (process.platform !== 'win32') {
      expect(fs.statSync(mainState.contextFile).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(mainState.contextFile)).mode & 0o777).toBe(0o700);
    }
    expect(mainState.appWidePort).toBe('0');
    const visibleTarget = await waitForVisibleTarget(mainState.cdpUrl);
    expect(visibleTarget.type).toBe('page');
    expect(visibleTarget.url).toBe(fixtureUrl);

    const chat = page.locator(`#eve-chat-pane-${conversationId}`);
    const workbench = page.locator(`#eve-workbench-pane-${conversationId}`);
    const toolbar = page.locator('.aion-url-viewer-toolbar--workbench');
    const tabbar = page.locator('.eve-workbench-pane__tabbar');
    const workbenchLauncher = tabbar.locator('button[aria-haspopup="menu"]');
    const [chatBox, workbenchBox, toolbarBox, addressBox, tabbarBox, launcherBox] = await Promise.all([
      chat.boundingBox(),
      workbench.boundingBox(),
      toolbar.boundingBox(),
      addressInput.boundingBox(),
      tabbar.boundingBox(),
      workbenchLauncher.boundingBox(),
    ]);
    for (const box of [chatBox, workbenchBox, toolbarBox, addressBox, tabbarBox, launcherBox])
      expect(box).not.toBeNull();
    expect(chatBox!.width).toBeGreaterThanOrEqual(340);
    expect(chatBox!.x + chatBox!.width).toBeLessThanOrEqual(workbenchBox!.x + 1);
    expect(addressBox!.x).toBeGreaterThanOrEqual(toolbarBox!.x);
    expect(addressBox!.x + addressBox!.width).toBeLessThanOrEqual(toolbarBox!.x + toolbarBox!.width);
    expect(launcherBox!.x).toBeGreaterThanOrEqual(tabbarBox!.x);
    expect(launcherBox!.x + launcherBox!.width).toBeLessThanOrEqual(tabbarBox!.x + tabbarBox!.width);
    await expect(page.locator('[data-testid="eve-workbench-tabs"]:visible')).toHaveCount(1);
    await expect(page.locator(`[id="eve-chat-pane-${conversationId}"]`)).toHaveCount(1);

    const privacyButton = page
      .locator('button[aria-label*="Datenschutz"], button[title*="Datenschutz"], button[aria-label*="Privacy"]')
      .first();
    if ((await privacyButton.count()) > 0 && (await privacyButton.isVisible())) {
      const privacyBox = await privacyButton.boundingBox();
      expect(privacyBox).not.toBeNull();
      expect(boxesOverlap(privacyBox!, launcherBox!)).toBe(false);
    }

    const browserScreenshot = testInfo.outputPath('browser-use-visible-target.png');
    const browserUseCode = [
      'before = page_info()',
      'goto_url(before["url"])',
      'assert wait_for_load()',
      'print({"phase": "open", "info": page_info(), "tabs": list_tabs()})',
      'print({"phase": "read", "copy": js("document.querySelector(\\"#proof-copy\\").textContent")})',
      'input_box = js("(()=>{const r=document.querySelector(\\"#proof-input\\").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()")',
      'click_at_xy(input_box["x"], input_box["y"])',
      'type_text("EVE-CDP-OK")',
      'button = js("(()=>{const r=document.querySelector(\\"#proof-button\\").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()")',
      'click_at_xy(button["x"], button["y"])',
      'print({"phase": "type-click", "value": js("document.querySelector(\\"#proof-input\\").value"), "result": js("document.querySelector(\\"#result\\").textContent")})',
      'viewport = page_info()',
      'scroll(viewport["w"] / 2, viewport["h"] / 2, dy=1500)',
      'wait(0.5)',
      'print({"phase": "scroll", "scroll_y": page_info()["sy"], "marker": js("document.querySelector(\\"#scroll-marker\\").textContent")})',
      `print({"phase": "screenshot", "path": capture_screenshot(${JSON.stringify(browserScreenshot)})})`,
      'close_tab()',
      'print({"phase": "cleanup", "tab": current_tab()})',
    ].join('\n');
    const proofStdout = await runBrowserUse(hermesPython, hermesRoot, mainState.contextFile, browserUseCode);

    expect(proofStdout).toContain('"success": true');
    expect(proofStdout).toContain("'phase': 'open'");
    expect(proofStdout).toContain("'copy': 'Visible EVE CDP target ready.'");
    expect(proofStdout).toContain("'value': 'EVE-CDP-OK'");
    expect(proofStdout).toContain("'result': 'Applied: EVE-CDP-OK'");
    expect(proofStdout).toContain("'marker': 'Scroll marker reached.'");
    expect(fs.existsSync(browserScreenshot)).toBe(true);

    const packageState = await electronApp.evaluate(({ app }) => ({
      isPackaged: app.isPackaged,
      version: app.getVersion(),
    }));
    if (process.env.E2E_PACKAGED === '1') expect(packageState.isPackaged).toBe(true);
    const cliVersion = await execFileAsync('uvx', ['browser-use==0.13.7', '--version'], {
      timeout: 30_000,
    });
    expect(cliVersion.stdout.trim()).toBe('0.1.8');

    const layoutSurface = page.locator('[data-eve-workbench-layout]');
    const layoutGroup = page.locator('[data-testid="eve-workbench-tabs"]:visible [role="group"]');
    const layoutButtons = layoutGroup.locator('button[data-active]');
    await expect(layoutButtons).toHaveCount(4);
    const focusButton = layoutButtons.nth(0);
    const splitLeftButton = layoutButtons.nth(1);
    const splitRightButton = layoutButtons.nth(2);
    const splitBottomButton = layoutButtons.nth(3);
    const singleChat = page.locator(`[id="eve-chat-pane-${conversationId}"]`);
    const browserTab = page.getByRole('tab', { name: 'Browser' });

    await splitRightButton.click();
    await expect(layoutSurface).toHaveAttribute('data-eve-workbench-layout', 'split-right');
    const [rightChatBox, rightWorkbenchBox] = await Promise.all([chat.boundingBox(), workbench.boundingBox()]);
    expect(rightChatBox).not.toBeNull();
    expect(rightWorkbenchBox).not.toBeNull();
    expect(rightChatBox!.width).toBeGreaterThanOrEqual(340);
    expect(rightChatBox!.x + rightChatBox!.width).toBeLessThanOrEqual(rightWorkbenchBox!.x + 1);
    await expect(singleChat).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath('workbench-split-right.png') });

    await splitLeftButton.click();
    await expect(layoutSurface).toHaveAttribute('data-eve-workbench-layout', 'split-left');
    const [leftChatBox, leftWorkbenchBox] = await Promise.all([chat.boundingBox(), workbench.boundingBox()]);
    expect(leftChatBox).not.toBeNull();
    expect(leftWorkbenchBox).not.toBeNull();
    expect(leftChatBox!.width).toBeGreaterThanOrEqual(340);
    expect(leftWorkbenchBox!.x + leftWorkbenchBox!.width).toBeLessThanOrEqual(leftChatBox!.x + 1);
    await expect(singleChat).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath('workbench-split-left.png') });

    await splitBottomButton.click();
    await expect(layoutSurface).toHaveAttribute('data-eve-workbench-layout', 'split-bottom');
    const [bottomChatBox, bottomWorkbenchBox] = await Promise.all([chat.boundingBox(), workbench.boundingBox()]);
    expect(bottomChatBox).not.toBeNull();
    expect(bottomWorkbenchBox).not.toBeNull();
    expect(bottomChatBox!.y + bottomChatBox!.height).toBeLessThanOrEqual(bottomWorkbenchBox!.y + 1);
    await expect(singleChat).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath('workbench-split-bottom.png') });

    await splitRightButton.click();
    await expect(layoutSurface).toHaveAttribute('data-eve-workbench-layout', 'split-right');
    const [dockTabBox, dockSurfaceBox] = await Promise.all([browserTab.boundingBox(), layoutSurface.boundingBox()]);
    expect(dockTabBox).not.toBeNull();
    expect(dockSurfaceBox).not.toBeNull();
    await page.mouse.move(dockTabBox!.x + dockTabBox!.width / 2, dockTabBox!.y + dockTabBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(dockTabBox!.x + dockTabBox!.width / 2 + 12, dockTabBox!.y + dockTabBox!.height / 2 + 4, {
      steps: 3,
    });
    await page.mouse.move(
      dockSurfaceBox!.x + dockSurfaceBox!.width / 2,
      dockSurfaceBox!.y + dockSurfaceBox!.height - 24,
      { steps: 8 }
    );
    const bottomDockTarget = page.locator('[data-testid="eve-workbench-dock-split-bottom"]');
    await expect(bottomDockTarget).toBeVisible();
    const bottomDockBox = await bottomDockTarget.boundingBox();
    expect(bottomDockBox).not.toBeNull();
    await page.mouse.move(bottomDockBox!.x + bottomDockBox!.width / 2, bottomDockBox!.y + bottomDockBox!.height / 2, {
      steps: 4,
    });
    await expect(bottomDockTarget).toHaveAttribute('data-active', 'true');
    await page.mouse.up();
    await expect(layoutSurface).toHaveAttribute('data-eve-workbench-layout', 'split-bottom');
    await page.screenshot({ path: testInfo.outputPath('workbench-drag-docked-bottom.png') });

    await focusButton.click();
    await expect(layoutSurface).toHaveAttribute('data-eve-workbench-layout', 'focus');
    await expect(chat).toBeHidden();
    const [focusSurfaceBox, focusWorkbenchBox] = await Promise.all([
      layoutSurface.boundingBox(),
      workbench.boundingBox(),
    ]);
    expect(focusSurfaceBox).not.toBeNull();
    expect(focusWorkbenchBox).not.toBeNull();
    expect(focusWorkbenchBox!.width).toBeGreaterThanOrEqual(focusSurfaceBox!.width - 2);
    await expect(singleChat).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath('workbench-focus-full-width.png') });

    await splitRightButton.click();
    await expect(layoutSurface).toHaveAttribute('data-eve-workbench-layout', 'split-right');
    await workbenchLauncher.click();
    await page.getByRole('menuitem', { name: /^Terminal$/ }).click();
    const terminal = page.locator('[data-terminal-theme]');
    await terminal.waitFor({ state: 'visible', timeout: 30_000 });
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
      document.body.setAttribute('arco-theme', 'dark');
    });
    await expect(terminal).toHaveAttribute('data-terminal-theme', 'dark');
    await page.screenshot({ path: testInfo.outputPath('workbench-terminal-dark.png') });
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'light');
      document.body.removeAttribute('arco-theme');
    });
    await expect(terminal).toHaveAttribute('data-terminal-theme', 'light');
    await page.screenshot({ path: testInfo.outputPath('workbench-terminal-light.png') });

    await browserTab.click();
    await expect(addressInput).toBeVisible();
    await expect(addressInput).toHaveValue(fixtureUrl);
    await expect(layoutSurface).toHaveAttribute('data-eve-workbench-layout', 'split-right');

    const secretCanary = 'sk-commandevebrowserproof123456789';
    const reconnectScreenshot = testInfo.outputPath('browser-use-reconnect-security.png');
    const reconnectCode = [
      'baseline = page_info()["url"]',
      `secret = ${JSON.stringify(secretCanary)}`,
      'origin = baseline.split("/browser-workbench.html", 1)[0]',
      'blocked_targets = [',
      '    ["file", "file:" + "///tmp/command-eve-browser-proof.txt"],',
      '    ["data", "data:" + "text/html,<h1>blocked</h1>"],',
      '    ["blob", "blob:" + origin + "/command-eve-browser-proof"],',
      '    ["secret-url", baseline + "?api_key=" + secret],',
      ']',
      'assert js("document.querySelector(\\"#proof-input\\").value") == "EVE-CDP-OK"',
      'attempts = {}',
      'for label, target in blocked_targets:',
      '    try:',
      '        result = goto_url(target)',
      '        attempts[label] = {"call": repr(result), "error": None}',
      '    except Exception as exc:',
      '        attempts[label] = {"call": None, "error": type(exc).__name__}',
      '    assert page_info()["url"] == baseline',
      'try:',
      '    js("fetch(" + repr(baseline + "?api_key=" + secret) + ")")',
      '    attempts["secret-fetch"] = {"error": None}',
      'except Exception as exc:',
      '    attempts["secret-fetch"] = {"error": type(exc).__name__}',
      'assert page_info()["url"] == baseline',
      'print({"phase": "reconnect-security", "info": page_info(), "attempts": attempts})',
      `print({"phase": "reconnect-screenshot", "path": capture_screenshot(${JSON.stringify(reconnectScreenshot)})})`,
    ].join('\n');
    const reconnectStdout = await runBrowserUse(hermesPython, hermesRoot, mainState.contextFile, reconnectCode);
    expect(reconnectStdout).toContain('"success": true');
    expect(reconnectStdout).toContain("'phase': 'reconnect-security'");
    expect(reconnectStdout).toContain(`'url': '${fixtureUrl}'`);
    expect(fs.existsSync(reconnectScreenshot)).toBe(true);
    expect(fixtureRequests.some((requestUrl) => requestUrl.includes(secretCanary))).toBe(false);
    await expect(singleChat).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath('workbench-reconnected-browser.png') });

    const oauthUrl = `${new URL(fixtureUrl).origin}/oauth/google`;
    await addressInput.fill(oauthUrl);
    await addressInput.press('Enter');
    await waitForVisibleTarget(mainState.cdpUrl, oauthUrl);
    const oauthCode = [
      'baseline = page_info()["url"]',
      'origin = baseline.split("/oauth/google", 1)[0]',
      'assert js("document.querySelector(\\"#oauth-copy\\").textContent") == "No real Google credentials are used."',
      'continue_box = js("(()=>{const r=document.querySelector(\\"#oauth-continue\\").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()")',
      'click_at_xy(continue_box["x"], continue_box["y"])',
      'assert wait_for_load()',
      'approve_box = js("(()=>{const r=document.querySelector(\\"#oauth-approve\\").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()")',
      'click_at_xy(approve_box["x"], approve_box["y"])',
      'assert wait_for_load()',
      'challenges = {}',
      'for kind, expected in [("mfa", "needs_user:mfa"), ("passkey", "needs_user:passkey"), ("captcha", "needs_user:captcha"), ("risk", "needs_user:risk-challenge")]:',
      '    goto_url(origin + "/oauth/challenge?kind=" + kind)',
      '    assert wait_for_load()',
      '    try:',
      '        click_at_xy(40, 40)',
      '        challenges[kind] = "UNEXPECTED_ALLOW"',
      '    except Exception as exc:',
      '        challenges[kind] = repr(exc)',
      'try:',
      '    js("document." + "cookie")',
      '    raw_profile_read = "UNEXPECTED_ALLOW"',
      'except Exception as exc:',
      '    raw_profile_read = repr(exc)',
      'assert "blocks raw browser credentials" in raw_profile_read',
      'print({"phase": "oauth-needs-user", "challenges": challenges, "raw_profile_read": raw_profile_read})',
    ].join('\n');
    const oauthStdout = await runBrowserUse(hermesPython, hermesRoot, mainState.contextFile, oauthCode);
    expect(oauthStdout).toContain('"success": true');
    expect(oauthStdout).toContain("'phase': 'oauth-needs-user'");
    for (const expected of [
      'needs_user:mfa',
      'needs_user:passkey',
      'needs_user:captcha',
      'needs_user:risk-challenge',
    ]) {
      expect(oauthStdout).toContain(expected);
    }
    expect(fixtureRequests.some((requestUrl) => requestUrl.includes('accounts.google.com'))).toBe(false);

    let packagedPersistenceLog = 'packaged persistence gate skipped in dev mode';
    if (process.env.E2E_PACKAGED === '1') {
      const profileStepOne = `${fixtureUrl}?profile=profile-a&step=one`;
      const profileStepTwo = `${fixtureUrl}?profile=profile-a&step=two`;
      await addressInput.fill(profileStepOne);
      await addressInput.press('Enter');
      await expect(addressInput).toHaveValue(profileStepOne);
      await addressInput.fill(profileStepTwo);
      await addressInput.press('Enter');
      await expect(addressInput).toHaveValue(profileStepTwo);
      await waitForVisibleTarget(mainState.cdpUrl, profileStepTwo);

      const establishProfileCode = [
        'button = js("(()=>{const r=document.querySelector(\\"#establish-profile\\").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()")',
        'click_at_xy(button["x"], button["y"])',
        'status = ""',
        'for _ in range(30):',
        '    status = js("document.querySelector(\\"#profile-status\\").textContent")',
        '    if "cookie=true;localStorage=true;indexedDB=true;cache=true" in status:',
        '        break',
        '    wait(0.2)',
        'assert "cookie=true;localStorage=true;indexedDB=true;cache=true" in status',
        'print({"phase": "profile-established", "status": status})',
      ].join('\n');
      const establishStdout = await runBrowserUse(
        hermesPython,
        hermesRoot,
        mainState.contextFile,
        establishProfileCode
      );
      expect(establishStdout).toContain('"success": true');
      expect(establishStdout).toContain('cookie=true;localStorage=true;indexedDB=true;cache=true');
      await page.waitForTimeout(600);

      const stateBeforeRestart = await invokeRendererBridge<{
        success: boolean;
        msg?: string;
        data?: {
          context_id: string;
          control_epoch: string;
          state: { active_tab_id: string | null; tabs: Array<{ url: string; history: { back: string[] } }> };
        };
      }>(page, 'app.get-browser-context');
      expect(stateBeforeRestart.success, stateBeforeRestart.msg).toBe(true);
      expect(stateBeforeRestart.data?.state.tabs.some((tab) => tab.url === profileStepTwo)).toBe(true);
      expect(stateBeforeRestart.data?.state.tabs.some((tab) => tab.history.back.includes(profileStepOne))).toBe(true);

      const restartContract = await electronApp.evaluate(({ app }) => {
        const env: Record<string, string> = {};
        for (const key of [
          'HOME',
          'PATH',
          'XDG_CONFIG_HOME',
          'XDG_CACHE_HOME',
          'XDG_DATA_HOME',
          'XDG_STATE_HOME',
          'TMPDIR',
          'TMP',
          'TEMP',
          'AIONUI_BACKEND_BINARY',
          'AIONUI_EXTENSIONS_PATH',
          'AIONUI_EXTENSION_STATES_FILE',
          'COMMAND_EVE_ARTIFACT_PYTHON_SITE_DIR',
          'COMMAND_EVE_AGENT_EVENTS_PATH',
        ]) {
          const value = process.env[key];
          if (value) env[key] = value;
        }
        return {
          executablePath: process.execPath,
          cwd: process.cwd(),
          userDataDir: app.getPath('userData'),
          env,
        } satisfies PackagedRestartContract;
      });

      await closeSharedElectronAppForIsolatedSpec();
      let restartedApp: ElectronApplication | null = null;
      try {
        const restarted = await launchPackagedRestart(restartContract, 'account-a', 'seed-a');
        restartedApp = restarted.electronApp;
        const restartedPage = restarted.page;
        await restartedPage.waitForFunction(
          () => Number((window as typeof window & { __backendPort?: number }).__backendPort) > 0,
          undefined,
          { timeout: 180_000 }
        );

        const oldCapabilityResponse = await fetch(`${mainState.cdpUrl}/json/list`).catch(() => null);
        expect(oldCapabilityResponse === null || oldCapabilityResponse.status >= 400).toBe(true);
        const restoredA = await invokeRendererBridge<typeof stateBeforeRestart>(
          restartedPage,
          'app.get-browser-context'
        );
        expect(restoredA.success, restoredA.msg).toBe(true);
        expect(restoredA.data?.context_id).toBe(stateBeforeRestart.data?.context_id);
        expect(restoredA.data?.control_epoch).not.toBe(stateBeforeRestart.data?.control_epoch);
        expect(restoredA.data?.state.tabs.some((tab) => tab.url === profileStepTwo)).toBe(true);

        await openConversationRoute(restartedPage, conversationId);
        await revealBrowserWorkbench(restartedPage);
        const restartedAddress = restartedPage.locator('.aion-url-viewer-toolbar--workbench .toolbar-input');
        await expect(restartedAddress).toHaveValue(profileStepTwo);
        const restartedMain = await restartedApp.evaluate(() => ({
          cdpUrl: process.env.BROWSER_CDP_URL ?? '',
          contextFile: process.env.COMMAND_EVE_BROWSER_CONTEXT_FILE ?? '',
        }));
        await waitForVisibleTarget(restartedMain.cdpUrl, profileStepTwo);
        const restoredProfileStdout = await runBrowserUse(
          hermesPython,
          hermesRoot,
          restartedMain.contextFile,
          [
            'status = ""',
            'for _ in range(30):',
            '    status = js("document.querySelector(\\"#profile-status\\").textContent")',
            '    if "cookie=true;localStorage=true;indexedDB=true;cache=true" in status:',
            '        break',
            '    wait(0.2)',
            'assert "cookie=true;localStorage=true;indexedDB=true;cache=true" in status',
            'print({"phase": "restart-profile-restored", "status": status})',
          ].join('\n')
        );
        expect(restoredProfileStdout).toContain('cookie=true;localStorage=true;indexedDB=true;cache=true');
        await restartedPage.screenshot({ path: testInfo.outputPath('packaged-restart-profile-restored.png') });

        await restartedApp.evaluate(() => {
          process.env.COMMAND_EVE_E2E_BROWSER_ACCOUNT_ID = 'account-b';
          process.env.COMMAND_EVE_E2E_BROWSER_SEED_ID = 'seed-a';
        });
        const contextB = await invokeRendererBridge<typeof stateBeforeRestart>(
          restartedPage,
          'app.get-browser-context'
        );
        expect(contextB.success, contextB.msg).toBe(true);
        expect(contextB.data?.context_id).not.toBe(restoredA.data?.context_id);
        expect(contextB.data?.control_epoch).not.toBe(restoredA.data?.control_epoch);
        expect(contextB.data?.state.tabs).toEqual([]);
        const staleAResponse = await fetch(`${restartedMain.cdpUrl}/json/list`).catch(() => null);
        expect(staleAResponse === null || staleAResponse.status >= 400).toBe(true);

        await restartedPage.reload();
        await openConversationRoute(restartedPage, conversationId);
        await revealBrowserWorkbench(restartedPage);
        const bAddress = restartedPage.locator('.aion-url-viewer-toolbar--workbench .toolbar-input');
        const isolatedProfileUrl = `${fixtureUrl}?profile=profile-a`;
        await bAddress.fill(isolatedProfileUrl);
        await bAddress.press('Enter');
        const contextBMain = await restartedApp.evaluate(() => ({
          cdpUrl: process.env.BROWSER_CDP_URL ?? '',
          contextFile: process.env.COMMAND_EVE_BROWSER_CONTEXT_FILE ?? '',
        }));
        await waitForVisibleTarget(contextBMain.cdpUrl, isolatedProfileUrl);
        const isolatedProfileStdout = await runBrowserUse(
          hermesPython,
          hermesRoot,
          contextBMain.contextFile,
          [
            'status = ""',
            'for _ in range(30):',
            '    status = js("document.querySelector(\\"#profile-status\\").textContent")',
            '    if "checking" not in status:',
            '        break',
            '    wait(0.2)',
            'assert "cookie=false;localStorage=false;indexedDB=false;cache=false" in status',
            'print({"phase": "account-isolated", "status": status})',
          ].join('\n')
        );
        expect(isolatedProfileStdout).toContain('cookie=false;localStorage=false;indexedDB=false;cache=false');

        await restartedApp.evaluate(() => {
          process.env.COMMAND_EVE_E2E_BROWSER_ACCOUNT_ID = 'account-a';
          process.env.COMMAND_EVE_E2E_BROWSER_SEED_ID = 'seed-b';
        });
        const contextOtherSeed = await invokeRendererBridge<typeof stateBeforeRestart>(
          restartedPage,
          'app.get-browser-context'
        );
        expect(contextOtherSeed.success, contextOtherSeed.msg).toBe(true);
        expect(contextOtherSeed.data?.context_id).not.toBe(restoredA.data?.context_id);
        expect(contextOtherSeed.data?.context_id).not.toBe(contextB.data?.context_id);
        expect(contextOtherSeed.data?.control_epoch).not.toBe(contextB.data?.control_epoch);
        expect(contextOtherSeed.data?.state.tabs).toEqual([]);
        const staleBResponse = await fetch(`${contextBMain.cdpUrl}/json/list`).catch(() => null);
        expect(staleBResponse === null || staleBResponse.status >= 400).toBe(true);

        await restartedApp.evaluate(() => {
          process.env.COMMAND_EVE_E2E_BROWSER_ACCOUNT_ID = 'account-a';
          process.env.COMMAND_EVE_E2E_BROWSER_SEED_ID = 'seed-a';
        });
        const returnedA = await invokeRendererBridge<typeof stateBeforeRestart>(
          restartedPage,
          'app.get-browser-context'
        );
        expect(returnedA.success, returnedA.msg).toBe(true);
        expect(returnedA.data?.context_id).toBe(restoredA.data?.context_id);
        expect(returnedA.data?.control_epoch).not.toBe(restoredA.data?.control_epoch);
        expect(returnedA.data?.control_epoch).not.toBe(contextB.data?.control_epoch);
        expect(returnedA.data?.control_epoch).not.toBe(contextOtherSeed.data?.control_epoch);
        expect(returnedA.data?.state.tabs.some((tab) => tab.url === profileStepTwo)).toBe(true);
        await restartedPage.reload();
        await openConversationRoute(restartedPage, conversationId);
        await revealBrowserWorkbench(restartedPage);
        const returnedAddress = restartedPage.locator('.aion-url-viewer-toolbar--workbench .toolbar-input');
        await expect(returnedAddress).toHaveValue(profileStepTwo);
        const returnedAMain = await restartedApp.evaluate(() => ({
          cdpUrl: process.env.BROWSER_CDP_URL ?? '',
          contextFile: process.env.COMMAND_EVE_BROWSER_CONTEXT_FILE ?? '',
        }));
        await waitForVisibleTarget(returnedAMain.cdpUrl, profileStepTwo);
        const returnedProfileStdout = await runBrowserUse(
          hermesPython,
          hermesRoot,
          returnedAMain.contextFile,
          [
            'status = ""',
            'for _ in range(30):',
            '    status = js("document.querySelector(\\"#profile-status\\").textContent")',
            '    if "cookie=true;localStorage=true;indexedDB=true;cache=true" in status:',
            '        break',
            '    wait(0.2)',
            'assert "cookie=true;localStorage=true;indexedDB=true;cache=true" in status',
            'print({"phase": "account-seed-roundtrip-restored", "status": status})',
          ].join('\n')
        );
        expect(returnedProfileStdout).toContain('cookie=true;localStorage=true;indexedDB=true;cache=true');
        await restartedPage.screenshot({ path: testInfo.outputPath('packaged-account-seed-roundtrip-restored.png') });

        const revokeResult = await invokeRendererBridge<typeof stateBeforeRestart>(
          restartedPage,
          'app.revoke-browser-context'
        );
        expect(revokeResult.success, revokeResult.msg).toBe(true);
        expect(revokeResult.data?.state.tabs).toEqual([]);
        const preRevokeCapability = await fetch(`${returnedAMain.cdpUrl}/json/list`).catch(() => null);
        expect(preRevokeCapability === null || preRevokeCapability.status >= 400).toBe(true);

        await restartedPage.reload();
        await openConversationRoute(restartedPage, conversationId);
        await revealBrowserWorkbench(restartedPage);
        const revokeAddress = restartedPage.locator('.aion-url-viewer-toolbar--workbench .toolbar-input');
        const revokedProfileUrl = `${fixtureUrl}?profile=profile-a`;
        await revokeAddress.fill(revokedProfileUrl);
        await revokeAddress.press('Enter');
        const revokedMain = await restartedApp.evaluate(() => ({
          cdpUrl: process.env.BROWSER_CDP_URL ?? '',
          contextFile: process.env.COMMAND_EVE_BROWSER_CONTEXT_FILE ?? '',
        }));
        await waitForVisibleTarget(revokedMain.cdpUrl, revokedProfileUrl);
        const revokedProfileStdout = await runBrowserUse(
          hermesPython,
          hermesRoot,
          revokedMain.contextFile,
          [
            'status = ""',
            'for _ in range(30):',
            '    status = js("document.querySelector(\\"#profile-status\\").textContent")',
            '    if "checking" not in status:',
            '        break',
            '    wait(0.2)',
            'assert "cookie=false;localStorage=false;indexedDB=false;cache=false" in status',
            'print({"phase": "revoke-cleared", "status": status})',
          ].join('\n')
        );
        expect(revokedProfileStdout).toContain('cookie=false;localStorage=false;indexedDB=false;cache=false');

        const invalidTarget = await sendCdpCommand(revokedMain.cdpUrl, {
          id: 901,
          method: 'Target.attachToTarget',
          params: { targetId: 'foreign-target', flatten: true },
        });
        expect(invalidTarget.error).toBeTruthy();
        const invalidSession = await sendCdpCommand(revokedMain.cdpUrl, {
          id: 902,
          method: 'Page.getFrameTree',
          sessionId: 'foreign-session',
        });
        expect(invalidSession.error).toBeTruthy();
        await restartedPage.screenshot({ path: testInfo.outputPath('packaged-revoke-isolated.png') });

        const secretMatches = await execFileAsync('rg', [
          '-a',
          '-l',
          '--fixed-strings',
          secretCanary,
          restartContract.userDataDir,
        ]).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '' }));
        expect(secretMatches.stdout.trim()).toBe('');
        packagedPersistenceLog = [
          'packaged_restart=true',
          'profile_storage_restored=cookie,localStorage,indexedDB,cache',
          'account_isolation=true',
          'seed_isolation=true',
          'account_seed_roundtrip_profile_restored=true',
          'control_epoch_rotation=true',
          'targeted_revoke=true',
          'stale_capabilities_fail_closed=true',
          'foreign_target_session_fail_closed=true',
          'secret_canary_in_user_data=false',
          `restart_context_id=${restoredA.data?.context_id ?? 'missing'}`,
        ].join('\n');
      } finally {
        await closeElectronApp(restartedApp);
      }
    }

    fs.writeFileSync(
      testInfo.outputPath('browser-workbench-proof.log'),
      [
        `packaged=${packageState.isPackaged}`,
        `app_version=${packageState.version}`,
        'browser_use_uvx=browser-use==0.13.7',
        `browser_use_cli_version=${cliVersion.stdout.trim()}`,
        `cdp_origin=${new URL(mainState.cdpUrl).origin}`,
        `cdp_capability_path=redacted:${new URL(mainState.cdpUrl).pathname.split('/').length - 1}-segments`,
        `context_id=${runtimeContext.context_id}`,
        '',
        '--- initial Browser Use proof ---',
        proofStdout,
        '',
        '--- reconnect and security proof ---',
        reconnectStdout,
        '',
        '--- local Google OAuth and user-presence proof ---',
        oauthStdout,
        '',
        '--- packaged persistence and isolation proof ---',
        packagedPersistenceLog,
      ].join('\n'),
      'utf8'
    );
  });
});
