/**
 * Command EVE Connector Catalog – Electron bridge proof.
 *
 * Verifies the desktop app can render the governed connector manifest through
 * the Electron bridge without exposing raw MCP-add or secret-edit surfaces.
 */
import { test, expect, closeSharedElectronAppForIsolatedSpec } from '../fixtures';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveAioncoreBinary } from '../helpers/aioncoreBinary';

const tempRoots: string[] = [];
let connectorCatalogE2ERoot: string;
let previousCommandEveEnv: {
  COMMAND_EVE_AGENT_EVENTS_PATH: string | undefined;
  COMMAND_EVE_COMPANY_OS_ROOT: string | undefined;
  COMMAND_EVE_CONNECTOR_MANIFEST_PATH: string | undefined;
} = {
  COMMAND_EVE_AGENT_EVENTS_PATH: undefined,
  COMMAND_EVE_COMPANY_OS_ROOT: undefined,
  COMMAND_EVE_CONNECTOR_MANIFEST_PATH: undefined,
};

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createE2ECompanyOsRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-connector-catalog-e2e-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, '.company-os', 'operations'), { recursive: true });
  writeJson(path.join(root, 'kits', 'company-os-kit', '.company-os', 'eve', 'connector-manifests.json'), {
    version: 'eve-connector-manifest/v0',
    policy: {
      state_authority: 'local-preflight-result-files-only',
      secret_rule:
        'Never ask for passwords, cookies, recovery codes, payment details, raw tokens or .env contents in chat.',
      write_rule: 'Write-capable connectors require CEO/Codex review and the matching HumanGate before use.',
    },
    connectors: [
      {
        id: 'local-company-os-workspace',
        name: 'Local Company.OS Workspace',
        tier: 'core',
        purpose: 'Find onboarding packets, local memory, install state, workspace registry and source-of-truth docs.',
        required_for: ['T0'],
        auth_method: 'local filesystem',
        auth_surface: 'installed Company.OS workspace',
        setup_mode: 'bootstrap',
        safe_preflight: ['Check local workspace'],
        verify_command: 'node scripts/operator-shell/eve-sidecar.mjs preflight',
        allowed_actions: ['read onboarding artifacts'],
        blocked_actions: ['overwrite local memory'],
        human_gate: 'HG-1 before persisting corrected company facts',
        memory_policy: 'local-first',
        preflight_result_file: path.join(
          root,
          '.company-os',
          'operations',
          'preflight-results',
          'local-company-os-workspace-latest.json'
        ),
      },
      {
        id: 'execution-ledger-plane',
        name: 'Plane Execution Ledger',
        tier: 'core',
        purpose: 'Hold Company.OS parent contracts, child worker contracts, status, blockers and review gates.',
        required_for: ['T3'],
        auth_method: 'Plane App connector preferred; app-token bridge fallback',
        auth_surface: 'Plane workspace',
        setup_mode: 'guided_connector',
        safe_preflight: ['sanity'],
        verify_command: 'node scripts/plane/plane-api-sanity.mjs',
        allowed_actions: ['read projects'],
        blocked_actions: ['mark Done'],
        human_gate: 'HG-3 before write-capable ledger changes',
        memory_policy: 'execution truth only',
        preflight_result_file: path.join(
          root,
          '.company-os',
          'operations',
          'preflight-results',
          'execution-ledger-plane-latest.json'
        ),
      },
      {
        id: 'github-gitnexus',
        name: 'GitHub + GitNexus',
        tier: 'autonomy_core',
        purpose: 'Support code delegation, repo discovery, codegraph impact analysis, PRs and update paths.',
        required_for: ['T4'],
        auth_method: 'GitHub CLI/OAuth plus local GitNexus index',
        auth_surface: 'GitHub account/org and local repos',
        setup_mode: 'guided_connector',
        safe_preflight: ['gh auth status', 'gitnexus status'],
        verify_command: 'gh auth status && gitnexus status',
        allowed_actions: ['read repos'],
        blocked_actions: ['push or merge without approval'],
        human_gate: 'HG-3 before write-capable GitHub actions',
        memory_policy: 'store repo metadata and decisions',
        preflight_result_file: path.join(
          root,
          '.company-os',
          'operations',
          'preflight-results',
          'github-gitnexus-latest.json'
        ),
      },
      {
        id: 'marketing-publishing-stack',
        name: 'Upload-Post + Social + Analytics',
        tier: 'optional_gated',
        purpose: 'Support marketing attribution, publishing, social analytics and department-specific growth loops.',
        required_for: ['marketing_wedge_only'],
        auth_method: 'OAuth/API',
        auth_surface: 'Upload-Post',
        setup_mode: 'deferred_gated_connector',
        safe_preflight: ['read-only pull'],
        verify_command: 'manual',
        allowed_actions: ['read history'],
        blocked_actions: ['publish'],
        human_gate: 'HG-4 before public publishing',
        memory_policy: 'archive exports only',
        preflight_result_file: path.join(
          root,
          '.company-os',
          'operations',
          'preflight-results',
          'marketing-publishing-stack-latest.json'
        ),
      },
    ],
  });
  return root;
}

