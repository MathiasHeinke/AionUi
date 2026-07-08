/**
 * E2E: Command EVE team leader boundary.
 *
 * The user-facing Create Team modal must expose Command EVE only. Claude,
 * Codex, Gemini and other raw CLI/ACP workers are internal Hermes-controlled
 * lanes, not selectable public team leaders.
 */
import { test, expect } from '../../fixtures';

const RAW_WORKER_LABELS = /Claude|Codex|Gemini|Hermes|AionUi|Aion CLI|aionrs/i;

test.describe('Team Agent Public Boundary', () => {
  test('Create Team exposes only Command EVE as the user-visible leader', async ({ page }) => {
    await page.goto(page.url().split('#')[0] + '#/guid');

    const existingModal = page.locator('.team-create-modal .arco-btn-text');
    if (await existingModal.isVisible({ timeout: 1000 }).catch(() => false)) {
      await existingModal.click({ force: true });
      await expect(page.locator('.team-create-modal')).toBeHidden({ timeout: 5000 });
    }

    await expect(page.locator('[data-testid="team-create-btn"]').first()).toBeVisible({ timeout: 10000 });
    await page.locator('[data-testid="team-create-btn"]').first().click();

    const modal = page.locator('.team-create-modal');
    const leaderSelect = modal.locator('[data-testid="team-create-leader-select"]');
    const hasLeaderSelect = await leaderSelect.isVisible({ timeout: 5000 }).catch(() => false);

    if (!hasLeaderSelect) {
      test.skip(true, 'Command EVE team leader is not available in this E2E environment');
      return;
    }

    await expect(leaderSelect).toBeVisible({ timeout: 5000 });
    await leaderSelect.click();

    const allOptions = page.locator('[data-testid^="team-create-agent-option-"]');
    await expect(allOptions.first()).toBeVisible({ timeout: 5000 });
    await expect.poll(async () => allOptions.count(), { timeout: 5000 }).toBe(1);

    const visibleLabel = ((await allOptions.first().textContent()) ?? '').trim();
    expect(visibleLabel).toMatch(/Command EVE/i);
    expect(visibleLabel).not.toMatch(RAW_WORKER_LABELS);

    await page.screenshot({ path: 'tests/e2e/results/team-whitelist-command-eve-only.png' });

    await modal.locator('.arco-btn-text').first().click();
    await expect(modal).toBeHidden({ timeout: 5000 });
  });
});
