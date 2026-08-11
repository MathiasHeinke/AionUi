import crypto from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Page, Route } from '@playwright/test';
import { E2E_BACKEND_DATA_DIR, expect, restartSharedElectronAppForIsolatedSpec, test } from '../fixtures';
import { goToGuid, httpDelete, httpGet, httpPost, invokeBridge } from '../helpers';

type CreatedConversation = { id: string };
type CoreConversation = CreatedConversation & Record<string, unknown>;

type CoreReceiptOutcome = 'accepted' | 'already_applied' | 'retryable' | 'rejected' | 'explicit_unknown';
type CoreReceiptState = 'processing' | 'pending' | 'completed' | 'rejected' | 'explicit_unknown';

type CoreActivityRouteState = {
  online: boolean;
  needsInput: boolean;
  receipts: Array<{
    completion_id: string;
    acp_session_id: string;
    state: CoreReceiptState;
    turn_id?: string;
    attempt_count: number;
    last_outcome?: CoreReceiptOutcome;
    last_outcome_code?: string;
    created_at: number;
    updated_at: number;
    completed_at?: number;
    last_outcome_at?: number;
  }>;
  artifacts: Array<Record<string, unknown>>;
  cancelTurnIds: string[];
};

type CoreActivityRouteOptions = {
  controlReceiptAvailability?: boolean;
};

const PACKAGED_QA_ENABLED = process.env.E2E_PACKAGED === '1' && process.env.COMMAND_EVE_E2E_PACKAGED_ATTACHMENT === '1';

const toBase64Url = (buffer: Buffer): string =>
  Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

const canonicalLicensePayload = (payload: Record<string, unknown>): string =>
  JSON.stringify({
    license_version: payload.license_version ?? null,
    edition: payload.edition ?? null,
    serial: payload.serial ?? null,
    tenant_serial: payload.tenant_serial ?? null,
    issued_at: payload.issued_at ?? null,
    expires_at: payload.expires_at ?? null,
  });

function signLicenseCode(privateKey: crypto.KeyObject, payload: Record<string, unknown>): string {
  const payloadBytes = Buffer.from(canonicalLicensePayload(payload), 'utf8');
  const signature = crypto.sign(null, payloadBytes, privateKey);
  return ['CEVE', 'v1', toBase64Url(payloadBytes), toBase64Url(signature)].join('.');
}

function resolvePackagedQaResources(): string {
  const explicit = process.env.COMMAND_EVE_DURABLE_WORK_QA_RESOURCES?.trim();
  if (explicit) {
    if (!path.isAbsolute(explicit)) throw new Error('COMMAND_EVE_DURABLE_WORK_QA_RESOURCES must be absolute.');
    return explicit;
  }
  if (process.platform !== 'darwin') {
    throw new Error('Packaged durable-work QA currently requires an explicit resources path outside macOS.');
  }
  return path.resolve(
    __dirname,
    '../../..',
    'out',
    'e2e-packaged',
    `mac-${process.arch}`,
    'Command EVE.app',
    'Contents',
    'Resources'
  );
}

let packagedQaLicenseCode: string | null = null;

type EntitlementStatusBridgeResponse = {
  success?: boolean;
  data?: {
    ok?: boolean;
    required?: boolean;
    state?: string;
    reason_code?: string;
  };
};

