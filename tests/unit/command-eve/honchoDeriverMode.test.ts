/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * COMPA-624 (2026-07-05) — the USER-SWITCHABLE deriver toggle. Proves the pure
 * routing: 'auto' honours the founder-locked local-when-ready-else-cloud rule;
 * 'local' is a PRIVACY-LOCK (always loopback Ollama, NEVER the cloud shim, even when
 * cold); 'cloud' forces the free cloud-Flash lane. Plus the serve deriver env and the
 * warm-up-receipt readiness reader.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveHonchoDeriverConfig, HONCHO_DERIVER_BRANCH_LOCAL, HONCHO_DERIVER_BRANCH_CLOUD, HONCHO_DERIVER_FORCED_TIER } from '@/process/commandEve/honchoRuntimeConfigCore';
import { buildHonchoDeriverEnv, HONCHO_DERIVER_ENV_KEYS, resolveLocalModelReadyFromWarmupReceipt } from '@/process/commandEve/honchoProvisioningRun';

describe('resolveHonchoDeriverConfig — the deriver switch', () => {
  it("'auto' + local ready ⇒ LOCAL loopback Ollama, no egress, no tier", () => {
    const d = resolveHonchoDeriverConfig({ deriverMode: 'auto', localModelOptedIn: true, localModelReady: true });
    expect(d.branch).toBe(HONCHO_DERIVER_BRANCH_LOCAL);
    expect(d.baseUrl).toBe('http://127.0.0.1:11434/v1');
    expect(d.behindEgressBoundary).toBe(false);
    expect(d.forcedTier).toBeUndefined();
    expect(d.routeReason).toBe('local-opt-in-ready');
  });

  it("'auto' + local NOT ready ⇒ falls to the FREE cloud-Flash shim lane (the crutch)", () => {
    const d = resolveHonchoDeriverConfig({ deriverMode: 'auto', localModelOptedIn: true, localModelReady: false });
    expect(d.branch).toBe(HONCHO_DERIVER_BRANCH_CLOUD);
    expect(d.baseUrl).toContain('127.0.0.1:25811'); // the loopback shim, never the edge fn
    expect(d.behindEgressBoundary).toBe(true);
    expect(d.forcedTier).toBe(HONCHO_DERIVER_FORCED_TIER);
    expect(d.routeReason).toBe('opt-in-not-ready');
  });

  it("'local' PRIVACY-LOCK ⇒ ALWAYS local, even when the model is cold — NEVER the cloud", () => {
    const cold = resolveHonchoDeriverConfig({ deriverMode: 'local', localModelOptedIn: false, localModelReady: false });
    expect(cold.branch).toBe(HONCHO_DERIVER_BRANCH_LOCAL);
    expect(cold.baseUrl).toBe('http://127.0.0.1:11434/v1');
    expect(cold.behindEgressBoundary).toBe(false); // nothing egresses
    expect(cold.routeReason).toBe('local-locked');
  });

  it("'cloud' ⇒ forces the free cloud-Flash lane even when a local model is ready", () => {
    const d = resolveHonchoDeriverConfig({ deriverMode: 'cloud', localModelOptedIn: true, localModelReady: true });
    expect(d.branch).toBe(HONCHO_DERIVER_BRANCH_CLOUD);
    expect(d.forcedTier).toBe(HONCHO_DERIVER_FORCED_TIER); // still hard-pinned to FREE
    expect(d.routeReason).toBe('forced-cloud');
  });

  it('absent mode defaults to auto (byte-compatible with the pre-toggle behaviour)', () => {
    const ready = resolveHonchoDeriverConfig({ localModelOptedIn: true, localModelReady: true });
    expect(ready.branch).toBe(HONCHO_DERIVER_BRANCH_LOCAL);
    const notReady = resolveHonchoDeriverConfig({ localModelOptedIn: true, localModelReady: false });
    expect(notReady.branch).toBe(HONCHO_DERIVER_BRANCH_CLOUD);
  });
});

describe('buildHonchoDeriverEnv — the serve deriver env overlay', () => {
  it('LOCAL branch ⇒ env points honcho at loopback Ollama (never egresses)', () => {
    const d = resolveHonchoDeriverConfig({ deriverMode: 'local' });
    const env = buildHonchoDeriverEnv({ deriver: d } as never);
    expect(env[HONCHO_DERIVER_ENV_KEYS.baseUrl]).toBe('http://127.0.0.1:11434/v1');
    expect(env[HONCHO_DERIVER_ENV_KEYS.model]).toBe('gemma4:e4b');
    // The local key is the Ollama placeholder, NEVER a real secret.
    expect(env[HONCHO_DERIVER_ENV_KEYS.apiKey]).toBe('ollama');
  });

  it('CLOUD branch ⇒ env points at the loopback shim, carries NO baked bearer AT ALL', () => {
    const d = resolveHonchoDeriverConfig({ deriverMode: 'cloud' });
    const env = buildHonchoDeriverEnv({ deriver: d } as never);
    expect(env[HONCHO_DERIVER_ENV_KEYS.baseUrl]).toContain('127.0.0.1:25811');
    // Defense-in-depth: the cloud lane emits NO api-key env key at all — the shim
    // owns the bearer (Authorization header). Never a baked key on the egress lane.
    expect(env[HONCHO_DERIVER_ENV_KEYS.apiKey]).toBeUndefined();
  });
});

describe('resolveLocalModelReadyFromWarmupReceipt', () => {
  const roots: string[] = [];
  const mk = (): string => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'honcho-warmup-'));
    roots.push(r);
    return r;
  };
  afterEach(() => {
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  });

  it('no receipt ⇒ false (default-deny ⇒ auto uses cloud)', () => {
    expect(resolveLocalModelReadyFromWarmupReceipt(mk())).toBe(false);
  });

  it("status 'ready' + matching model ⇒ true", () => {
    const r = mk();
    fs.writeFileSync(path.join(r, 'model-warmup-receipt.json'), JSON.stringify({ status: 'ready', model: 'gemma4:e4b' }));
    expect(resolveLocalModelReadyFromWarmupReceipt(r)).toBe(true);
  });

  it("status 'ready' but a DIFFERENT model ⇒ false (no false readiness)", () => {
    const r = mk();
    fs.writeFileSync(path.join(r, 'model-warmup-receipt.json'), JSON.stringify({ status: 'ready', model: 'qwen3:8b' }));
    expect(resolveLocalModelReadyFromWarmupReceipt(r)).toBe(false);
  });

  it("status 'running'/'failed' ⇒ false", () => {
    const r = mk();
    fs.writeFileSync(path.join(r, 'model-warmup-receipt.json'), JSON.stringify({ status: 'running', model: 'gemma4:e4b' }));
    expect(resolveLocalModelReadyFromWarmupReceipt(r)).toBe(false);
  });

  it('malformed JSON ⇒ false (fail-soft)', () => {
    const r = mk();
    fs.writeFileSync(path.join(r, 'model-warmup-receipt.json'), '{not json');
    expect(resolveLocalModelReadyFromWarmupReceipt(r)).toBe(false);
  });
});
