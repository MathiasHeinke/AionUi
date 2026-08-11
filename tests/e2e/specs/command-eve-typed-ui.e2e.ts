/**
 * Deterministic visual and integration proof for Typed Generative UI.
 *
 * The fixture enters through the real conversation artifact store, renders in
 * the existing chat, and opens the same validated AST in the right Workbench.
 * It never calls a model, network service, release path or production system.
 */

import type { TypedUIEnvelope } from '@/common/typedUI';
import {
  appendMainOwnedTypedUIProviderCompletionReceipt,
  appendTrustedTypedUIGenerationReceipt,
  hashTypedUIEnvelope,
  TYPED_UI_GENERATION_RECEIPT_VERSION,
  TYPED_UI_PROVIDER_COMPLETION_RECEIPT_VERSION,
} from '@/process/commandEve/typedUIProvenanceAttestationCore';
import type { Page } from '@playwright/test';
import path from 'node:path';
import { E2E_USER_DATA_DIR, test, expect } from '../fixtures';
import { goToGuid, httpPost } from '../helpers';

type TypedUIArtifactOptions = { artifactId: string; createdAt: number };

type TypedUIRegistry = {
  controllers: Record<
    string,
    {
      prepareTypedUIArtifact: (options: TypedUIArtifactOptions) => TypedUIEnvelope;
      emitTypedUIArtifact: (options: TypedUIArtifactOptions) => Promise<string>;
    }
  >;
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
      return Boolean(
        registry?.controllers[id]?.prepareTypedUIArtifact && registry.controllers[id]?.emitTypedUIArtifact
      );
    },
    conversationId,
    { timeout: 15_000 }
  );
}

async function prepareTypedUIArtifact(
  page: Page,
  conversationId: string,
  options: TypedUIArtifactOptions
): Promise<TypedUIEnvelope> {
  return page.evaluate(
    ({ id, artifactOptions }) => {
      const registry = (
        window as typeof window & {
          __AIONUI_E2E_MESSAGE_STREAM__?: TypedUIRegistry;
        }
      ).__AIONUI_E2E_MESSAGE_STREAM__;
      const controller = registry?.controllers[id];
      if (!controller) throw new Error(`No Typed UI E2E controller for ${id}`);
      return controller.prepareTypedUIArtifact(artifactOptions);
    },
    { id: conversationId, artifactOptions: options }
  );
}

async function emitTypedUIArtifact(
  page: Page,
  conversationId: string,
  options: TypedUIArtifactOptions
): Promise<string> {
  return page.evaluate(
    async ({ id, artifactOptions }) => {
      const registry = (
        window as typeof window & {
          __AIONUI_E2E_MESSAGE_STREAM__?: TypedUIRegistry;
        }
      ).__AIONUI_E2E_MESSAGE_STREAM__;
      const controller = registry?.controllers[id];
      if (!controller) throw new Error(`No Typed UI E2E controller for ${id}`);
      return controller.emitTypedUIArtifact(artifactOptions);
    },
    { id: conversationId, artifactOptions: options }
  );
}

async function setVisualTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((nextTheme) => {
    document.documentElement.setAttribute('data-theme', nextTheme);
    document.body.setAttribute('arco-theme', nextTheme);
  }, theme);
}

