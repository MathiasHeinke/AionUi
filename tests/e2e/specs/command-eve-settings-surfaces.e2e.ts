/**
 * Command EVE settings surfaces – packaged app E2E.
 *
 * Protects the product shell from regressing back into a generic AionUI setup:
 * Humanized local EVE lanes must be visible, runtime controls must be present,
 * Command EVE must remain the only public runtime identity, and Command EVE
 * capabilities must replace the legacy/global skill-market surface.
 */
import { test, expect } from '../fixtures';
import { goToGuid, goToSettings } from '../helpers';

test.describe('Command EVE settings surfaces', () => {
  test.setTimeout(120_000);

  test('brands the shell sidebar and exposes governed Command EVE surfaces', async ({ page }) => {
    await goToGuid(page);

    // The in-app EVE wordmark was removed from the sidebar (brand lives only in the
    // macOS window title bar now); the sidebar header still mounts as a readiness gate.
    await expect(page.getByTestId('layout-sider-header')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/^AionUi$/)).toHaveCount(0);
    await expect(page.getByText(/Command Center/).first()).toBeVisible({ timeout: 30_000 });

    await goToSettings(page, 'connectors');
    await expect(page.getByText(/Connectoren|Connectors/).first()).toBeVisible({ timeout: 30_000 });
    await goToSettings(page, 'capabilities');
    await expect(page.getByText(/Skills|Fähigkeiten|Capabilities/).first()).toBeVisible({ timeout: 30_000 });
    await goToSettings(page, 'model');
    await expect(page.getByText(/Runtime|Command EVE Local Runtime/).first()).toBeVisible({ timeout: 30_000 });
  });

  test('shows humanized local EVE lanes plus runtime status and warmup controls', async ({ page }) => {
    await page.waitForSelector('body', { state: 'visible' });

    await goToSettings(page, 'model');
    await expect(page.getByText('Command EVE Local Runtime')).toBeVisible();
    await expect(page.getByTestId('command-eve-model-support-note')).toContainText(
      /Optionale Pro-Einstellungen|Optional pro settings/i
    );
    await expect(
      page.getByText(/Derzeit unterstützt nur Aion CLI|Only Aion CLI currently supports custom models/)
    ).toHaveCount(0);
    await expect(page.getByText(/Gemma|Ollama|custom:command-eve/i)).toHaveCount(0);

    const e4b = page.getByTestId('command-eve-model-tier-gemma-4-e4b-local-default');
    await expect(e4b).toContainText(/Schnell & effizient|Fast & efficient/);
    await expect(e4b.getByTestId('command-eve-model-tier-select-gemma-4-e4b-local-default')).toBeVisible();

    const twelveB = page.getByTestId('command-eve-model-tier-gemma-4-12b-local-planning');
    await expect(twelveB).toContainText(/Planung & Analyse|Planning & analysis/);
    await expect(twelveB.getByTestId('command-eve-model-tier-select-gemma-4-12b-local-planning')).toBeVisible();

    const thirtyOneB = page.getByTestId('command-eve-model-tier-gemma-4-31b-local-pro');
    await expect(thirtyOneB).toContainText(/Lokale Pro-Leistung|Local pro performance/);

    await goToSettings(page, 'system');
    const statusRow = page.getByTestId('system-preference-commandEveRuntimeStatus');
    await expect(statusRow).toContainText(/EVE-Aktivitätsstatus anzeigen|Show EVE activity status/);
    await expect(statusRow.locator('.arco-switch')).toBeVisible();

    const warmupRow = page.getByTestId('system-preference-commandEveModelWarmup');
    await expect(warmupRow).toContainText(/Lokales EVE-Modell vorwärmen|Pre-warm local EVE model/);
    await expect(warmupRow).toContainText(/keine Cloud-Anbieter|cloud providers are not pinged/);
    await expect(warmupRow.locator('.arco-switch')).toBeVisible();
  });

  test('keeps Hermes as EVE runtime identity and hides legacy Aion CLI cards', async ({ page }) => {
    await page.waitForSelector('body', { state: 'visible' });

    await goToSettings(page, 'agent');
    await expect(page.getByText(/EVE-Runtime|EVE Runtime/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Dein Team|Your team/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/^Aion CLI$/)).toHaveCount(0);
    await expect(page.getByText(/Agenten & Belegschaft|Agents & workforce/)).toHaveCount(0);
    await expect(page.getByText(/Externe Worker|External workers/)).toHaveCount(0);
    await expect(page.getByText(/Claude Code CLI|Codex CLI|Google Gemini AI command line tool/)).toHaveCount(0);
  });

  test('shows Command EVE capability catalog and suppresses legacy/global skill-market sections', async ({ page }) => {
    await page.waitForSelector('body', { state: 'visible' });

    await goToSettings(page, 'capabilities');
    const section = page.getByTestId('command-eve-capability-section');
    await expect(section).toBeVisible();
    await expect(section).toContainText(/Command-EVE-Fähigkeiten|Command EVE capabilities/);
    await expect(section).toContainText('Content Machine');
    await expect(section).toContainText('Video-first Content Engine');
    await expect(section).toContainText(/Connector-Policies|Connector policies/);
    await expect(section).toContainText(/Local Command EVE runtime/i);
    await expect(section).toContainText('GitHub + GitNexus');
    await expect(section).toContainText(/Desktop observation/i);

    await expect(page.getByTestId('extension-skills-section')).toHaveCount(0);
    await expect(page.getByTestId('auto-skills-section')).toHaveCount(0);
    await expect(page.getByText('xiaohongshu-recruiter')).toHaveCount(0);
    await expect(page.getByText('weixin-file-send')).toHaveCount(0);
  });

  test('keeps assistant CRUD hidden in public builds', async ({ page }) => {
    await page.waitForSelector('body', { state: 'visible' });

    await goToSettings(page, 'assistants');
    await expect(page.getByText(/EVE-Runtime|EVE Runtime/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('assistant-card-command-eve-chief-of-staff')).toHaveCount(0);
    await expect(page.getByTestId('assistant-edit-drawer')).toHaveCount(0);
    await expect(page.getByText('xiaohongshu-recruiter')).toHaveCount(0);
    await expect(page.getByText('weixin-file-send')).toHaveCount(0);
    await expect(page.getByText('aionui-skills')).toHaveCount(0);
  });
});
