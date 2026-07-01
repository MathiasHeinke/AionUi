/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildConnectorCatalog, resolveConnectorCatalogSource } from '@/process/commandEve/connectorCatalogCore';

const tempRoots: string[] = [];

const makeRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-connector-catalog-test-'));
  tempRoots.push(root);
  return root;
};

const writeJson = (filePath: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

const writeManifest = (root: string): string => {
  const manifestPath = path.join(root, 'kits', 'company-os-kit', '.company-os', 'eve', 'connector-manifests.json');
  writeJson(manifestPath, {
    version: 'eve-connector-manifest/v0',
    policy: {
      state_authority: 'local-preflight-result-files-only',
      secret_rule: 'Never ask for tokens in chat.',
      write_rule: 'Writes require HumanGate.',
    },
    connectors: [
      {
        id: 'local-company-os-workspace',
        name: 'Local Company.OS Workspace',
        tier: 'core',
        purpose: 'Read local install truth.',
        required_for: ['T0'],
        auth_method: 'local filesystem',
        auth_surface: 'workspace',
        setup_mode: 'bootstrap',
        safe_preflight: ['check root'],
        verify_command: 'node smoke.mjs',
        allowed_actions: ['read install record'],
        blocked_actions: ['overwrite local memory'],
        human_gate: 'HG-1 before persistence',
        memory_policy: 'local-first',
        preflight_result_file: '.company-os/operations/preflight-results/local-company-os-workspace-latest.json',
      },
      {
        id: 'execution-ledger-plane',
        name: 'Plane Execution Ledger',
        tier: 'core',
        purpose: 'Read work items.',
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
        preflight_result_file: '.company-os/operations/preflight-results/execution-ledger-plane-latest.json',
      },
      {
        id: 'marketing-publishing-stack',
        name: 'Upload-Post + Social + Analytics',
        tier: 'optional_gated',
        purpose: 'Read marketing exports.',
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
        preflight_result_file: '.company-os/operations/preflight-results/marketing-publishing-stack-latest.json',
      },
    ],
  });
  return manifestPath;
};

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Command EVE connector catalog core', () => {
  it('blocks loudly without a manifest source', () => {
    const result = buildConnectorCatalog({ env: {} });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('blocked');
    expect(result.reason_code).toBe('CONNECTOR_MANIFEST_SOURCE_MISSING');
  });

  it('resolves the connector manifest from Command EVE env vars', () => {
    const source = resolveConnectorCatalogSource({
      env: {
        COMMAND_EVE_COMPANY_OS_ROOT: '/tmp/company-os',
      },
    });

    expect(source.company_os_root).toBe('/tmp/company-os');
    expect(source.manifest_path).toBe('/tmp/company-os/kits/company-os-kit/.company-os/eve/connector-manifests.json');
  });

  it('renders conservative evidence states from manifest and preflight receipts', () => {
    const root = makeRoot();
    writeManifest(root);
    writeJson(path.join(root, '.company-os/operations/preflight-results/local-company-os-workspace-latest.json'), {
      ok: true,
      checked_at: '2026-06-10T10:00:00.000Z',
      evidence_path: 'reports/local.json',
    });
    writeJson(path.join(root, '.company-os/operations/preflight-results/marketing-publishing-stack-latest.json'), {
      ok: true,
      checked_at: '2026-06-10T10:05:00.000Z',
    });

    const result = buildConnectorCatalog({ companyOsRoot: root, env: {} });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('ready');
    const cards = result.model?.connectors ?? [];
    expect(cards.find((card) => card.id === 'local-company-os-workspace')?.evidence_state).toBe('connected');
    expect(cards.find((card) => card.id === 'execution-ledger-plane')?.evidence_state).toBe('gated');
    expect(cards.find((card) => card.id === 'marketing-publishing-stack')?.evidence_state).toBe('gated');
    expect(result.model?.summary.connected).toBe(1);
    expect(result.model?.summary.gated).toBe(2);
  });

  it('marks failed preflight receipts as blocked', () => {
    const root = makeRoot();
    writeManifest(root);
    writeJson(path.join(root, '.company-os/operations/preflight-results/local-company-os-workspace-latest.json'), {
      ok: false,
      reason_code: 'ROOT_MISSING',
      error: 'Missing workspace root.',
    });

    const result = buildConnectorCatalog({ companyOsRoot: root, env: {} });

    expect(result.ok).toBe(true);
    expect(result.model?.connectors.find((card) => card.id === 'local-company-os-workspace')?.evidence_state).toBe(
      'blocked'
    );
  });

  it('treats bootstrap filesystem connectors as installed before auth heuristics', () => {
    const root = makeRoot();
    writeManifest(root);

    const result = buildConnectorCatalog({ companyOsRoot: root, env: {} });
    const localWorkspace = result.model?.connectors.find((card) => card.id === 'local-company-os-workspace');

    expect(localWorkspace?.evidence_state).toBe('installed');
    expect(localWorkspace?.guided_setup.state).toBe('preflight_required');
    expect(localWorkspace?.guided_setup.primary_action).toBe('run_read_only_preflight');
  });

  it('derives a governed setup plan without enabling raw MCP writes', () => {
    const root = makeRoot();
    writeManifest(root);
    writeJson(path.join(root, '.company-os/operations/preflight-results/local-company-os-workspace-latest.json'), {
      ok: true,
      checked_at: '2026-06-10T10:00:00.000Z',
      evidence_path: 'reports/local.json',
    });
    writeJson(path.join(root, '.company-os/operations/preflight-results/marketing-publishing-stack-latest.json'), {
      ok: false,
      reason_code: 'AUTH_SCOPE_MISSING',
      error: 'OAuth scope not connected.',
    });

    const result = buildConnectorCatalog({ companyOsRoot: root, env: {} });
    const cards = result.model?.connectors ?? [];
    const connected = cards.find((card) => card.id === 'local-company-os-workspace');
    const needsAuth = cards.find((card) => card.id === 'execution-ledger-plane');
    const blocked = cards.find((card) => card.id === 'marketing-publishing-stack');

    expect(result.model?.mcp_enable_policy.allowed).toBe(false);
    expect(result.model?.mcp_enable_policy.blocked_transports).toContain('http');
    expect(connected?.guided_setup.state).toBe('connected');
    expect(connected?.guided_setup.primary_action).toBe('view_receipt');
    expect(connected?.guided_setup.mcp_enable_allowed).toBe(false);
    expect(needsAuth?.guided_setup.state).toBe('preflight_required');
    expect(needsAuth?.guided_setup.primary_action).toBe('run_read_only_preflight');
    expect(needsAuth?.guided_setup.requires_human_gate).toBe('HG-3 before write-capable ledger changes');
    expect(blocked?.guided_setup.state).toBe('blocked');
    expect(blocked?.guided_setup.primary_action).toBe('inspect_blocker');
    expect(blocked?.guided_setup.secret_handling).toBe('never_in_chat');
  });

  it('keeps the stdio-only read-only posture when curated connectors (Linear/Notion/Slack) are present', () => {
    const root = makeRoot();
    const manifestPath = path.join(root, 'kits', 'company-os-kit', '.company-os', 'eve', 'connector-manifests.json');
    writeJson(manifestPath, {
      version: 'eve-connector-manifest/v0',
      policy: {
        state_authority: 'local-preflight-result-files-only',
        secret_rule: 'Never ask for tokens in chat.',
        write_rule: 'Writes require HumanGate.',
      },
      connectors: [
        {
          id: 'linear-project-management',
          name: 'Linear',
          tier: 'recommended',
          purpose: 'Read backlogs and draft issues.',
          required_for: ['client_delivery_wedge'],
          auth_method: 'Linear API key',
          auth_surface: 'Linear workspace',
          setup_mode: 'guided_connector',
          safe_preflight: ['list teams read-only'],
          verify_command: 'connector-specific: list Linear teams read-only',
          allowed_actions: ['read issues'],
          blocked_actions: ['create or update issues without review'],
          human_gate: 'HG-3 before write-capable Linear changes',
          memory_policy: 'store issue metadata, not secrets',
          dsgvo_note: 'US SaaS (Linear) — confirm DPA.',
          preflight_result_file:
            '.company-os/operations/preflight-results/linear-project-management-latest.json',
        },
        {
          id: 'notion-workspace',
          name: 'Notion',
          tier: 'recommended',
          purpose: 'Read shared pages and draft docs.',
          required_for: ['client_delivery_wedge'],
          auth_method: 'Notion OAuth or integration API key',
          auth_surface: 'Notion workspace',
          setup_mode: 'guided_connector',
          safe_preflight: ['search read-only'],
          verify_command: 'connector-specific: read-only Notion search',
          allowed_actions: ['read shared pages'],
          blocked_actions: ['write or publish pages without review'],
          human_gate: 'HG-2 for read scopes; HG-3 for write/share actions',
          memory_policy: 'summaries and links only',
          dsgvo_note: 'US SaaS (Notion) — confirm DPA.',
          preflight_result_file: '.company-os/operations/preflight-results/notion-workspace-latest.json',
        },
        {
          id: 'slack-internal-comms',
          name: 'Slack',
          tier: 'optional',
          purpose: 'Read approved channels; posting gated.',
          required_for: ['operator_internal_only'],
          auth_method: 'Slack OAuth with channel scopes',
          auth_surface: 'Slack workspace',
          setup_mode: 'deferred_gated_connector',
          safe_preflight: ['read-only channel test'],
          verify_command: 'connector-specific: read-only Slack channel test',
          allowed_actions: ['read approved channels'],
          blocked_actions: ['post messages'],
          human_gate: 'HG-3 before posting to any Slack channel or DM',
          memory_policy: 'do not persist raw message bodies',
          dsgvo_note: 'US SaaS (Slack) — confirm DPA.',
          preflight_result_file: '.company-os/operations/preflight-results/slack-internal-comms-latest.json',
        },
      ],
    });

    const result = buildConnectorCatalog({ companyOsRoot: root, env: {} });
    const cards = result.model?.connectors ?? [];

    expect(result.ok).toBe(true);
    // The new curated entries parse into cards.
    expect(cards.map((card) => card.id)).toEqual([
      'linear-project-management',
      'notion-workspace',
      'slack-internal-comms',
    ]);
    // stdio-only read-only posture is unchanged by the new catalog entries.
    expect(result.model?.mcp_enable_policy.allowed).toBe(false);
    expect(result.model?.mcp_enable_policy.blocked_transports).toEqual(['http', 'sse', 'streamable_http']);
    expect(result.model?.mcp_enable_policy.connector_write_allowed).toBe(false);
    // No per-connector guided setup ever opens raw MCP enable / write.
    for (const card of cards) {
      expect(card.guided_setup.mcp_enable_allowed).toBe(false);
      expect(card.guided_setup.connector_write_allowed).toBe(false);
      expect(card.guided_setup.secret_handling).toBe('never_in_chat');
    }
    // Slack (deferred gated + HG-3) is treated as gated -> HumanGate required, never auto-connected.
    const slack = cards.find((card) => card.id === 'slack-internal-comms');
    expect(slack?.evidence_state).toBe('gated');
    expect(slack?.guided_setup.state).toBe('humangate_required');
  });

  it('parses the OPTIONAL mcp_invocation field tolerantly (arch §4)', () => {
    const root = makeRoot();
    const manifestPath = path.join(root, 'kits', 'company-os-kit', '.company-os', 'eve', 'connector-manifests.json');
    writeJson(manifestPath, {
      version: 'eve-connector-manifest/v0',
      policy: { state_authority: 'local-preflight-result-files-only' },
      connectors: [
        {
          id: 'linear-project-management',
          name: 'Linear',
          tier: 'recommended',
          purpose: 'p',
          required_for: ['x'],
          auth_method: 'Linear API key',
          auth_surface: 'w',
          setup_mode: 'guided_connector',
          safe_preflight: ['s'],
          verify_command: 'v',
          allowed_actions: ['read'],
          blocked_actions: ['write'],
          human_gate: 'HG-3',
          memory_policy: 'm',
          preflight_result_file: '.company-os/operations/preflight-results/linear-project-management-latest.json',
          mcp_invocation: {
            transport: 'stdio',
            command: 'npx',
            args: ['-y', 'mcp-linear'],
            env_refs: ['LINEAR_API_KEY'],
            scope_default: 'founder',
          },
        },
        {
          // NO mcp_invocation — must still parse as a valid connector.
          id: 'local-company-os-workspace',
          name: 'Local Workspace',
          tier: 'core',
          purpose: 'p',
          required_for: ['T0'],
          auth_method: 'local filesystem',
          auth_surface: 'w',
          setup_mode: 'bootstrap',
          safe_preflight: ['s'],
          verify_command: 'v',
          allowed_actions: ['read'],
          blocked_actions: ['overwrite'],
          human_gate: 'HG-1',
          memory_policy: 'm',
          preflight_result_file: '.company-os/operations/preflight-results/local-company-os-workspace-latest.json',
        },
        {
          // MALFORMED mcp_invocation (http transport) — dropped, connector stays valid.
          id: 'notion-workspace',
          name: 'Notion',
          tier: 'recommended',
          purpose: 'p',
          required_for: ['x'],
          auth_method: 'Notion API key',
          auth_surface: 'w',
          setup_mode: 'guided_connector',
          safe_preflight: ['s'],
          verify_command: 'v',
          allowed_actions: ['read'],
          blocked_actions: ['write'],
          human_gate: 'HG-3',
          memory_policy: 'm',
          preflight_result_file: '.company-os/operations/preflight-results/notion-workspace-latest.json',
          mcp_invocation: { transport: 'http', command: 'curl', args: [], env_refs: [] },
        },
      ],
    });

    const result = buildConnectorCatalog({ companyOsRoot: root, env: {} });
    const cards = result.model?.connectors ?? [];
    expect(result.ok).toBe(true);
    // All three connectors parse (an entry without / with a bad mcp_invocation stays valid).
    expect(cards.map((c) => c.id).sort()).toEqual([
      'linear-project-management',
      'local-company-os-workspace',
      'notion-workspace',
    ]);

    const linear = cards.find((c) => c.id === 'linear-project-management');
    expect(linear?.mcp_invocation).toEqual({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'mcp-linear'],
      env_refs: ['LINEAR_API_KEY'],
      scope_default: 'founder',
    });

    // No mcp_invocation → field absent, connector still valid.
    expect(cards.find((c) => c.id === 'local-company-os-workspace')?.mcp_invocation).toBeUndefined();
    // http transport → dropped (unrepresentable); connector still valid.
    expect(cards.find((c) => c.id === 'notion-workspace')?.mcp_invocation).toBeUndefined();
  });

  it('rejects unsupported manifest schemas', () => {
    const root = makeRoot();
    const manifestPath = path.join(root, 'manifest.json');
    writeJson(manifestPath, { version: 'wrong/v0', connectors: [] });

    const result = buildConnectorCatalog({ manifestPath, env: {} });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.reason_code).toBe('CONNECTOR_MANIFEST_SCHEMA_MISMATCH');
  });
});
