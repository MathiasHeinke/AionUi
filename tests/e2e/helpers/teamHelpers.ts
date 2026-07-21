import { expect, test, type Locator, type Page } from '@playwright/test';
import { invokeBridge } from './bridge';
import { TEAM_PUBLIC_LEADER_TYPE, TEAM_SUPPORTED_BACKENDS } from './teamConfig';

type TeamAgent = { role: string; name: string };
type TeamRecord = { id: string; name: string; agents: TeamAgent[] };

/** UI label patterns for public team leader types. */
const BACKEND_UI_PATTERN: Record<string, RegExp> = {
  'command-eve': /Command EVE/i,
  claude: /Claude Code/i,
  codex: /Codex/i,
  gemini: /Gemini/i,
};

/**
 * Create a team through the sidebar UI (TeamCreateModal).
 *
 * Uses the real user flow so the TeamCreateModal.onCreated -> refreshTeams()
 * callback runs and the sidebar SWR cache stays in sync. Plain HTTP POST of
 * /api/teams would bypass this, leaving the sidebar empty under Playwright
 * Electron (see mnemo #269).
 *
 * Throws if no supported backend is available — callers should skip the test.
 */
export async function createTeam(page: Page, name: string, leaderType?: string): Promise<string> {
  if (TEAM_SUPPORTED_BACKENDS.size === 0) {
    throw new Error('No supported team backends available — skip this test');
  }

  await closeAnyVisibleCreateTeamModal(page);
  await ensureSiderExpanded(page);

  const createBtn = page.locator('[data-testid="team-create-btn"]').first();
  await createBtn.waitFor({ state: 'visible', timeout: 10_000 });
  await createBtn.click();

  const modal = page.locator('.team-create-modal').last();
  await modal.waitFor({ state: 'visible', timeout: 5_000 });

  const nameInput = modal.locator('[data-testid="team-create-name-input"]');
  await nameInput.fill(name);

  const leaderSelect = modal.locator('[data-testid="team-create-leader-select"]');
  const hasLeaderSelect = await leaderSelect.isVisible({ timeout: 3_000 }).catch(() => false);
  if (!hasLeaderSelect) {
    await closeModal(page, modal);
    throw new Error('No supported agents installed — skip this test');
  }

  const option = await pickLeaderOption(page, leaderType ?? TEAM_PUBLIC_LEADER_TYPE);
  if (!option) {
    await page.keyboard.press('Escape').catch(() => {});
    await closeModal(page, modal);
    throw new Error(`No agent option matched leader type "${leaderType ?? 'any'}" — skip this test`);
  }
  await option.click();

  const confirmBtn = modal.locator('.arco-btn-primary');
  await expect(confirmBtn).toBeEnabled({ timeout: 5_000 });
  await confirmBtn.click();

  await modal.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {});
  await page.waitForFunction(() => /^#\/team\/[^/?#]+/.test(window.location.hash), undefined, { timeout: 15_000 });

  const hash = await page.evaluate(() => window.location.hash);
  const match = hash.match(/#\/team\/([^/?#]+)/);
  if (!match) {
    throw new Error(`Could not extract teamId from URL hash: ${hash}`);
  }
  return match[1];
}

/**
 * Sandbox-aware team spawn for specs that create real ACP agents.
 *
 * createTeam drives the UI create flow, which spawns a leader ACP agent. In
 * the E2E sandbox (and on machines without agent CLIs) no supported backend is
 * installed — createTeam then THROWS ("No supported agents installed — skip
 * this test"), which Playwright records as a FAILURE. That is an environment
 * condition, not a product defect, so sandboxed runs must SKIP cleanly instead
 * (1.818 C4 harness finding: skip-throw instead of clean skip in teams specs).
 *
 * This helper routes the spawn through the established skip pattern from
 * team-member-init-failure.e2e.ts: known unavailability errors become
 * test.skip(), unexpected errors still fail loud. Returns the teamId, or null
 * when the test was skipped (unreachable — test.skip aborts — but keeps type
 * narrowing honest for callers).
 */
export async function createTeamOrSkip(page: Page, name: string, leaderType?: string): Promise<string | null> {
  try {
    return await createTeam(page, name, leaderType);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/No supported (team )?backends? available|No supported agents installed|No agent option matched/i.test(message)) {
      test.skip(true, `Team "${name}" could not be created in this sandbox: ${message}`);
      return null;
    }
    throw error;
  }
}

