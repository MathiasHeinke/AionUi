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

  test('keeps the EVE control popover aligned without shifting composer controls', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 900, height: 720 });
    await goToGuid(page);

    const composer = page.locator('.eve-composer-surface').first();
    const bar = page.getByTestId('unified-send-bar');
    const trigger = page.getByTestId('eve-composer-control-trigger');
    const mic = bar.locator('.speech-input-button').first();
    const send = page.getByTestId('guid-send-btn');
    const attach = page.getByTestId('file-upload-btn');
    const workspace = page.getByTestId('workspace-context-control');

    await expect(composer).toBeVisible({ timeout: 30_000 });
    await expect(trigger).toBeVisible();
    await expect(mic).toBeVisible();
    await expect(send).toBeVisible();
    await expect(attach).toBeVisible();
    await expect(workspace).toBeVisible();

    const actionBoxes = await Promise.all(
      [attach, workspace, trigger, mic, send].map((control) => control.boundingBox())
    );
    expect(actionBoxes.every(Boolean)).toBe(true);
    for (let leftIndex = 0; leftIndex < actionBoxes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < actionBoxes.length; rightIndex += 1) {
        const leftBox = actionBoxes[leftIndex];
        const rightBox = actionBoxes[rightIndex];
        if (!leftBox || !rightBox) continue;
        const horizontalOverlap =
          Math.min(leftBox.x + leftBox.width, rightBox.x + rightBox.width) - Math.max(leftBox.x, rightBox.x);
        const verticalOverlap =
          Math.min(leftBox.y + leftBox.height, rightBox.y + rightBox.height) - Math.max(leftBox.y, rightBox.y);
        expect(horizontalOverlap > 1 && verticalOverlap > 1).toBe(false);
      }
    }

    const before = await Promise.all([trigger.boundingBox(), mic.boundingBox(), send.boundingBox()]);
    expect(before.every(Boolean)).toBe(true);

    await trigger.click();
    const menu = page.getByTestId('eve-composer-control-menu');
    await expect(menu).toBeVisible();

    const popup = page.locator('.eve-composer-control-popover:visible').last();
    const arrow = popup.locator('.arco-popover-arrow');
    const [composerBox, popupBox, triggerBox, arrowBox] = await Promise.all([
      composer.boundingBox(),
      popup.boundingBox(),
      trigger.boundingBox(),
      arrow.boundingBox(),
    ]);
    expect(composerBox).not.toBeNull();
    expect(popupBox).not.toBeNull();
    expect(triggerBox).not.toBeNull();
    expect(arrowBox).not.toBeNull();

    if (composerBox && popupBox && triggerBox && arrowBox) {
      expect(popupBox.x).toBeGreaterThanOrEqual(composerBox.x - 1);
      expect(popupBox.x + popupBox.width).toBeLessThanOrEqual(composerBox.x + composerBox.width + 1);
      const triggerCenter = triggerBox.x + triggerBox.width / 2;
      const arrowCenter = arrowBox.x + arrowBox.width / 2;
      expect(Math.abs(triggerCenter - arrowCenter)).toBeLessThanOrEqual(3);
    }

    const after = await Promise.all([trigger.boundingBox(), mic.boundingBox(), send.boundingBox()]);
    expect(after).toEqual(before);

    const screenshotPath = 'tests/e2e/results/command-eve-composer-popover-alignment.png';
    await page.screenshot({ path: screenshotPath });
    await testInfo.attach('command-eve-composer-popover-alignment', {
      path: screenshotPath,
      contentType: 'image/png',
    });
  });

  test('styles both titlebar rail toggles as the same neutral control', async ({ page }) => {
    await goToGuid(page);

    const siderToggle = page.getByTestId('sider-toggle-btn');
    const elementsToggle = page.getByTestId('elements-rail-toggle');
    await expect(siderToggle).toBeVisible({ timeout: 30_000 });
    await expect(elementsToggle).toBeVisible();

    const [siderBox, elementsBox] = await Promise.all([siderToggle.boundingBox(), elementsToggle.boundingBox()]);
    expect(siderBox).not.toBeNull();
    expect(elementsBox).not.toBeNull();
    if (siderBox && elementsBox) {
      expect(elementsBox.width).toBeCloseTo(siderBox.width, 1);
      expect(elementsBox.height).toBeCloseTo(siderBox.height, 1);
      expect(elementsBox.y).toBeCloseTo(siderBox.y, 1);
    }

    const readChromeStyle = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        borderColor: style.borderColor,
        borderRadius: style.borderRadius,
        borderWidth: style.borderWidth,
        color: style.color,
      };
    };
    const [siderStyle, elementsStyle] = await Promise.all([
      siderToggle.evaluate(readChromeStyle),
      elementsToggle.evaluate(readChromeStyle),
    ]);
    expect(elementsStyle).toEqual(siderStyle);
    await expect(elementsToggle).not.toHaveClass(/elements-active/);
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
    await expect(page.getByText(/Ollama|custom:command-eve/i)).toHaveCount(0);

    const e4b = page.getByTestId('command-eve-model-tier-gemma-4-e4b-local-default');
    await expect(e4b).toContainText('Gemma 4 E4B Uncensored');
    await expect(e4b.getByTestId('command-eve-model-tier-select-gemma-4-e4b-local-default')).toBeVisible();

    const twelveB = page.getByTestId('command-eve-model-tier-gemma-4-12b-local-planning');
    await expect(twelveB).toContainText('Gemma 4 12B Heretic');
    await expect(twelveB.getByTestId('command-eve-model-tier-select-gemma-4-12b-local-planning')).toBeVisible();

    const thirtyOneB = page.getByTestId('command-eve-model-tier-gemma-4-31b-local-pro');
    await expect(thirtyOneB).toContainText('Gemma 4 31B Heretic');
    await expect(page.getByTestId('command-eve-model-tier-bonsai-27b-local-experimental')).toContainText('Bonsai 27B');
    await expect(page.getByTestId('command-eve-model-tier-colibri-glm-5-2-uncensored-max')).toContainText(
      'Colibrì GLM-5.2 Uncensored'
    );

    await goToSettings(page, 'system');
    // The old duplicate runtime-status switch was removed from System. Runtime
    // truth now has one dedicated, sanitized EVE-Runtime page.
    await expect(page.getByTestId('system-preference-commandEveRuntimeStatus')).toHaveCount(0);

    const warmupRow = page.getByTestId('system-preference-commandEveModelWarmup');
    await expect(warmupRow).toContainText(/Lokales EVE-Modell vorwärmen|Pre-warm local EVE model/);
    await expect(warmupRow).toContainText(
      /Cloud-Modelle werden dabei nicht aufgerufen|Cloud models are not called|cloud providers are not pinged/
    );
    await expect(warmupRow.locator('.arco-switch')).toBeVisible();

    await goToSettings(page, 'runtime');
    await expect(page.getByRole('heading', { name: /Lokale KI|Local AI/ })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Lokale Ausführung|Local execution/).first()).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByText(/Wird automatisch von EVE verwaltet|Managed automatically by EVE/).first()
    ).toBeVisible();
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
