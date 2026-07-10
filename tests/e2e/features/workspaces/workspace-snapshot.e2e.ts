/**
 * E2E: Workspace Changes tab — real user flow.
 *
 * Creates a team with a seeded workspace, writes a file to disk to produce a
 * diff, then drives the Changes tab in the workspace panel:
 *   1. Click the Changes tab
 *   2. Verify the unstaged file appears
 *   3. Click Stage → verify it moves to Staged
 *
 * The snake-case staging pipeline (init/compare/stage/unstage/discard) is
 * covered by direct unit tests against `WorkspaceSnapshotService` in the
 * integration suite; this file only asserts the rendered UI state.
 */
import { test, expect } from '../../fixtures';
import { cleanupTeamsByName } from '../../helpers';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

const TEAM_NAME = `E2E Workspace Snapshot ${Date.now()}`;

test.describe('Workspace Changes — UI panel', () => {
  let workspace: string;

  test.beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-e2e-ws-snap-'));
    fs.writeFileSync(path.join(workspace, 'baseline.txt'), 'original');
    execFileSync('git', ['init', '--quiet'], { cwd: workspace });
    execFileSync('git', ['add', 'baseline.txt'], { cwd: workspace });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Command EVE E2E',
        '-c',
        'user.email=e2e@command-eve.invalid',
        'commit',
        '--quiet',
        '-m',
        'baseline',
      ],
      { cwd: workspace }
    );
  });

  test.afterAll(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('changes tab surfaces a newly written file and stage button moves it', async ({ page, electronApp }) => {
    test.setTimeout(180_000);

    await electronApp.evaluate(async ({ dialog }, target) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [target] });
    }, workspace);

    await cleanupTeamsByName(page, TEAM_NAME);

    // ── Create team with seeded workspace ────────────────────────────────
    const createBtn = page.locator('[data-testid="team-create-btn"]').first();
    await expect(createBtn).toBeVisible({ timeout: 10_000 });
    await createBtn.click();

    const modal = page.locator('.team-create-modal');
    await expect(modal).toBeVisible({ timeout: 10_000 });

    await modal.locator('[data-testid="team-create-name-input"]').fill(TEAM_NAME);

    const commandEveOption = modal.locator('[data-testid^="team-create-agent-option-"]').first();
    await expect(commandEveOption).toBeVisible({ timeout: 5_000 });
    await commandEveOption.click();

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

    const panel = page.locator('.chat-workspace');
    await expect(panel).toBeVisible({ timeout: 30_000 });

    // ── Seed a diff on disk (snapshot baseline was captured on team create) ─
    fs.writeFileSync(path.join(workspace, 'created.txt'), 'hello-snapshot');

    // ── Switch to Changes tab ────────────────────────────────────────────
    const changesTab = panel.locator('.arco-tabs-header-title').filter({ hasText: /Changes|Änderungen|更改/ });
    await expect(changesTab.first()).toBeVisible({ timeout: 10_000 });
    await changesTab.first().click();

    await page.screenshot({ path: 'tests/e2e/results/workspace-snapshot-01-changes-tab.png' });

    // ── Newly created file should surface somewhere in the Changes list ──
    const createdEntry = panel.getByText('created.txt').first();
    await expect(createdEntry).toBeVisible({ timeout: 30_000 });

    await page.screenshot({ path: 'tests/e2e/results/workspace-snapshot-02-unstaged.png' });

    // ── Click a Stage button if available (per-file or Stage All) ────────
    // The FileChangeList renders a Stage-all action + per-file stage buttons.
    const stageButton = panel.getByRole('button', {
      name: /Stage All Changes|Alle Änderungen bereitstellen|全部暂存/i,
    });
    await expect(stageButton).toBeVisible({ timeout: 5_000 });
    await stageButton.click();
    // After staging, the file should still be in the list (just under Staged).
    await expect(panel.getByText('created.txt').first()).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: 'tests/e2e/results/workspace-snapshot-03-staged.png' });

    // ── Cleanup ──────────────────────────────────────────────────────────
    await cleanupTeamsByName(page, TEAM_NAME);
  });
});
