/**
 * Skills Hub E2E Tests - URL Highlight (P1 Priority)
 *
 * Test Cases Covered:
 * - TC-S-22: URL parameter highlight skill (success scenario)
 */

import { test, expect } from '../../../fixtures';
import {
  goToSkillsHub,
  refreshSkillsHub,
  importSkillViaBridge,
  createTempExternalSource,
  createTestSkill,
  cleanupTestSkills,
  normalizeTestId,
} from '../../../helpers/skillsHub';
import { takeScreenshot } from '../../../helpers/screenshots';
import * as path from 'path';

test.describe('Skills Hub - URL Highlight (P1)', () => {
  test.afterEach(async ({ page }) => {
    await cleanupTestSkills(page);
  });

  // ============================================================================
  // TC-S-22: URL parameter highlight skill (success scenario)
  // ============================================================================

  test('TC-S-22: should highlight skill and scroll to it when URL has highlight param', async ({ page }) => {
    // Clear any existing URL params from previous tests
    await page.evaluate(() => {
      const url = new URL(window.location.href);
      url.search = '';
      window.history.replaceState({}, '', url.toString());
    });

    // Setup: Create and import target skill
    const tempSource = createTempExternalSource('tc-s-22');
    try {
      const skillName = `E2E-Test-Highlight-Target-${Date.now()}`;
      createTestSkill(tempSource.path, skillName, 'Target skill for highlight test');

      const importResult = await importSkillViaBridge(page, path.join(tempSource.path, skillName));
      expect(importResult.success).toBe(true);

      // Navigate to Skills Hub and refresh to load imported skill
      await goToSkillsHub(page);
      await refreshSkillsHub(page);

      // Verify skill exists before highlight test
      let targetCard = page.locator(`[data-testid="my-skill-card-${normalizeTestId(skillName)}"]`);
      await expect(targetCard).toBeVisible({ timeout: 10000 });

      // Screenshot 01: Before highlight
      await takeScreenshot(page, 'skills-hub/tc-s-22/01-before-highlight.png');

      // Step 1: Add highlight parameter via history API
      await page.evaluate((name) => {
        const url = new URL(window.location.href);
        const currentHash = url.hash;
        const [path, search] = currentHash.split('?');
        const params = new URLSearchParams(search || '');
        params.set('highlight', name);
        const newHash = `${path}?${params.toString()}`;
        window.location.hash = newHash;
        return { currentHash, newHash, finalHash: window.location.hash };
      }, skillName);

      // drift: 4fe872e6 highlight styling refactored from utility classes
      // (border-primary-5/bg-primary-1) to the BEM modifier eve-skill-row--highlighted.
      // The app applies it via requestAnimationFrame and auto-clears it after ~2s,
      // so poll immediately — a fixed sleep or screenshots first can miss the window.
      await expect(targetCard).toHaveClass(/eve-skill-row--highlighted/, { timeout: 10_000 });

      // Screenshot 02: Card highlighted
      await takeScreenshot(page, 'skills-hub/tc-s-22/02-highlighted.png');

      // Verify URL parameter was cleared by app
      const currentURL = page.url();
      expect(currentURL).not.toContain('highlight=');

      // Step 2: the app's 2s clear timer removes the modifier again
      await expect(targetCard).not.toHaveClass(/eve-skill-row--highlighted/, { timeout: 10_000 });

      // Screenshot 03: Highlight cleared
      await takeScreenshot(page, 'skills-hub/tc-s-22/03-highlight-cleared.png');

      // URL parameter stays cleared
      const finalUrl = page.url();
      expect(finalUrl).not.toContain('highlight=');
    } finally {
      tempSource.cleanup();
    }
  });
});
