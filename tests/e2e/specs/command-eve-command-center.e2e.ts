/**
 * Command EVE Command Center – Electron bridge proof.
 *
 * Verifies the desktop app can render real Company.OS read-model data through
 * the Electron bridge. This is the GUI↔local-ledger evidence for COMPA-590.
 *
 * Path configuration (env-driven, release-machine fallback):
 *   COMMAND_EVE_COMPANY_OS_ROOT  – absolute path to the Company.OS repo root.
 *                                   Defaults to /Users/mathiasheinke/Developer/Company.OS
 *                                   (byte-for-byte release-machine behaviour when unset).
 *   COMMAND_EVE_E2E_EVENTS_LEDGER – absolute path to the clean ledger fixture.
 *                                   Defaults to <companyOsRoot>/reports/command-eve/e2e/2026-06-10/agent-events.clean.jsonl.
 * If neither env nor fallback path exists on disk the test fails loudly (no silent skip).
 */
import { E2E_AGENT_EVENTS_PATH, test, expect } from '../fixtures';
import { expectFounderOnlyBridgeDenied } from '../helpers/bridge/founderOnly';
import fs from 'fs';
import path from 'path';

const COMPANY_OS_ROOT_DEFAULT = '/Users/mathiasheinke/Developer/Company.OS';
const LEDGER_FIXTURE_RELATIVE = 'reports/command-eve/e2e/2026-06-10/agent-events.clean.jsonl';
const COMMAND_EVE_DATA_DIR_NAME = 'command-eve';
// State initialised in beforeAll, used by the test body.
let e2eLedgerPath: string = '';

// Prior env values captured in beforeAll, restored in afterAll.
let prevCompanyOsRoot: string | undefined;

test.describe('Command EVE Command Center', () => {
  test.setTimeout(120_000);

  test.beforeAll(() => {
    // Capture prior values before any mutation.
    prevCompanyOsRoot = process.env.COMMAND_EVE_COMPANY_OS_ROOT;

    const companyOsRoot: string = process.env.COMMAND_EVE_COMPANY_OS_ROOT ?? COMPANY_OS_ROOT_DEFAULT;
    const cleanLedgerSource: string =
      process.env.COMMAND_EVE_E2E_EVENTS_LEDGER ?? path.join(companyOsRoot, LEDGER_FIXTURE_RELATIVE);

    if (!fs.existsSync(cleanLedgerSource)) {
      throw new Error(
        `[command-eve-command-center e2e] Ledger fixture not found: ${cleanLedgerSource}\n` +
          `Set COMMAND_EVE_COMPANY_OS_ROOT or COMMAND_EVE_E2E_EVENTS_LEDGER to a valid path.`
      );
    }

    fs.mkdirSync(path.dirname(E2E_AGENT_EVENTS_PATH), { recursive: true });
    e2eLedgerPath = E2E_AGENT_EVENTS_PATH;
    fs.copyFileSync(cleanLedgerSource, e2eLedgerPath);

    process.env.COMMAND_EVE_COMPANY_OS_ROOT = companyOsRoot;
    // The Electron app is a singleton per Playwright worker. Keep this path
    // stable across Command EVE specs so the main process and assertions read
    // the same append-only ledger even when specs run in one worker.
    process.env.COMMAND_EVE_AGENT_EVENTS_PATH = e2eLedgerPath;
  });

  test.afterAll(() => {
    // Restore prior env values exactly.
    if (prevCompanyOsRoot === undefined) {
      delete process.env.COMMAND_EVE_COMPANY_OS_ROOT;
    } else {
      process.env.COMMAND_EVE_COMPANY_OS_ROOT = prevCompanyOsRoot;
    }
  });

  test('keeps the founder route and governed bridge private in customer mode', async ({ page, electronApp }) => {
    const userDataPath = await electronApp.evaluate(async ({ app }) => app.getPath('userData'));
    const commandEveDataPath = path.join(userDataPath, COMMAND_EVE_DATA_DIR_NAME);
    const reconciliationPath = path.join(
      commandEveDataPath,
      'command-eve-runtime',
      'capabilities',
      'command-eve-runtime-reconciliation.json'
    );
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

    await page.waitForSelector('body', { state: 'visible' });

    await page.evaluate(() => {
      window.location.hash = '#/command-center';
    });

    await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 30_000 }).toBe('#/guid');
    await expect(page.getByText(/Command Center|Kommandozentrale/)).toHaveCount(0);

    const ledgerBefore = fs.readFileSync(e2eLedgerPath, 'utf8');
    await expectFounderOnlyBridgeDenied(page, 'command-eve.command-center-read-model', { maxRuns: 50 });
    await expectFounderOnlyBridgeDenied(page, 'command-eve.kanban-marketing-proof-card', {
      boardSlug: 'marketing',
      eventLedgerPath: e2eLedgerPath,
    });
    expect(fs.readFileSync(e2eLedgerPath, 'utf8')).toBe(ledgerBefore);
  });
});