async function pickLeaderOption(page: Page, leaderType?: string): Promise<Locator | null> {
  const options = page.locator('[data-testid^="team-create-agent-option-"]');
  await options
    .first()
    .waitFor({ state: 'visible', timeout: 5_000 })
    .catch(() => {});

  if (!leaderType) {
    const first = options.first();
    return (await first.count().catch(() => 0)) > 0 ? first : null;
  }

  const pattern = BACKEND_UI_PATTERN[leaderType] ?? new RegExp(leaderType, 'i');
  const count = await options.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const option = options.nth(i);
    const text = await option.textContent().catch(() => '');
    if (pattern.test(text ?? '')) return option;
  }
  return null;
}

async function closeModal(page: Page, modal: Locator): Promise<void> {
  const cancel = modal
    .locator('button')
    .filter({ hasText: /Cancel|取消|Abbrechen/i })
    .first();
  if ((await cancel.count().catch(() => 0)) > 0) {
    await cancel.click({ force: true }).catch(() => {});
  } else {
    await page.keyboard.press('Escape').catch(() => {});
  }
  await page
    .locator('.team-create-modal')
    .last()
    .waitFor({ state: 'hidden', timeout: 5_000 })
    .catch(() => {});
}

async function closeAnyVisibleCreateTeamModal(page: Page): Promise<void> {
  const modal = page.locator('.team-create-modal').last();
  if (await modal.isVisible({ timeout: 500 }).catch(() => false)) {
    await closeModal(page, modal);
  }
}

/**
 * The team sidebar section persists its expanded state in localStorage. Tests
 * that act on existing team rows must open it explicitly instead of depending
 * on state leaked from a previous run.
 */
export async function ensureTeamSectionExpanded(page: Page): Promise<void> {
  await ensureSiderExpanded(page);

  const toggle = page.locator('[data-testid="team-section-toggle"]').first();
  await toggle.waitFor({ state: 'visible', timeout: 10_000 });

  const menuTriggerCount = await page
    .locator('[data-testid="sider-item-menu-trigger"]')
    .count()
    .catch(() => 0);
  if (menuTriggerCount === 0) {
    await toggle.click();
  }
}

export async function ensureSiderExpanded(page: Page): Promise<void> {
  const createBtn = page.locator('[data-testid="team-create-btn"]').first();
  if (await createBtn.isVisible({ timeout: 500 }).catch(() => false)) {
    return;
  }

  const sider = page.locator('.layout-sider').first();
  await sider.waitFor({ state: 'attached', timeout: 5_000 });
  const isCollapsed = await sider.evaluate((element) => element.classList.contains('collapsed'));
  if (isCollapsed) {
    const toggle = page.locator('[data-testid="sider-toggle-btn"]').first();
    await toggle.waitFor({ state: 'visible', timeout: 5_000 });
    await toggle.click();
  }
  await createBtn.waitFor({ state: 'visible', timeout: 10_000 });
}

export async function getTeamSiderRow(page: Page, teamName: string): Promise<Locator> {
  await ensureTeamSectionExpanded(page);
  return page
    .locator('div.group')
    .filter({ has: page.locator('[data-testid="sider-item-menu-trigger"]') })
    .filter({ has: page.getByText(teamName, { exact: true }) })
    .first();
}

/**
 * Find-or-create a team by name. Returns teamId.
 */
export async function ensureTeam(page: Page, name: string, leaderType?: string): Promise<string> {
  const teams = await invokeBridge<TeamRecord[]>(page, 'team.list', {
    user_id: 'system_default_user',
  }).catch(() => [] as TeamRecord[]);

  const existing = teams.find((t) => t.name === name);
  if (existing) return existing.id;

  return createTeam(page, name, leaderType);
}

/**
 * Delete a team by id via IPC. No-op if team doesn't exist.
 */
export async function deleteTeam(page: Page, id: string): Promise<void> {
  await invokeBridge(page, 'team.remove', { id }).catch(() => {});
}

/**
 * Remove all teams whose name matches `name`. Used for pre-test cleanup.
 *
 * Cleanup is done via IPC — faster and doesn't require the sidebar row to
 * render. After deleting we reload the page so SWR refetches the team list
 * and the sidebar reflects current backend state.
 */
export async function cleanupTeamsByName(page: Page, name: string): Promise<void> {
  const teams = await invokeBridge<TeamRecord[]>(page, 'team.list', {
    user_id: 'system_default_user',
  }).catch(() => [] as TeamRecord[]);

  const matches = teams.filter((t) => t.name === name);
  for (const t of matches) {
    await invokeBridge(page, 'team.remove', { id: t.id }).catch(() => {});
  }

  if (matches.length > 0) {
    const url = page.url();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2_000);
  }
}
