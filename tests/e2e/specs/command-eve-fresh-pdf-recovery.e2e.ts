import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Page, Route } from '@playwright/test';

import { test, expect } from '../fixtures';
import { goToGuid, invokeBridge } from '../helpers';
import { httpDelete, httpPost } from '../helpers/httpBridge';

type CreatedConversation = {
  id: string;
  name: string;
  type: 'acp';
  extra: Record<string, unknown>;
  created_at?: number;
  modified_at?: number;
};

type ReportExportResponse =
  | { success?: boolean; data?: { ok?: boolean; reason_code?: string; output_path?: string } }
  | { ok?: boolean; reason_code?: string; output_path?: string };

type ActiveSeatResponse =
  | { success?: boolean; data?: { ok?: boolean; seat_id?: string } }
  | { ok?: boolean; seat_id?: string };

function responseData<T>(response: T | { data?: T }): T {
  if (response && typeof response === 'object' && 'data' in response && response.data) return response.data;
  return response as T;
}

function fulfillData(route: Route, data: unknown): Promise<void> {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data }),
  });
}

async function ensureRendererReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      window.location.href !== 'about:blank' &&
      typeof (window as unknown as { __backendPort?: number }).__backendPort === 'number',
    { timeout: 30_000 }
  );
}

async function createPdf(page: Page, outputPath: string): Promise<void> {
  const activeSeat = responseData(
    await invokeBridge<ActiveSeatResponse>(page, 'command-eve.active-seat', undefined, 15_000)
  );
  expect(activeSeat.ok).toBe(true);
  expect(activeSeat.seat_id).toBeTruthy();

  const result = responseData(
    await invokeBridge<ReportExportResponse>(
      page,
      'command-eve.report-export',
      {
        format: 'pdf',
        markdown:
          '# Recovery proof\n\nThis PDF proves that a fresh Command EVE conversation uses native document intelligence.',
        seatId: activeSeat.seat_id,
        outputPath,
        title: 'Recovery proof',
        brand: { displayName: 'E2E Operator' },
      },
      30_000
    )
  );

  expect(result.ok, result.reason_code).toBe(true);
  expect(result.output_path).toBe(outputPath);
  expect(fs.readFileSync(outputPath).subarray(0, 5).toString('ascii')).toBe('%PDF-');
}

async function goToConversation(page: Page, conversationId: string): Promise<void> {
  await page.evaluate((id) => {
    window.location.assign(`#/conversation/${id}`);
  }, conversationId);
  await page.waitForFunction((id) => window.location.hash === `#/conversation/${id}`, conversationId, {
    timeout: 15_000,
  });
}

