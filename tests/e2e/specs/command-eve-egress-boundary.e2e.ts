/**
 * Command EVE Egress Boundary – packaged GUI E2E.
 *
 * Drives the real Command EVE chat UI and verifies sensitive text sent through
 * the visible EVE path produces a fresh egress-boundary receipt before model
 * egress. This is the native-binding proof: UI → EVE/Hermes path → local
 * runtime shim → receipt.
 */
import { test, expect } from '../fixtures';
import { goToGuid, sendMessageFromGuid } from '../helpers';
import { invokeBridge } from '../helpers/bridge/invoke';

type RuntimeStatusResponse = {
  success?: boolean;
  msg?: string;
  data?: RuntimeStatus;
};

type RuntimeStatus = {
  status?: string;
  default_model?: string;
  next_action?: string;
  model_warmup?: {
    status?: string;
    model?: string;
    error?: string;
  };
  egress_boundary?: {
    decision?: string;
    observed_at?: string;
    finding_count?: number;
    policy_action?: string;
    receipt_path?: string;
  };
};

type ActiveSeatBridgeResponse =
  | {
      success?: boolean;
      data?: {
        seat_id?: string;
      };
    }
  | {
      seat_id?: string;
    };

async function commandEveRuntimeStatus(page: Parameters<typeof invokeBridge>[0]): Promise<RuntimeStatusResponse> {
  const response = await invokeBridge<RuntimeStatusResponse>(page, 'command-eve.runtime-status', undefined, 15_000);
  return response;
}

function isRuntimeReady(status: RuntimeStatus | undefined): boolean {
  return status?.status === 'ready' && Boolean(status.default_model);
}

function isDefaultModelWarm(status: RuntimeStatus | undefined): boolean {
  return Boolean(
    isRuntimeReady(status) &&
    status?.model_warmup?.status === 'ready' &&
    status.model_warmup.model === status.default_model
  );
}

async function ensureCommandEveRuntimeReady(page: Parameters<typeof invokeBridge>[0]): Promise<RuntimeStatus> {
  const initial = await commandEveRuntimeStatus(page);
  if (initial.success && isDefaultModelWarm(initial.data)) return initial.data;

  const ensured = await invokeBridge<RuntimeStatusResponse>(
    page,
    'command-eve.ensure-local-model-tier',
    { tierId: 'e4b' },
    180_000
  );
  const status = ensured.data;
  if (ensured.success && isDefaultModelWarm(status)) return status;

  const warmed = await invokeBridge<RuntimeStatusResponse>(
    page,
    'command-eve.warm-local-model',
    { tierId: 'e4b' },
    180_000
  );
  if (warmed.success && isDefaultModelWarm(warmed.data)) return warmed.data;

  test.skip(
    true,
    `Command EVE runtime not ready: ${
      warmed.msg ||
      warmed.data?.model_warmup?.error ||
      warmed.data?.next_action ||
      ensured.msg ||
      status?.next_action ||
      initial.msg ||
      initial.data?.next_action ||
      'unknown'
    }`
  );
  throw new Error('unreachable after test.skip');
}

function isLegacySeatId(seatId: string | undefined): boolean {
  const trimmed = (seatId || '').trim().toLowerCase();
  return trimmed.length === 0 || trimmed === 'default' || trimmed === 'seat-1';
}

async function forceLocalInferenceLane(page: Parameters<typeof invokeBridge>[0]): Promise<void> {
  const activeSeat = await invokeBridge<ActiveSeatBridgeResponse>(
    page,
    'command-eve.active-seat',
    undefined,
    10_000
  ).catch(() => undefined);
  const seatId =
    (activeSeat && 'data' in activeSeat ? activeSeat.data?.seat_id : undefined) ||
    (activeSeat && 'seat_id' in activeSeat ? activeSeat.seat_id : undefined) ||
    'seat-1';
  const inferenceSelectionKey = isLegacySeatId(seatId)
    ? 'commandEve.inferenceSelection'
    : `seat:${seatId.trim().toLowerCase()}:commandEve.inferenceSelection`;

  await page.evaluate(async ({ selectionKey }) => {
    const win = window as Window & {
      __backendPort?: number;
      __aionBackend?: { getPort?: () => number };
    };
    const dynamicPort = win.__aionBackend?.getPort?.();
    const port = typeof dynamicPort === 'number' && dynamicPort > 0 ? dynamicPort : win.__backendPort;
    if (!port) {
      throw new Error('window.__backendPort is not available');
    }

    const response = await fetch(`http://127.0.0.1:${port}/api/settings/client`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        [selectionKey]: 'command-eve-local:local-standard',
        'commandEve.localModelTierId': 'e4b',
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`PUT /api/settings/client failed (${response.status}): ${body}`);
    }
  }, { selectionKey: inferenceSelectionKey });

  await page.reload();
  await page.waitForSelector('body', { state: 'visible' });
}

