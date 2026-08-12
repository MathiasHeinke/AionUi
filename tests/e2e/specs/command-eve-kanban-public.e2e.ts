/**
 * Native Command EVE Kanban in the single-chat workbench.
 *
 * Provider-free: HTTP creates one empty local conversation only. Every board
 * mutation is driven through visible UI and Hermes' canonical default board.
 * The second launch reuses the exact profile to prove both SQLite and workbench
 * tab identity survive a clean desktop restart. Computer Use is status-only in
 * this fixture; the spec never clicks install, grant, capture, or action gates.
 */
import {
  expect,
  test,
  type ElectronApplication,
  type Page,
  type TestInfo,
  _electron as electron,
} from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeSharedElectronAppForIsolatedSpec } from '../fixtures';
import { resolveAioncoreBinary } from '../helpers/aioncoreBinary';
import { invokeBridge } from '../helpers/bridge/invoke';
import { httpGet, httpPost } from '../helpers/httpBridge';
import {
  EXPECTED_HERMES_VERSION,
  EXPECTED_HERMES_WHEEL_SHA256,
  EXPECTED_NATIVE_KANBAN_STATUSES,
  classifyNativeKanbanProfile,
  evaluateNativeKanbanRead,
  type NativeKanbanBridgeResponse,
  type NativeKanbanProfileState,
  type NativeKanbanReadEvaluation,
} from '../helpers/nativeKanbanReadiness';

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
type RuntimeBootstrapReceipt = {
  version?: unknown;
  status?: unknown;
  stages?: Array<{ id?: unknown; status?: unknown }>;
  runtime_provenance?: {
    hermes?: {
      install_source?: unknown;
      wheel_sha256?: unknown;
      wheel_sha256_verified?: unknown;
      installed_wheel_sha256?: unknown;
      installed_wheel_verified?: unknown;
    };
  };
};
type HermesWheelReceipt = {
  version?: unknown;
  package_version?: unknown;
  wheel_sha256?: unknown;
  extras?: unknown;
};
type NativeKanbanRuntimeSnapshot = {
  runtimeRoot: string;
  receiptPath: string;
  wheelReceiptPath: string;
  kanbanDbPath: string;
  kanbanDbBytes: number;
  receipt: RuntimeBootstrapReceipt | null;
  wheelReceipt: HermesWheelReceipt | null;
};
type RuntimeStatusBridgeResponse = {
  success?: boolean;
  msg?: string;
  data?: {
    status?: string;
    receipt_path?: string;
    next_action?: string;
    stages?: Array<{ id?: string; status?: string; code?: string; detail?: string }>;
  };
};
type ActiveSeatBridgeResponse = {
  success?: boolean;
  msg?: string;
  data?: { version?: string; ok?: boolean; seat_id?: string; reason_code?: string };
};
type SeatContextBridgeResponse = {
  success?: boolean;
  msg?: string;
  data?: { seatId?: string; seatContextRevision?: number };
};
type NativeKanbanBoardReadAttempt = {
  observed_at: string;
  profile: NativeKanbanProfileState;
  profile_after?: NativeKanbanProfileState;
  runtime_snapshot_error?: string;
  response?: NativeKanbanBridgeResponse;
  board_error?: string;
  evaluation?: NativeKanbanReadEvaluation;
  runtime_status?: RuntimeStatusBridgeResponse;
  runtime_status_error?: string;
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

async function openConversationFromFreshBoot(page: Page, conversationId: string): Promise<void> {
  const conversationHash = `#/conversation/${conversationId}`;

  // Reproduce a persisted chat URL without firing an in-session hash change,
  // then reload the renderer. The one-shot boot guard must return us to the
  // real home shell before the history row drives normal React Router
  // navigation, exactly as a user opening an existing chat would.
  await page.evaluate((rawBootHash) => {
    window.history.replaceState(null, '', rawBootHash);
  }, conversationHash);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await ensureBackendReady(page);
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/guid');
  await expect(page.getByTestId('guid-input')).toBeVisible({ timeout: 30_000 });

  const historyRow = page.locator(`[id="c-${conversationId}"]`);
  await expect(historyRow).toBeVisible({ timeout: 30_000 });
  await historyRow.getByRole('button').first().click();

  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(conversationHash);
  await expect(page.getByTestId('message-list-scroller')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(`[id="eve-chat-pane-${conversationId}"]`)).toHaveCount(1);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readOptionalJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch (error) {
    throw new Error(`Unreadable or malformed JSON receipt at ${filePath}: ${errorMessage(error)}`, { cause: error });
  }
}

function nativeKanbanRuntimePaths() {
  // Explicit E2E profiles do not use the global CLI symlink. getDataPath()
  // therefore resolves to this exact private profile root.
  const runtimeRoot = path.join(isolatedUserDataDir, 'command-eve', 'command-eve-runtime');
  const receiptPath = path.join(runtimeRoot, 'runtime-bootstrap-receipt.json');
  const wheelReceiptPath = path.join(runtimeRoot, 'hermes', 'bundled-wheel-receipt.json');
  const kanbanDbPath = path.join(runtimeRoot, 'hermes', 'home', 'kanban.db');
  return { runtimeRoot, receiptPath, wheelReceiptPath, kanbanDbPath };
}

function readNativeKanbanRuntimeSnapshot(): NativeKanbanRuntimeSnapshot {
  const paths = nativeKanbanRuntimePaths();
  return {
    ...paths,
    kanbanDbBytes: fs.existsSync(paths.kanbanDbPath) ? fs.statSync(paths.kanbanDbPath).size : 0,
    receipt: readOptionalJson<RuntimeBootstrapReceipt>(paths.receiptPath),
    wheelReceipt: readOptionalJson<HermesWheelReceipt>(paths.wheelReceiptPath),
  };
}

function readNativeKanbanRuntimeDiagnostics() {
  const paths = nativeKanbanRuntimePaths();
  let receipt: RuntimeBootstrapReceipt | null = null;
  let receiptError: string | null = null;
  let wheelReceipt: HermesWheelReceipt | null = null;
  let wheelReceiptError: string | null = null;
  let kanbanDbBytes = 0;
  let kanbanDbError: string | null = null;
  try {
    receipt = readOptionalJson<RuntimeBootstrapReceipt>(paths.receiptPath);
  } catch (error) {
    receiptError = errorMessage(error);
  }
  try {
    wheelReceipt = readOptionalJson<HermesWheelReceipt>(paths.wheelReceiptPath);
  } catch (error) {
    wheelReceiptError = errorMessage(error);
  }
  try {
    kanbanDbBytes = fs.existsSync(paths.kanbanDbPath) ? fs.statSync(paths.kanbanDbPath).size : 0;
  } catch (error) {
    kanbanDbError = errorMessage(error);
  }
  return {
    snapshot: { ...paths, kanbanDbBytes, receipt, wheelReceipt } satisfies NativeKanbanRuntimeSnapshot,
    receipt_error: receiptError,
    wheel_receipt_error: wheelReceiptError,
    kanban_db_error: kanbanDbError,
  };
}

function profileState(snapshot: NativeKanbanRuntimeSnapshot): NativeKanbanProfileState {
  const hermesStage = snapshot.receipt?.stages?.find((stage) => stage.id === 'hermes');
  return classifyNativeKanbanProfile({
    bootstrapReceiptExists: snapshot.receipt !== null,
    bootstrapHermesStageStatus: typeof hermesStage?.status === 'string' ? hermesStage.status : null,
    wheelReceiptVersion: typeof snapshot.wheelReceipt?.version === 'string' ? snapshot.wheelReceipt.version : null,
    wheelReceiptPackageVersion:
      typeof snapshot.wheelReceipt?.package_version === 'string' ? snapshot.wheelReceipt.package_version : null,
    wheelReceiptSha256:
      typeof snapshot.wheelReceipt?.wheel_sha256 === 'string' ? snapshot.wheelReceipt.wheel_sha256 : null,
    kanbanDbBytes: snapshot.kanbanDbBytes,
  });
}

function bootstrapReceiptEvidence(receipt: RuntimeBootstrapReceipt | null) {
  const hermes = receipt?.runtime_provenance?.hermes;
  return receipt
    ? {
        version: receipt.version,
        status: receipt.status,
        stages: receipt.stages,
        hermes: hermes
          ? {
              install_source: hermes.install_source,
              wheel_sha256: hermes.wheel_sha256,
              wheel_sha256_verified: hermes.wheel_sha256_verified,
              installed_wheel_sha256: hermes.installed_wheel_sha256,
              installed_wheel_verified: hermes.installed_wheel_verified,
            }
          : null,
      }
    : null;
}

async function attachNativeKanbanReadReceipts(
  page: Page,
  testInfo: TestInfo,
  phase: 'initial' | 'restart',
  conversationId: string,
  expectedStartProfile: 'cold' | 'warm',
  activeSeat: ActiveSeatBridgeResponse | null,
  activeSeatError: string | null,
  seatContext: SeatContextBridgeResponse | null,
  seatContextError: string | null,
  attempts: NativeKanbanBoardReadAttempt[]
): Promise<void> {
  const runtimeDiagnostics = readNativeKanbanRuntimeDiagnostics();
  const runtime = runtimeDiagnostics.snapshot;
  const runtimeEvidenceInvalid = Boolean(
    runtimeDiagnostics.receipt_error || runtimeDiagnostics.wheel_receipt_error || runtimeDiagnostics.kanban_db_error
  );
  const renderer = await page
    .evaluate(() => ({
      hash: window.location.hash,
      canonical_chat_pane_count: document.querySelectorAll('[id^="eve-chat-pane-"]').length,
      kanban_board_count: document.querySelectorAll('[data-testid="native-kanban-board"]').length,
      kanban_column_ids: Array.from(document.querySelectorAll('[data-testid^="native-kanban-column-"]')).map((node) =>
        node.getAttribute('data-testid')
      ),
    }))
    .catch((error) => ({ renderer_error: error instanceof Error ? error.message : String(error) }));
  const tab = await persistedKanbanTab(page, conversationId).catch((error) => ({
    diagnostic_error: error instanceof Error ? error.message : String(error),
  }));
  const agentEvents = fs.existsSync(agentEventsFile) ? fs.readFileSync(agentEventsFile, 'utf8') : '';

  await testInfo.attach(`native-kanban-bootstrap-${phase}`, {
    body: Buffer.from(
      JSON.stringify(
        {
          expected_start_profile: expectedStartProfile,
          observed_profile: runtimeEvidenceInvalid ? 'invalid' : profileState(runtime),
          receipt_path: runtime.receiptPath,
          wheel_receipt_path: runtime.wheelReceiptPath,
          kanban_db_path: runtime.kanbanDbPath,
          kanban_db_bytes: runtime.kanbanDbBytes,
          receipt_error: runtimeDiagnostics.receipt_error,
          wheel_receipt_error: runtimeDiagnostics.wheel_receipt_error,
          kanban_db_error: runtimeDiagnostics.kanban_db_error,
          receipt: bootstrapReceiptEvidence(runtime.receipt),
          wheel_receipt: runtime.wheelReceipt,
        },
        null,
        2
      )
    ),
    contentType: 'application/json',
  });
  await testInfo.attach(`native-kanban-acp-seat-session-${phase}`, {
    body: Buffer.from(
      JSON.stringify(
        {
          conversation_id: conversationId,
          active_seat: activeSeat,
          active_seat_error: activeSeatError,
          seat_context: seatContext,
          seat_context_error: seatContextError,
          renderer,
          persisted_tab: tab,
        },
        null,
        2
      )
    ),
    contentType: 'application/json',
  });
  await testInfo.attach(`native-kanban-board-reads-${phase}`, {
    body: Buffer.from(JSON.stringify(attempts, null, 2)),
    contentType: 'application/json',
  });
  await testInfo.attach(`native-kanban-agent-events-${phase}`, {
    body: Buffer.from(agentEvents || '(empty agent event ledger)\n'),
    contentType: 'text/plain',
  });
}

async function waitForNativeKanbanReadiness(
  page: Page,
  testInfo: TestInfo,
  phase: 'initial' | 'restart',
  conversationId: string,
  expectedStartProfile: 'cold' | 'warm'
): Promise<void> {
  const attempts: NativeKanbanBoardReadAttempt[] = [];
  let activeSeat: ActiveSeatBridgeResponse | null = null;
  let activeSeatError: string | null = null;
  let seatContext: SeatContextBridgeResponse | null = null;
  let seatContextError: string | null = null;
  let readyEvaluation: NativeKanbanReadEvaluation | null = null;
  const deadline = Date.now() + 180_000;

  try {
    try {
      activeSeat = await invokeBridge<ActiveSeatBridgeResponse>(page, 'command-eve.active-seat', undefined, 15_000);
    } catch (error) {
      activeSeatError = error instanceof Error ? error.message : String(error);
      throw error;
    }
    expect(activeSeat.success, activeSeat.msg || 'Active-seat bridge failed before native Kanban read.').toBe(true);
    expect(activeSeat.data).toMatchObject({ version: 'command-eve-active-seat/v0', ok: true });
    expect(activeSeat.data?.seat_id).toBeTruthy();
    try {
      seatContext = await invokeBridge<SeatContextBridgeResponse>(page, 'command-eve.seat-context', undefined, 15_000);
    } catch (error) {
      seatContextError = error instanceof Error ? error.message : String(error);
      throw error;
    }
    expect(seatContext.success, seatContext.msg || 'Seat-context bridge failed before native Kanban read.').toBe(true);
    expect(seatContext.data?.seatId).toBe(activeSeat.data?.seat_id);
    expect(seatContext.data?.seatContextRevision).toEqual(expect.any(Number));

    while (Date.now() < deadline) {
      const attempt: NativeKanbanBoardReadAttempt = {
        observed_at: new Date().toISOString(),
        profile: 'partial',
      };
      attempts.push(attempt);
      try {
        attempt.profile = profileState(readNativeKanbanRuntimeSnapshot());
      } catch (error) {
        attempt.runtime_snapshot_error = errorMessage(error);
        throw error;
      }

      let response: NativeKanbanBridgeResponse;
      try {
        // oxlint-disable-next-line no-await-in-loop -- readiness polling must serialize one real board read at a time
        response = await invokeBridge<NativeKanbanBridgeResponse>(
          page,
          'command-eve.native-kanban-board',
          undefined,
          30_000
        );
      } catch (error) {
        attempt.board_error = errorMessage(error);
        throw error;
      }
      attempt.response = response;
      const evaluation = evaluateNativeKanbanRead(response, attempt.profile);
      attempt.evaluation = evaluation;

      try {
        // oxlint-disable-next-line no-await-in-loop -- snapshot the runtime state paired with this exact board read
        attempt.runtime_status = await invokeBridge<RuntimeStatusBridgeResponse>(
          page,
          'command-eve.runtime-status',
          undefined,
          15_000
        );
      } catch (error) {
        attempt.runtime_status_error = errorMessage(error);
        throw error;
      }
      if (attempt.runtime_status.success !== true) {
        throw new Error(
          `Runtime-status bridge failed during native Kanban readiness: ${attempt.runtime_status.msg || 'unknown'}`
        );
      }
      const hermesStage = attempt.runtime_status.data?.stages?.find((stage) => stage.id === 'hermes');
      if (hermesStage?.status === 'blocked' || hermesStage?.status === 'failed') {
        throw new Error(`Hermes bootstrap reached a terminal stage: ${JSON.stringify(hermesStage)}`);
      }
      try {
        attempt.profile_after = profileState(readNativeKanbanRuntimeSnapshot());
      } catch (error) {
        attempt.runtime_snapshot_error = errorMessage(error);
        throw error;
      }

      if (evaluation.disposition === 'ready' && hermesStage?.status === 'pass' && attempt.profile_after === 'warm') {
        readyEvaluation = evaluation;
        break;
      }
      if (evaluation.disposition !== 'ready' && hermesStage?.status === 'pass') {
        throw new Error(
          `Native Kanban stayed unavailable after the Hermes bootstrap stage passed: ${JSON.stringify(evaluation.summary)}`
        );
      }
      if (evaluation.disposition === 'terminal') {
        throw new Error(`Native Kanban returned a terminal board response: ${JSON.stringify(evaluation.summary)}`);
      }

      // This delay is coupled to a typed retryable board result; it is the
      // bounded interval between real provider reads, never an unobserved sleep.
      // oxlint-disable-next-line no-await-in-loop -- the next provider read must not overlap this one
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(1_000, Math.max(1, deadline - Date.now()))));
    }

    if (!readyEvaluation) {
      throw new Error(
        `Native Kanban did not become ready within 180000ms; last_read=${JSON.stringify(attempts.at(-1)?.evaluation?.summary ?? null)}`
      );
    }

    const runtime = readNativeKanbanRuntimeSnapshot();
    expect(profileState(runtime), 'The successful native board read must leave a warm canonical profile.').toBe('warm');
    expect(runtime.wheelReceipt).toMatchObject({
      version: 'command-eve-hermes-wheel-receipt/v2',
      package_version: EXPECTED_HERMES_VERSION,
      wheel_sha256: EXPECTED_HERMES_WHEEL_SHA256,
      extras: ['acp', 'mcp'],
    });
    expect(runtime.kanbanDbBytes).toBeGreaterThan(0);
    expect(readyEvaluation.summary.columns).toEqual(EXPECTED_NATIVE_KANBAN_STATUSES);
    if (expectedStartProfile === 'warm') {
      expect(attempts, 'A warm restart must succeed on its first real native board read.').toHaveLength(1);
    }
  } finally {
    await attachNativeKanbanReadReceipts(
      page,
      testInfo,
      phase,
      conversationId,
      expectedStartProfile,
      activeSeat,
      activeSeatError,
      seatContext,
      seatContextError,
      attempts
    );
  }
}

