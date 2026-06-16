/**
 * Command EVE Kanban Board – end-to-end mutation proof.
 *
 * Verifies that real GUI interactions (create card + move card) produce:
 *   1. A real sqlite row in the tasks table of the board DB the app wrote.
 *   2. A real task_events receipt row (kind = command_eve_card_created /
 *      command_eve_card_moved / command_eve_dispatch_plan_checked) with the
 *      HG-2.5 / NL-5 governance payload.
 *   3. A real agent-event/v1 audit line in the temp ledger
 *      (event_type = kanban.marketing_board_card_created /
 *       kanban.marketing_board_card_moved).
 *
 * No test.skip – fails loud if any precondition is missing (mirrors the
 * proof-card spec in command-eve-command-center.e2e.ts).
 *
 * Strategy:
 *   - The marketing board is created (if missing) by clicking the proof card
 *     button first, which is exactly what the command-center spec already proves.
 *     After the proof card step the board status is 'ready' and the "Post anlegen"
 *     create button becomes enabled.
 *   - Card creation uses the real modal: click → fill → submit.
 *   - Card move uses the real "Weiter →" button.
 *   - The card_id and board db_path are read from the UI after creation so
 *     the sqlite assertions target the exact DB the app wrote.
 *
 * Path configuration (env-driven, release-machine fallback):
 *   COMMAND_EVE_COMPANY_OS_ROOT   – absolute path to the Company.OS repo root.
 *                                   Defaults to /Users/mathiasheinke/Developer/Company.OS
 *   COMMAND_EVE_E2E_EVENTS_LEDGER – absolute path to the clean ledger fixture.
 *                                   Defaults to <companyOsRoot>/reports/command-eve/e2e/2026-06-10/agent-events.clean.jsonl
 */
import { test, expect } from '../fixtures';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

// ── Fixture / ledger setup (mirrors command-center spec) ──────────────────────

const COMPANY_OS_ROOT_DEFAULT = '/Users/mathiasheinke/Developer/Company.OS';
const LEDGER_FIXTURE_RELATIVE = 'reports/command-eve/e2e/2026-06-10/agent-events.clean.jsonl';

// State initialised in beforeAll, used by test bodies.
let e2eLedgerPath: string = '';
let e2eLedgerRoot: string = '';

// Prior env values captured in beforeAll, restored in afterAll.
let prevCompanyOsRoot: string | undefined;
let prevAgentEventsPath: string | undefined;
let prevNl5CompanyOsRoot: string | undefined;
let prevCommandEveNodeBinary: string | undefined;

// ── SQLite helper ─────────────────────────────────────────────────────────────

function sqliteQuery(dbPath: string, sql: string): string[][] {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`[kanban-board e2e] Board DB not found: ${dbPath}`);
  }
  const raw = execFileSync('sqlite3', ['-separator', '\t', dbPath, sql], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function uniquePostTitle(): string {
  return `E2E Post ${Date.now().toString(36).toUpperCase()}`;
}

/**
 * Write the reconciliation lock file so the bridge's governance check passes.
 * Mirrors the command-center spec exactly.
 */
function writeReconciliationLock(reconciliationPath: string): void {
  fs.mkdirSync(path.dirname(reconciliationPath), { recursive: true });
  fs.writeFileSync(
    reconciliationPath,
    `${JSON.stringify(
      {
        version: 'command-eve-runtime-reconciliation/v0',
        hermes_config: {
          mcp_servers: [],
          kanban_dispatch_in_gateway: false,
          kanban_auto_decompose: false,
        },
      },
      null,
      2
    )}\n`
  );
}

function writeFakeNl5DispatchCli(companyOsRoot: string): void {
  const cliPath = path.join(companyOsRoot, 'scripts', 'orchestration', 'hermes-pre-generation-dispatch.mjs');
  fs.mkdirSync(path.dirname(cliPath), { recursive: true });
  fs.writeFileSync(
    cliPath,
    `#!/usr/bin/env node
import fs from 'node:fs';

const request = JSON.parse(fs.readFileSync(0, 'utf8'));
const controllerApproved = request?.controllerApproval?.status === 'approved';
console.log(JSON.stringify({
  version: 'hermes-pre-generation-dispatch/v0',
  ok: controllerApproved,
  status: controllerApproved ? 'ready' : 'blocked',
  subprocess_spawned: false,
  reason_codes: controllerApproved
    ? ['command_eve.nl5_ready_after_controller_approval']
    : ['hermes.pre_generation.controller_approval_missing'],
  policy: {
    status: controllerApproved ? 'pass' : 'blocked',
    data_boundary_receipt: {
      ok: true,
      status: 'local-only-pass',
      sensitivity: 'S1',
      sensitivity_score: 1,
      effective_lane: 'local_only'
    }
  }
}, null, 2));
process.exitCode = controllerApproved ? 0 : 78;
`,
    { mode: 0o700 }
  );
}

function removeCrmOverlayDatabases(userDataPath: string): void {
  const commandEveDataRoots = [
    path.join(userDataPath, 'command-eve'),
    path.join(os.homedir(), '.command-eve-dev'),
    path.join(os.homedir(), '.command-eve-dev-2'),
    path.join(os.homedir(), '.command-eve'),
  ];
  for (const root of commandEveDataRoots) {
    const crmDbPath = path.join(root, 'command-eve-runtime', 'hermes', 'home', 'crm', 'command-eve-crm.db');
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(`${crmDbPath}${suffix}`, { force: true });
    }
  }
}

// ── Shared state (create → move hand-off) ─────────────────────────────────────

let createdCardId: string | null = null;
let boardDbPath: string | null = null;

// ── Test suite ────────────────────────────────────────────────────────────────

