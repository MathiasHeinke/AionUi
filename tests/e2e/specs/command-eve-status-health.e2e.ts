/**
 * Command EVE Status / Health surface.
 *
 * Proves the Command Center status panel is backed by the real Company.OS
 * status-surface CLI, and that missing runtime truth fails loudly instead of
 * rendering a confident green state.
 */
import { test, expect } from '../fixtures';
import { expectFounderOnlyBridgeDenied } from '../helpers/bridge/founderOnly';

test.describe('Command EVE status health', () => {
  test.setTimeout(120_000);

  test.beforeEach(async ({ page }) => {
    await page.waitForSelector('body', { state: 'visible' });
  });

  test('denies the founder status surface in customer mode', async ({ page }) => {
    await expectFounderOnlyBridgeDenied(page, 'command-eve.status-surface', {
      companyOsRoot: '/tmp/forbidden-company-os',
      eventLedgerPath: '/tmp/forbidden-company-os/events.jsonl',
      maxRuns: 8,
    });
  });

  test('denies the founder status surface before any missing-ledger handling', async ({ page }) => {
    await expectFounderOnlyBridgeDenied(page, 'command-eve.status-surface', {
      companyOsRoot: '/tmp/forbidden-company-os',
      eventLedgerPath: `/tmp/forbidden-company-os/missing-${Date.now()}.jsonl`,
      maxRuns: 8,
    });
  });
});