test('renders compact in chat and full in the existing Workbench, light and dark', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await goToGuid(page);
  const conversationId = await createConversation(page);
  await openConversation(page, conversationId);
  const createdAt = Date.now();
  const artifactOptions = { artifactId: `e2e-typed-ui-${createdAt}`, createdAt };
  const envelope = await prepareTypedUIArtifact(page, conversationId, artifactOptions);
  const generationLedgerPath = path.join(
    E2E_USER_DATA_DIR,
    'command-eve',
    'command-eve-runtime',
    'audit',
    'typed-ui-generations.jsonl'
  );
  const completionLedgerPath = path.join(
    E2E_USER_DATA_DIR,
    'command-eve',
    'command-eve-runtime',
    'audit',
    'typed-ui-provider-completions.jsonl'
  );
  const completion = appendMainOwnedTypedUIProviderCompletionReceipt(completionLedgerPath, {
    version: TYPED_UI_PROVIDER_COMPLETION_RECEIPT_VERSION,
    session_id: `session-${artifactOptions.artifactId}`,
    provider: envelope.provenance.provider,
    model: envelope.provenance.model,
    request_id: envelope.provenance.request_id,
    route_receipt: {
      receipt_id: `route-${artifactOptions.artifactId}`,
      route: 'provider-free-e2e',
      status: 'completed',
    },
    seat_id: 'seat-1',
    seat_context_revision: 0,
    completed_at: envelope.provenance.generated_at,
  });
  appendTrustedTypedUIGenerationReceipt(generationLedgerPath, completionLedgerPath, {
    version: TYPED_UI_GENERATION_RECEIPT_VERSION,
    completed_route_receipt_id: completion.completion_receipt_id,
    artifact_id: artifactOptions.artifactId,
    conversation_id: conversationId,
    source_message_id: `message-${artifactOptions.artifactId}`,
    created_at: createdAt,
    content_sha256: hashTypedUIEnvelope(envelope),
  });
  const artifactId = await emitTypedUIArtifact(page, conversationId, artifactOptions);

  const compact = page.getByTestId('typed-ui-compact');
  await expect(compact).toBeVisible({ timeout: 15_000 });
  await expect(compact.getByRole('heading', { name: 'Typed release cockpit' })).toBeVisible();
  await expect(compact.getByText('Reach the integration gate')).toBeVisible();
  await expect(compact.getByTestId('typed-ui-provenance-status')).toContainText(/verifiziert|verified/i);
  await expect(compact).not.toContainText('e2e-local');
  await expect(compact).not.toContainText('deterministic-visual-fixture');
  const disabledPause = compact.getByRole('button', { name: /Pausieren|Pause/i });
  const disabledCancel = compact.getByRole('button', { name: /Abbrechen|Cancel/i });
  await expect(disabledPause).toHaveAttribute('aria-disabled', 'true');
  await expect(disabledCancel).toHaveAttribute('aria-disabled', 'true');
  await disabledPause.focus();
  await expect(disabledPause).toBeFocused();
  await expect(compact).toHaveAttribute('aria-label', /\S/);
  await expect(compact.getByTestId('typed-ui-action-status')).toHaveAttribute('aria-live', 'polite');
  await expect(page.getByTestId(`conversation-artifact-file`)).toHaveAttribute(
    'data-conversation-artifact-kind',
    'file'
  );

  await setVisualTheme(page, 'light');
  await compact.screenshot({ path: 'tests/e2e/results/typed-ui-compact-light.png' });

  await page.setViewportSize({ width: 720, height: 820 });
  await expect(compact).toBeVisible();
  const narrowCompactBox = await compact.boundingBox();
  expect(narrowCompactBox).not.toBeNull();
  expect((narrowCompactBox?.x ?? 0) + (narrowCompactBox?.width ?? 0)).toBeLessThanOrEqual(720);
  await compact.screenshot({ path: 'tests/e2e/results/typed-ui-compact-narrow-light.png' });

  await setVisualTheme(page, 'dark');
  await compact.screenshot({ path: 'tests/e2e/results/typed-ui-compact-narrow-dark.png' });

  await page.setViewportSize({ width: 1440, height: 900 });
  await compact.screenshot({ path: 'tests/e2e/results/typed-ui-compact-dark.png' });
  await setVisualTheme(page, 'light');

  const openWorkbench = compact.getByRole('button', { name: /Workbench/i });
  await expect(openWorkbench).toBeEnabled();
  await openWorkbench.focus();
  await expect(openWorkbench).toBeFocused();
  await page.keyboard.press('Enter');

  const full = page.getByTestId('typed-ui-full');
  await expect(full).toBeVisible({ timeout: 15_000 });
  await expect(compact.getByTestId('typed-ui-action-status')).toContainText('open_artifact', { timeout: 10_000 });
  await expect(page.locator('.preview-panel:visible').last()).toContainText('Typed release cockpit');
  await page.screenshot({ path: 'tests/e2e/results/typed-ui-workbench-light.png' });

  await page.setViewportSize({ width: 720, height: 820 });
  await expect(full).toBeVisible();
  const narrowFullBox = await full.boundingBox();
  expect(narrowFullBox).not.toBeNull();
  expect(narrowFullBox?.width ?? 721).toBeLessThanOrEqual(720);
  await full.screenshot({ path: 'tests/e2e/results/typed-ui-workbench-narrow-light.png' });

  await setVisualTheme(page, 'dark');
  await full.screenshot({ path: 'tests/e2e/results/typed-ui-workbench-narrow-dark.png' });

  await page.setViewportSize({ width: 1440, height: 900 });
  await full.screenshot({ path: 'tests/e2e/results/typed-ui-workbench-dark.png' });
  await expect(full.getByRole('button', { name: 'Prepare' })).toBeEnabled();
  await expect(full.getByRole('button', { name: /Freigabe|approval/i })).toBeEnabled();

  expect(artifactId).toMatch(/^e2e-typed-ui-/);
});
