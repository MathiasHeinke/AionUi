/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildLocalRuntimeStatus } from '@/process/commandEve/localRuntimeStatusCore';

const tempRoots: string[] = [];

const makeRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-local-runtime-status-test-'));
  tempRoots.push(root);
  return root;
};

const writeJson = (filePath: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

const manifest = {
  version: 'command-eve-runtime-bootstrap-manifest/v0',
  release: '1.0.0-alpha.5',
  hermes: {
    package: 'hermes-agent',
    version: '0.17.0',
    extras: ['acp'],
  },
  local_runtime: {
    provider: 'ollama',
    base_url: 'http://127.0.0.1:11434',
    egress_proxy_url: 'http://127.0.0.1:25811',
    default_tier_id: 'gemma-4-e4b-local-default',
    tiers: [
      {
        id: 'gemma-4-e4b-local-default',
        label: 'Gemma 4 E4B local default',
        model_ref: 'gemma4:e4b',
        default: true,
        context_length: 65536,
        ollama_num_ctx: 65536,
        max_tokens: 512,
        min_unified_memory_gb: 16,
        min_free_disk_gb: 10,
      },
      {
        id: 'gemma-4-12b-local-planning',
        label: 'Gemma 4 12B local planning opt-in',
        model_ref: 'gemma4:12b',
        context_length: 65536,
        ollama_num_ctx: 65536,
        max_tokens: 512,
        min_unified_memory_gb: 16,
        min_free_disk_gb: 20,
      },
    ],
  },
  installer_policy: {
    allow_homebrew_install: true,
    allow_model_pull: true,
    model_weights_in_app_bundle: false,
    fail_closed_reason_codes: ['BLOCKED_RAM', 'BLOCKED_DISK'],
  },
};

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Command EVE local runtime status core', () => {
  it('renders local Gemma tiers from the runtime manifest without a receipt', () => {
    const root = makeRoot();
    const manifestPath = path.join(root, 'command-eve-runtime-bootstrap.json');
    writeJson(manifestPath, manifest);

    const result = buildLocalRuntimeStatus({
      userDataPath: root,
      manifestPath,
      now: () => new Date('2026-06-11T02:00:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('ready');
    expect(result.model?.release).toBe('1.0.0-alpha.5');
    expect(result.model?.hermes.version).toBe('0.17.0');
    expect(result.model?.provider.base_url).toBe('http://127.0.0.1:11434');
    expect(result.model?.selected_tier_id).toBe('gemma-4-e4b-local-default');
    expect(result.model?.selected_model_ref).toBe('command-eve-gemma4-e4b-64k:latest');
    expect(result.model?.tiers.map((tier) => tier.model_ref)).toEqual(['gemma4:e4b', 'gemma4:12b']);
    expect(result.model?.tiers[1].status).toBe('opt_in');
    expect(result.model?.warnings).toContain('runtime_receipt_missing');
    expect(result.model?.warnings).toContain('model_warmup_receipt_missing');
  });

  it('uses the runtime receipt to show the selected 12B planning tier', () => {
    const root = makeRoot();
    const manifestPath = path.join(root, 'command-eve-runtime-bootstrap.json');
    const receiptPath = path.join(root, 'receipt.json');
    const modelWarmupReceiptPath = path.join(root, 'warmup.json');
    writeJson(manifestPath, manifest);
    writeJson(receiptPath, {
      version: 'command-eve-runtime-bootstrap/v0',
      app_release: '1.0.0-alpha.5',
      mode: 'auto',
      status: 'ready',
      started_at: '2026-06-11T01:00:00.000Z',
      completed_at: '2026-06-11T01:01:00.000Z',
      runtime_root: root,
      hermes_home: path.join(root, 'hermes-home'),
      provider: 'ollama',
      default_model: 'command-eve-gemma4-12b-64k:latest',
      base_model: 'gemma4:12b',
      ollama_base_url: 'http://127.0.0.1:11434',
      egress_proxy_url: 'http://127.0.0.1:25811',
      stages: [],
      next_action: 'ready',
      warnings: [],
      capabilities: { skills: 1, connectors: 1, capability_pack: 'pack.json' },
    });
    writeJson(modelWarmupReceiptPath, {
      version: 'command-eve-model-warmup/v0',
      status: 'ready',
      model: 'command-eve-gemma4-12b-64k:latest',
      base_url: 'http://127.0.0.1:25811',
      started_at: '2026-06-11T01:01:00.000Z',
      completed_at: '2026-06-11T01:01:03.000Z',
      elapsed_ms: 3000,
    });

    const result = buildLocalRuntimeStatus({
      userDataPath: root,
      manifestPath,
      receiptPath,
      modelWarmupReceiptPath,
    });

    expect(result.ok).toBe(true);
    expect(result.model?.selected_tier_id).toBe('gemma-4-12b-local-planning');
    expect(result.model?.selected_model_ref).toBe('command-eve-gemma4-12b-64k:latest');
    expect(result.model?.tiers.find((tier) => tier.id === 'gemma-4-12b-local-planning')?.status).toBe('selected');
    expect(result.model?.receipt?.status).toBe('ready');
    expect(result.model?.model_warmup?.status).toBe('ready');
    expect(result.model?.model_warmup?.elapsed_ms).toBe(3000);
    // 1.6.3: no injected Ollama probe ⇒ the core SAYS so (never a silent gap).
    expect(result.model?.warnings).toEqual(['ollama_probe_unavailable']);
  });

  it('accepts a running warm-up receipt without a completed timestamp', () => {
    const root = makeRoot();
    const manifestPath = path.join(root, 'command-eve-runtime-bootstrap.json');
    const modelWarmupReceiptPath = path.join(root, 'warmup.json');
    writeJson(manifestPath, manifest);
    writeJson(modelWarmupReceiptPath, {
      version: 'command-eve-model-warmup/v0',
      status: 'running',
      model: 'command-eve-gemma4-e4b-64k:latest',
      base_url: 'http://127.0.0.1:25811',
      started_at: '2026-06-11T01:01:00.000Z',
      elapsed_ms: 0,
    });

    const result = buildLocalRuntimeStatus({
      userDataPath: root,
      manifestPath,
      modelWarmupReceiptPath,
    });

    expect(result.ok).toBe(true);
    expect(result.model?.model_warmup?.status).toBe('running');
    expect(result.model?.model_warmup?.started_at).toBe('2026-06-11T01:01:00.000Z');
    expect(result.model?.model_warmup?.completed_at).toBeUndefined();
    expect(result.model?.warnings).toContain('runtime_receipt_missing');
    expect(result.model?.warnings).not.toContain('model_warmup_receipt_schema_mismatch');
  });

  it('plumbs a blocked OLLAMA_MISSING stage into an external-link remediation', () => {
    const root = makeRoot();
    const manifestPath = path.join(root, 'command-eve-runtime-bootstrap.json');
    const receiptPath = path.join(root, 'receipt.json');
    writeJson(manifestPath, manifest);
    writeJson(receiptPath, {
      version: 'command-eve-runtime-bootstrap/v0',
      app_release: '1.0.0-alpha.5',
      mode: 'auto',
      status: 'blocked',
      started_at: '2026-06-11T01:00:00.000Z',
      completed_at: '2026-06-11T01:01:00.000Z',
      runtime_root: root,
      hermes_home: path.join(root, 'hermes-home'),
      provider: 'ollama',
      default_model: 'command-eve-gemma4-e4b-64k:latest',
      ollama_base_url: 'http://127.0.0.1:11434',
      egress_proxy_url: 'http://127.0.0.1:25811',
      stages: [
        { id: 'capacity', status: 'pass' },
        { id: 'ollama', status: 'blocked', code: 'OLLAMA_MISSING', detail: 'ollama binary not found' },
      ],
      next_action: 'install_ollama',
      warnings: [],
      capabilities: { skills: 1, connectors: 1, capability_pack: 'pack.json' },
    });

    const result = buildLocalRuntimeStatus({ userDataPath: root, manifestPath, receiptPath });

    expect(result.ok).toBe(true);
    expect(result.model?.blocked_stage?.stage_id).toBe('ollama');
    expect(result.model?.blocked_stage?.stage_status).toBe('blocked');
    expect(result.model?.blocked_stage?.reason_code).toBe('OLLAMA_MISSING');
    expect(result.model?.blocked_stage?.remediation_kind).toBe('external-link');
    expect(result.model?.blocked_stage?.detail).toBe('ollama binary not found');
  });

  it('maps the local-block reason codes to their remediation kinds', () => {
    const root = makeRoot();
    const manifestPath = path.join(root, 'command-eve-runtime-bootstrap.json');
    writeJson(manifestPath, manifest);
    const cases: Array<[string, string]> = [
      ['MODEL_NOT_FETCHED', 'pull-progress'],
      ['MODEL_PULL_FAILED', 'pull-progress'],
      ['BLOCKED_RAM', 'cloud-redirect'],
      ['BLOCKED_DISK', 'cloud-redirect'],
      ['PYTHON_UNSUPPORTED', 'reinstall'],
      ['HERMES_VERSION_MISMATCH', 'reinstall'],
      ['SOMETHING_UNKNOWN', 'reinstall'],
    ];
    for (const [code, kind] of cases) {
      const receiptPath = path.join(root, `receipt-${code}.json`);
      writeJson(receiptPath, {
        version: 'command-eve-runtime-bootstrap/v0',
        app_release: '1.0.0-alpha.5',
        mode: 'auto',
        status: 'blocked',
        started_at: '2026-06-11T01:00:00.000Z',
        completed_at: '2026-06-11T01:01:00.000Z',
        runtime_root: root,
        hermes_home: path.join(root, 'hermes-home'),
        provider: 'ollama',
        default_model: 'command-eve-gemma4-e4b-64k:latest',
        ollama_base_url: 'http://127.0.0.1:11434',
        egress_proxy_url: 'http://127.0.0.1:25811',
        stages: [{ id: 'model', status: 'blocked', code }],
        next_action: 'remediate',
        warnings: [],
        capabilities: { skills: 1, connectors: 1, capability_pack: 'pack.json' },
      });
      const result = buildLocalRuntimeStatus({ userDataPath: root, manifestPath, receiptPath });
      expect(result.model?.blocked_stage?.reason_code).toBe(code);
      expect(result.model?.blocked_stage?.remediation_kind).toBe(kind);
    }
  });

  it('leaves blocked_stage absent when every stage passed', () => {
    const root = makeRoot();
    const manifestPath = path.join(root, 'command-eve-runtime-bootstrap.json');
    const receiptPath = path.join(root, 'receipt.json');
    writeJson(manifestPath, manifest);
    writeJson(receiptPath, {
      version: 'command-eve-runtime-bootstrap/v0',
      app_release: '1.0.0-alpha.5',
      mode: 'auto',
      status: 'ready',
      started_at: '2026-06-11T01:00:00.000Z',
      completed_at: '2026-06-11T01:01:00.000Z',
      runtime_root: root,
      hermes_home: path.join(root, 'hermes-home'),
      provider: 'ollama',
      default_model: 'command-eve-gemma4-e4b-64k:latest',
      ollama_base_url: 'http://127.0.0.1:11434',
      egress_proxy_url: 'http://127.0.0.1:25811',
      stages: [
        { id: 'ollama', status: 'pass' },
        { id: 'model', status: 'pass' },
      ],
      next_action: 'ready',
      warnings: [],
      capabilities: { skills: 1, connectors: 1, capability_pack: 'pack.json' },
    });

    const result = buildLocalRuntimeStatus({ userDataPath: root, manifestPath, receiptPath });

    expect(result.ok).toBe(true);
    expect(result.model?.blocked_stage).toBeUndefined();
  });

  it('fails closed when the manifest is unsafe', () => {
    const root = makeRoot();
    const manifestPath = path.join(root, 'command-eve-runtime-bootstrap.json');
    writeJson(manifestPath, {
      ...manifest,
      local_runtime: {
        ...manifest.local_runtime,
        base_url: 'https://example.com',
      },
    });

    const result = buildLocalRuntimeStatus({ userDataPath: root, manifestPath });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.reason_code).toBe('LOCAL_RUNTIME_STATUS_FAILED');
    expect(result.message).toContain('manifest.ollama_url_not_loopback');
  });
});

describe('buildLocalRuntimeStatus — live model-pull progress (v1.6.x)', () => {
  const writeManifest = (root: string): string => {
    const manifestPath = path.join(root, 'command-eve-runtime-bootstrap.json');
    writeJson(manifestPath, manifest);
    return manifestPath;
  };

  it('surfaces model_pull + synthesizes the pull-progress card during a FRESH pull (no receipt block)', () => {
    const root = makeRoot();
    const manifestPath = writeManifest(root);
    const modelPullProgressPath = path.join(root, 'pull.json');
    writeJson(modelPullProgressPath, {
      version: 'command-eve-model-pull/v0',
      model: 'gemma4:e4b',
      status: 'pulling',
      total: 1000,
      completed: 400,
      percent: 40,
      updated_at: '2026-06-11T02:00:00.000Z',
    });

    const result = buildLocalRuntimeStatus({
      userDataPath: root,
      manifestPath,
      modelPullProgressPath,
      now: () => new Date('2026-06-11T02:00:05.000Z'), // 5s later — fresh
    });

    expect(result.ok).toBe(true);
    expect(result.model?.model_pull?.percent).toBe(40);
    expect(result.model?.model_pull?.status).toBe('pulling');
    // The receipt is silent mid-pull, so the card is synthesized.
    expect(result.model?.blocked_stage?.remediation_kind).toBe('pull-progress');
    expect(result.model?.blocked_stage?.reason_code).toBe('MODEL_NOT_FETCHED');
  });

  it('does NOT synthesize a card for a STALE pulling file (crashed pull never freezes the card)', () => {
    const root = makeRoot();
    const manifestPath = writeManifest(root);
    const modelPullProgressPath = path.join(root, 'pull.json');
    writeJson(modelPullProgressPath, {
      version: 'command-eve-model-pull/v0',
      model: 'gemma4:e4b',
      status: 'pulling',
      total: 1000,
      completed: 400,
      percent: 40,
      updated_at: '2026-06-11T02:00:00.000Z',
    });

    const result = buildLocalRuntimeStatus({
      userDataPath: root,
      manifestPath,
      modelPullProgressPath,
      now: () => new Date('2026-06-11T02:05:00.000Z'), // 5 min later — stale
    });

    // 1.6.3 review fix: the RAW payload now applies the SAME staleness rule —
    // a crashed pull froze the settings model card on "Lädt X %" forever.
    expect(result.model?.model_pull).toBeUndefined();
    expect(result.model?.warnings).toContain('model_pull_stale');
    expect(result.model?.blocked_stage).toBeUndefined(); // and still no frozen card
  });

  it('a done pull reports model_pull without a blocked card', () => {
    const root = makeRoot();
    const manifestPath = writeManifest(root);
    const modelPullProgressPath = path.join(root, 'pull.json');
    writeJson(modelPullProgressPath, {
      version: 'command-eve-model-pull/v0',
      model: 'gemma4:e4b',
      status: 'done',
      total: 1000,
      completed: 1000,
      percent: 100,
      updated_at: '2026-06-11T02:00:00.000Z',
    });

    const result = buildLocalRuntimeStatus({ userDataPath: root, manifestPath, modelPullProgressPath });
    expect(result.model?.model_pull?.status).toBe('done');
    expect(result.model?.blocked_stage).toBeUndefined();
  });
});

describe('1.6.3 — probe-enriched tier cards (installed / fits / recommended)', () => {
  const setup = () => {
    const root = makeRoot();
    const manifestPath = path.join(root, 'command-eve-runtime-bootstrap.json');
    writeJson(manifestPath, manifest);
    return { root, manifestPath };
  };

  it('marks a tier installed via the runtime alias AND carries its on-disk size', () => {
    const { root, manifestPath } = setup();
    const result = buildLocalRuntimeStatus({
      userDataPath: root,
      manifestPath,
      installedModels: [{ name: 'command-eve-gemma4-e4b-64k:latest', size: 9_500_000_000 }],
      totalMemoryBytes: 16 * 1024 ** 3,
      freeDiskGb: 100,
    });
    const [e4b, twelveB] = result.model!.tiers;
    expect(e4b.installed).toBe(true);
    expect(e4b.installed_size_bytes).toBe(9_500_000_000);
    expect(twelveB.installed).toBe(false);
    expect(result.model!.warnings).not.toContain('ollama_probe_unavailable');
  });

  it('matches installed by the RAW model_ref too (bare name implies :latest)', () => {
    const { root, manifestPath } = setup();
    const result = buildLocalRuntimeStatus({
      userDataPath: root,
      manifestPath,
      installedModels: [{ name: 'gemma4:12b' }],
    });
    expect(result.model!.tiers[1].installed).toBe(true);
  });

  it('an UNAVAILABLE probe reads as installed:false + an honest warning, never a false claim', () => {
    const { root, manifestPath } = setup();
    const result = buildLocalRuntimeStatus({ userDataPath: root, manifestPath });
    expect(result.model!.tiers.every((tier) => tier.installed === false)).toBe(true);
    expect(result.model!.warnings).toContain('ollama_probe_unavailable');
  });

  it('computes RAM/disk fits from injected hardware; installed tiers need no fresh disk', () => {
    const { root, manifestPath } = setup();
    const result = buildLocalRuntimeStatus({
      userDataPath: root,
      manifestPath,
      installedModels: [{ name: 'gemma4:12b' }],
      totalMemoryBytes: 16 * 1024 ** 3,
      freeDiskGb: 12, // enough for e4b (10) but NOT a fresh 12b pull (20)
    });
    const [e4b, twelveB] = result.model!.tiers;
    expect(e4b.ram_fit).toBe(true);
    expect(e4b.disk_fit).toBe(true);
    // 12b is short on FRESH disk — but it is INSTALLED, so disk_fit stays true.
    expect(twelveB.disk_fit).toBe(true);
    expect(result.model!.hardware?.total_memory_gb).toBe(16);
  });

  it('unknown hardware NEVER invents a blocker (fits default true)', () => {
    const { root, manifestPath } = setup();
    const result = buildLocalRuntimeStatus({ userDataPath: root, manifestPath, installedModels: [] });
    expect(result.model!.tiers.every((tier) => tier.ram_fit && tier.disk_fit)).toBe(true);
    expect(result.model!.hardware).toBeUndefined();
  });

  it('recommendation policy: manifest default; a ≥64GB machine lifts to the 12B tier', () => {
    const { root, manifestPath } = setup();
    const small = buildLocalRuntimeStatus({ userDataPath: root, manifestPath, totalMemoryBytes: 16 * 1024 ** 3 });
    expect(small.model!.tiers.find((tier) => tier.recommended)?.id).toBe('gemma-4-e4b-local-default');
    const big = buildLocalRuntimeStatus({ userDataPath: root, manifestPath, totalMemoryBytes: 64 * 1024 ** 3 });
    expect(big.model!.tiers.find((tier) => tier.recommended)?.id).toBe('gemma-4-12b-local-planning');
  });
});

describe('1.6.3 review fix — stale pull rows never freeze the payload', () => {
  it("drops a >120s-old 'pulling' row (crashed pull) and says so via warning", () => {
    const root = makeRoot();
    const manifestPath = path.join(root, 'command-eve-runtime-bootstrap.json');
    writeJson(manifestPath, manifest);
    const pullPath = path.join(root, 'command-eve-runtime', 'model-pull-progress.json');
    writeJson(pullPath, {
      version: 'command-eve-model-pull/v0',
      model: 'gemma4:e4b',
      status: 'pulling',
      total: 1000,
      completed: 430,
      percent: 43,
      updated_at: '2026-07-03T10:00:00.000Z',
    });
    const result = buildLocalRuntimeStatus({
      userDataPath: root,
      manifestPath,
      modelPullProgressPath: pullPath,
      now: () => new Date('2026-07-03T12:00:00.000Z'), // 2h later — long stale
    });
    expect(result.model?.model_pull).toBeUndefined();
    expect(result.model?.warnings).toContain('model_pull_stale');
  });

  it("keeps a FRESH 'pulling' row and terminal done/failed rows untouched", () => {
    const root = makeRoot();
    const manifestPath = path.join(root, 'command-eve-runtime-bootstrap.json');
    writeJson(manifestPath, manifest);
    const pullPath = path.join(root, 'command-eve-runtime', 'model-pull-progress.json');
    writeJson(pullPath, {
      version: 'command-eve-model-pull/v0',
      model: 'gemma4:e4b',
      status: 'pulling',
      total: 1000,
      completed: 430,
      percent: 43,
      updated_at: '2026-07-03T11:59:30.000Z',
    });
    const fresh = buildLocalRuntimeStatus({
      userDataPath: root,
      manifestPath,
      modelPullProgressPath: pullPath,
      now: () => new Date('2026-07-03T12:00:00.000Z'),
    });
    expect(fresh.model?.model_pull?.percent).toBe(43);
    writeJson(pullPath, { version: 'command-eve-model-pull/v0', model: 'gemma4:e4b', status: 'done', total: 1000, completed: 1000, percent: 100, updated_at: '2026-07-03T09:00:00.000Z' });
    const done = buildLocalRuntimeStatus({ userDataPath: root, manifestPath, modelPullProgressPath: pullPath, now: () => new Date('2026-07-03T12:00:00.000Z') });
    expect(done.model?.model_pull?.status).toBe('done');
  });
});
