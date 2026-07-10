/**
 * Agent Settings Detection — E2E tests.
 *
 * Covers the public Command EVE runtime/orchestration settings. Raw CLI agent
 * discovery remains an upstream-only surface.
 */
import { test, expect } from '../fixtures';
import { goToSettings, expectUrlContains, expectBodyContainsAny } from '../helpers';

const upstreamAgentSettingsTest = process.env.AIONUI_UPSTREAM_MODE === '1' ? test : test.skip;

test.describe('Agent Settings Detection', () => {
  test('EVE runtime settings page renders', async ({ page }) => {
    await goToSettings(page, 'agent');
    await expectUrlContains(page, 'agent');
    await expect(page.getByRole('heading', { name: /EVE-Runtime/i })).toBeVisible({ timeout: 8_000 });
  });

  test('Command EVE settings expose only the managed EVE runtime', async ({ page }) => {
    await goToSettings(page, 'agent');

    await expect(page.getByRole('heading', { name: /EVE-Runtime/i })).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText(/Claude Code|Codex|Gemini CLI/i)).toHaveCount(0);
  });

  upstreamAgentSettingsTest('upstream settings show detected Gemini or Aion agents', async ({ page }) => {
    await goToSettings(page, 'agent');

    // Gemini or Aion RS should be in the agent list
    await expectBodyContainsAny(page, ['Gemini', 'gemini', 'Aion']);
  });

  test('agent settings page has sidebar navigation item', async ({ page }) => {
    await goToSettings(page, 'agent');

    await expect(page.getByRole('button', { name: /EVE-Runtime/i })).toBeVisible({ timeout: 8_000 });
  });

  test('orchestration tab and curated team are visible', async ({ page }) => {
    await goToSettings(page, 'agent');

    await expect(page.getByRole('tab', { name: /Orchestrierung|Orchestration/i })).toBeVisible({ timeout: 8_000 });
    await expectBodyContainsAny(page, ['Dein Team', 'Your Team']);
  });

  test('detected agents section refreshes without error', async ({ page }) => {
    await goToSettings(page, 'agent');

    // Navigate away and back to trigger a refresh
    await goToSettings(page, 'about');
    await goToSettings(page, 'agent');

    // Page should still render correctly
    await expect(page.getByRole('heading', { name: /EVE-Runtime/i })).toBeVisible({ timeout: 8_000 });
  });
});