if (PACKAGED_QA_ENABLED) {
  // The ephemeral QA license is intentionally not known by the production
  // entitlement service. Keep this unsigned, offline proof on the product's
  // existing explicit offline path so a live revocation check cannot race the
  // local signature/restart assertions or send the disposable wire externally.
  process.env.COMMAND_EVE_ONLINE_REVERIFY = 'off';
  const resourcesPath = resolvePackagedQaResources();
  const markerPath = path.join(resourcesPath, '.command-eve-e2e-packaged-attachment');
  if (!fs.existsSync(markerPath)) {
    throw new Error('Packaged durable-work QA requires the non-distributable E2E attachment marker.');
  }

  const publicKeyPath = path.join(resourcesPath, 'command-eve-license-public-key.pem');
  const originalPublicKey = fs.readFileSync(publicKeyPath);
  const originalPublicKeyMode = fs.statSync(publicKeyPath).mode & 0o777;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }), {
    mode: originalPublicKeyMode,
  });
  process.on('exit', () => {
    try {
      fs.writeFileSync(publicKeyPath, originalPublicKey, { mode: originalPublicKeyMode });
    } catch {
      // Best effort: this is generated, non-distributable electron-builder output.
    }
  });

  const managedResources = path.join(
    resourcesPath,
    'bundled-aioncore',
    `${process.platform}-${process.arch}`,
    'managed-resources'
  );
  if (!fs.existsSync(path.join(managedResources, 'node'))) {
    throw new Error(`Packaged durable-work QA managed Node resources are missing: ${managedResources}`);
  }
  process.env.AIONUI_BUNDLED_MANAGED_RESOURCES = managedResources;
  packagedQaLicenseCode = signLicenseCode(privateKey, {
    license_version: 'command-eve-license/v1',
    edition: 'pilot',
    serial: `CEVE-DURABLE-WORK-QA-${process.pid}`,
    tenant_serial: `TENANT-DURABLE-WORK-QA-${process.pid}`,
    issued_at: '2026-01-01T00:00:00.000Z',
    expires_at: '2030-01-01T00:00:00.000Z',
  });
}

async function ensurePackagedQaEntitlement(page: Page): Promise<void> {
  if (!packagedQaLicenseCode) return;
  const initial = await invokeBridge<EntitlementStatusBridgeResponse>(page, 'command-eve.entitlement-status');
  if (initial.data?.ok === true && initial.data.state === 'entitled') return;
  const gate = page.getByTestId('registration-gate');
  await expect(gate).toBeVisible({ timeout: 30_000 });

  await page.getByTestId('registration-gate-have-code').click();
  const setupButton = page.getByTestId('registration-gate-license-setup-button');
  if ((await setupButton.count()) > 0) {
    await setupButton.click();
    await page.getByTestId('registration-gate-name').fill('Packaged QA');
    await page.getByTestId('registration-gate-company').fill('Command EVE QA');
    await page.getByTestId('registration-gate-email').fill('packaged-qa@example.invalid');
    await page.getByTestId('registration-gate-consent').click();
    await page.getByTestId('registration-gate-submit').click();
  }
  await expect(page.getByTestId('registration-gate-license-form')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('registration-gate-code').fill(packagedQaLicenseCode);
  await page.getByTestId('registration-gate-license-submit').click();
  await expect(gate).toHaveCount(0, { timeout: 30_000 });
  await assertPackagedQaEntitled(page, 'after activation');
}

async function assertPackagedQaEntitled(page: Page, stage: string): Promise<void> {
  if (!packagedQaLicenseCode) return;
  const response = await invokeBridge<EntitlementStatusBridgeResponse>(page, 'command-eve.entitlement-status');
  const status = response?.data;
  if (status?.ok !== true || status.state !== 'entitled') {
    throw new Error(`Packaged QA entitlement was lost ${stage}: ${JSON.stringify(status ?? response)}`);
  }
}

function fulfillData(route: Route, data: unknown): Promise<void> {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data }),
  });
}

async function createConversation(page: Page): Promise<string> {
  await goToGuid(page);
  await assertPackagedQaEntitled(page, 'after guid navigation');
  await page.waitForFunction(
    () => typeof (window as unknown as { __backendPort?: number }).__backendPort === 'number',
    { timeout: 30_000 }
  );
  const conversation = await httpPost<CreatedConversation>(page, '/api/conversations', {
    type: 'acp',
    name: `E2E durable work activity ${Date.now()}`,
    extra: {
      workspace: os.tmpdir(),
      custom_workspace: true,
      backend: 'codex',
      session_mode: 'default',
    },
  });
  if (!conversation.id) throw new Error('Conversation creation returned no id');
  return conversation.id;
}

async function openConversation(page: Page, conversationId: string): Promise<void> {
  await page.evaluate((id) => {
    window.location.hash = `#/conversation/${id}`;
  }, conversationId);
  await page.waitForFunction((id) => window.location.hash === `#/conversation/${id}`, conversationId);
  await expect(page.getByTestId('message-list-scroller')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('sendbox-input')).toBeVisible({ timeout: 60_000 });
}