test.describe('Command EVE Kanban Board – mutation proof', () => {
  test.setTimeout(180_000);

  test.beforeAll(() => {
    // Capture prior values before any mutation.
    prevCompanyOsRoot = process.env.COMMAND_EVE_COMPANY_OS_ROOT;
    prevAgentEventsPath = process.env.COMMAND_EVE_AGENT_EVENTS_PATH;
    prevNl5CompanyOsRoot = process.env.COMMAND_EVE_NL5_COMPANY_OS_ROOT;
    prevCommandEveNodeBinary = process.env.COMMAND_EVE_NODE_BINARY;

    const companyOsRoot: string = process.env.COMMAND_EVE_COMPANY_OS_ROOT ?? COMPANY_OS_ROOT_DEFAULT;
    const cleanLedgerSource: string =
      process.env.COMMAND_EVE_E2E_EVENTS_LEDGER ?? path.join(companyOsRoot, LEDGER_FIXTURE_RELATIVE);

    if (!fs.existsSync(cleanLedgerSource)) {
      throw new Error(
        `[command-eve-kanban-board e2e] Ledger fixture not found: ${cleanLedgerSource}\n` +
          `Set COMMAND_EVE_COMPANY_OS_ROOT or COMMAND_EVE_E2E_EVENTS_LEDGER to a valid path.`
      );
    }

    // Isolated temp dir so the canonical evidence file is never mutated.
    e2eLedgerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-kanban-board-e2e-'));
    e2eLedgerPath = path.join(e2eLedgerRoot, 'agent-events.clean.jsonl');
    fs.copyFileSync(cleanLedgerSource, e2eLedgerPath);
    const nl5CompanyOsRoot = path.join(e2eLedgerRoot, 'company-os-nl5-fixture');
    writeFakeNl5DispatchCli(nl5CompanyOsRoot);

    // Point the bridge at our isolated ledger.
    process.env.COMMAND_EVE_COMPANY_OS_ROOT = companyOsRoot;
    process.env.COMMAND_EVE_AGENT_EVENTS_PATH = e2eLedgerPath;
    process.env.COMMAND_EVE_NL5_COMPANY_OS_ROOT = nl5CompanyOsRoot;
    process.env.COMMAND_EVE_NODE_BINARY = process.execPath;
  });

  test.afterAll(() => {
    // Restore prior env values exactly.
    if (prevCompanyOsRoot === undefined) {
      delete process.env.COMMAND_EVE_COMPANY_OS_ROOT;
    } else {
      process.env.COMMAND_EVE_COMPANY_OS_ROOT = prevCompanyOsRoot;
    }
    if (prevAgentEventsPath === undefined) {
      delete process.env.COMMAND_EVE_AGENT_EVENTS_PATH;
    } else {
      process.env.COMMAND_EVE_AGENT_EVENTS_PATH = prevAgentEventsPath;
    }
    if (prevNl5CompanyOsRoot === undefined) {
      delete process.env.COMMAND_EVE_NL5_COMPANY_OS_ROOT;
    } else {
      process.env.COMMAND_EVE_NL5_COMPANY_OS_ROOT = prevNl5CompanyOsRoot;
    }
    if (prevCommandEveNodeBinary === undefined) {
      delete process.env.COMMAND_EVE_NODE_BINARY;
    } else {
      process.env.COMMAND_EVE_NODE_BINARY = prevCommandEveNodeBinary;
    }

    // Clean up temp dir.
    if (e2eLedgerRoot) {
      fs.rmSync(e2eLedgerRoot, { recursive: true, force: true });
      e2eLedgerRoot = '';
    }
  });

  // ── TEST 1: Create ──────────────────────────────────────────────────────────
  test('create: GUI click produces sqlite row + task_events receipt + audit event', async ({
    page,
    electronApp,
  }, testInfo) => {
    // ── Reconciliation lock ─────────────────────────────────────────────────
    const userDataPath = await electronApp.evaluate(async ({ app }) => app.getPath('userData'));
    const reconciliationPath = path.join(
      userDataPath,
      'command-eve-runtime',
      'capabilities',
      'command-eve-runtime-reconciliation.json'
    );
    writeReconciliationLock(reconciliationPath);

    // ── Navigate to Command Center ──────────────────────────────────────────
    await page.waitForSelector('body', { state: 'visible' });
    await page.evaluate(() => {
      window.location.hash = '#/command-center';
    });
    await expect(page.getByText(/Command Center|Kommandozentrale/).first()).toBeVisible({ timeout: 30_000 });
    // Wait for read model to load (mirrors command-center spec).
    await expect(page.getByText(/agent-events\.clean\.jsonl/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Lokales Board|Local Board/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Marketing Board/).first()).toBeVisible({ timeout: 30_000 });

    // ── Ensure the board DB exists by running the proof card first ──────────
    // This is the same step the command-center spec proves. It initialises
    // the DB and makes the "Post anlegen" button enabled.
    await page.getByRole('button', { name: /Proof-Karte anlegen|Create proof card/ }).click();
    await expect(page.getByText(/KANBAN_MARKETING_PROOF_CARD_CREATED|KANBAN_MARKETING_PROOF_CARD_EXISTS/)).toBeVisible({
      timeout: 60_000,
    });

    // After proof card creation the marketingResult state is updated in-place
    // by the UI (it re-reads the board via kanbanMarketingBoard.invoke).
    // The "Post anlegen" button is now enabled (board status = ready).
    // Wait for it without re-navigating (we're already on the page).
    const createOpenBtn = page.getByTestId('marketing-card-create-open');
    await expect(createOpenBtn).toBeVisible({ timeout: 30_000 });
    const boardFailureContext = await page.getByTestId('command-eve-marketing-board').innerText();
    await expect(createOpenBtn, boardFailureContext).toBeEnabled({ timeout: 30_000 });

    // ── Read the board db_path from the UI ─────────────────────────────────
    // The board section renders: "<Database label>: <db_path>"
    // We extract this so the sqlite assertions target the correct file.
    const dbPathLabel = await page.locator('span:has-text("/kanban/boards/marketing/kanban.db")').first().textContent();
    const dbPathMatch = dbPathLabel?.match(/([^\s]+kanban\.db)/);
    const resolvedDbPath = dbPathMatch?.[1] ?? null;
    expect(resolvedDbPath, 'Board db_path must be visible in the marketing board section').toBeTruthy();
    boardDbPath = resolvedDbPath!;

    // ── Click "Post anlegen" → open create modal ────────────────────────────
    const postTitle = uniquePostTitle();
    const postDescription = 'E2E mutation proof – create';

    await createOpenBtn.click();
    await expect(page.getByTestId('marketing-card-create-modal')).toBeVisible({ timeout: 10_000 });

    // ── Fill the modal ──────────────────────────────────────────────────────
    await page.getByTestId('marketing-card-create-title').fill(postTitle);
    await page.getByTestId('marketing-card-create-description').fill(postDescription);
    // Lane defaults to 'research' – leave as is.

    // ── Submit ──────────────────────────────────────────────────────────────
    await page.getByTestId('marketing-card-create-submit').click();

    // ── Wait for success: modal closes and Alert appears ────────────────────
    await expect(page.getByTestId('marketing-card-create-modal')).not.toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('KANBAN_MARKETING_CARD_CREATED')).toBeVisible({ timeout: 60_000 });

    // ── Extract card_id from the DOM ────────────────────────────────────────
    // The create result Alert shows card_id or audit_event_path.
    // We find the card in the research lane by its unique title.
    await expect(page.getByText(postTitle)).toBeVisible({ timeout: 30_000 });

    // Find the article (card) containing this title.
    const cardArticle = page.locator(`article:has-text("${postTitle}")`).first();
    await expect(cardArticle).toBeVisible({ timeout: 10_000 });

    // The card's data-testid is `marketing-card-{card_id}`. Extract it.
    const cardTestId = await cardArticle.getAttribute('data-testid');
    expect(cardTestId, 'Card article must have data-testid attribute').toBeTruthy();
    const extractedCardId = cardTestId?.replace(/^marketing-card-/, '') ?? null;
    expect(extractedCardId, 'card_id must be extractable from data-testid').toBeTruthy();
    createdCardId = extractedCardId!;

    // ── Assert: research lane column contains the card ──────────────────────
    await expect(page.getByTestId('marketing-lane-research')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId(`marketing-card-${createdCardId}`)).toBeVisible({ timeout: 10_000 });

    // ── Assert: sqlite tasks row ────────────────────────────────────────────
    const taskRows = sqliteQuery(
      boardDbPath,
      `SELECT id, title, current_step_key, status FROM tasks WHERE id = '${createdCardId}'`
    );
    expect(taskRows.length, `tasks row for card_id=${createdCardId} must exist`).toBeGreaterThan(0);
    expect(taskRows[0][0], 'tasks.id must match card_id').toBe(createdCardId);
    expect(taskRows[0][1], 'tasks.title must match submitted title').toBe(postTitle);
    expect(taskRows[0][2], 'tasks.current_step_key must be research').toBe('research');

    // ── Assert: task_events 'command_eve_card_created' receipt ─────────────
    const eventRows = sqliteQuery(
      boardDbPath,
      `SELECT kind, payload FROM task_events WHERE task_id = '${createdCardId}' AND kind = 'command_eve_card_created' LIMIT 1`
    );
    expect(eventRows.length, `task_events created receipt must exist`).toBeGreaterThan(0);
    const eventPayload = JSON.parse(eventRows[0][1]) as {
      lane_key?: string;
      human_gate?: string;
      dispatcher_enabled?: boolean;
      auto_decompose_enabled?: boolean;
    };
    expect(eventPayload.human_gate, 'receipt human_gate must be HG-2.5').toBe('HG-2.5');
    expect(eventPayload.dispatcher_enabled, 'receipt dispatcher_enabled must be false').toBe(false);
    expect(eventPayload.auto_decompose_enabled, 'receipt auto_decompose_enabled must be false').toBe(false);
    expect(eventPayload.lane_key, 'receipt lane_key must be research').toBe('research');

    // ── Assert: audit event in temp ledger ─────────────────────────────────
    // The bridge uses COMMAND_EVE_AGENT_EVENTS_PATH (our temp file) as the
    // ledger path. It appends the audit event there.
    expect(fs.existsSync(e2eLedgerPath), `audit ledger must exist: ${e2eLedgerPath}`).toBe(true);

    const ledgerLines = fs.readFileSync(e2eLedgerPath, 'utf8').split('\n').filter(Boolean);
    const matchingCreateAudit = ledgerLines.find((line) => {
      try {
        const evt = JSON.parse(line) as { event_type?: string; issue_id?: string };
        return evt.issue_id === createdCardId && evt.event_type === 'kanban.marketing_board_card_created';
      } catch {
        return false;
      }
    });
    expect(
      matchingCreateAudit,
      `audit ledger must contain kanban.marketing_board_card_created for card_id=${createdCardId}`
    ).toBeTruthy();

    // ── Screenshot ──────────────────────────────────────────────────────────
    const screenshotPath = 'tests/e2e/results/command-eve-kanban-board-create.png';
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await testInfo.attach('kanban-board-create-proof', { path: screenshotPath, contentType: 'image/png' });
  });

  // ── TEST 2: Move ────────────────────────────────────────────────────────────
  test('move: GUI click produces sqlite task_events moved receipt + audit event', async ({
    page,
    electronApp,
  }, testInfo) => {
    // Fail loud if create test did not produce a card.
    if (!createdCardId || !boardDbPath) {
      throw new Error(
        `[kanban-board e2e] move test requires a prior successful create test; ` +
          `createdCardId=${String(createdCardId)} boardDbPath=${String(boardDbPath)}`
      );
    }

    // ── Reconciliation lock ─────────────────────────────────────────────────
    const userDataPath = await electronApp.evaluate(async ({ app }) => app.getPath('userData'));
    const reconciliationPath = path.join(
      userDataPath,
      'command-eve-runtime',
      'capabilities',
      'command-eve-runtime-reconciliation.json'
    );
    writeReconciliationLock(reconciliationPath);

    // ── Navigate to Command Center ──────────────────────────────────────────
    await page.waitForSelector('body', { state: 'visible' });
    await page.evaluate(() => {
      window.location.hash = '#/command-center';
    });
    await expect(page.getByText(/Command Center|Kommandozentrale/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Lokales Board|Local Board/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Marketing Board/).first()).toBeVisible({ timeout: 30_000 });

    // Wait for the created card to appear in the board.
    const cardTestId = `marketing-card-${createdCardId}`;
    await expect(page.getByTestId(cardTestId)).toBeVisible({ timeout: 30_000 });

    // Confirm card is in research lane (pre-condition).
    await expect(page.getByTestId('marketing-lane-research').getByTestId(cardTestId)).toBeVisible({
      timeout: 10_000,
    });

    // ── Click the "Weiter →" move button ───────────────────────────────────
    const moveBtn = page.getByTestId(`marketing-card-move-${createdCardId}`);
    await expect(moveBtn).toBeVisible({ timeout: 10_000 });
    await moveBtn.click();

    // ── Wait for move success Alert ─────────────────────────────────────────
    await expect(page.getByText('KANBAN_MARKETING_CARD_MOVED')).toBeVisible({ timeout: 60_000 });

    // ── Card should now be in draft lane ───────────────────────────────────
    await expect(page.getByTestId('marketing-lane-draft').getByTestId(cardTestId)).toBeVisible({
      timeout: 30_000,
    });

    // ── Assert: sqlite tasks row updated ───────────────────────────────────
    const taskRows = sqliteQuery(
      boardDbPath,
      `SELECT id, current_step_key, status FROM tasks WHERE id = '${createdCardId}'`
    );
    expect(taskRows.length, `tasks row for card_id=${createdCardId} must still exist`).toBeGreaterThan(0);
    expect(taskRows[0][1], 'current_step_key must be draft after move').toBe('draft');
    expect(taskRows[0][2], 'status must be todo (draft native status)').toBe('todo');

    // ── Assert: task_events 'command_eve_card_moved' receipt ───────────────
    const eventRows = sqliteQuery(
      boardDbPath,
      `SELECT kind, payload FROM task_events WHERE task_id = '${createdCardId}' AND kind = 'command_eve_card_moved' LIMIT 1`
    );
    expect(eventRows.length, `task_events moved receipt must exist`).toBeGreaterThan(0);
    const movedPayload = JSON.parse(eventRows[0][1]) as {
      to_lane_key?: string;
      human_gate?: string;
      dispatcher_enabled?: boolean;
      auto_decompose_enabled?: boolean;
    };
    expect(movedPayload.human_gate, 'moved receipt human_gate must be HG-2.5').toBe('HG-2.5');
    expect(movedPayload.dispatcher_enabled, 'moved receipt dispatcher_enabled must be false').toBe(false);
    expect(movedPayload.auto_decompose_enabled, 'moved receipt auto_decompose_enabled must be false').toBe(false);
    expect(movedPayload.to_lane_key, 'moved receipt to_lane_key must be draft').toBe('draft');

    // ── Assert: audit event in temp ledger ─────────────────────────────────
    expect(fs.existsSync(e2eLedgerPath), `audit ledger must exist: ${e2eLedgerPath}`).toBe(true);

    const ledgerLines = fs.readFileSync(e2eLedgerPath, 'utf8').split('\n').filter(Boolean);
    const matchingMoveAudit = ledgerLines.find((line) => {
      try {
        const evt = JSON.parse(line) as { event_type?: string; issue_id?: string };
        return evt.issue_id === createdCardId && evt.event_type === 'kanban.marketing_board_card_moved';
      } catch {
        return false;
      }
    });
    expect(
      matchingMoveAudit,
      `audit ledger must contain kanban.marketing_board_card_moved for card_id=${createdCardId}`
    ).toBeTruthy();

    // ── Screenshot ──────────────────────────────────────────────────────────
    const screenshotPath = 'tests/e2e/results/command-eve-kanban-board-move.png';
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await testInfo.attach('kanban-board-move-proof', { path: screenshotPath, contentType: 'image/png' });
  });

  // ── TEST 3: Local card actions ────────────────────────────────────────────
  test('actions: GUI comment/block/unblock/complete produce receipts without spawning Hermes', async ({
    page,
    electronApp,
  }, testInfo) => {
    if (!createdCardId || !boardDbPath) {
      throw new Error(
        `[kanban-board e2e] action test requires a prior successful create test; ` +
          `createdCardId=${String(createdCardId)} boardDbPath=${String(boardDbPath)}`
      );
    }

    const userDataPath = await electronApp.evaluate(async ({ app }) => app.getPath('userData'));
    const reconciliationPath = path.join(
      userDataPath,
      'command-eve-runtime',
      'capabilities',
      'command-eve-runtime-reconciliation.json'
    );
    writeReconciliationLock(reconciliationPath);

    await page.waitForSelector('body', { state: 'visible' });
    await page.evaluate(() => {
      window.location.hash = '#/command-center';
    });
    await expect(page.getByText(/Command Center|Kommandozentrale/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Marketing Board/).first()).toBeVisible({ timeout: 30_000 });

    const cardTestId = `marketing-card-${createdCardId}`;
    await expect(page.getByTestId(cardTestId)).toBeVisible({ timeout: 30_000 });

    await page.getByTestId(`marketing-card-comment-${createdCardId}`).click();
    await expect(page.getByTestId('marketing-card-comment-modal')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('marketing-card-comment-input').fill('E2E local action receipt.');
    await page.getByTestId('marketing-card-comment-submit').click();
    await expect(page.getByTestId('marketing-card-comment-modal')).not.toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('KANBAN_MARKETING_CARD_COMMENTED')).toBeVisible({ timeout: 60_000 });

    await page.getByTestId(`marketing-card-block-${createdCardId}`).click();
    await expect(page.getByText('KANBAN_MARKETING_CARD_BLOCKED')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('marketing-lane-review').getByTestId(cardTestId)).toBeVisible({ timeout: 30_000 });

    await page.getByTestId(`marketing-card-unblock-${createdCardId}`).click();
    await expect(page.getByText('KANBAN_MARKETING_CARD_UNBLOCKED')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('marketing-lane-review').getByTestId(cardTestId)).toBeVisible({ timeout: 30_000 });

    await page.getByTestId(`marketing-card-complete-${createdCardId}`).click();
    await expect(page.getByText('KANBAN_MARKETING_CARD_COMPLETED')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('marketing-lane-readyToApprove').getByTestId(cardTestId)).toBeVisible({
      timeout: 30_000,
    });

    const taskRows = sqliteQuery(
      boardDbPath,
      `SELECT id, current_step_key, status, completed_at FROM tasks WHERE id = '${createdCardId}'`
    );
    expect(taskRows[0][1], 'current_step_key must be readyToApprove after complete').toBe('readyToApprove');
    expect(taskRows[0][2], 'status must be completed after complete').toBe('completed');
    expect(Number(taskRows[0][3]), 'completed_at must be recorded').toBeGreaterThan(0);

    const commentRows = sqliteQuery(
      boardDbPath,
      `SELECT author, body FROM task_comments WHERE task_id = '${createdCardId}'`
    );
    expect(commentRows.length, 'task_comments receipt row must exist').toBeGreaterThan(0);
    expect(commentRows[0][0], 'comment author must be eve').toBe('eve');
    expect(commentRows[0][1], 'comment body must match submitted text').toBe('E2E local action receipt.');

    const receiptKinds = sqliteQuery(
      boardDbPath,
      `SELECT kind, payload FROM task_events WHERE task_id = '${createdCardId}' AND kind IN ('command_eve_card_commented','command_eve_card_blocked','command_eve_card_unblocked','command_eve_card_completed') ORDER BY id`
    );
    expect(receiptKinds.map((row) => row[0])).toEqual([
      'command_eve_card_commented',
      'command_eve_card_blocked',
      'command_eve_card_unblocked',
      'command_eve_card_completed',
    ]);
    for (const row of receiptKinds) {
      const payload = JSON.parse(row[1]) as { subprocess_spawned?: boolean; external_calls?: boolean };
      expect(payload.subprocess_spawned, `${row[0]} must not spawn Hermes`).toBe(false);
      expect(payload.external_calls, `${row[0]} must not call external services`).toBe(false);
    }

    const ledgerLines = fs.readFileSync(e2eLedgerPath, 'utf8').split('\n').filter(Boolean);
    for (const eventType of [
      'kanban.marketing_board_card_commented',
      'kanban.marketing_board_card_blocked',
      'kanban.marketing_board_card_unblocked',
      'kanban.marketing_board_card_completed',
    ]) {
      const match = ledgerLines.find((line) => {
        try {
          const evt = JSON.parse(line) as { event_type?: string; issue_id?: string };
          return evt.issue_id === createdCardId && evt.event_type === eventType;
        } catch {
          return false;
        }
      });
      expect(match, `audit ledger must contain ${eventType} for card_id=${createdCardId}`).toBeTruthy();
    }

    const screenshotPath = 'tests/e2e/results/command-eve-kanban-board-actions.png';
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await testInfo.attach('kanban-board-action-proof', { path: screenshotPath, contentType: 'image/png' });
  });

  // ── TEST 4: Dispatch gate check ───────────────────────────────────────────
  test('dispatch gate: GUI click routes through NL-5 and records a blocked no-spawn receipt', async ({
    page,
    electronApp,
  }, testInfo) => {
    const userDataPath = await electronApp.evaluate(async ({ app }) => app.getPath('userData'));
    const reconciliationPath = path.join(
      userDataPath,
      'command-eve-runtime',
      'capabilities',
      'command-eve-runtime-reconciliation.json'
    );
    writeReconciliationLock(reconciliationPath);

    await page.waitForSelector('body', { state: 'visible' });
    await page.reload();
    await page.waitForSelector('body', { state: 'visible' });
    await page.evaluate(() => {
      window.location.hash = '#/command-center';
    });
    await expect(page.getByText(/Command Center|Kommandozentrale/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Lokales Board|Local Board/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Marketing Board/).first()).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: /Proof-Karte anlegen|Create proof card/ }).click();
    await expect(page.getByText(/KANBAN_MARKETING_PROOF_CARD_CREATED|KANBAN_MARKETING_PROOF_CARD_EXISTS/)).toBeVisible({
      timeout: 60_000,
    });

    const createOpenBtn = page.getByTestId('marketing-card-create-open');
    await expect(createOpenBtn).toBeVisible({ timeout: 30_000 });
    await expect(createOpenBtn).toBeEnabled({ timeout: 30_000 });

    const dbPathLabel = await page.locator('span:has-text("/kanban/boards/marketing/kanban.db")').first().textContent();
    const dbPathMatch = dbPathLabel?.match(/([^\s]+kanban\.db)/);
    const dispatchBoardDbPath = dbPathMatch?.[1] ?? null;
    expect(dispatchBoardDbPath, 'Board db_path must be visible in the marketing board section').toBeTruthy();

    const postTitle = `${uniquePostTitle()} Dispatch`;
    await createOpenBtn.click();
    await expect(page.getByTestId('marketing-card-create-modal')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('marketing-card-create-title').fill(postTitle);
    await page.getByTestId('marketing-card-create-description').fill('E2E mutation proof – dispatch gate');
    await page.getByTestId('marketing-card-create-submit').click();
    await expect(page.getByTestId('marketing-card-create-modal')).not.toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('KANBAN_MARKETING_CARD_CREATED')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(postTitle)).toBeVisible({ timeout: 30_000 });

    const cardArticle = page.locator(`article:has-text("${postTitle}")`).first();
    await expect(cardArticle).toBeVisible({ timeout: 10_000 });
    const cardTestId = await cardArticle.getAttribute('data-testid');
    expect(cardTestId, 'Card article must have data-testid attribute').toBeTruthy();
    const dispatchCardId = cardTestId?.replace(/^marketing-card-/, '') ?? null;
    expect(dispatchCardId, 'card_id must be extractable from data-testid').toBeTruthy();

    const dispatchButton = page.getByTestId(`marketing-card-dispatch-plan-${dispatchCardId}`);
    await expect(dispatchButton).toBeVisible({ timeout: 30_000 });
    await dispatchButton.click();

    const dispatchResult = page.getByTestId('marketing-card-dispatch-plan-result');
    await expect(dispatchResult).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('marketing-card-dispatch-plan-detail')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('marketing-card-dispatch-plan-reason')).toHaveText(
      /hermes\.pre_generation\.controller_approval_missing/
    );
    await expect(dispatchResult.getByText(/Hermes: nicht gestartet|Hermes: not spawned/)).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId('marketing-card-dispatch-controller-approval')).toContainText(
      /Controller-Freigabe:\s*erforderlich|Controller approval:\s*required/,
      {
        timeout: 30_000,
      }
    );
    await expect(page.getByTestId('marketing-card-dispatch-release-gate')).toContainText(
      /Release:\s*blockiert|Release:\s*blocked/,
      {
        timeout: 30_000,
      }
    );
    await expect(page.getByTestId('marketing-card-dispatch-handoff')).toContainText(/role:cmo\s*\/\s*manual/, {
      timeout: 30_000,
    });
    await expect(page.getByTestId('marketing-card-dispatch-approval-panel')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('marketing-card-dispatch-approval-state')).toContainText(
      /wartet auf Controller|waiting for controller/
    );
    await expect(page.getByTestId('marketing-card-dispatch-approve-receipt')).toBeEnabled();
    await page.getByTestId('marketing-card-dispatch-record-review').click();
    const approvalResult = page.getByTestId('marketing-card-dispatch-approval-result');
    await expect(approvalResult).toBeVisible({ timeout: 30_000 });
    await expect(approvalResult).toContainText(/KANBAN_MARKETING_CONTROLLER_APPROVAL_PENDING_RECORDED/);
    await expect(page.getByTestId('marketing-card-dispatch-approval-detail')).toContainText(/ausstehend|pending/);
    await expect(page.getByTestId(`marketing-card-controller-review-${dispatchCardId}`)).toContainText(
      /ausstehend|pending/
    );
    await expect(page.getByTestId(`marketing-card-controller-review-pending-${dispatchCardId}`)).toContainText(
      /wartet auf Controller|waiting for controller/
    );
    await expect(page.getByTestId(`marketing-card-controller-handoff-${dispatchCardId}`)).toContainText(
      /role:cmo\s*\/\s*manual/
    );
    await expect(page.getByTestId('marketing-dispatch-queue')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('marketing-dispatch-queue-pending-count')).toContainText(/Pending:\s*[1-9]\d*/);
    await expect(page.getByTestId(`marketing-dispatch-queue-item-${dispatchCardId}`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId(`marketing-dispatch-queue-status-${dispatchCardId}`)).toContainText(
      /ausstehend|pending/
    );
    await expect(page.getByTestId(`marketing-dispatch-queue-next-${dispatchCardId}`)).toContainText(
      /Controller muss|Controller still needs/
    );
    await page.getByTestId('marketing-card-dispatch-approve-receipt').click();
    const decisionResult = page.getByTestId('marketing-card-dispatch-decision-result');
    await expect(decisionResult).toBeVisible({ timeout: 30_000 });
    await expect(decisionResult).toContainText(/KANBAN_MARKETING_CONTROLLER_APPROVAL_RECORDED_NO_SPAWN/);
    await expect(page.getByTestId('marketing-card-dispatch-decision-detail')).toContainText(/freigegeben|approved/);
    await expect(page.getByTestId(`marketing-card-controller-decision-${dispatchCardId}`)).toContainText(
      /freigegeben|approved/
    );
    await expect(page.getByTestId('marketing-dispatch-queue-approved-count')).toContainText(/Approved:\s*[1-9]\d*/);
    await expect(page.getByTestId(`marketing-dispatch-queue-status-${dispatchCardId}`)).toContainText(
      /freigegeben|approved/
    );
    await expect(page.getByTestId(`marketing-dispatch-queue-next-${dispatchCardId}`)).toContainText(
      /Marketing-Draft|marketing draft/
    );
    const generateDraftButton = page.getByTestId(`marketing-dispatch-queue-generate-${dispatchCardId}`);
    await expect(generateDraftButton).toBeEnabled({ timeout: 30_000 });
    await generateDraftButton.click();
    const draftResult = page.getByTestId('marketing-draft-generate-result');
    await expect(draftResult).toBeVisible({ timeout: 60_000 });
    await expect(draftResult).toContainText(postTitle);
    await expect(page.getByTestId(`marketing-generated-draft-preview-${dispatchCardId}`)).toContainText(postTitle, {
      timeout: 30_000,
    });
    await expect(page.getByTestId(`marketing-dispatch-queue-next-${dispatchCardId}`)).toContainText(/Review|review/);
    await expect(page.getByTestId('marketing-dispatch-queue-generated-count')).toContainText(/Drafts:\s*[1-9]\d*/);
    const approveOutputButton = page.getByTestId(`marketing-dispatch-queue-approve-output-${dispatchCardId}`);
    await expect(approveOutputButton).toBeEnabled({ timeout: 30_000 });
    await approveOutputButton.click();
    const outputResult = page.getByTestId('marketing-output-approve-result');
    await expect(outputResult).toBeVisible({ timeout: 60_000 });
    await expect(outputResult).toContainText(postTitle);
    await expect(page.getByTestId(`marketing-approved-output-preview-${dispatchCardId}`)).toContainText(postTitle, {
      timeout: 30_000,
    });
    await expect(page.getByTestId(`marketing-dispatch-queue-output-approved-tag-${dispatchCardId}`)).toContainText(
      /Outputs|Output/
    );
    await expect(page.getByTestId(`marketing-dispatch-queue-worker-ready-tag-${dispatchCardId}`)).toContainText(
      /Worker/
    );
    await expect(page.getByTestId(`marketing-worker-handoff-preview-${dispatchCardId}`)).toContainText(
      /role:\s*role:cmo/
    );
    await expect(page.getByTestId(`marketing-worker-handoff-preview-${dispatchCardId}`)).toContainText(
      /dispatch:\s*manual/
    );
    await expect(page.getByTestId('marketing-worker-handoff-result')).toContainText(/role:\s*role:cmo/);
    const requestWorkerButton = page.getByTestId(`marketing-dispatch-queue-request-worker-${dispatchCardId}`);
    await expect(requestWorkerButton).toBeEnabled({ timeout: 30_000 });
    await requestWorkerButton.click();
    const workerRequestResult = page.getByTestId('marketing-worker-dispatch-request-result');
    await expect(workerRequestResult).toBeVisible({ timeout: 60_000 });
    await expect(workerRequestResult).toContainText(/role:\s*role:cmo/);
    await expect(page.getByTestId(`marketing-dispatch-queue-worker-requested-tag-${dispatchCardId}`)).toContainText(
      /Dispatch|gesperrt|Anfrage/
    );
    await expect(page.getByTestId(`marketing-dispatch-queue-next-${dispatchCardId}`)).toContainText(
      /Worker|policy|gesperrt|Dispatch/
    );
    await expect(page.getByTestId('marketing-dispatch-queue-output-approved-count')).toContainText(
      /Outputs:\s*[1-9]\d*/
    );
    await expect(page.getByTestId('marketing-dispatch-queue-worker-ready-count')).toContainText(/Worker.*:\s*[1-9]\d*/);
    await expect(page.getByTestId('marketing-dispatch-queue-worker-requested-count')).toContainText(
      /Dispatch.*:\s*[1-9]\d*/
    );
    const observedWorkerButton = page.getByTestId(`marketing-dispatch-queue-run-observed-worker-${dispatchCardId}`);
    await expect(observedWorkerButton).toBeEnabled({ timeout: 30_000 });
    await observedWorkerButton.click();
    const observedWorkerResult = page.getByTestId('marketing-worker-observed-run-result');
    await expect(observedWorkerResult).toBeVisible({ timeout: 60_000 });
    await expect(observedWorkerResult).toContainText(/worker\.reported/);
    await expect(observedWorkerResult).toContainText(/subprocess_spawned:\s*false/);
    await expect(page.getByTestId(`marketing-worker-observed-preview-${dispatchCardId}`)).toContainText(
      /worker\.reported/,
      { timeout: 30_000 }
    );
    await expect(page.getByTestId(`marketing-dispatch-queue-worker-observed-tag-${dispatchCardId}`)).toContainText(
      /Observed|gespeichert|Run/
    );
    await expect(page.getByTestId(`marketing-dispatch-queue-next-${dispatchCardId}`)).toContainText(
      /Observed|Publishing|gesperrt|external workers/
    );
    await expect(page.getByTestId('marketing-dispatch-queue-worker-observed-count')).toContainText(
      /Observed.*:\s*[1-9]\d*/
    );
    const startGateButton = page.getByTestId(`marketing-dispatch-queue-check-worker-start-gate-${dispatchCardId}`);
    await expect(startGateButton).toBeEnabled({ timeout: 30_000 });
    await startGateButton.click();
    const startGateResult = page.getByTestId('marketing-worker-start-gate-result');
    await expect(startGateResult).toBeVisible({ timeout: 60_000 });
    await expect(startGateResult).toContainText(/command-eve-worker-start-packet/);
    await expect(startGateResult).toContainText(/runtime_executor_not_configured/);
    await expect(startGateResult).toContainText(/HG-3/);
    const observedExecutorProfileButton = page
      .locator('[data-testid^="marketing-worker-start-gate-check-observed-executor-profile-"]')
      .first();
    await expect(observedExecutorProfileButton).toBeEnabled({ timeout: 30_000 });
    await observedExecutorProfileButton.click();
    await expect(startGateResult).toContainText(/command_eve\.runtime_executor_profile_accepted_no_spawn/);
    await expect(startGateResult).toContainText(/hermes-local-observed/);
    const prepareDispatcherButton = page.getByTestId(
      `marketing-dispatch-queue-prepare-worker-dispatcher-${dispatchCardId}`
    );
    await expect(prepareDispatcherButton).toBeEnabled({ timeout: 30_000 });
    await prepareDispatcherButton.click();
    const dispatcherPrepareResult = page.getByTestId('marketing-worker-dispatcher-prepare-result');
    await expect(dispatcherPrepareResult).toBeVisible({ timeout: 60_000 });
    await expect(dispatcherPrepareResult).toContainText(/command-eve-worker-dispatcher-prepare-packet/);
    await expect(dispatcherPrepareResult).toContainText(/subprocess_spawned.*false|subprocess.*false/);
    await expect(
      page.getByTestId(`marketing-dispatch-queue-worker-dispatcher-prepared-tag-${dispatchCardId}`)
    ).toContainText(/Dispatcher|vorbereitet|prepared/);
    await expect(page.getByTestId(`marketing-dispatch-queue-next-${dispatchCardId}`)).toContainText(
      /Release|Freigabe|Dispatcher|prepared/
    );
    await expect(page.getByTestId('command-center-operating-readiness')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('operating-readiness-controllerReviewQueue')).toContainText(/ready|bereit|1/);
    await expect(page.getByTestId('operating-readiness-dispatchBlocked')).toContainText(
      /ready|bereit|KANBAN_MARKETING_DISPATCH_PLAN_READY/
    );
    await expect(page.getByTestId('operating-readiness-workerAutonomyLocked')).toContainText(
      /ready|bereit|worker_dispatch|dispatcher_enabled=false/
    );

    const dispatchRows = sqliteQuery(
      dispatchBoardDbPath!,
      `SELECT kind, payload FROM task_events WHERE task_id = '${dispatchCardId}' AND kind = 'command_eve_dispatch_plan_checked' LIMIT 1`
    );
    expect(dispatchRows.length, `dispatch plan receipt must exist for ${dispatchCardId}`).toBeGreaterThan(0);
    const dispatchPayload = JSON.parse(dispatchRows[0][1]) as {
      nl5_gate_checked?: boolean;
      subprocess_spawned?: boolean;
      controller_approval_required?: boolean;
      release_blocked?: boolean;
      reason_codes?: string[];
      dispatch_handoff_packet?: {
        version?: string;
        dispatch?: string;
        role_label?: string;
      };
    };
    expect(dispatchPayload.nl5_gate_checked, 'NL-5 must be checked').toBe(true);
    expect(dispatchPayload.subprocess_spawned, 'Hermes subprocess must not spawn without controller approval').toBe(
      false
    );
    expect(dispatchPayload.controller_approval_required, 'Controller approval must be required').toBe(true);
    expect(dispatchPayload.release_blocked, 'Release must remain blocked before controller approval').toBe(true);
    expect(dispatchPayload.reason_codes).toContain('hermes.pre_generation.controller_approval_missing');
    expect(dispatchPayload.dispatch_handoff_packet).toMatchObject({
      version: 'command-eve-local-dispatch-handoff/v0',
      dispatch: 'manual',
      role_label: 'role:cmo',
    });

    const approvalRows = sqliteQuery(
      dispatchBoardDbPath!,
      `SELECT kind, payload FROM task_events WHERE task_id = '${dispatchCardId}' AND kind = 'command_eve_controller_approval_pending' LIMIT 1`
    );
    expect(approvalRows.length, `controller review receipt must exist for ${dispatchCardId}`).toBeGreaterThan(0);
    const approvalPayload = JSON.parse(approvalRows[0][1]) as {
      controller_approval_status?: string;
      controller_approved?: boolean;
      release_blocked?: boolean;
      subprocess_spawned?: boolean;
      reason_codes?: string[];
      dispatch_handoff_packet?: {
        version?: string;
        dispatch?: string;
        role_label?: string;
      };
    };
    expect(approvalPayload.controller_approval_status).toBe('pending');
    expect(approvalPayload.controller_approved).toBe(false);
    expect(approvalPayload.release_blocked).toBe(true);
    expect(approvalPayload.subprocess_spawned).toBe(false);
    expect(approvalPayload.reason_codes).toContain('command_eve.controller_approval_pending');
    expect(approvalPayload.dispatch_handoff_packet).toMatchObject({
      version: 'command-eve-local-dispatch-handoff/v0',
      dispatch: 'manual',
      role_label: 'role:cmo',
    });

    const decisionRows = sqliteQuery(
      dispatchBoardDbPath!,
      `SELECT kind, payload FROM task_events WHERE task_id = '${dispatchCardId}' AND kind = 'command_eve_controller_decision_recorded' LIMIT 1`
    );
    expect(decisionRows.length, `controller decision receipt must exist for ${dispatchCardId}`).toBeGreaterThan(0);
    const decisionPayload = JSON.parse(decisionRows[0][1]) as {
      controller_approval_status?: string;
      controller_approved?: boolean;
      release_blocked?: boolean;
      subprocess_spawned?: boolean;
      reason_codes?: string[];
      dispatch_handoff_packet?: {
        version?: string;
        dispatch?: string;
        role_label?: string;
      };
    };
    expect(decisionPayload.controller_approval_status).toBe('approved');
    expect(decisionPayload.controller_approved).toBe(true);
    expect(decisionPayload.release_blocked).toBe(true);
    expect(decisionPayload.subprocess_spawned).toBe(false);
    expect(decisionPayload.reason_codes).toContain('command_eve.controller_approval_recorded_no_spawn');
    expect(decisionPayload.dispatch_handoff_packet).toMatchObject({
      version: 'command-eve-local-dispatch-handoff/v0',
      dispatch: 'manual',
      role_label: 'role:cmo',
    });

    const draftRows = sqliteQuery(
      dispatchBoardDbPath!,
      `SELECT kind, payload FROM task_events WHERE task_id = '${dispatchCardId}' AND kind = 'command_eve_marketing_draft_generated' LIMIT 1`
    );
    expect(draftRows.length, `marketing draft receipt must exist for ${dispatchCardId}`).toBeGreaterThan(0);
    const draftPayload = JSON.parse(draftRows[0][1]) as {
      controller_approval_status?: string;
      controller_approved?: boolean;
      release_blocked?: boolean;
      subprocess_spawned?: boolean;
      external_calls?: boolean;
      nl5_gate_checked?: boolean;
      draft_status?: string;
      draft_text?: string;
      reason_codes?: string[];
    };
    expect(draftPayload.controller_approval_status).toBe('approved');
    expect(draftPayload.controller_approved).toBe(true);
    expect(draftPayload.release_blocked).toBe(false);
    expect(draftPayload.subprocess_spawned).toBe(false);
    expect(draftPayload.external_calls).toBe(false);
    expect(draftPayload.nl5_gate_checked).toBe(true);
    expect(draftPayload.draft_status).toBe('generated');
    expect(draftPayload.draft_text).toContain(postTitle);
    expect(draftPayload.reason_codes).toContain('command_eve.marketing_draft_generated_local');

    const draftComments = sqliteQuery(
      dispatchBoardDbPath!,
      `SELECT COUNT(*) FROM task_comments WHERE task_id = '${dispatchCardId}' AND author = 'eve' AND body LIKE '%${postTitle}%'`
    );
    expect(
      Number(draftComments[0]?.[0] ?? 0),
      `marketing draft comment must exist for ${dispatchCardId}`
    ).toBeGreaterThan(0);

    const outputRows = sqliteQuery(
      dispatchBoardDbPath!,
      `SELECT kind, payload FROM task_events WHERE task_id = '${dispatchCardId}' AND kind = 'command_eve_marketing_output_approved' LIMIT 1`
    );
    expect(outputRows.length, `marketing output approval receipt must exist for ${dispatchCardId}`).toBeGreaterThan(0);
    const outputPayload = JSON.parse(outputRows[0][1]) as {
      controller_approval_status?: string;
      controller_approved?: boolean;
      release_blocked?: boolean;
      subprocess_spawned?: boolean;
      external_calls?: boolean;
      nl5_gate_checked?: boolean;
      output_approval_status?: string;
      output_text?: string;
      worker_dispatch_status?: string;
      worker_dispatch_ready?: boolean;
      worker_contract_yaml?: string;
      worker_prompt?: string;
      reason_codes?: string[];
    };
    expect(outputPayload.controller_approval_status).toBe('approved');
    expect(outputPayload.controller_approved).toBe(true);
    expect(outputPayload.release_blocked).toBe(false);
    expect(outputPayload.subprocess_spawned).toBe(false);
    expect(outputPayload.external_calls).toBe(false);
    expect(outputPayload.nl5_gate_checked).toBe(true);
    expect(outputPayload.output_approval_status).toBe('approved');
    expect(outputPayload.output_text).toContain(postTitle);
    expect(outputPayload.worker_dispatch_status).toBe('prepared');
    expect(outputPayload.worker_dispatch_ready).toBe(true);
    expect(outputPayload.worker_contract_yaml).toContain('role: role:cmo');
    expect(outputPayload.worker_contract_yaml).toContain('dispatch: manual');
    expect(outputPayload.worker_prompt).toContain('Approved local output');
    expect(outputPayload.reason_codes).toContain('command_eve.marketing_output_approved_local');

    const workerRequestRows = sqliteQuery(
      dispatchBoardDbPath!,
      `SELECT kind, payload FROM task_events WHERE task_id = '${dispatchCardId}' AND kind = 'command_eve_marketing_worker_dispatch_requested' LIMIT 1`
    );
    expect(
      workerRequestRows.length,
      `marketing worker dispatch request receipt must exist for ${dispatchCardId}`
    ).toBeGreaterThan(0);
    const workerRequestPayload = JSON.parse(workerRequestRows[0][1]) as {
      controller_approval_status?: string;
      controller_approved?: boolean;
      release_blocked?: boolean;
      subprocess_spawned?: boolean;
      external_calls?: boolean;
      nl5_gate_checked?: boolean;
      worker_dispatch_status?: string;
      worker_dispatch_request_status?: string;
      worker_contract_yaml?: string;
      reason_codes?: string[];
    };
    expect(workerRequestPayload.controller_approval_status).toBe('approved');
    expect(workerRequestPayload.controller_approved).toBe(true);
    expect(workerRequestPayload.release_blocked).toBe(true);
    expect(workerRequestPayload.subprocess_spawned).toBe(false);
    expect(workerRequestPayload.external_calls).toBe(false);
    expect(workerRequestPayload.nl5_gate_checked).toBe(true);
    expect(workerRequestPayload.worker_dispatch_status).toBe('prepared');
    expect(workerRequestPayload.worker_dispatch_request_status).toBe('blocked');
    expect(workerRequestPayload.worker_contract_yaml).toContain('role: role:cmo');
    expect(workerRequestPayload.reason_codes).toContain('command_eve.marketing_worker_dispatch_requested_no_spawn');

    const observedRows = sqliteQuery(
      dispatchBoardDbPath!,
      `SELECT kind, payload FROM task_events WHERE task_id = '${dispatchCardId}' AND kind = 'command_eve_marketing_worker_observed_run_completed' LIMIT 1`
    );
    expect(observedRows.length, `observed worker run receipt must exist for ${dispatchCardId}`).toBeGreaterThan(0);
    const observedPayload = JSON.parse(observedRows[0][1]) as {
      controller_approval_status?: string;
      controller_approved?: boolean;
      release_blocked?: boolean;
      subprocess_spawned?: boolean;
      external_calls?: boolean;
      nl5_gate_checked?: boolean;
      worker_execution_mode?: string;
      worker_observed_run_status?: string;
      worker_observed_output?: string;
      worker_contract_yaml?: string;
      reason_codes?: string[];
    };
    expect(observedPayload.controller_approval_status).toBe('approved');
    expect(observedPayload.controller_approved).toBe(true);
    expect(observedPayload.release_blocked).toBe(true);
    expect(observedPayload.subprocess_spawned).toBe(false);
    expect(observedPayload.external_calls).toBe(false);
    expect(observedPayload.nl5_gate_checked).toBe(true);
    expect(observedPayload.worker_execution_mode).toBe('observed_local');
    expect(observedPayload.worker_observed_run_status).toBe('completed');
    expect(observedPayload.worker_observed_output).toContain('worker.reported:');
    expect(observedPayload.worker_contract_yaml).toContain('role: role:cmo');
    expect(observedPayload.reason_codes).toContain(
      'command_eve.marketing_worker_observed_run_completed_local_no_spawn'
    );

    const blockedStartGateRows = sqliteQuery(
      dispatchBoardDbPath!,
      `SELECT kind, payload FROM task_events WHERE task_id = '${dispatchCardId}' AND kind = 'command_eve_marketing_worker_start_gate_checked' AND payload LIKE '%runtime_executor_not_configured%' LIMIT 1`
    );
    expect(
      blockedStartGateRows.length,
      `blocked worker start gate receipt must exist for ${dispatchCardId}`
    ).toBeGreaterThan(0);
    const startGatePayload = JSON.parse(blockedStartGateRows[0][1]) as {
      release_blocked?: boolean;
      subprocess_spawned?: boolean;
      external_calls?: boolean;
      nl5_gate_checked?: boolean;
      worker_start_gate_status?: string;
      worker_start_gate_reason_codes?: string[];
      worker_start_packet?: {
        version?: string;
        human_gate?: string;
        subprocess_spawned?: boolean;
        external_calls?: boolean;
        data_boundary_checked?: boolean;
        worker_start_data_boundary_receipt?: {
          version?: string;
          requested_lane?: string;
          effective_lane?: string;
          provider_execution_allowed?: boolean;
          raw_text_stored?: boolean;
          finding_count?: number;
        };
      };
      source_nl5_gate_checked?: boolean;
      worker_start_nl5_checked?: boolean;
      worker_start_data_boundary_receipt?: {
        version?: string;
        requested_lane?: string;
        effective_lane?: string;
        provider_execution_allowed?: boolean;
        raw_text_stored?: boolean;
        finding_count?: number;
      };
      reason_codes?: string[];
    };
    expect(startGatePayload.release_blocked).toBe(true);
    expect(startGatePayload.subprocess_spawned).toBe(false);
    expect(startGatePayload.external_calls).toBe(false);
    expect(startGatePayload.nl5_gate_checked).toBe(true);
    expect(startGatePayload.source_nl5_gate_checked).toBe(true);
    expect(startGatePayload.worker_start_nl5_checked).toBe(true);
    expect(startGatePayload.worker_start_gate_status).toBe('blocked');
    expect(startGatePayload.worker_start_gate_reason_codes).toContain('runtime_executor_not_configured');
    expect(startGatePayload.worker_start_packet).toMatchObject({
      version: 'command-eve-worker-start-packet/v0',
      human_gate: 'HG-3',
      subprocess_spawned: false,
      external_calls: false,
      data_boundary_checked: true,
    });
    expect(startGatePayload.worker_start_packet?.worker_start_data_boundary_receipt).toMatchObject({
      version: 'command-eve-worker-start-data-boundary-receipt/v0',
      requested_lane: 'local_only',
      effective_lane: 'local_only',
      provider_execution_allowed: false,
      raw_text_stored: false,
    });
    expect(startGatePayload.worker_start_data_boundary_receipt).toMatchObject({
      version: 'command-eve-worker-start-data-boundary-receipt/v0',
      requested_lane: 'local_only',
      effective_lane: 'local_only',
      provider_execution_allowed: false,
      raw_text_stored: false,
    });
    expect(startGatePayload.reason_codes).toContain('command_eve.marketing_worker_start_gate_checked_no_spawn');

    const readyStartGateRows = sqliteQuery(
      dispatchBoardDbPath!,
      `SELECT kind, payload FROM task_events WHERE task_id = '${dispatchCardId}' AND kind = 'command_eve_marketing_worker_start_gate_checked' AND payload LIKE '%command_eve.runtime_executor_profile_accepted_no_spawn%' LIMIT 1`
    );
    expect(
      readyStartGateRows.length,
      `ready observed executor start gate receipt must exist for ${dispatchCardId}`
    ).toBeGreaterThan(0);
    const readyStartGatePayload = JSON.parse(readyStartGateRows[0][1]) as {
      release_blocked?: boolean;
      subprocess_spawned?: boolean;
      external_calls?: boolean;
      nl5_gate_checked?: boolean;
      source_nl5_gate_checked?: boolean;
      worker_start_nl5_checked?: boolean;
      worker_start_gate_status?: string;
      worker_start_gate_reason_codes?: string[];
      worker_start_packet?: {
        executor_profile_receipt?: {
          ok?: boolean;
          status?: string;
          executor_kind?: string;
          execution_mode?: string;
          transport?: string;
          data_boundary_enforced?: boolean;
          external_calls_allowed?: boolean;
          subprocess_spawn_allowed?: boolean;
          reason_codes?: string[];
        };
      };
      executor_profile_receipt?: {
        ok?: boolean;
        status?: string;
        executor_kind?: string;
        execution_mode?: string;
        transport?: string;
        data_boundary_enforced?: boolean;
        external_calls_allowed?: boolean;
        subprocess_spawn_allowed?: boolean;
        reason_codes?: string[];
      };
      reason_codes?: string[];
    };
    expect(readyStartGatePayload.release_blocked).toBe(true);
    expect(readyStartGatePayload.subprocess_spawned).toBe(false);
    expect(readyStartGatePayload.external_calls).toBe(false);
    expect(readyStartGatePayload.nl5_gate_checked).toBe(true);
    expect(readyStartGatePayload.source_nl5_gate_checked).toBe(true);
    expect(readyStartGatePayload.worker_start_nl5_checked).toBe(true);
    expect(readyStartGatePayload.worker_start_gate_status).toBe('ready');
    expect(readyStartGatePayload.worker_start_gate_reason_codes).toEqual([]);
    expect(readyStartGatePayload.executor_profile_receipt).toMatchObject({
      ok: true,
      status: 'accepted',
      executor_kind: 'hermes-local-observed',
      execution_mode: 'observed',
      transport: 'local',
      data_boundary_enforced: true,
      external_calls_allowed: false,
      subprocess_spawn_allowed: false,
    });
    expect(readyStartGatePayload.worker_start_packet?.executor_profile_receipt).toMatchObject({
      ok: true,
      status: 'accepted',
      executor_kind: 'hermes-local-observed',
    });
    expect(readyStartGatePayload.reason_codes).toContain('command_eve.marketing_worker_start_gate_checked_no_spawn');
    expect(readyStartGatePayload.reason_codes).toContain('command_eve.runtime_executor_profile_accepted_no_spawn');

    const dispatcherPrepareRows = sqliteQuery(
      dispatchBoardDbPath!,
      `SELECT kind, payload FROM task_events WHERE task_id = '${dispatchCardId}' AND kind = 'command_eve_marketing_worker_dispatcher_prepared' LIMIT 1`
    );
    expect(
      dispatcherPrepareRows.length,
      `marketing worker dispatcher prepare receipt must exist for ${dispatchCardId}`
    ).toBeGreaterThan(0);
    const dispatcherPreparePayload = JSON.parse(dispatcherPrepareRows[0][1]) as {
      dispatcher_prepare_status?: string;
      worker_start_gate_status?: string;
      subprocess_spawned?: boolean;
      external_calls?: boolean;
      release_blocked?: boolean;
      reason_codes?: string[];
      dispatcher_prepare_packet?: {
        version?: string;
        executor_kind?: string;
        execution_mode?: string;
        transport?: string;
        dispatcher_prepare_status?: string;
        worker_start_gate_status?: string;
        subprocess_spawned?: boolean;
        external_calls?: boolean;
        release_blocked?: boolean;
      };
    };
    expect(dispatcherPreparePayload.dispatcher_prepare_status).toBe('ready');
    expect(dispatcherPreparePayload.worker_start_gate_status).toBe('ready');
    expect(dispatcherPreparePayload.subprocess_spawned).toBe(false);
    expect(dispatcherPreparePayload.external_calls).toBe(false);
    expect(dispatcherPreparePayload.release_blocked).toBe(true);
    expect(dispatcherPreparePayload.dispatcher_prepare_packet).toMatchObject({
      version: 'command-eve-worker-dispatcher-prepare-packet/v0',
      executor_kind: 'hermes-local-observed',
      execution_mode: 'observed',
      transport: 'local',
      dispatcher_prepare_status: 'ready',
      worker_start_gate_status: 'ready',
      subprocess_spawned: false,
      external_calls: false,
      release_blocked: true,
    });
    expect(dispatcherPreparePayload.reason_codes).toContain(
      'command_eve.marketing_worker_dispatcher_prepared_no_spawn'
    );

    const outputComments = sqliteQuery(
      dispatchBoardDbPath!,
      `SELECT COUNT(*) FROM task_comments WHERE task_id = '${dispatchCardId}' AND author = 'eve' AND body LIKE 'Approved local marketing output:%${postTitle}%'`
    );
    expect(
      Number(outputComments[0]?.[0] ?? 0),
      `marketing output approval comment must exist for ${dispatchCardId}`
    ).toBeGreaterThan(0);

    const ledgerLines = fs.readFileSync(e2eLedgerPath, 'utf8').split('\n').filter(Boolean);
    const matchingDispatchAudit = ledgerLines.find((line) => {
      try {
        const evt = JSON.parse(line) as { event_type?: string; issue_id?: string; payload?: Record<string, unknown> };
        return (
          evt.issue_id === dispatchCardId &&
          evt.event_type === 'kanban.marketing_board_dispatch_plan_checked' &&
          evt.payload?.subprocess_spawned === false &&
          (evt.payload?.dispatch_handoff_packet as { dispatch?: string } | undefined)?.dispatch === 'manual'
        );
      } catch {
        return false;
      }
    });
    expect(
      matchingDispatchAudit,
      `audit ledger must contain kanban.marketing_board_dispatch_plan_checked for card_id=${dispatchCardId}`
    ).toBeTruthy();
    const matchingApprovalAudit = ledgerLines.find((line) => {
      try {
        const evt = JSON.parse(line) as { event_type?: string; issue_id?: string; payload?: Record<string, unknown> };
        return (
          evt.issue_id === dispatchCardId &&
          evt.event_type === 'kanban.marketing_board_controller_approval_pending' &&
          evt.payload?.controller_approval_status === 'pending' &&
          evt.payload?.subprocess_spawned === false &&
          (evt.payload?.dispatch_handoff_packet as { dispatch?: string } | undefined)?.dispatch === 'manual'
        );
      } catch {
        return false;
      }
    });
    expect(
      matchingApprovalAudit,
      `audit ledger must contain kanban.marketing_board_controller_approval_pending for card_id=${dispatchCardId}`
    ).toBeTruthy();
    const matchingDecisionAudit = ledgerLines.find((line) => {
      try {
        const evt = JSON.parse(line) as { event_type?: string; issue_id?: string; payload?: Record<string, unknown> };
        return (
          evt.issue_id === dispatchCardId &&
          evt.event_type === 'kanban.marketing_board_controller_decision_recorded' &&
          evt.payload?.controller_approval_status === 'approved' &&
          evt.payload?.subprocess_spawned === false &&
          evt.payload?.release_blocked === true &&
          (evt.payload?.dispatch_handoff_packet as { dispatch?: string } | undefined)?.dispatch === 'manual'
        );
      } catch {
        return false;
      }
    });
    expect(
      matchingDecisionAudit,
      `audit ledger must contain kanban.marketing_board_controller_decision_recorded for card_id=${dispatchCardId}`
    ).toBeTruthy();
    const matchingDraftAudit = ledgerLines.find((line) => {
      try {
        const evt = JSON.parse(line) as { event_type?: string; issue_id?: string; payload?: Record<string, unknown> };
        return (
          evt.issue_id === dispatchCardId &&
          evt.event_type === 'kanban.marketing_board_marketing_draft_generated' &&
          evt.payload?.controller_approval_status === 'approved' &&
          evt.payload?.subprocess_spawned === false &&
          evt.payload?.release_blocked === false
        );
      } catch {
        return false;
      }
    });
    expect(
      matchingDraftAudit,
      `audit ledger must contain kanban.marketing_board_marketing_draft_generated for card_id=${dispatchCardId}`
    ).toBeTruthy();
    const matchingOutputAudit = ledgerLines.find((line) => {
      try {
        const evt = JSON.parse(line) as { event_type?: string; issue_id?: string; payload?: Record<string, unknown> };
        return (
          evt.issue_id === dispatchCardId &&
          evt.event_type === 'kanban.marketing_board_marketing_output_approved' &&
          evt.payload?.controller_approval_status === 'approved' &&
          evt.payload?.subprocess_spawned === false &&
          evt.payload?.release_blocked === false &&
          evt.payload?.output_approval_status === 'approved' &&
          evt.payload?.worker_dispatch_status === 'prepared' &&
          String(evt.payload?.worker_contract_yaml || '').includes('role: role:cmo')
        );
      } catch {
        return false;
      }
    });
    expect(
      matchingOutputAudit,
      `audit ledger must contain kanban.marketing_board_marketing_output_approved for card_id=${dispatchCardId}`
    ).toBeTruthy();
    const matchingWorkerDispatchRequestAudit = ledgerLines.find((line) => {
      try {
        const evt = JSON.parse(line) as { event_type?: string; issue_id?: string; payload?: Record<string, unknown> };
        return (
          evt.issue_id === dispatchCardId &&
          evt.event_type === 'kanban.marketing_board_worker_dispatch_requested' &&
          evt.payload?.controller_approval_status === 'approved' &&
          evt.payload?.subprocess_spawned === false &&
          evt.payload?.release_blocked === true &&
          evt.payload?.worker_dispatch_status === 'prepared' &&
          evt.payload?.worker_dispatch_request_status === 'blocked' &&
          String(evt.payload?.worker_contract_yaml || '').includes('role: role:cmo')
        );
      } catch {
        return false;
      }
    });
    expect(
      matchingWorkerDispatchRequestAudit,
      `audit ledger must contain kanban.marketing_board_worker_dispatch_requested for card_id=${dispatchCardId}`
    ).toBeTruthy();
    const matchingObservedWorkerAudit = ledgerLines.find((line) => {
      try {
        const evt = JSON.parse(line) as { event_type?: string; issue_id?: string; payload?: Record<string, unknown> };
        return (
          evt.issue_id === dispatchCardId &&
          evt.event_type === 'kanban.marketing_board_worker_observed_run_completed' &&
          evt.payload?.controller_approval_status === 'approved' &&
          evt.payload?.subprocess_spawned === false &&
          evt.payload?.external_calls === false &&
          evt.payload?.release_blocked === true &&
          evt.payload?.worker_execution_mode === 'observed_local' &&
          evt.payload?.worker_observed_run_status === 'completed' &&
          String(evt.payload?.worker_contract_yaml || '').includes('role: role:cmo')
        );
      } catch {
        return false;
      }
    });
    expect(
      matchingObservedWorkerAudit,
      `audit ledger must contain kanban.marketing_board_worker_observed_run_completed for card_id=${dispatchCardId}`
    ).toBeTruthy();
    const matchingStartGateAudit = ledgerLines.find((line) => {
      try {
        const evt = JSON.parse(line) as { event_type?: string; issue_id?: string; payload?: Record<string, unknown> };
        const startPacket = evt.payload?.worker_start_packet as
          | {
              version?: string;
              human_gate?: string;
              subprocess_spawned?: boolean;
              data_boundary_checked?: boolean;
              worker_start_data_boundary_receipt?: {
                version?: string;
                provider_execution_allowed?: boolean;
                raw_text_stored?: boolean;
              };
            }
          | undefined;
        const reasonCodes = evt.payload?.worker_start_gate_reason_codes as string[] | undefined;
        const workerStartBoundaryReceipt = evt.payload?.worker_start_data_boundary_receipt as
          | {
              version?: string;
              provider_execution_allowed?: boolean;
              raw_text_stored?: boolean;
            }
          | undefined;
        return (
          evt.issue_id === dispatchCardId &&
          evt.event_type === 'kanban.marketing_board_worker_start_gate_checked' &&
          evt.payload?.subprocess_spawned === false &&
          evt.payload?.external_calls === false &&
          evt.payload?.release_blocked === true &&
          evt.payload?.worker_start_gate_status === 'blocked' &&
          reasonCodes?.includes('runtime_executor_not_configured') === true &&
          evt.payload?.source_nl5_gate_checked === true &&
          evt.payload?.worker_start_nl5_checked === true &&
          workerStartBoundaryReceipt?.version === 'command-eve-worker-start-data-boundary-receipt/v0' &&
          workerStartBoundaryReceipt?.provider_execution_allowed === false &&
          workerStartBoundaryReceipt?.raw_text_stored === false &&
          startPacket?.version === 'command-eve-worker-start-packet/v0' &&
          startPacket?.human_gate === 'HG-3' &&
          startPacket?.subprocess_spawned === false &&
          startPacket?.data_boundary_checked === true &&
          startPacket?.worker_start_data_boundary_receipt?.version ===
            'command-eve-worker-start-data-boundary-receipt/v0' &&
          startPacket?.worker_start_data_boundary_receipt?.provider_execution_allowed === false &&
          startPacket?.worker_start_data_boundary_receipt?.raw_text_stored === false
        );
      } catch {
        return false;
      }
    });
    expect(
      matchingStartGateAudit,
      `audit ledger must contain kanban.marketing_board_worker_start_gate_checked for card_id=${dispatchCardId}`
    ).toBeTruthy();
    const matchingDispatcherPrepareAudit = ledgerLines.find((line) => {
      try {
        const evt = JSON.parse(line) as { event_type?: string; issue_id?: string; payload?: Record<string, unknown> };
        const preparePacket = evt.payload?.dispatcher_prepare_packet as
          | {
              version?: string;
              executor_kind?: string;
              execution_mode?: string;
              transport?: string;
              dispatcher_prepare_status?: string;
              worker_start_gate_status?: string;
              subprocess_spawned?: boolean;
              external_calls?: boolean;
              release_blocked?: boolean;
            }
          | undefined;
        return (
          evt.issue_id === dispatchCardId &&
          evt.event_type === 'kanban.marketing_board_worker_dispatcher_prepared' &&
          evt.payload?.dispatcher_prepare_status === 'ready' &&
          evt.payload?.worker_start_gate_status === 'ready' &&
          evt.payload?.subprocess_spawned === false &&
          evt.payload?.external_calls === false &&
          evt.payload?.release_blocked === true &&
          preparePacket?.version === 'command-eve-worker-dispatcher-prepare-packet/v0' &&
          preparePacket?.executor_kind === 'hermes-local-observed' &&
          preparePacket?.execution_mode === 'observed' &&
          preparePacket?.transport === 'local' &&
          preparePacket?.subprocess_spawned === false &&
          preparePacket?.external_calls === false &&
          preparePacket?.release_blocked === true
        );
      } catch {
        return false;
      }
    });
    expect(
      matchingDispatcherPrepareAudit,
      `audit ledger must contain kanban.marketing_board_worker_dispatcher_prepared for card_id=${dispatchCardId}`
    ).toBeTruthy();

    const screenshotPath = 'tests/e2e/results/command-eve-kanban-board-dispatch-gate.png';
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await testInfo.attach('kanban-board-dispatch-gate-proof', { path: screenshotPath, contentType: 'image/png' });
  });

  // ── TEST 5: Safe local loop ────────────────────────────────────────────────
  test('safe local loop: one GUI click prepares the gated marketing dispatcher with receipts', async ({
    page,
    electronApp,
  }, testInfo) => {
    const userDataPath = await electronApp.evaluate(async ({ app }) => app.getPath('userData'));
    const reconciliationPath = path.join(
      userDataPath,
      'command-eve-runtime',
      'capabilities',
      'command-eve-runtime-reconciliation.json'
    );
    writeReconciliationLock(reconciliationPath);

    await page.waitForSelector('body', { state: 'visible' });
    await page.reload();
    await page.waitForSelector('body', { state: 'visible' });
    await page.evaluate(() => {
      window.location.hash = '#/command-center';
    });
    await expect(page.getByText(/Command Center|Kommandozentrale/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Marketing Board/).first()).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: /Proof-Karte anlegen|Create proof card/ }).click();
    await expect(page.getByText(/KANBAN_MARKETING_PROOF_CARD_CREATED|KANBAN_MARKETING_PROOF_CARD_EXISTS/)).toBeVisible({
      timeout: 60_000,
    });

    const dbPathLabel = await page.locator('span:has-text("/kanban/boards/marketing/kanban.db")').first().textContent();
    const dbPathMatch = dbPathLabel?.match(/([^\s]+kanban\.db)/);
    const safeLoopBoardDbPath = dbPathMatch?.[1] ?? null;
    expect(safeLoopBoardDbPath, 'Board db_path must be visible in the marketing board section').toBeTruthy();

    const postTitle = `${uniquePostTitle()} Safe Loop`;
    await page.getByTestId('marketing-card-create-open').click();
    await expect(page.getByTestId('marketing-card-create-modal')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('marketing-card-create-title').fill(postTitle);
    await page.getByTestId('marketing-card-create-description').fill('E2E mutation proof – safe local loop');
    await page.getByTestId('marketing-card-create-submit').click();
    await expect(page.getByTestId('marketing-card-create-modal')).not.toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('KANBAN_MARKETING_CARD_CREATED')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(postTitle)).toBeVisible({ timeout: 30_000 });

    const cardArticle = page.locator(`article:has-text("${postTitle}")`).first();
    await expect(cardArticle).toBeVisible({ timeout: 10_000 });
    const cardTestId = await cardArticle.getAttribute('data-testid');
    expect(cardTestId, 'Card article must have data-testid attribute').toBeTruthy();
    const safeLoopCardId = cardTestId?.replace(/^marketing-card-/, '') ?? null;
    expect(safeLoopCardId, 'card_id must be extractable from data-testid').toBeTruthy();

    await page.getByTestId(`marketing-card-dispatch-plan-${safeLoopCardId}`).click();
    await expect(page.getByTestId('marketing-card-dispatch-plan-result')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('marketing-card-dispatch-record-review').click();
    await expect(page.getByTestId('marketing-card-dispatch-approval-result')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('marketing-card-dispatch-approve-receipt').click();
    await expect(page.getByTestId('marketing-card-dispatch-decision-result')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId(`marketing-dispatch-queue-status-${safeLoopCardId}`)).toContainText(
      /freigegeben|approved/
    );

    const safeLoopButton = page.getByTestId(`marketing-dispatch-queue-run-safe-local-loop-${safeLoopCardId}`);
    await expect(safeLoopButton).toBeEnabled({ timeout: 30_000 });
    await safeLoopButton.click();

    const dispatcherPrepareResult = page.getByTestId('marketing-worker-dispatcher-prepare-result');
    await expect(dispatcherPrepareResult).toBeVisible({ timeout: 60_000 });
    await expect(dispatcherPrepareResult).toContainText(/command-eve-worker-dispatcher-prepare-packet/);
    await expect(dispatcherPrepareResult).toContainText(/subprocess_spawned.*false|subprocess.*false/);
    await expect(page.getByTestId(`marketing-generated-draft-preview-${safeLoopCardId}`)).toContainText(postTitle, {
      timeout: 30_000,
    });
    await expect(page.getByTestId(`marketing-approved-output-preview-${safeLoopCardId}`)).toContainText(postTitle, {
      timeout: 30_000,
    });
    await expect(page.getByTestId(`marketing-worker-observed-preview-${safeLoopCardId}`)).toContainText(
      /worker\.reported/,
      { timeout: 30_000 }
    );
    await expect(page.getByTestId(`marketing-worker-start-gate-preview-${safeLoopCardId}`)).toContainText(
      /command-eve-worker-start-packet/,
      { timeout: 30_000 }
    );
    await expect(page.getByTestId(`marketing-worker-dispatcher-prepare-preview-${safeLoopCardId}`)).toContainText(
      /command-eve-worker-dispatcher-prepare-packet/,
      { timeout: 30_000 }
    );
    await expect(
      page.getByTestId(`marketing-dispatch-queue-worker-dispatcher-prepared-tag-${safeLoopCardId}`)
    ).toContainText(/Dispatcher|vorbereitet|prepared/);
    await expect(page.getByTestId(`marketing-dispatch-queue-next-${safeLoopCardId}`)).toContainText(
      /Release|Freigabe|Dispatcher|prepared/
    );

    const safeLoopEventRows = sqliteQuery(
      safeLoopBoardDbPath!,
      `SELECT kind, payload FROM task_events WHERE task_id = '${safeLoopCardId}' AND kind IN (
        'command_eve_marketing_draft_generated',
        'command_eve_marketing_output_approved',
        'command_eve_marketing_worker_dispatch_requested',
        'command_eve_marketing_worker_observed_run_completed',
        'command_eve_marketing_worker_start_gate_checked',
        'command_eve_marketing_worker_dispatcher_prepared'
      )`
    );
    const safeLoopKinds = new Set(safeLoopEventRows.map((row) => row[0]));
    for (const kind of [
      'command_eve_marketing_draft_generated',
      'command_eve_marketing_output_approved',
      'command_eve_marketing_worker_dispatch_requested',
      'command_eve_marketing_worker_observed_run_completed',
      'command_eve_marketing_worker_start_gate_checked',
      'command_eve_marketing_worker_dispatcher_prepared',
    ]) {
      expect(safeLoopKinds.has(kind), `${kind} receipt must exist for ${safeLoopCardId}`).toBe(true);
    }

    for (const [kind, payloadText] of safeLoopEventRows) {
      const payload = JSON.parse(payloadText) as {
        controller_approved?: boolean;
        subprocess_spawned?: boolean;
        external_calls?: boolean;
        nl5_gate_checked?: boolean;
        release_blocked?: boolean;
        worker_start_gate_status?: string;
        dispatcher_prepare_status?: string;
        dispatcher_prepare_packet?: {
          version?: string;
          subprocess_spawned?: boolean;
          external_calls?: boolean;
          release_blocked?: boolean;
        };
      };
      expect(payload.controller_approved, `${kind} must stay controller-approved`).toBe(true);
      expect(payload.subprocess_spawned, `${kind} must not spawn subprocesses`).toBe(false);
      expect(payload.nl5_gate_checked, `${kind} must keep NL-5 checked`).toBe(true);
      if ('external_calls' in payload) {
        expect(payload.external_calls, `${kind} must not call external services`).toBe(false);
      }
      if (kind === 'command_eve_marketing_worker_start_gate_checked') {
        expect(payload.release_blocked, `${kind} must stay release-blocked`).toBe(true);
        expect(payload.worker_start_gate_status).toBe('ready');
      }
      if (kind === 'command_eve_marketing_worker_dispatcher_prepared') {
        expect(payload.release_blocked, `${kind} must stay release-blocked`).toBe(true);
        expect(payload.dispatcher_prepare_status).toBe('ready');
        expect(payload.dispatcher_prepare_packet).toMatchObject({
          version: 'command-eve-worker-dispatcher-prepare-packet/v0',
          subprocess_spawned: false,
          external_calls: false,
          release_blocked: true,
        });
      }
    }

    const ledgerLines = fs.readFileSync(e2eLedgerPath, 'utf8').split('\n').filter(Boolean);
    const matchingSafeLoopDispatcherAudit = ledgerLines.find((line) => {
      try {
        const evt = JSON.parse(line) as { event_type?: string; issue_id?: string; payload?: Record<string, unknown> };
        return (
          evt.issue_id === safeLoopCardId &&
          evt.event_type === 'kanban.marketing_board_worker_dispatcher_prepared' &&
          evt.payload?.dispatcher_prepare_status === 'ready' &&
          evt.payload?.subprocess_spawned === false &&
          evt.payload?.external_calls === false
        );
      } catch {
        return false;
      }
    });
    expect(
      matchingSafeLoopDispatcherAudit,
      `audit ledger must contain safe-loop dispatcher prepare for card_id=${safeLoopCardId}`
    ).toBeTruthy();

    const screenshotPath = 'tests/e2e/results/command-eve-kanban-board-safe-local-loop.png';
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await testInfo.attach('kanban-board-safe-local-loop-proof', { path: screenshotPath, contentType: 'image/png' });
  });

  // ── TEST 6: Embedded NL-5 fallback ─────────────────────────────────────────
  test('dispatch gate: GUI click uses embedded NL-5 when Company.OS dispatch CLI is unavailable', async ({
    page,
    electronApp,
  }, testInfo) => {
    const nl5FixtureRoot = process.env.COMMAND_EVE_NL5_COMPANY_OS_ROOT;
    if (nl5FixtureRoot) {
      fs.rmSync(nl5FixtureRoot, { recursive: true, force: true });
    }

    const userDataPath = await electronApp.evaluate(async ({ app }) => app.getPath('userData'));
    const reconciliationPath = path.join(
      userDataPath,
      'command-eve-runtime',
      'capabilities',
      'command-eve-runtime-reconciliation.json'
    );
    writeReconciliationLock(reconciliationPath);

    await page.waitForSelector('body', { state: 'visible' });
    await page.reload();
    await page.waitForSelector('body', { state: 'visible' });
    await page.evaluate(() => {
      window.location.hash = '#/command-center';
    });
    await expect(page.getByText(/Command Center|Kommandozentrale/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Marketing Board/).first()).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: /Proof-Karte anlegen|Create proof card/ }).click();
    await expect(page.getByText(/KANBAN_MARKETING_PROOF_CARD_CREATED|KANBAN_MARKETING_PROOF_CARD_EXISTS/)).toBeVisible({
      timeout: 60_000,
    });

    const createOpenBtn = page.getByTestId('marketing-card-create-open');
    await expect(createOpenBtn).toBeEnabled({ timeout: 30_000 });
    const dbPathLabel = await page.locator('span:has-text("/kanban/boards/marketing/kanban.db")').first().textContent();
    const dbPathMatch = dbPathLabel?.match(/([^\s]+kanban\.db)/);
    const embeddedBoardDbPath = dbPathMatch?.[1] ?? null;
    expect(embeddedBoardDbPath, 'Board db_path must be visible for embedded NL-5 proof').toBeTruthy();

    const postTitle = `${uniquePostTitle()} Embedded NL5`;
    await createOpenBtn.click();
    await expect(page.getByTestId('marketing-card-create-modal')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('marketing-card-create-title').fill(postTitle);
    await page
      .getByTestId('marketing-card-create-description')
      .fill('Embedded NL-5 proof with German phone +49 30 12345678 and no external Company.OS CLI.');
    await page.getByTestId('marketing-card-create-submit').click();
    await expect(page.getByTestId('marketing-card-create-modal')).not.toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('KANBAN_MARKETING_CARD_CREATED')).toBeVisible({ timeout: 60_000 });

    const cardArticle = page.locator(`article:has-text("${postTitle}")`).first();
    await expect(cardArticle).toBeVisible({ timeout: 10_000 });
    const cardTestId = await cardArticle.getAttribute('data-testid');
    const embeddedCardId = cardTestId?.replace(/^marketing-card-/, '') ?? null;
    expect(embeddedCardId, 'embedded NL-5 card_id must be extractable').toBeTruthy();

    await page.getByTestId(`marketing-card-dispatch-plan-${embeddedCardId}`).click();

    const dispatchResult = page.getByTestId('marketing-card-dispatch-plan-result');
    await expect(dispatchResult).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('marketing-card-dispatch-plan-source')).toHaveText('command-eve-embedded-nl5', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('marketing-card-dispatch-handoff')).toContainText(/role:cmo\s*\/\s*manual/, {
      timeout: 30_000,
    });
    await expect(page.getByTestId('marketing-card-dispatch-approval-panel')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('marketing-card-dispatch-approval-state')).toContainText(
      /wartet auf Controller|waiting for controller/
    );
    await expect(page.getByTestId('marketing-card-dispatch-approve-receipt')).toBeEnabled();
    await expect(page.getByTestId('marketing-card-dispatch-plan-reason')).toHaveText(
      /hermes\.pre_generation\.controller_approval_missing/
    );
    await expect(dispatchResult.getByText(/Hermes: nicht gestartet|Hermes: not spawned/)).toBeVisible({
      timeout: 30_000,
    });

    const dispatchRows = sqliteQuery(
      embeddedBoardDbPath!,
      `SELECT kind, payload FROM task_events WHERE task_id = '${embeddedCardId}' AND kind = 'command_eve_dispatch_plan_checked' LIMIT 1`
    );
    expect(dispatchRows.length, `embedded dispatch receipt must exist for ${embeddedCardId}`).toBeGreaterThan(0);
    const dispatchPayload = JSON.parse(dispatchRows[0][1]) as {
      nl5_gate_checked?: boolean;
      subprocess_spawned?: boolean;
      dispatch_source?: string;
      dispatch_source_reason?: string;
      reason_codes?: string[];
      policy?: {
        dispatch_source?: string;
        dispatch_source_reason?: string;
        implementation?: string;
        data_boundary_receipt?: { finding_count?: number; raw_text_stored?: boolean };
      };
      dispatch_handoff_packet?: {
        version?: string;
        dispatch?: string;
        role_label?: string;
        safety?: { dispatch_source?: string; subprocess_spawned?: boolean };
      };
    };
    expect(dispatchPayload.nl5_gate_checked).toBe(true);
    expect(dispatchPayload.subprocess_spawned).toBe(false);
    expect(dispatchPayload.dispatch_source).toBe('command-eve-embedded-nl5');
    expect(dispatchPayload.policy?.dispatch_source).toBe('command-eve-embedded-nl5');
    expect(dispatchPayload.dispatch_source_reason || dispatchPayload.policy?.dispatch_source_reason || '').toContain(
      'embedded NL-5'
    );
    expect(dispatchPayload.reason_codes).toContain('hermes.pre_generation.controller_approval_missing');
    expect(dispatchPayload.dispatch_handoff_packet).toMatchObject({
      version: 'command-eve-local-dispatch-handoff/v0',
      dispatch: 'manual',
      role_label: 'role:cmo',
      safety: expect.objectContaining({
        dispatch_source: 'command-eve-embedded-nl5',
        subprocess_spawned: false,
      }),
    });
    expect(dispatchPayload.policy?.implementation).toBe('command-eve-embedded-nl5');
    expect(dispatchPayload.policy?.data_boundary_receipt?.raw_text_stored).toBe(false);
    expect(dispatchPayload.policy?.data_boundary_receipt?.finding_count ?? 0).toBeGreaterThanOrEqual(1);

    const ledgerLines = fs.readFileSync(e2eLedgerPath, 'utf8').split('\n').filter(Boolean);
    const matchingEmbeddedAudit = ledgerLines.find((line) => {
      try {
        const evt = JSON.parse(line) as { event_type?: string; issue_id?: string; payload?: Record<string, unknown> };
        return (
          evt.issue_id === embeddedCardId &&
          evt.event_type === 'kanban.marketing_board_dispatch_plan_checked' &&
          evt.payload?.subprocess_spawned === false &&
          (evt.payload?.dispatch_handoff_packet as { dispatch?: string } | undefined)?.dispatch === 'manual'
        );
      } catch {
        return false;
      }
    });
    expect(
      matchingEmbeddedAudit,
      `audit ledger must contain embedded NL-5 dispatch event for card_id=${embeddedCardId}`
    ).toBeTruthy();

    const screenshotPath = 'tests/e2e/results/command-eve-kanban-board-embedded-nl5.png';
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await testInfo.attach('kanban-board-embedded-nl5-proof', { path: screenshotPath, contentType: 'image/png' });
  });

  // ── TEST 7: CRM overlay init ──────────────────────────────────────────────
  test('crm overlay: GUI click initializes local-only CRM schema + audit receipt', async ({
    page,
    electronApp,
  }, testInfo) => {
    const userDataPath = await electronApp.evaluate(async ({ app }) => app.getPath('userData'));
    removeCrmOverlayDatabases(userDataPath);
    const reconciliationPath = path.join(
      userDataPath,
      'command-eve-runtime',
      'capabilities',
      'command-eve-runtime-reconciliation.json'
    );
    writeReconciliationLock(reconciliationPath);

    await page.waitForSelector('body', { state: 'visible' });
    await page.reload();
    await page.waitForSelector('body', { state: 'visible' });
    await page.evaluate(() => {
      window.location.hash = '#/command-center';
    });
    await expect(page.getByText(/Command Center|Kommandozentrale/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/CRM Overlay/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Marketing Board/).first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /Proof-Karte anlegen|Create proof card/ }).click();
    await expect(page.getByText(/KANBAN_MARKETING_PROOF_CARD_CREATED|KANBAN_MARKETING_PROOF_CARD_EXISTS/)).toBeVisible({
      timeout: 60_000,
    });
    const crmMarketingDbPathLabel = await page
      .locator('span:has-text("/kanban/boards/marketing/kanban.db")')
      .first()
      .textContent();
    const crmMarketingDbPathMatch = crmMarketingDbPathLabel?.match(/([^\s]+kanban\.db)/);
    const crmMarketingDbPath = crmMarketingDbPathMatch?.[1] ?? null;
    expect(crmMarketingDbPath, 'Marketing board db_path must be visible for CRM handoff proof').toBeTruthy();

    await expect(page.getByTestId('crm-overlay-blocked')).toBeVisible({ timeout: 30_000 });

    const initializeButton = page.getByTestId('crm-overlay-initialize');
    await expect(initializeButton).toBeVisible({ timeout: 30_000 });
    await expect(initializeButton).toBeEnabled({ timeout: 30_000 });
    await initializeButton.click();

    await expect(page.getByTestId('crm-overlay-initialize-result')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/CRM_OVERLAY_INITIALIZED_LOCAL_ONLY/)).toBeVisible({ timeout: 60_000 });
    await expect(initializeButton).toBeDisabled({ timeout: 30_000 });

    const dbPathLabel = await page.getByTestId('crm-overlay-db-path').textContent();
    const crmDbPath = dbPathLabel?.trim() || '';
    expect(crmDbPath, 'CRM overlay db path must be visible').toContain('command-eve-crm.db');

    const tableRows = sqliteQuery(crmDbPath, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    expect(tableRows).toEqual([
      ['crm_companies'],
      ['crm_contacts'],
      ['crm_deals'],
      ['crm_events'],
      ['sqlite_sequence'],
    ]);
    const crmEventRows = sqliteQuery(
      crmDbPath,
      "SELECT kind, payload FROM crm_events WHERE kind = 'crm_overlay_initialized'"
    );
    expect(crmEventRows.length, 'crm_events initialization receipt must exist').toBeGreaterThan(0);
    const crmEventPayload = JSON.parse(crmEventRows[0][1]) as {
      local_only?: boolean;
      hosted_sync_enabled?: boolean;
      outreach_enabled?: boolean;
      human_gate?: string;
    };
    expect(crmEventPayload.local_only).toBe(true);
    expect(crmEventPayload.hosted_sync_enabled).toBe(false);
    expect(crmEventPayload.outreach_enabled).toBe(false);
    expect(crmEventPayload.human_gate).toBe('HG-4');

    const draftButton = page.getByTestId('crm-draft-create');
    await expect(draftButton).toBeVisible({ timeout: 30_000 });
    await expect(draftButton).toBeEnabled({ timeout: 30_000 });
    await draftButton.click();
    await expect(page.getByText(/Lokalen CRM-Draft anlegen|Create local CRM draft/)).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('crm-draft-company-name').fill('Alois Consulting GmbH');
    await page.getByTestId('crm-draft-contact-name').fill('Alois Beispiel');
    await page.getByTestId('crm-draft-role-title').fill('Geschaeftsfuehrer');
    await page.getByTestId('crm-draft-deal-label').fill('Outreach Pilot');
    await page.getByTestId('crm-draft-notes').fill('Local-only CRM draft note.');
    await page.getByRole('button', { name: /^Draft anlegen$|^Create draft$/ }).click();

    await expect(page.getByTestId('crm-draft-create-result')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/CRM_DRAFT_DEAL_CREATED_LOCAL_ONLY/)).toBeVisible({ timeout: 60_000 });
    const draftDealList = page.getByTestId('crm-draft-deal-list');
    await expect(draftDealList).toBeVisible({ timeout: 30_000 });
    await expect(draftDealList.getByText('Alois Consulting GmbH')).toBeVisible({ timeout: 30_000 });
    await expect(draftDealList.getByText('Alois Beispiel · Geschaeftsfuehrer')).toBeVisible({ timeout: 30_000 });
    await expect(draftDealList.getByText('Outreach Pilot')).toBeVisible({ timeout: 30_000 });
    await expect(draftDealList.getByText(/crm-deal-/)).toBeVisible({ timeout: 30_000 });
    await expect(draftDealList.getByText('draft-only')).toBeVisible({ timeout: 30_000 });
    await expect(draftDealList.getByText('unknown')).toBeVisible({ timeout: 30_000 });
    await expect(draftDealList.getByText('HG-4')).toBeVisible({ timeout: 30_000 });
    await expect(draftDealList.getByText('S2')).toBeVisible({ timeout: 30_000 });

    const qualifyButton = draftDealList.getByRole('button', { name: /Qualifizieren|Qualify/ }).first();
    await expect(qualifyButton).toBeVisible({ timeout: 30_000 });
    await expect(qualifyButton).toBeEnabled({ timeout: 30_000 });
    await qualifyButton.click();

    await expect(page.getByTestId('crm-stage-local-result')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/CRM_STAGE_CHANGED_LOCAL_ONLY/)).toBeVisible({ timeout: 60_000 });
    await expect(draftDealList.getByText('qualified')).toBeVisible({ timeout: 30_000 });

    const consentButton = draftDealList.getByRole('button', { name: /Consent notieren|Record consent/ }).first();
    await expect(consentButton).toBeVisible({ timeout: 30_000 });
    await expect(consentButton).toBeEnabled({ timeout: 30_000 });
    await consentButton.click();

    await expect(page.getByTestId('crm-consent-local-result')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/CRM_CONSENT_CAPTURED_LOCAL_ONLY/)).toBeVisible({ timeout: 60_000 });
    await expect(draftDealList.getByText('captured-local')).toBeVisible({ timeout: 30_000 });
    await expect(draftDealList.getByText('review-only')).toBeVisible({ timeout: 30_000 });

    const marketingRequestButton = page.locator('[data-testid^="crm-create-marketing-request-"]').first();
    await expect(marketingRequestButton).toBeVisible({ timeout: 30_000 });
    await expect(marketingRequestButton).toBeEnabled({ timeout: 30_000 });
    await marketingRequestButton.click();

    await expect
      .poll(() => sqliteQuery(crmMarketingDbPath!, "SELECT id FROM tasks WHERE title = 'Outreach Pilot'").length, {
        message: 'CRM handoff must create a local marketing task row',
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
    const crmMarketingTaskRows = sqliteQuery(
      crmMarketingDbPath!,
      "SELECT id, title, current_step_key FROM tasks WHERE title = 'Outreach Pilot' ORDER BY created_at DESC LIMIT 1"
    );
    const crmMarketingCardId = crmMarketingTaskRows[0]?.[0] ?? '';
    expect(crmMarketingCardId, 'CRM marketing request card id must be persisted in tasks').toMatch(
      /^t_command_eve_marketing_/
    );
    expect(crmMarketingTaskRows[0]?.[1]).toBe('Outreach Pilot');
    expect(crmMarketingTaskRows[0]?.[2]).toBe('research');
    const crmMarketingBodyRows = sqliteQuery(
      crmMarketingDbPath!,
      `SELECT COUNT(*) FROM tasks WHERE id = '${crmMarketingCardId}' AND body LIKE '%CRM deal:%' AND body LIKE '%Company: Alois Consulting GmbH%' AND body LIKE '%Source: Command EVE local CRM overlay%'`
    );
    expect(Number(crmMarketingBodyRows[0]?.[0] || 0), 'CRM handoff body must persist source metadata').toBe(1);
    await expect(page.getByTestId(`marketing-dispatch-queue-item-${crmMarketingCardId}`)).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId(`marketing-dispatch-queue-loop-progress-${crmMarketingCardId}`)).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId(`marketing-dispatch-queue-loop-step-controller-${crmMarketingCardId}`)).toContainText(
      /Controller/
    );
    await expect(page.getByTestId(`marketing-dispatch-queue-loop-step-draft-${crmMarketingCardId}`)).toContainText(
      /Draft/
    );
    await expect(page.getByTestId(`marketing-dispatch-queue-crm-source-${crmMarketingCardId}`)).toContainText(
      /CRM-Handoff|CRM handoff/,
      { timeout: 30_000 }
    );
    await expect(page.getByTestId(`marketing-dispatch-queue-crm-company-${crmMarketingCardId}`)).toContainText(
      'Alois Consulting GmbH'
    );
    await expect(page.getByTestId(`marketing-dispatch-queue-status-${crmMarketingCardId}`)).toContainText(
      /ausstehend|pending/
    );
    const crmMarketingDispatchRows = sqliteQuery(
      crmMarketingDbPath!,
      `SELECT kind, payload FROM task_events WHERE task_id = '${crmMarketingCardId}' AND kind = 'command_eve_dispatch_plan_checked' LIMIT 1`
    );
    expect(crmMarketingDispatchRows.length, 'CRM handoff dispatch receipt must exist').toBeGreaterThan(0);
    const crmMarketingDispatchPayload = JSON.parse(crmMarketingDispatchRows[0][1]) as {
      subprocess_spawned?: boolean;
      nl5_gate_checked?: boolean;
      dispatch_handoff_packet?: { dispatch?: string };
      reason_codes?: string[];
    };
    expect(crmMarketingDispatchPayload.subprocess_spawned).toBe(false);
    expect(crmMarketingDispatchPayload.nl5_gate_checked).toBe(true);
    expect(crmMarketingDispatchPayload.dispatch_handoff_packet?.dispatch).toBe('manual');
    expect(crmMarketingDispatchPayload.reason_codes).toContain('hermes.pre_generation.controller_approval_missing');
    const crmMarketingApprovalRows = sqliteQuery(
      crmMarketingDbPath!,
      `SELECT kind, payload FROM task_events WHERE task_id = '${crmMarketingCardId}' AND kind = 'command_eve_controller_approval_pending' LIMIT 1`
    );
    expect(crmMarketingApprovalRows.length, 'CRM handoff controller approval receipt must exist').toBeGreaterThan(0);
    const crmMarketingApprovalPayload = JSON.parse(crmMarketingApprovalRows[0][1]) as {
      controller_approval_status?: string;
      subprocess_spawned?: boolean;
      human_gate?: string;
      reason_codes?: string[];
    };
    expect(crmMarketingApprovalPayload.controller_approval_status).toBe('pending');
    expect(crmMarketingApprovalPayload.subprocess_spawned).toBe(false);
    expect(crmMarketingApprovalPayload.human_gate).toBe('HG-2.5');
    expect(crmMarketingApprovalPayload.reason_codes).toContain('command_eve.controller_approval_pending');

    await page.getByTestId('marketing-card-dispatch-approve-receipt').click();
    await expect(page.getByTestId('marketing-card-dispatch-decision-result')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId(`marketing-dispatch-queue-status-${crmMarketingCardId}`)).toContainText(
      /freigegeben|approved/
    );

    const crmSafeLoopButton = page.getByTestId(`marketing-dispatch-queue-run-safe-local-loop-${crmMarketingCardId}`);
    await expect(crmSafeLoopButton).toBeEnabled({ timeout: 30_000 });
    await crmSafeLoopButton.click();

    await expect(page.getByTestId('marketing-worker-dispatcher-prepare-result')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId(`marketing-generated-draft-preview-${crmMarketingCardId}`)).toContainText(
      'Outreach Pilot',
      { timeout: 30_000 }
    );
    await expect(page.getByTestId(`marketing-approved-output-preview-${crmMarketingCardId}`)).toContainText(
      'Outreach Pilot',
      { timeout: 30_000 }
    );
    await expect(page.getByTestId(`marketing-worker-observed-preview-${crmMarketingCardId}`)).toContainText(
      /worker\.reported/,
      { timeout: 30_000 }
    );
    await expect(page.getByTestId(`marketing-worker-start-gate-preview-${crmMarketingCardId}`)).toContainText(
      /command-eve-worker-start-packet/,
      { timeout: 30_000 }
    );
    await expect(page.getByTestId(`marketing-worker-dispatcher-prepare-preview-${crmMarketingCardId}`)).toContainText(
      /command-eve-worker-dispatcher-prepare-packet/,
      { timeout: 30_000 }
    );
    await expect(
      page.getByTestId(`marketing-dispatch-queue-worker-dispatcher-prepared-tag-${crmMarketingCardId}`)
    ).toContainText(/Dispatcher|vorbereitet|prepared/);
    await expect(page.getByTestId(`marketing-dispatch-queue-loop-step-output-${crmMarketingCardId}`)).toContainText(
      /Output/
    );
    await expect(page.getByTestId(`marketing-dispatch-queue-loop-step-handoff-${crmMarketingCardId}`)).toContainText(
      /Handoff|handoff/
    );
    await expect(page.getByTestId(`marketing-dispatch-queue-loop-step-observed-${crmMarketingCardId}`)).toContainText(
      /Observed|observed/
    );
    await expect(page.getByTestId(`marketing-dispatch-queue-loop-step-startGate-${crmMarketingCardId}`)).toContainText(
      /Start-Gate|Start gate/
    );
    await expect(page.getByTestId(`marketing-dispatch-queue-loop-step-dispatcher-${crmMarketingCardId}`)).toContainText(
      /Dispatcher/
    );

    const crmSafeLoopEventRows = sqliteQuery(
      crmMarketingDbPath!,
      `SELECT kind, payload FROM task_events WHERE task_id = '${crmMarketingCardId}' AND kind IN (
        'command_eve_marketing_draft_generated',
        'command_eve_marketing_output_approved',
        'command_eve_marketing_worker_dispatch_requested',
        'command_eve_marketing_worker_observed_run_completed',
        'command_eve_marketing_worker_start_gate_checked',
        'command_eve_marketing_worker_dispatcher_prepared'
      )`
    );
    const crmSafeLoopKinds = new Set(crmSafeLoopEventRows.map((row) => row[0]));
    for (const kind of [
      'command_eve_marketing_draft_generated',
      'command_eve_marketing_output_approved',
      'command_eve_marketing_worker_dispatch_requested',
      'command_eve_marketing_worker_observed_run_completed',
      'command_eve_marketing_worker_start_gate_checked',
      'command_eve_marketing_worker_dispatcher_prepared',
    ]) {
      expect(crmSafeLoopKinds.has(kind), `${kind} receipt must exist for CRM handoff ${crmMarketingCardId}`).toBe(true);
    }

    for (const [kind, payloadText] of crmSafeLoopEventRows) {
      const payload = JSON.parse(payloadText) as {
        controller_approved?: boolean;
        subprocess_spawned?: boolean;
        external_calls?: boolean;
        nl5_gate_checked?: boolean;
        release_blocked?: boolean;
        worker_start_gate_status?: string;
        dispatcher_prepare_status?: string;
        dispatcher_prepare_packet?: {
          version?: string;
          subprocess_spawned?: boolean;
          external_calls?: boolean;
          release_blocked?: boolean;
        };
      };
      expect(payload.controller_approved, `${kind} must stay controller-approved`).toBe(true);
      expect(payload.subprocess_spawned, `${kind} must not spawn subprocesses`).toBe(false);
      expect(payload.nl5_gate_checked, `${kind} must keep NL-5 checked`).toBe(true);
      if ('external_calls' in payload) {
        expect(payload.external_calls, `${kind} must not call external services`).toBe(false);
      }
      if (kind === 'command_eve_marketing_worker_start_gate_checked') {
        expect(payload.release_blocked, `${kind} must stay release-blocked`).toBe(true);
        expect(payload.worker_start_gate_status).toBe('ready');
      }
      if (kind === 'command_eve_marketing_worker_dispatcher_prepared') {
        expect(payload.release_blocked, `${kind} must stay release-blocked`).toBe(true);
        expect(payload.dispatcher_prepare_status).toBe('ready');
        expect(payload.dispatcher_prepare_packet).toMatchObject({
          version: 'command-eve-worker-dispatcher-prepare-packet/v0',
          subprocess_spawned: false,
          external_calls: false,
          release_blocked: true,
        });
      }
    }

    await expect(page.getByTestId('command-center-operating-readiness')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('operating-readiness-crmNl5Receipts')).toContainText(/ready|bereit/);

    const dealRows = sqliteQuery(
      crmDbPath,
      'SELECT stage, allowed_actions, consent_status, human_gate, data_class, notes_ref FROM crm_deals'
    );
    expect(dealRows).toEqual([['qualified', 'review-only', 'captured-local', 'HG-4', 'S2', 'Outreach Pilot']]);
    const companyRows = sqliteQuery(crmDbPath, 'SELECT display_name FROM crm_companies');
    expect(companyRows).toEqual([['Alois Consulting GmbH']]);
    const contactRows = sqliteQuery(crmDbPath, 'SELECT display_name, role_title, notes_ref FROM crm_contacts');
    expect(contactRows).toEqual([['Alois Beispiel', 'Geschaeftsfuehrer', 'Local-only CRM draft note.']]);
    const draftEventRows = sqliteQuery(
      crmDbPath,
      "SELECT kind, payload FROM crm_events WHERE kind = 'crm_draft_deal_created'"
    );
    expect(draftEventRows.length, 'crm_events draft receipt must exist').toBeGreaterThan(0);
    const draftEventPayload = JSON.parse(draftEventRows[0][1]) as {
      local_only?: boolean;
      outreach_enabled?: boolean;
      consent_status?: string;
      allowed_actions?: string;
      human_gate?: string;
      company_label_length?: number;
      contact_label_length?: number;
      deal_label_length?: number;
      data_boundary_checked?: boolean;
      data_boundary_receipt?: { version?: string; action?: string; status?: string };
    };
    expect(draftEventPayload.local_only).toBe(true);
    expect(draftEventPayload.outreach_enabled).toBe(false);
    expect(draftEventPayload.consent_status).toBe('unknown');
    expect(draftEventPayload.allowed_actions).toBe('draft-only');
    expect(draftEventPayload.human_gate).toBe('HG-4');
    expect(draftEventPayload.company_label_length).toBe('Alois Consulting GmbH'.length);
    expect(draftEventPayload.contact_label_length).toBe('Alois Beispiel'.length);
    expect(draftEventPayload.deal_label_length).toBe('Outreach Pilot'.length);
    expect(draftEventPayload.data_boundary_checked).toBe(true);
    expect(draftEventPayload.data_boundary_receipt).toMatchObject({
      version: 'command-eve-crm-nl5-local-receipt/v0',
      action: 'crm_draft_deal_create',
      status: 'local-only-pass',
    });
    const stageEventRows = sqliteQuery(
      crmDbPath,
      "SELECT kind, payload FROM crm_events WHERE kind = 'crm_draft_deal_stage_changed'"
    );
    expect(stageEventRows.length, 'crm_events stage receipt must exist').toBeGreaterThan(0);
    const stageEventPayload = JSON.parse(stageEventRows[0][1]) as {
      local_only?: boolean;
      outreach_enabled?: boolean;
      subprocess_spawned?: boolean;
      consent_status?: string;
      allowed_actions?: string;
      human_gate?: string;
      stage?: string;
      data_boundary_checked?: boolean;
      data_boundary_receipt?: { version?: string; action?: string; status?: string };
    };
    expect(stageEventPayload.local_only).toBe(true);
    expect(stageEventPayload.outreach_enabled).toBe(false);
    expect(stageEventPayload.subprocess_spawned).toBe(false);
    expect(stageEventPayload.consent_status).toBe('unknown');
    expect(stageEventPayload.allowed_actions).toBe('draft-only');
    expect(stageEventPayload.human_gate).toBe('HG-4');
    expect(stageEventPayload.stage).toBe('qualified');
    expect(stageEventPayload.data_boundary_checked).toBe(true);
    expect(stageEventPayload.data_boundary_receipt).toMatchObject({
      version: 'command-eve-crm-nl5-local-receipt/v0',
      action: 'crm_draft_deal_stage_local',
      status: 'local-only-pass',
    });
    const consentEventRows = sqliteQuery(
      crmDbPath,
      "SELECT kind, payload FROM crm_events WHERE kind = 'crm_consent_captured_local'"
    );
    expect(consentEventRows.length, 'crm_events consent receipt must exist').toBeGreaterThan(0);
    const consentEventPayload = JSON.parse(consentEventRows[0][1]) as {
      local_only?: boolean;
      outreach_enabled?: boolean;
      subprocess_spawned?: boolean;
      consent_status?: string;
      consent_basis?: string;
      consent_source?: string;
      allowed_actions?: string;
      human_gate?: string;
      data_class?: string;
      data_boundary_checked?: boolean;
      data_boundary_receipt?: { version?: string; action?: string; status?: string };
    };
    expect(consentEventPayload.local_only).toBe(true);
    expect(consentEventPayload.outreach_enabled).toBe(false);
    expect(consentEventPayload.subprocess_spawned).toBe(false);
    expect(consentEventPayload.consent_status).toBe('captured-local');
    expect(consentEventPayload.consent_basis).toBe('manual-founder-confirmation');
    expect(consentEventPayload.consent_source).toBe('command-eve-local-ui');
    expect(consentEventPayload.allowed_actions).toBe('review-only');
    expect(consentEventPayload.human_gate).toBe('HG-4');
    expect(consentEventPayload.data_class).toBe('S2');
    expect(consentEventPayload.data_boundary_checked).toBe(true);
    expect(consentEventPayload.data_boundary_receipt).toMatchObject({
      version: 'command-eve-crm-nl5-local-receipt/v0',
      action: 'crm_consent_capture_local',
      status: 'local-only-pass',
    });

    const ledgerLines = fs.readFileSync(e2eLedgerPath, 'utf8').split('\n').filter(Boolean);
    const matchingCrmAudit = ledgerLines.find((line) => {
      try {
        const evt = JSON.parse(line) as { event_type?: string; payload?: Record<string, unknown> };
        return evt.event_type === 'crm.overlay_initialized' && evt.payload?.local_only === true;
      } catch {
        return false;
      }
    });
    expect(matchingCrmAudit, 'audit ledger must contain crm.overlay_initialized').toBeTruthy();
    const matchingCrmDraftAudit = ledgerLines.find((line) => {
      try {
        const evt = JSON.parse(line) as { event_type?: string; payload?: Record<string, unknown> };
        return (
          evt.event_type === 'crm.draft_deal_created' &&
          evt.payload?.local_only === true &&
          evt.payload?.allowed_actions === 'draft-only' &&
          evt.payload?.data_boundary_checked === true
        );
      } catch {
        return false;
      }
    });
    expect(matchingCrmDraftAudit, 'audit ledger must contain crm.draft_deal_created').toBeTruthy();
    const matchingCrmStageAudit = ledgerLines.find((line) => {
      try {
        const evt = JSON.parse(line) as { event_type?: string; payload?: Record<string, unknown> };
        return (
          evt.event_type === 'crm.draft_deal_stage_changed' &&
          evt.payload?.local_only === true &&
          evt.payload?.subprocess_spawned === false &&
          evt.payload?.data_boundary_checked === true &&
          evt.payload?.stage === 'qualified'
        );
      } catch {
        return false;
      }
    });
    expect(matchingCrmStageAudit, 'audit ledger must contain crm.draft_deal_stage_changed').toBeTruthy();
    const matchingCrmConsentAudit = ledgerLines.find((line) => {
      try {
        const evt = JSON.parse(line) as { event_type?: string; payload?: Record<string, unknown> };
        return (
          evt.event_type === 'crm.consent_captured_local' &&
          evt.payload?.local_only === true &&
          evt.payload?.subprocess_spawned === false &&
          evt.payload?.data_boundary_checked === true &&
          evt.payload?.consent_status === 'captured-local' &&
          evt.payload?.allowed_actions === 'review-only'
        );
      } catch {
        return false;
      }
    });
    expect(matchingCrmConsentAudit, 'audit ledger must contain crm.consent_captured_local').toBeTruthy();
    const matchingCrmMarketingAudit = ledgerLines.find((line) => {
      try {
        const evt = JSON.parse(line) as { event_type?: string; issue_id?: string; payload?: Record<string, unknown> };
        return (
          evt.issue_id === crmMarketingCardId &&
          evt.event_type === 'kanban.marketing_board_controller_approval_pending' &&
          evt.payload?.controller_approval_status === 'pending' &&
          evt.payload?.subprocess_spawned === false
        );
      } catch {
        return false;
      }
    });
    expect(
      matchingCrmMarketingAudit,
      `audit ledger must contain CRM handoff controller approval for card_id=${crmMarketingCardId}`
    ).toBeTruthy();

    const screenshotPath = 'tests/e2e/results/command-eve-crm-overlay-init.png';
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await testInfo.attach('crm-overlay-init-proof', { path: screenshotPath, contentType: 'image/png' });
  });
});