test.describe('Command EVE fresh PDF recovery', () => {
  test('prepares a fresh PDF natively and recovers a missed terminal transcript without route re-entry', async ({
    page,
  }) => {
    test.setTimeout(120_000);

    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-fresh-pdf-e2e-'));
    const pdfPath = path.join(outputDir, 'recovery-proof.pdf');
    const prompt = 'Read the attached PDF and answer with the recovery marker.';
    const recoveryMarker = 'PDF_RECOVERY_VISIBLE_WITHOUT_CHAT_SWITCH';
    let conversationId: string | null = null;

    try {
      await ensureRendererReady(page);
      await goToGuid(page);
      await createPdf(page, pdfPath);

      const conversation = await httpPost<CreatedConversation>(page, '/api/conversations', {
        type: 'acp',
        name: prompt,
        extra: {
          workspace: outputDir,
          custom_workspace: true,
          backend: 'hermes',
          session_mode: 'dont_ask',
        },
      });
      conversationId = conversation.id;
      expect(conversationId).toBeTruthy();

      const encodedId = encodeURIComponent(conversationId);
      const messagesPattern = new RegExp(`/api/conversations/${encodedId}/messages(?:\\?.*)?$`);
      const conversationPattern = new RegExp(`/api/conversations/${encodedId}(?:\\?.*)?$`);
      const warmupPattern = new RegExp(`/api/conversations/${encodedId}/warmup(?:\\?.*)?$`);
      const slashCommandsPattern = new RegExp(`/api/conversations/${encodedId}/slash-commands(?:\\?.*)?$`);
      let sendAccepted = false;
      let serverFinished = false;
      let capturedSendBody: { content?: string; files?: string[] } | null = null;
      let historyReads = 0;

      const messagesHandler = async (route: Route) => {
        if (route.request().method() === 'POST') {
          capturedSendBody = route.request().postDataJSON() as { content?: string; files?: string[] };
          sendAccepted = true;
          await fulfillData(route, {
            turn_id: 'turn-pdf-recovery',
            msg_id: 'user-pdf-recovery',
            runtime: {
              state: 'running',
              can_send_message: false,
              has_task: true,
              task_status: 'running',
              is_processing: true,
              pending_confirmations: 0,
              turn_id: 'turn-pdf-recovery',
            },
          });
          setTimeout(() => {
            serverFinished = true;
          }, 700);
          return;
        }

        historyReads += 1;
        await fulfillData(
          route,
          serverFinished
            ? {
                items: [
                  {
                    id: 'user-pdf-recovery',
                    msg_id: 'user-pdf-recovery',
                    conversation_id: conversationId,
                    type: 'text',
                    position: 'right',
                    content: { content: prompt },
                    created_at: Date.now() - 100,
                  },
                  {
                    id: 'assistant-pdf-recovery',
                    msg_id: 'assistant-pdf-recovery',
                    conversation_id: conversationId,
                    type: 'text',
                    position: 'left',
                    content: { content: recoveryMarker },
                    created_at: Date.now(),
                  },
                ],
                oldest_cursor: 'user-pdf-recovery',
                newest_cursor: 'assistant-pdf-recovery',
                has_more_before: false,
                has_more_after: false,
              }
            : {
                items: [],
                oldest_cursor: null,
                newest_cursor: null,
                has_more_before: false,
                has_more_after: false,
              }
        );
      };

      const conversationHandler = async (route: Route) => {
        const runtime = serverFinished
          ? {
              state: 'idle',
              can_send_message: true,
              has_task: false,
              task_status: 'finished',
              is_processing: false,
              pending_confirmations: 0,
              turn_id: null,
            }
          : sendAccepted
            ? {
                state: 'running',
                can_send_message: false,
                has_task: true,
                task_status: 'running',
                is_processing: true,
                pending_confirmations: 0,
                turn_id: 'turn-pdf-recovery',
              }
            : {
                state: 'idle',
                can_send_message: true,
                has_task: false,
                task_status: 'finished',
                is_processing: false,
                pending_confirmations: 0,
                turn_id: null,
              };

        await fulfillData(route, {
          ...conversation,
          status: runtime.task_status,
          runtime,
        });
      };

      await page.route(messagesPattern, messagesHandler);
      await page.route(conversationPattern, conversationHandler);
      await page.route(warmupPattern, (route) => fulfillData(route, null));
      await page.route(slashCommandsPattern, (route) => fulfillData(route, []));

      await page.evaluate(
        ({ id, input, filePath }) => {
          sessionStorage.setItem(
            `acp_initial_message_${id}`,
            JSON.stringify({
              input,
              files: [filePath],
            })
          );
        },
        { id: conversationId, input: prompt, filePath: pdfPath }
      );

      await goToConversation(page, conversationId);

      await expect.poll(() => sendAccepted, { timeout: 30_000 }).toBe(true);
      await expect(page.getByTestId('message-list-skeleton')).toBeVisible();
      await expect(page.getByText(/EVEs Übergabenotiz/i)).toHaveCount(0);

      expect(capturedSendBody?.content).toContain(prompt);
      expect(capturedSendBody?.content).toContain('recovery-proof.pdf');
      expect(capturedSendBody?.content).not.toContain('document.md');
      expect(capturedSendBody?.content).not.toContain('document-intelligence');
      expect(capturedSendBody?.files).toContain(pdfPath);
      const sidecarPath = capturedSendBody?.files?.find((file) => file !== pdfPath && file.endsWith('document.md'));
      expect(sidecarPath).toBeTruthy();
      expect(fs.readFileSync(sidecarPath as string, 'utf8')).toContain('## PDF p. 1');
      await expect(page.getByText(/document\.md/i)).toHaveCount(0);

      // No websocket terminal event is emitted. The renderer must discover the
      // durable idle state, refresh persisted history, and unlock itself.
      await expect(page.getByText(recoveryMarker, { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('message-text-right').getByTestId('message-text-content')).toHaveText(prompt);
      await expect(page.getByTestId('message-list-skeleton')).toHaveCount(0);
      expect(historyReads).toBeGreaterThanOrEqual(2);
      expect(await page.evaluate(() => window.location.hash)).toBe(`#/conversation/${conversationId}`);

      await page.unroute(messagesPattern, messagesHandler);
      await page.unroute(conversationPattern, conversationHandler);
      await page.unroute(warmupPattern);
      await page.unroute(slashCommandsPattern);
    } finally {
      if (conversationId) {
        await httpDelete(page, `/api/conversations/${encodeURIComponent(conversationId)}`).catch(() => {});
      }
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