test.describe('Command EVE egress boundary', () => {
  test.setTimeout(240_000);

  test('redacts sensitive data from the real EVE GUI chat path and writes a fresh receipt', async ({ page }) => {
    const rendererLogs: string[] = [];
    const createConversationPayloads: string[] = [];
    page.on('request', (request) => {
      if (request.method() !== 'POST' || !request.url().includes('/api/conversations')) return;
      const postData = request.postData();
      if (postData) createConversationPayloads.push(postData);
      if (createConversationPayloads.length > 10) createConversationPayloads.shift();
    });
    page.on('console', (message) => {
      rendererLogs.push(`[${message.type()}] ${message.text()}`);
      if (rendererLogs.length > 100) rendererLogs.shift();
    });
    page.on('pageerror', (error) => {
      rendererLogs.push(`[pageerror] ${error.message}`);
      if (rendererLogs.length > 100) rendererLogs.shift();
    });

    await page.waitForSelector('body', { state: 'visible' });
    await forceLocalInferenceLane(page);
    const readyStatus = await ensureCommandEveRuntimeReady(page);
    const previousObservedAt = readyStatus.egress_boundary?.observed_at ?? '';

    await goToGuid(page);

    const syntheticSecret =
      'E2E boundary proof: api_key=sk-e2etestboundary1234567890 and address Musterstraße 12, phone +49 30 12345678.';
    let conversationId: string;
    try {
      conversationId = await sendMessageFromGuid(page, syntheticSecret);
    } catch (error) {
      console.log(`[Command EVE E2E create payloads]\n${createConversationPayloads.join('\n---\n')}`);
      console.log(`[Command EVE E2E renderer logs]\n${rendererLogs.join('\n')}`);
      throw error;
    }
    expect(conversationId).toBeTruthy();

    try {
      await expect
        .poll(
          async () => {
            const response = await commandEveRuntimeStatus(page);
            const boundary = response.data?.egress_boundary;
            if (!boundary) return null;
            if (!boundary.observed_at || boundary.observed_at === previousObservedAt) return null;
            return boundary;
          },
          {
            timeout: 90_000,
            message: 'Waiting for a fresh Command EVE egress-boundary receipt from the GUI chat path',
          }
        )
        .toMatchObject({
          decision: 'redact',
          policy_action: 'redact',
          finding_count: 4,
        });
    } catch (error) {
      const status = await commandEveRuntimeStatus(page).catch((statusError) => ({
        success: false,
        msg: statusError instanceof Error ? statusError.message : String(statusError),
      }));
      const diagnostics = await page.evaluate(() => {
        const storageKeys: string[] = [];
        for (let i = 0; i < window.sessionStorage.length; i += 1) {
          const key = window.sessionStorage.key(i);
          if (key?.includes('initial_message')) storageKeys.push(key);
        }
        return {
          hash: window.location.hash,
          storageKeys,
          bodyText: document.body.innerText.slice(0, 2000),
        };
      });
      console.log(`[Command EVE E2E receipt diagnostics]\n${JSON.stringify({ status, diagnostics }, null, 2)}`);
      console.log(`[Command EVE E2E create payloads]\n${createConversationPayloads.join('\n---\n')}`);
      console.log(`[Command EVE E2E renderer logs]\n${rendererLogs.join('\n')}`);
      throw error;
    }

    const response = await commandEveRuntimeStatus(page);
    expect(response.success).toBe(true);
    expect(response.data?.egress_boundary?.decision).toBe('redact');
    expect(response.data?.egress_boundary?.finding_count ?? 0).toBeGreaterThanOrEqual(2);
    expect(response.data?.egress_boundary?.receipt_path).toContain('last-egress-boundary-receipt.json');
  });
});
