/**
 * Deterministic visual and integration proof for Typed Generative UI.
 *
 * The fixture enters through the real conversation artifact store, renders in
 * the existing chat, and opens the same validated AST in the right Workbench.
 * It never calls a model, network service, release path or production system.
 */

import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { goToGuid, httpPost } from '../helpers';

type TypedUIRegistry = {
  controllers: Record<string, { emitTypedUIArtifact: () => Promise<string> }>;
};

const ENABLED_CONVERSATION_KEY = 'aionui:e2e-message-stream-conversation-id';

async function createConversation(page: Page): Promise<string> {
  const result = await httpPost<{ id?: string }>(page, '/api/conversations', {
    type: 'acp',
    name: `E2E Typed UI ${Date.now()}`,
    extra: { workspace: '/tmp', custom_workspace: true, backend: 'claude', session_mode: 'default' },
  });
  if (!result.id) throw new Error('Conversation create response did not include an id');
  return result.id;
}

async function openConversation(page: Page, conversationId: string): Promise<void> {
  await page.evaluate(
    ({ key, id }) => {
      window.sessionStorage.setItem(key, id);
    },
    { key: ENABLED_CONVERSATION_KEY, id: conversationId }
  );
  const baseUrl = page.url().split('#')[0];
  await page.goto(`${baseUrl}#/conversation/${conversationId}`);
  await page.waitForSelector('[data-testid="message-list-scroller"]', { timeout: 30_000 });
  await page.waitForFunction(
    (id) => {
      const registry = (
        window as typeof window & {
          __AIONUI_E2E_MESSAGE_STREAM__?: TypedUIRegistry;
        }
      ).__AIONUI_E2E_MESSAGE_STREAM__;
      return Boolean(registry?.controllers[id]?.emitTypedUIArtifact);
    },
    conversationId,
    { timeout: 15_000 }
  );
}

async function emitTypedUIArtifact(page: Page, conversationId: string): Promise<string> {
  return page.evaluate(async (id) => {
    const registry = (
      window as typeof window & {
        __AIONUI_E2E_MESSAGE_STREAM__?: TypedUIRegistry;
      }
    ).__AIONUI_E2E_MESSAGE_STREAM__;
    const controller = registry?.controllers[id];
    if (!controller) throw new Error(`No Typed UI E2E controller for ${id}`);
    return controller.emitTypedUIArtifact();
  }, conversationId);
}

async function setVisualTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((nextTheme) => {
    document.documentElement.setAttribute('data-theme', nextTheme);
    document.body.setAttribute('arco-theme', nextTheme);
  }, theme);
}

test('renders compact in chat and full in the existing Workbench, light and dark', async ({ page }) => {
  test.setTimeout(180_000);
  await goToGuid(page);
  const conversationId = await createConversation(page);
  await openConversation(page, conversationId);
  const artifactId = await emitTypedUIArtifact(page, conversationId);

  const compact = page.getByTestId('typed-ui-compact');
  await expect(compact).toBeVisible({ timeout: 15_000 });
  await expect(compact.getByRole('heading', { name: 'Typed release cockpit' })).toBeVisible();
  await expect(compact.getByText('Reach the integration gate')).toBeVisible();
  await expect(page.getByTestId(`conversation-artifact-file`)).toHaveAttribute(
    'data-conversation-artifact-kind',
    'file'
  );

  await setVisualTheme(page, 'light');
  await compact.screenshot({ path: 'tests/e2e/results/typed-ui-compact-light.png' });

  const openWorkbench = compact.getByRole('button', { name: /Workbench/i });
  await expect(openWorkbench).toBeEnabled();
  await openWorkbench.click();

  const full = page.getByTestId('typed-ui-full');
  await expect(full).toBeVisible({ timeout: 15_000 });
  await expect(compact.getByTestId('typed-ui-action-status')).toContainText('open_artifact', { timeout: 10_000 });
  await expect(page.locator('.preview-panel:visible').last()).toContainText('Typed release cockpit');
  await page.screenshot({ path: 'tests/e2e/results/typed-ui-workbench-light.png' });

  await setVisualTheme(page, 'dark');
  await compact.screenshot({ path: 'tests/e2e/results/typed-ui-compact-dark.png' });
  await full.screenshot({ path: 'tests/e2e/results/typed-ui-workbench-dark.png' });
  await expect(full.getByRole('button', { name: 'Prepare' })).toBeEnabled();
  await expect(full.getByRole('button', { name: /Freigabe|approval/i })).toBeEnabled();

  expect(artifactId).toMatch(/^e2e-typed-ui-/);
});
