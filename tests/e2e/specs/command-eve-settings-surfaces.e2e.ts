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

  test.afterEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test('brands the shell sidebar and exposes governed Command EVE surfaces', async ({ page }) => {
    await goToGuid(page);

    // The in-app EVE wordmark was removed from the sidebar (brand lives only in the
    // macOS window title bar now); the sidebar header still mounts as a readiness gate.
    await expect(page.getByTestId('layout-sider-header')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/^AionUi$/)).toHaveCount(0);
    await expect(page.getByText(/Command Center|Kommandozentrale/)).toHaveCount(0);
    await expect(page.getByTestId('sider-kanban-entry')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('sider-kanban-entry')).toHaveJSProperty('tagName', 'BUTTON');
    await expect(page.getByTestId('workspace-context-control')).toHaveJSProperty('tagName', 'BUTTON');
    await expect(page.getByTestId('workspace-context-control')).toHaveAttribute('aria-label', /\S+/);
    await expect(page.getByTestId('eve-composer-control-trigger')).toBeVisible();

    // Legacy support/website/WebUI shortcuts no longer occupy the primary EVE
    // work surface; they remain available through settings instead.
    for (const quickAction of ['feedback', 'website', 'webui']) {
      const control = page.getByTestId(`guid-quick-action-${quickAction}`);
      await expect(control).toHaveCount(0);
    }

    await goToSettings(page, 'connectors');
    await expect(page.getByText(/Connectoren|Connectors/).first()).toBeVisible({ timeout: 30_000 });
    await goToSettings(page, 'capabilities');
    await expect(page.getByText(/Skills|Fähigkeiten|Capabilities/).first()).toBeVisible({ timeout: 30_000 });
    await goToSettings(page, 'model');
    await expect(page.getByText(/Runtime|Command EVE Local Runtime/).first()).toBeVisible({ timeout: 30_000 });
  });

  test('keeps the About surface on the public Command EVE identity', async ({ page }) => {
    await goToSettings(page, 'about');

    await expect(page.getByRole('heading', { name: 'Command EVE', exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/KI-Operatorin|AI operator/)).toBeVisible();
    await expect(page.getByText(/Gemini CLI|Hermes|AionUi/)).toHaveCount(0);

    await page.getByTestId('about-check-updates').click();
    const updateModal = page.locator('.arco-modal:visible').last();
    await expect(updateModal).toContainText(/Software-Update|Software Update|Alles aktuell|Up to date/);
    await page.keyboard.press('Escape');
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
    await expect(warmupRow).toContainText(
      /Cloud-Modelle werden dabei nicht aufgerufen|Cloud models are not called|cloud providers are not pinged/
    );
    await expect(warmupRow.locator('.arco-switch')).toBeVisible();
  });

  test('keeps EVE as the public runtime identity and hides internal agent cards', async ({ page }) => {
    await page.waitForSelector('body', { state: 'visible' });

    await goToSettings(page, 'agent');
    await expect(page.getByText(/EVE-Runtime|EVE Runtime/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Dein Team|Your team/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/^Aion CLI$/)).toHaveCount(0);
    await expect(page.getByText(/Agenten & Belegschaft|Agents & workforce/)).toHaveCount(0);
    await expect(page.getByText(/Externe Worker|External workers/)).toHaveCount(0);
    await expect(page.getByText(/Claude Code CLI|Codex CLI|Google Gemini AI command line tool/)).toHaveCount(0);
    await expect(page.getByText(/Hermes/)).toHaveCount(0);

    await goToGuid(page);
    await expect(page.locator('[data-testid^="preset-pill-"]')).toHaveCount(0);
    await expect(page.getByTestId('btn-add-preset')).toHaveCount(0);
    await expect(page.getByText(/Cowork|Aion CLI|Claude Code|Codex CLI|Gemini CLI/)).toHaveCount(0);
  });

  test('shows Command EVE capability catalog and suppresses legacy/global skill-market sections', async ({ page }) => {
    await page.waitForSelector('body', { state: 'visible' });

    await goToSettings(page, 'capabilities');
    const section = page.getByTestId('command-eve-capability-section');
    await expect(section).toBeVisible();
    await expect(section).toContainText(/Command-EVE-Fähigkeiten|Command EVE capabilities/);
    await expect(section).toContainText(/geprüfte Grundfähigkeiten|verified core capabilities/);
    await expect(section).toContainText(/sicher verwaltete Verbindungen|safely managed connections/);
    await expect(section).toContainText(/Geld ausgeben|Spend money|publishing|veröffentlichen/i);

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

  test('ships three local EVE backgrounds and projects the selected preset', async ({ page }) => {
    await goToSettings(page, 'appearance');

    const presets = page.locator('[data-testid^="eve-background-preset-"]');
    await expect(presets).toHaveCount(3);
    await expect(page.getByRole('radio', { name: 'Dawn Alloy' })).toBeChecked();
    await expect(page.getByRole('radio', { name: 'Frosted Gallery' })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Obsidian Atrium' })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => ({
          enabled: document.documentElement.getAttribute('data-eve-bg-image'),
          image: document.documentElement.style.getPropertyValue('--eve-bg-image-url'),
        }))
      )
      .toMatchObject({ enabled: 'true', image: expect.stringContaining('command-eve-dawn-alloy') });

    const glassTiers = await page.evaluate(() => {
      const rootStyle = getComputedStyle(document.documentElement);
      const content = document.querySelector<HTMLElement>('.layout-content');
      return {
        chrome: Number.parseFloat(rootStyle.getPropertyValue('--eve-glass-chrome-opacity')),
        composer: Number.parseFloat(rootStyle.getPropertyValue('--eve-glass-composer-opacity')),
        reading: Number.parseFloat(rootStyle.getPropertyValue('--eve-glass-reading-opacity')),
        panel: Number.parseFloat(rootStyle.getPropertyValue('--eve-glass-panel-opacity')),
        overlay: Number.parseFloat(rootStyle.getPropertyValue('--eve-glass-overlay-opacity')),
        contentBackgroundImage: content ? getComputedStyle(content).backgroundImage : 'missing',
      };
    });
    expect(glassTiers.chrome).toBeLessThan(70);
    expect(glassTiers.composer).toBeGreaterThan(glassTiers.chrome);
    expect(glassTiers.composer).toBeLessThan(glassTiers.reading);
    expect(glassTiers.reading).toBeGreaterThanOrEqual(66);
    expect(glassTiers.panel).toBeGreaterThan(glassTiers.chrome);
    expect(glassTiers.panel).toBeGreaterThan(glassTiers.reading);
    expect(glassTiers.overlay).toBeGreaterThan(glassTiers.panel);
    expect(glassTiers.contentBackgroundImage).toContain('radial-gradient');

    await page.getByRole('radio', { name: 'Frosted Gallery' }).click();
    await expect(page.getByRole('radio', { name: 'Frosted Gallery' })).toBeChecked();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--eve-bg-image-url')))
      .toContain('command-eve-frosted-gallery');
  });

  test('keeps a deep-linked mobile settings route in the visible navigation strip', async ({ page }) => {
    await page.waitForFunction(() => document.body.innerText.trim().length > 0, undefined, { timeout: 30_000 });
    const originalViewport = page.viewportSize() ?? { width: 1280, height: 800 };

    try {
      await goToSettings(page, 'about');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => {
        window.dispatchEvent(new Event('resize'));
      });
      await page.waitForSelector('.settings-page-wrapper', { state: 'visible', timeout: 30_000 });

      const nav = page.locator('.settings-mobile-top-nav');
      const activeItem = nav.locator('[aria-current="page"]');
      await expect(nav).toBeVisible();
      await expect(activeItem).toContainText(/Über|About/);

      await expect
        .poll(() =>
          activeItem.evaluate((item) => {
            const container = item.closest('.settings-mobile-top-nav');
            if (!container) return false;
            const itemRect = item.getBoundingClientRect();
            const containerRect = container.getBoundingClientRect();
            return itemRect.left >= containerRect.left - 1 && itemRect.right <= containerRect.right + 1;
          })
        )
        .toBe(true);

      await expect(page.locator('.settings-mobile-top-nav-shell')).toHaveClass(/settings-mobile-top-nav-shell--before/);

      await page.evaluate(() => window.location.assign('#/guid'));
      await page.waitForFunction(() => window.location.hash === '#/guid', undefined, { timeout: 10_000 });
      await expect(page.getByTestId('elements-rail-toggle')).toHaveCount(0);
    } finally {
      await page.setViewportSize(originalViewport);
      await page.evaluate(() => window.location.assign('#/guid'));
      await page.waitForFunction(() => window.location.hash === '#/guid', undefined, { timeout: 10_000 });
      const sider = page.locator('.layout-sider');
      if (await sider.evaluate((element) => element.getBoundingClientRect().width < 100)) {
        await page.getByTestId('sider-toggle-btn').click();
        await expect
          .poll(() => sider.evaluate((element) => element.getBoundingClientRect().width))
          .toBeGreaterThan(100);
      }
    }
  });
});