async function removeConversation(page: Page, conversationId: string): Promise<void> {
  await httpDelete(page, `/api/conversations/${encodeURIComponent(conversationId)}`).catch(() => {});
}

const coreReceipt = (
  completionId: string,
  lastOutcome?: CoreReceiptOutcome,
  state: CoreReceiptState = 'completed'
): CoreActivityRouteState['receipts'][number] => {
  const now = Date.now();
  return {
    completion_id: completionId,
    acp_session_id: `session-${completionId}`,
    state,
    turn_id: state === 'rejected' ? undefined : `turn-${completionId}`,
    attempt_count: 2,
    last_outcome: lastOutcome,
    last_outcome_code: lastOutcome === 'retryable' ? 'busy_retry' : undefined,
    created_at: now - 10_000,
    updated_at: now - 1_000,
    completed_at: state === 'completed' ? now - 1_000 : undefined,
    last_outcome_at: lastOutcome ? now - 1_000 : undefined,
  };
};

async function installCoreActivityRoutes(
  page: Page,
  conversationId: string,
  baseConversation: CoreConversation,
  state: CoreActivityRouteState,
  options: CoreActivityRouteOptions = {}
): Promise<void> {
  const escapedId = encodeURIComponent(conversationId);
  if (options.controlReceiptAvailability !== false) {
    await page.route(`**/api/conversations/${escapedId}/async-completion-receipts`, (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      if (!state.online) {
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, error: { code: 'qa_transport_offline' } }),
        });
      }
      return route.continue();
    });
  }
  await page.route(`**/api/conversations/${escapedId}/artifacts`, (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    return fulfillData(route, state.artifacts);
  });
  await page.route(`**/api/conversations/${escapedId}/cancel`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = route.request().postDataJSON() as { turn_id?: string };
    if (body.turn_id) state.cancelTurnIds.push(body.turn_id);
    return route.continue();
  });
  await page.route(`**/api/conversations/${escapedId}`, (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    return fulfillData(route, {
      ...baseConversation,
      runtime: state.needsInput
        ? {
            state: 'waiting_confirmation',
            can_send_message: false,
            has_task: true,
            task_status: 'running',
            is_processing: true,
            pending_confirmations: 1,
            turn_id: 'turn-needs-user',
          }
        : {
            state: 'idle',
            can_send_message: true,
            has_task: false,
            is_processing: false,
            pending_confirmations: 0,
            turn_id: null,
          },
    });
  });
}

const sqlLiteral = (value: string | number | null | undefined): string => {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Receipt fixture contains a non-finite number.');
    return String(value);
  }
  return `'${value.replaceAll("'", "''")}'`;
};

function findAionCoreDatabase(conversationId: string): string {
  const candidates: string[] = [];
  const pending = [path.dirname(E2E_BACKEND_DATA_DIR)];
  while (pending.length > 0) {
    const directory = pending.pop() as string;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name === 'aionui-backend.db') candidates.push(candidate);
    }
  }
  const active = candidates.filter((candidate) => {
    try {
      const count = execFileSync(
        'sqlite3',
        [candidate, `SELECT COUNT(*) FROM conversations WHERE id = ${sqlLiteral(conversationId)};`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      ).trim();
      return count === '1';
    } catch {
      return false;
    }
  });
  if (active.length !== 1) {
    throw new Error(
      `Expected one AionCore QA database for ${conversationId}; matched: ${active.join(', ')}; candidates: ${candidates.join(', ')}`
    );
  }
  return active[0];
}