test.describe('Command EVE Connector Catalog', () => {
  test.setTimeout(120_000);

  test.beforeAll(() => {
    previousCommandEveEnv = {
      COMMAND_EVE_AGENT_EVENTS_PATH: process.env.COMMAND_EVE_AGENT_EVENTS_PATH,
      COMMAND_EVE_COMPANY_OS_ROOT: process.env.COMMAND_EVE_COMPANY_OS_ROOT,
      COMMAND_EVE_CONNECTOR_MANIFEST_PATH: process.env.COMMAND_EVE_CONNECTOR_MANIFEST_PATH,
    };
    connectorCatalogE2ERoot = createE2ECompanyOsRoot();
    process.env.COMMAND_EVE_CONNECTOR_MANIFEST_PATH = path.join(
      connectorCatalogE2ERoot,
      'kits',
      'company-os-kit',
      '.company-os',
      'eve',
      'connector-manifests.json'
    );
    process.env.COMMAND_EVE_COMPANY_OS_ROOT = connectorCatalogE2ERoot;
    process.env.COMMAND_EVE_AGENT_EVENTS_PATH = path.join(connectorCatalogE2ERoot, 'metrics', 'agent-events.jsonl');
  });

  test.afterAll(() => {
    for (const [key, value] of Object.entries(previousCommandEveEnv)) {
      if (value === undefined) {
        delete process.env[key as keyof typeof previousCommandEveEnv];
      } else {
        process.env[key] = value;
      }
    }

    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test('renders governed connector cards from the local manifest', async ({}, testInfo) => {
    // drift: the manifest/company-root env must reach the Electron main process, so this spec
    // launches its own instance with the seeded env instead of relying on the shared fixtures
    // app (whose launch env predates beforeAll and may carry a foreign audit-ledger path).
    await closeSharedElectronAppForIsolatedSpec();
    const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-connector-catalog-home-'));
    tempRoots.push(isolatedHome);
    const backendBinary = resolveAioncoreBinary();
    let app: ElectronApplication | null = null;
    let page: Page;
    try {
      app = await electron.launch({
        args: ['.', `--user-data-dir=${path.join(isolatedHome, 'user-data')}`],
        cwd: path.resolve(__dirname, '../../..'),
        env: {
          ...(process.env as Record<string, string>),
          HOME: isolatedHome,
          // The desktop binary resolver consumes bundled resources or PATH;
          // AIONUI_BACKEND_BINARY is the E2E harness input, not a product
          // resolver input. Put its owning directory on PATH for this isolated
          // app so the same verified binary is actually launched.
          PATH: `${path.dirname(backendBinary)}${path.delimiter}${process.env.PATH || ''}`,
          AIONUI_DISABLE_AUTO_UPDATE: '1',
          AIONUI_DISABLE_DEVTOOLS: '1',
          AIONUI_E2E_TEST: '1',
          AIONUI_MULTI_INSTANCE: '1',
          AIONUI_CDP_PORT: '0',
          NODE_ENV: 'development',
          COMMAND_EVE_REGISTRATION_REQUIRED: '0',
        },
        timeout: 60_000,
      });
      page = await app.firstWindow();
    } catch (error) {
      if (app) await app.close().catch(() => {});
      throw error;
    }

    try {
      await page.waitForSelector('body', { state: 'visible' });

      await page.evaluate(() => {
        window.location.hash = '#/connectors';
      });

      // drift: bc58b27d governed German-first UI titles the page "Connectoren"/"Connectors", not "Connector Catalog"
      await expect(
        page
          .locator('h1')
          .filter({ hasText: /Connectoren|Connectors/ })
          .first()
      ).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByText('CONNECTOR_CATALOG_ELECTRON_BRIDGE_REQUIRED')).toHaveCount(0);

      // drift: bc58b27d the public (non-founder) build renders governed cards with public names
      // only; manifest paths, policy text, MCP-enable tags and audit details are founder-view
      // (showTechnicalDetails) and must NOT render here.
      await expect(page.getByTestId('connector-card-local-company-os-workspace')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('connector-card-execution-ledger-plane')).toBeVisible();
      await expect(page.getByTestId('connector-card-github-gitnexus')).toBeVisible();
      await expect(page.getByTestId('connector-card-marketing-publishing-stack')).toBeVisible();
      await expect(page.getByText(/Command EVE Workspace/i).first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/Aufgaben und Projekte|Tasks and projects/).first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText('GitHub + GitNexus').first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText('Upload-Post + Social + Analytics').first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText('Plane Execution Ledger')).toHaveCount(0);
      await expect(page.getByText('connector-manifests.json')).toHaveCount(0);
      await expect(page.getByText('raw_mcp_add')).toHaveCount(0);
      await expect(page.getByText(/HUMANGATE_AND_PREFLIGHT_REQUIRED/)).toHaveCount(0);
      await expect(page.getByText(/Installiert|Installed/).first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/Freigabe nötig|Approval required/).first()).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(async () => page.getByRole('button', { name: /Verbindung prüfen|Check connection/ }).count(), {
          timeout: 30_000,
        })
        .toBeGreaterThanOrEqual(2);

      const localPreflightButton = page.getByTestId('connector-preflight-button-local-company-os-workspace');
      await expect(localPreflightButton).toBeVisible({ timeout: 30_000 });
      await localPreflightButton.click();
      // This is the READY-path spec. The isolated process receives a root-confined
      // manifest, receipt path and audit ledger, so accepting a blocked result here
      // would hide a broken preflight. Fail-closed/path-rejection behavior has its
      // own connectorPreflightCore tests.
      await expect(page.getByText(/Verbindung geprüft|Connection checked/).first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/Prüfung nicht abgeschlossen|Check not completed/)).toHaveCount(0);

      const receiptPath = path.join(
        connectorCatalogE2ERoot,
        '.company-os',
        'operations',
        'preflight-results',
        'local-company-os-workspace-latest.json'
      );
      const auditEventPath = path.join(connectorCatalogE2ERoot, 'metrics', 'agent-events.jsonl');
      await expect.poll(() => fs.existsSync(receiptPath), { timeout: 30_000 }).toBe(true);
      await expect.poll(() => fs.existsSync(auditEventPath), { timeout: 30_000 }).toBe(true);

      const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as {
        schema_version?: string;
        ok?: boolean;
        connector_id?: string;
        reason_code?: string;
        checks?: Array<{ required?: boolean; ok?: boolean }>;
      };
      expect(receipt).toMatchObject({
        schema_version: 'command-eve-connector-preflight-receipt/v0',
        ok: true,
        connector_id: 'local-company-os-workspace',
        reason_code: 'LOCAL_COMPANY_OS_WORKSPACE_READY',
      });
      expect(receipt.checks?.filter((check) => check.required).every((check) => check.ok)).toBe(true);

      const auditEvents = fs
        .readFileSync(auditEventPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(
        auditEvents.some((event) => {
          const payload = event.payload as Record<string, unknown> | undefined;
          return (
            event.event_type === 'connector.preflight_recorded' &&
            payload?.connector_id === 'local-company-os-workspace' &&
            payload.status === 'ready' &&
            payload.ok === true &&
            payload.reason_code === 'LOCAL_COMPANY_OS_WORKSPACE_READY' &&
            payload.receipt_path === receiptPath
          );
        })
      ).toBe(true);

      const screenshotPath = 'tests/e2e/results/command-eve-connector-catalog.png';
      await page.screenshot({ path: screenshotPath, fullPage: true });
      await testInfo.attach('command-eve-connector-catalog', {
        path: screenshotPath,
        contentType: 'image/png',
      });
    } finally {
      await app.close().catch(() => {});
    }
  });
});