async function openKanbanWorkbench(
  page: Page,
  testInfo: TestInfo,
  phase: 'initial' | 'restart',
  conversationId: string,
  expectedStartProfile: 'cold' | 'warm'
): Promise<void> {
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

  // A brand-new isolated profile intentionally provisions Hermes in the
  // background. Poll the real typed provider only while it returns a known
  // cold-provisioning state, then use the same visible Refresh action the
  // operator uses. No columns or board state are fabricated in the harness.
  await waitForNativeKanbanReadiness(page, testInfo, phase, conversationId, expectedStartProfile);
  const refresh = page.getByTestId('native-kanban-refresh');
  await expect(refresh).toBeEnabled({ timeout: 30_000 });
  await refresh.click();
  await expect(page.locator('[data-testid^="native-kanban-column-"]')).toHaveCount(8, { timeout: 60_000 });
  const domColumnIds = await page
    .locator('[data-testid^="native-kanban-column-"]')
    .evaluateAll((columns) => columns.map((column) => column.getAttribute('data-testid')));
  expect(domColumnIds).toEqual(EXPECTED_NATIVE_KANBAN_STATUSES.map((status) => `native-kanban-column-${status}`));
  await expect(page.getByText(`Hermes ${EXPECTED_HERMES_VERSION}`, { exact: true })).toBeVisible();
  await expect
    .poll(() => readNativeKanbanRuntimeSnapshot().kanbanDbBytes, {
      timeout: 30_000,
      message: 'Waiting for Hermes to provision the canonical default-board SQLite file',
    })
    .toBeGreaterThan(0);
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

  // oxlint-disable-next-line no-empty-pattern -- Playwright requires the first callback argument to destructure fixtures
  test('normalizes fresh boot, opens one chat in-app, and restores one canonical card', async ({}, testInfo) => {
    let app: ElectronApplication | null = null;
    let page: Page | null = null;
    try {
      expect(
        profileState(readNativeKanbanRuntimeSnapshot()),
        'A new isolated Electron profile must start without runtime receipts or a Kanban DB.'
      ).toBe('cold');

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
      await openConversationFromFreshBoot(page, conversation.id);
      await openKanbanWorkbench(page, testInfo, 'initial', conversation.id, 'cold');

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

      expect(
        profileState(readNativeKanbanRuntimeSnapshot()),
        'The same profile must be warm before the clean desktop restart.'
      ).toBe('warm');

      app = await launchApp();
      page = await resolveMainWindow(app);
      await ensureBackendReady(page);
      await openConversationFromFreshBoot(page, conversation.id);

      await expect.poll(async () => (await persistedKanbanTab(page as Page, conversation.id))?.id).toBe(tabId);
      await openKanbanWorkbench(page, testInfo, 'restart', conversation.id, 'warm');
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
