/**
 * Public Command EVE Kanban contract.
 *
 * The customer shell exposes the seat-scoped `/kanban` board while keeping the
 * founder Marketing Command Center private. This proof initializes the same
 * native Hermes `default` board EVE writes, then drives a real create and move
 * through the public UI and checks the isolated audit ledger.
 */
import fs from 'fs';
import path from 'path';
import { E2E_AGENT_EVENTS_PATH, test, expect } from '../fixtures';
import { invokeBridge } from '../helpers';

const COMMAND_EVE_DATA_DIR_NAME = 'command-eve';

function writeReconciliationLock(userDataPath: string): void {
  const reconciliationPath = path.join(
    userDataPath,
    COMMAND_EVE_DATA_DIR_NAME,
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
}

function ledgerContains(eventType: string, cardId: string): boolean {
  if (!fs.existsSync(E2E_AGENT_EVENTS_PATH)) return false;
  return fs
    .readFileSync(E2E_AGENT_EVENTS_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .some((line) => {
      try {
        const event = JSON.parse(line) as { event_type?: string; issue_id?: string };
        return event.event_type === eventType && event.issue_id === cardId;
      } catch {
        return false;
      }
    });
}

test.describe('Command EVE public Kanban', () => {
  test.setTimeout(120_000);

  test('creates and moves a task on the native per-seat board with audit receipts', async ({ page, electronApp }) => {
    const userDataPath = await electronApp.evaluate(async ({ app }) => app.getPath('userData'));
    writeReconciliationLock(userDataPath);

    const proof = await invokeBridge<{
      success: boolean;
      data: { ok: boolean; status: string; reason_code?: string };
    }>(
      page,
      'command-eve.kanban-marketing-proof-card',
      { boardSlug: 'default', eventLedgerPath: E2E_AGENT_EVENTS_PATH },
      30_000
    );
    expect(proof.success, proof.data.reason_code).toBe(true);
    expect(proof.data.ok, proof.data.reason_code).toBe(true);

    await page.evaluate(() => {
      window.location.hash = '#/kanban';
    });
    await expect(page.getByTestId('kanban-columns')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('kanban-board-slug')).toContainText('default');

    const title = `Public E2E task ${Date.now().toString(36)}`;
    await page.getByTestId('kanban-card-create-open').click();
    await expect(page.getByTestId('kanban-card-create-modal')).toBeVisible();
    await page.getByTestId('kanban-card-create-title').fill(title);
    await page.getByTestId('kanban-card-create-description').fill('Public create and move contract');
    await page.getByTestId('kanban-card-create-submit').click();

    const card = page.locator(`article:has-text("${title}")`).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    const testId = await card.getAttribute('data-testid');
    expect(testId).toMatch(/^kanban-card-/);
    const cardId = String(testId).replace(/^kanban-card-/, '');

    await expect(page.getByTestId('kanban-lane-research').getByTestId(`kanban-card-${cardId}`)).toBeVisible();
    await expect.poll(() => ledgerContains('kanban.marketing_board_card_created', cardId)).toBe(true);

    await page.getByTestId(`kanban-card-move-${cardId}`).click();
    await expect(page.getByTestId('kanban-lane-draft').getByTestId(`kanban-card-${cardId}`)).toBeVisible({
      timeout: 30_000,
    });
    await expect.poll(() => ledgerContains('kanban.marketing_board_card_moved', cardId)).toBe(true);
  });
});
