/**
 * E2E: Workspace Files tab — real user flow.
 *
 * Creates a team with a seeded workspace, navigates to the team page, and
 * verifies the workspace panel renders with the file tree, search input, and
 * can resolve a seeded file. All interactions drive the renderer UI; the
 * backend contract for `/api/fs/*` is covered separately in the Vitest
 * integration suite (tests/integration).
 */
import { test, expect } from '../../fixtures';
import { cleanupTeamsByName, invokeBridge } from '../../helpers';
import { openWorkspaceContextPanel } from '../../helpers/workspacePanel';
import fs from 'fs';
import path from 'path';
import os from 'os';

const TEAM_NAME = `E2E Workspace Files ${Date.now()}`;

test.describe('Workspace Files — UI panel', () => {
  let workspace: string;

  test.beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-e2e-ws-files-'));
    fs.writeFileSync(path.join(workspace, 'readme.md'), '# seeded');
    fs.mkdirSync(path.join(workspace, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'notes', 'alpha.txt'), 'alpha');
    fs.writeFileSync(path.join(workspace, 'notes', 'beta.txt'), 'beta');
  });

  test.afterAll(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('workspace panel renders tree and search for a team workspace', async ({ page, electronApp }) => {
    test.setTimeout(120_000);

    // Mock native folder dialog → point at our seeded workspace so the team is
    // created with a user-specified workspace (not a temp one).
    await electronApp.evaluate(async ({ dialog }, target) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [target] });
    }, workspace);

    await cleanupTeamsByName(page, TEAM_NAME);

    // drift: the public EVE team leader only renders once the chief-of-staff assistant is
    // seeded; the boot-time seed races fresh sandboxes, so ensure it via the bridge first
    // and reload so the renderer refetches the assistants catalog.
    const ensured = await invokeBridge<{ success?: boolean; msg?: string }>(
      page,
      'command-eve.ensure-assistant',
      undefined,
      90_000
    );
    expect(ensured.success, ensured.msg || 'Command EVE assistant readiness failed').toBe(true);
    await page.reload();
    await page.waitForSelector('body', { state: 'visible' });

    // ── Create team via sidebar UI ───────────────────────────────────────
    const createBtn = page.locator('[data-testid="team-create-btn"]').first();
    await expect(createBtn).toBeVisible({ timeout: 10_000 });
    await createBtn.click();

    const modal = page.locator('.team-create-modal');
    await expect(modal).toBeVisible({ timeout: 10_000 });

    const nameInput = modal.locator('[data-testid="team-create-name-input"]');
    await nameInput.fill(TEAM_NAME);

    const commandEveOption = modal.locator('[data-testid^="team-create-agent-option-"]').first();
    await expect(commandEveOption).toBeVisible({ timeout: 5_000 });
    await commandEveOption.click();

    // Pick workspace via the mocked native dialog trigger
    const wsTrigger = modal.locator('[data-testid="team-create-workspace-trigger"]');
    await expect(wsTrigger).toBeVisible({ timeout: 5_000 });
    await wsTrigger.click();
    const menu = page.locator('[data-testid="team-create-workspace-menu"]');
    if (await menu.isVisible({ timeout: 1_000 }).catch(() => false)) {
      const chooseDifferent = menu
        .locator('text=/Choose a different folder|Anderen Ordner auswählen|选择其他文件夹/i')
        .or(menu.locator('.cursor-pointer').last());
      await chooseDifferent.first().click();
    }

    const createConfirmBtn = modal.locator('.arco-btn-primary');
    await expect(createConfirmBtn).toBeEnabled({ timeout: 5_000 });
    await createConfirmBtn.click();

    await expect(modal).toBeHidden({ timeout: 15_000 });
    await page.waitForURL(/\/team\//, { timeout: 15_000 });

    // drift: 964c3c97 .chat-workspace now lives behind the collapsed-by-default ShellElementsRail
    // "Kontext" tab — open the rail via the titlebar toggle, then activate the context tab.
    await openWorkspaceContextPanel(page);

    // ── Wait for workspace panel to mount ────────────────────────────────
    const panel = page.locator('.chat-workspace');
    await expect(panel).toBeVisible({ timeout: 30_000 });

    // Title label reflects the workspace directory name
    const title = panel.locator('.workspace-title-label').first();
    await expect(title).toBeVisible({ timeout: 15_000 });

    await page.screenshot({ path: 'tests/e2e/results/workspace-files-01-panel.png' });

    // ── Tree should list our seeded files ────────────────────────────────
    const tree = panel.locator('.workspace-tree');
    await expect(tree).toBeVisible({ timeout: 15_000 });

    // readme.md is a top-level seeded file
    await expect(panel.getByText('readme.md').first()).toBeVisible({ timeout: 10_000 });

    // ── Search input toggles + accepts a query ───────────────────────────
    const searchInput = panel.locator('.workspace-search-input input').first();
    await expect(searchInput).toBeVisible({ timeout: 5_000 });
    await searchInput.fill('readme');
    await expect(searchInput).toHaveValue('readme', { timeout: 3_000 });

    // Search narrows the visible entries — readme.md stays visible
    await expect(panel.getByText('readme.md').first()).toBeVisible({ timeout: 5_000 });

    await searchInput.fill('');

    await page.screenshot({ path: 'tests/e2e/results/workspace-files-02-tree.png' });

    // ── Cleanup ──────────────────────────────────────────────────────────
    await cleanupTeamsByName(page, TEAM_NAME);
  });
});
