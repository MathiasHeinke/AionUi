/**
 * Public scheduled-task contract.
 *
 * Customers schedule work through Command EVE. Claude, Codex, Gemini, Hermes,
 * and other execution engines remain EVE's internal tools and never appear as
 * a user-facing agent choice.
 */
import { test, expect } from '../fixtures';
import { invokeBridge } from '../helpers';

type CronJob = {
  id: string;
  name: string;
  description?: string;
  metadata?: {
    agent_type?: string;
    agent_config?: {
      name?: string;
      assistant_id?: string;
      mode?: string;
    };
  };
};

test.describe('Command EVE public scheduled tasks', () => {
  test.setTimeout(90_000);

  test('shows only Command EVE and stores the managed Hermes execution contract', async ({ page }) => {
    let createdJobId: string | undefined;
    const taskName = `EVE scheduled E2E ${Date.now().toString(36)}`;

    try {
      await page.evaluate(() => window.location.assign('#/scheduled'));
      await page.waitForFunction(() => window.location.hash === '#/scheduled', { timeout: 10_000 });
      await expect(page.locator('h1').filter({ hasText: /Geplante Aufgaben|Scheduled Tasks/ })).toBeVisible({
        timeout: 30_000,
      });

      // drift: the chief-of-staff assistant seeds asynchronously ~3s after app ready; a fresh
      // sandbox races it and cron create fails with "assistant 'command-eve-chief-of-staff'
      // not found", so ensure the assistant via the bridge before creating the task.
      const ensured = await invokeBridge<{ success?: boolean; msg?: string }>(
        page,
        'command-eve.ensure-assistant',
        undefined,
        90_000
      );
      expect(ensured.success, ensured.msg || 'Command EVE assistant readiness failed').toBe(true);

      await page.getByRole('button', { name: /Neue Aufgabe|New task/ }).click();
      const dialog = page.locator('.arco-modal').first();
      await expect(dialog).toBeVisible();

      const agent = dialog.getByTestId('command-eve-cron-agent');
      await expect(agent).toContainText('Command EVE');
      await expect(agent.locator('input')).toBeDisabled();
      await expect(dialog).not.toContainText(/Claude Code|Codex CLI|Gemini CLI|Aion CLI/);

      await dialog.locator('#name input').fill(taskName);
      await dialog.locator('#description input').fill('Public Command EVE scheduler contract');
      await dialog.locator('#prompt textarea').fill('Prepare a concise morning status update.');
      await page.locator('.arco-modal-footer .arco-btn-primary').first().click();
      const createError = page.locator('.arco-message-error').last();
      await Promise.race([
        dialog.waitFor({ state: 'hidden', timeout: 15_000 }),
        createError.waitFor({ state: 'visible', timeout: 15_000 }),
      ]);
      if (await createError.isVisible()) {
        throw new Error(`Scheduled task creation failed: ${(await createError.innerText()).trim()}`);
      }

      const jobs = await invokeBridge<CronJob[]>(page, 'cron.list-jobs', undefined, 10_000);
      const created = jobs.find((job) => job.name === taskName);
      expect(created).toBeTruthy();
      createdJobId = created?.id;
      expect(created?.metadata?.agent_type).toBe('acp');
      expect(created?.metadata?.agent_config).toMatchObject({
        name: 'Command EVE',
        assistant_id: 'command-eve-chief-of-staff',
      });
      expect(created?.metadata?.agent_config).not.toHaveProperty('backend');
      expect(created?.metadata?.agent_config).not.toHaveProperty('custom_agent_id');
      expect(created?.metadata?.agent_config).not.toHaveProperty('is_preset');

      // drift: the list view does not reliably re-render the new card via subscription
      // events in the sandbox; reload so the page refetches before asserting the card.
      await page.reload();
      await expect(page.locator('h1').filter({ hasText: /Geplante Aufgaben|Scheduled Tasks/ })).toBeVisible({
        timeout: 30_000,
      });

      const taskCard = page.getByText(taskName, { exact: true }).first().locator('../..');
      await expect(taskCard).toBeVisible({ timeout: 15_000 });
      // drift: 1c6716a3 the task card renders the agent mark as avatar image or initials
      // fallback (no guaranteed img[alt="Command EVE"]); accept either Command EVE mark.
      const agentMark = taskCard.locator('img[alt="Command EVE"]').or(taskCard.getByText('C', { exact: true }).first());
      await expect(agentMark.first()).toBeVisible({ timeout: 10_000 });
      await expect(taskCard).not.toContainText(/Claude|Codex|Gemini|Hermes|Aion CLI/i);
      await taskCard.click();
      await expect(page.locator('h1').filter({ hasText: taskName })).toBeVisible({ timeout: 15_000 });
      const detailSidebar = page.getByTestId('task-detail-sidebar-column');
      await expect(detailSidebar.getByText('Command EVE', { exact: true })).toBeVisible();
      await expect(detailSidebar).not.toContainText(/Claude|Codex|Gemini|Hermes|Aion CLI/i);
      await page.getByRole('button', { name: /Geplante Aufgabe bearbeiten|Edit Scheduled Task/ }).click();

      const editDialog = page.locator('.arco-modal').first();
      await expect(editDialog).toBeVisible();
      await expect(editDialog.getByTestId('command-eve-cron-agent')).toContainText('Command EVE');
      await editDialog.locator('#description input').fill('Updated public Command EVE scheduler contract');
      await editDialog.getByRole('button', { name: /Speichern|Save/ }).click();

      const updateError = page.locator('.arco-message-error').last();
      await Promise.race([
        editDialog.waitFor({ state: 'hidden', timeout: 15_000 }),
        updateError.waitFor({ state: 'visible', timeout: 15_000 }),
      ]);
      if (await updateError.isVisible()) {
        throw new Error(`Scheduled task update failed: ${(await updateError.innerText()).trim()}`);
      }

      const updated = await invokeBridge<CronJob>(page, 'cron.get-job', { job_id: createdJobId }, 10_000);
      expect(updated.description).toBe('Updated public Command EVE scheduler contract');
      expect(updated.metadata?.agent_type).toBe('acp');
      expect(updated.metadata?.agent_config).toMatchObject({
        name: 'Command EVE',
        assistant_id: 'command-eve-chief-of-staff',
      });
    } finally {
      if (createdJobId) {
        await invokeBridge(page, 'cron.remove-job', { job_id: createdJobId }, 10_000).catch(() => {});
      }
    }
  });
});