function seedCoreReceipts(conversationId: string, receipts: CoreActivityRouteState['receipts']): void {
  const databasePath = findAionCoreDatabase(conversationId);
  const statements = receipts.map((receipt) => {
    if (receipt.state === 'rejected') {
      const code = receipt.last_outcome_code || 'session_mismatch';
      return `INSERT INTO command_eve_async_completion_rejections
        (conversation_id, bound_acp_session_id, requested_acp_session_id, completion_id,
         payload_sha256, code, attempt_count, created_at, updated_at)
        VALUES (${[
          conversationId,
          `session-bound-${receipt.completion_id}`,
          receipt.acp_session_id,
          receipt.completion_id,
          crypto.createHash('sha256').update(receipt.completion_id).digest('hex'),
          code,
          receipt.attempt_count,
          receipt.created_at,
          receipt.updated_at,
        ]
          .map(sqlLiteral)
          .join(', ')});`;
    }
    const databaseState = receipt.state === 'explicit_unknown' ? 'unknown' : receipt.state;
    const values = [
      receipt.completion_id,
      conversationId,
      receipt.acp_session_id,
      crypto.createHash('sha256').update(receipt.completion_id).digest('hex'),
      databaseState,
      databaseState === 'processing' ? 'packaged-qa-owner' : null,
      receipt.turn_id,
      receipt.attempt_count,
      receipt.last_outcome_code,
      receipt.created_at,
      receipt.updated_at,
      receipt.completed_at,
      receipt.last_outcome,
      receipt.last_outcome_code,
      receipt.last_outcome_at,
    ];
    return `INSERT INTO command_eve_async_completion_receipts
      (completion_id, conversation_id, acp_session_id, payload_sha256, state, owner_instance_id,
       turn_id, attempt_count, last_error_code, created_at, updated_at, completed_at,
       last_ack_status, last_ack_code, last_ack_at)
      VALUES (${values.map(sqlLiteral).join(', ')});`;
  });
  execFileSync(
    'sqlite3',
    ['-cmd', '.timeout 5000', databasePath, ['BEGIN IMMEDIATE;', ...statements, 'COMMIT;'].join('\n')],
    {
      stdio: 'pipe',
    }
  );
  const persistedCount = execFileSync(
    'sqlite3',
    [
      databasePath,
      `SELECT
         (SELECT COUNT(*) FROM command_eve_async_completion_receipts WHERE conversation_id = ${sqlLiteral(conversationId)}) +
         (SELECT COUNT(*) FROM command_eve_async_completion_rejections WHERE conversation_id = ${sqlLiteral(conversationId)});`,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim();
  if (persistedCount !== String(receipts.length)) {
    throw new Error(`Receipt fixture persistence mismatch in ${databasePath}: ${persistedCount}/${receipts.length}`);
  }
}

async function showActivityRail(page: Page): Promise<ReturnType<Page['getByTestId']>> {
  const rail = page.getByTestId('shell-elements-rail');
  if (!(await rail.isVisible().catch(() => false))) await page.getByTestId('elements-rail-toggle').click();
  await expect(rail).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('elements-rail-tab-activity').click();
  return rail;
}

async function installLegacyDelegationHistory(page: Page, conversationId: string): Promise<RegExp> {
  const pattern = new RegExp(`/api/conversations/${encodeURIComponent(conversationId)}/messages(?:\\?.*)?$`);
  await page.route(pattern, (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    return fulfillData(route, {
      items: [
        {
          id: 'delegation-message-1',
          msg_id: 'delegation-message-1',
          conversation_id: conversationId,
          type: 'acp_tool_call',
          position: 'left',
          created_at: Date.now(),
          content: {
            session_id: conversationId,
            update: {
              sessionUpdate: 'tool_call',
              tool_call_id: 'delegation-tool-1',
              status: 'in_progress',
              title: 'delegate: Verify durable wake receipts',
              kind: 'execute',
              rawInput: { goal: 'Verify durable wake receipts', role: 'cto' },
            },
          },
        },
      ],
      oldest_cursor: 'delegation-message-1',
      newest_cursor: 'delegation-message-1',
      has_more_before: false,
      has_more_after: false,
    });
  });
  return pattern;
}

test.describe('Command EVE durable work activity shell', () => {
  test.setTimeout(120_000);
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await ensurePackagedQaEntitlement(page);
  });

  test.afterEach(async ({ page }) => {
    if (!page.isClosed()) await page.setViewportSize({ width: 1280, height: 800 });
  });

  test('keeps one chat composer while the activity rail remains keyboard-operable at narrow width', async ({
    page,
  }) => {
    const conversationId = await createConversation(page);
    try {
      // 900px is the narrow desktop shell: below this the product intentionally
      // switches to its mobile conversation layout instead of showing a side rail.
      await page.setViewportSize({ width: 900, height: 760 });
      await openConversation(page, conversationId);

      const composer = page.getByTestId('sendbox-input');
      await expect(composer).toHaveCount(1);

      const railToggle = page.getByTestId('elements-rail-toggle');
      await expect(railToggle).toBeVisible({ timeout: 30_000 });
      await railToggle.click();

      const rail = page.getByTestId('shell-elements-rail');
      const activityTab = page.getByTestId('elements-rail-tab-activity');
      const artifactsTab = page.getByTestId('elements-rail-tab-artifacts');
      await expect(rail).toBeVisible();
      await expect(activityTab).toHaveAttribute('aria-selected', 'true');
      await activityTab.focus();
      await page.keyboard.press('ArrowRight');
      await expect(artifactsTab).toHaveAttribute('aria-selected', 'true');
      await artifactsTab.focus();
      await page.keyboard.press('ArrowLeft');
      await expect(activityTab).toHaveAttribute('aria-selected', 'true');

      await expect(composer).toHaveCount(1);
      const railBox = await rail.boundingBox();
      expect(railBox).not.toBeNull();
      if (railBox) {
        expect(railBox.width).toBeGreaterThanOrEqual(220);
        expect(railBox.width).toBeLessThanOrEqual(360);
      }
      const hasHorizontalOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1
      );
      expect(hasHorizontalOverflow).toBe(false);
    } finally {
      await removeConversation(page, conversationId);
    }
  });

  test('keeps the activity rail legible in both shell themes', async ({ page }, testInfo) => {
    const conversationId = await createConversation(page);
    const messagesPattern = await installLegacyDelegationHistory(page, conversationId);
    try {
      await openConversation(page, conversationId);
      await page.getByTestId('elements-rail-toggle').click();
      const rail = page.getByTestId('shell-elements-rail');
      await expect(rail).toBeVisible({ timeout: 30_000 });
      await expect(rail.getByText('Verify durable wake receipts').first()).toBeVisible();
      await expect(rail.getByText(/Reconnect fehlt|Reconnect unavailable/)).toBeVisible();

      const captureTheme = async (theme: 'light' | 'dark') => {
        await page.evaluate((nextTheme) => document.documentElement.setAttribute('data-theme', nextTheme), theme);
        const colors = await rail.evaluate((element) => {
          const style = getComputedStyle(element);
          return { background: style.backgroundColor, color: style.color };
        });
        expect(colors.background).not.toBe(colors.color);
        expect(colors.color).not.toBe('rgba(0, 0, 0, 0)');

        const screenshotPath = `tests/e2e/results/durable-work-activity-${theme}.png`;
        await page.screenshot({ path: screenshotPath });
        await testInfo.attach(`durable-work-activity-${theme}`, {
          path: screenshotPath,
          contentType: 'image/png',
        });
      };

      await captureTheme('light');
      await captureTheme('dark');

      await rail.getByRole('button', { name: /Verify durable wake receipts.*(?:öffnen|open)/i }).click();
      const detail = page.getByTestId('durable-work-activity-detail');
      await expect(detail).toBeVisible();
      await expect(detail.getByText(/Kein bestätigtes Wake-Receipt|No accepted wake receipt/)).toBeVisible();
      await expect(page.getByTestId('sendbox-input')).toHaveCount(1);

      const detailScreenshotPath = 'tests/e2e/results/durable-work-activity-detail-dark.png';
      await page.screenshot({ path: detailScreenshotPath });
      await testInfo.attach('durable-work-activity-detail-dark', {
        path: detailScreenshotPath,
        contentType: 'image/png',
      });
    } finally {
      await page.unroute(messagesPattern).catch(() => {});
      await removeConversation(page, conversationId);
    }
  });

  test('projects committed core receipts across switch, reconnect and unsigned app restart', async ({
    page,
  }, testInfo) => {
    const conversationId = await createConversation(page);
    const secondConversationId = await createConversation(page);
    const firstConversation = await httpGet<CoreConversation>(page, `/api/conversations/${conversationId}`);
    const secondConversation = await httpGet<CoreConversation>(page, `/api/conversations/${secondConversationId}`);
    const firstState: CoreActivityRouteState = {
      online: true,
      needsInput: true,
      receipts: [
        coreReceipt('accepted', 'accepted'),
        coreReceipt('already', 'already_applied'),
        coreReceipt('busy', 'retryable', 'pending'),
        coreReceipt('rejected', 'rejected', 'rejected'),
        coreReceipt('unknown', 'explicit_unknown', 'explicit_unknown'),
        coreReceipt('processing', undefined, 'processing'),
      ],
      artifacts: [
        {
          id: 'artifact-child-1',
          conversation_id: conversationId,
          kind: 'html',
          status: 'active',
          payload: {
            artifact_type: 'html',
            title: 'Child worker evidence',
            html: '<main><h1>Verified child evidence</h1></main>',
            receipt: { completion_id: 'accepted' },
          },
          created_at: Date.now() - 2_000,
          updated_at: Date.now() - 1_000,
        },
      ],
      cancelTurnIds: [],
    };
    const secondState: CoreActivityRouteState = {
      online: true,
      needsInput: false,
      receipts: [coreReceipt('second-conversation', 'accepted')],
      artifacts: [],
      cancelTurnIds: [],
    };

    seedCoreReceipts(conversationId, firstState.receipts);
    seedCoreReceipts(secondConversationId, secondState.receipts);
    await installCoreActivityRoutes(page, conversationId, firstConversation, firstState);
    await installCoreActivityRoutes(page, secondConversationId, secondConversation, secondState);
    const persistedProjection = await httpGet<{
      version: string;
      conversation_id: string;
      reconstructed_from: string;
      receipts: CoreActivityRouteState['receipts'];
    }>(page, `/api/conversations/${conversationId}/async-completion-receipts`);
    expect(persistedProjection).toMatchObject({
      version: 'command-eve-async-completion-receipts/v1',
      conversation_id: conversationId,
      reconstructed_from: 'persistent_receipts',
    });
    expect(persistedProjection.receipts.map((receipt) => receipt.completion_id).sort()).toEqual(
      firstState.receipts.map((receipt) => receipt.completion_id).sort()
    );

    try {
      await openConversation(page, conversationId);
      let rail = await showActivityRail(page);
      await expect(rail.getByText(/Wake delivery accepted|Wake-Zustellung angenommen/)).toBeVisible();
      await expect(rail.getByText(/Wake delivery already applied|Wake-Zustellung bereits angewendet/)).toBeVisible();
      await expect(rail.getByText(/Wake delivery will retry|Wake-Zustellung wird wiederholt/)).toBeVisible();
      await expect(rail.getByText(/Wake delivery rejected|Wake-Zustellung abgelehnt/)).toBeVisible();
      await expect(rail.getByText(/^Wake.*(?:explicitly unknown|ausdrücklich unbekannt)$/)).toBeVisible();
      await expect(rail.getByText(/Needs input|Eingabe nötig/).first()).toBeVisible();
      await expect(rail.getByText(/Succeeded|Erfolgreich/)).toHaveCount(0);
      await expect(rail.getByTestId('durable-work-item-hermes:execution:accepted')).toHaveAttribute(
        'data-status',
        'stalled'
      );
      await expect(rail.getByTestId('durable-work-item-hermes:execution:already')).toHaveAttribute(
        'data-status',
        'stalled'
      );
      await expect(page.getByTestId('sendbox-input')).toHaveCount(1);

      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
      const coreLightScreenshot = 'tests/e2e/results/durable-work-core-light.png';
      await page.screenshot({ path: coreLightScreenshot });
      await testInfo.attach('durable-work-core-light', { path: coreLightScreenshot, contentType: 'image/png' });
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
      const coreDarkScreenshot = 'tests/e2e/results/durable-work-core-dark.png';
      await page.screenshot({ path: coreDarkScreenshot });
      await testInfo.attach('durable-work-core-dark', { path: coreDarkScreenshot, contentType: 'image/png' });

      const processingItem = rail.getByTestId('durable-work-item-hermes:execution:processing');
      await expect(processingItem).toHaveAttribute('data-status', 'reconnect_unavailable');
      await expect(
        processingItem.getByRole('button', { name: /Hermes background work.*(?:stop|stoppen)/i })
      ).toBeDisabled();
      expect(firstState.cancelTurnIds).toEqual([]);

      const busyItem = rail.getByTestId('durable-work-item-hermes:execution:busy');
      await expect(
        busyItem.getByRole('button', { name: /Hermes background work.*(?:resume|fortsetzen)/i })
      ).toBeDisabled();
      await expect(busyItem.getByRole('button', { name: /Hermes background work.*(?:retry|erneut)/i })).toBeDisabled();

      await openConversation(page, secondConversationId);
      rail = await showActivityRail(page);
      await expect(rail.getByTestId('durable-work-item-hermes:execution:second-conversation')).toBeVisible();
      await expect(rail.getByText(/Hermes background work · accepted/)).toHaveCount(0);

      await openConversation(page, conversationId);
      rail = await showActivityRail(page);
      const acceptedItem = rail.getByTestId('durable-work-item-hermes:execution:accepted');
      await expect(acceptedItem).toBeVisible();
      await expect(acceptedItem).toHaveAttribute('data-status', 'stalled');

      firstState.online = false;
      await expect
        .poll(async () => (await acceptedItem.getAttribute('data-status')) || '', { timeout: 8_000 })
        .toBe('reconnect_unavailable');
      await expect(
        acceptedItem.getByRole('button', { name: /Hermes background work.*(?:stop|stoppen)/i })
      ).toBeDisabled();

      firstState.online = true;
      await expect
        .poll(async () => (await acceptedItem.getAttribute('data-status')) || '', { timeout: 8_000 })
        .toBe('stalled');

      await acceptedItem.getByRole('button', { name: /Hermes background work.*(?:open|öffnen)/i }).click();
      const detail = page.getByTestId('durable-work-activity-detail');
      await expect(detail.getByText('Child worker evidence')).toBeVisible();
      await expect(detail.getByText(/Wake delivery accepted|Wake-Zustellung angenommen/)).toBeVisible();
      const coreDetailScreenshot = 'tests/e2e/results/durable-work-core-detail-dark.png';
      await page.screenshot({ path: coreDetailScreenshot });
      await testInfo.attach('durable-work-core-detail-dark', {
        path: coreDetailScreenshot,
        contentType: 'image/png',
      });
      await detail.getByRole('button', { name: 'Child worker evidence' }).click();
      await expect(page.getByText('Child worker evidence').first()).toBeVisible();
      const childArtifactScreenshot = 'tests/e2e/results/durable-work-child-artifact-dark.png';
      await page.screenshot({ path: childArtifactScreenshot });
      await testInfo.attach('durable-work-child-artifact-dark', {
        path: childArtifactScreenshot,
        contentType: 'image/png',
      });

      const restarted = await restartSharedElectronAppForIsolatedSpec();
      page = restarted.page;
      await ensurePackagedQaEntitlement(page);
      await page.waitForFunction(
        () => typeof (window as unknown as { __backendPort?: number }).__backendPort === 'number',
        { timeout: 30_000 }
      );
      const restartedProjection = await httpGet<{
        version: string;
        conversation_id: string;
        reconstructed_from: string;
        receipts: CoreActivityRouteState['receipts'];
      }>(page, `/api/conversations/${conversationId}/async-completion-receipts`);
      expect(restartedProjection).toMatchObject({
        version: 'command-eve-async-completion-receipts/v1',
        conversation_id: conversationId,
        reconstructed_from: 'persistent_receipts',
      });
      expect(restartedProjection.receipts.map((receipt) => receipt.completion_id).sort()).toEqual(
        firstState.receipts.map((receipt) => receipt.completion_id).sort()
      );
      // Keep only the presentation fixtures after restart. The receipt path is
      // intentionally left untouched so the rail reconstructs from the live
      // restarted AionCore database rather than a Playwright response.
      await installCoreActivityRoutes(page, conversationId, firstConversation, firstState, {
        controlReceiptAvailability: false,
      });
      await openConversation(page, conversationId);
      rail = await showActivityRail(page);
      await expect(rail.getByTestId('durable-work-item-hermes:execution:accepted')).toBeVisible({ timeout: 30_000 });
      await expect(rail.getByTestId('durable-work-item-hermes:execution:accepted')).toHaveAttribute(
        'data-status',
        'stalled'
      );
      await expect(rail.getByText(/Wake delivery accepted|Wake-Zustellung angenommen/)).toBeVisible();
      await expect(page.getByTestId('sendbox-input')).toHaveCount(1);
    } finally {
      await removeConversation(page, conversationId);
      await removeConversation(page, secondConversationId);
    }
  });
});
