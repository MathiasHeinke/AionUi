import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('Command EVE runtime bridge registration', () => {
  it('pins packaged license-key resolution to Electron signed resources unconditionally', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../packages/desktop/src/index.ts'), 'utf8');
    const markerStart = source.indexOf('// ============ Command EVE license-key resolution');
    const markerEnd = source.indexOf('// ============ Single Instance Lock', markerStart);
    const markerSource = source.slice(markerStart, markerEnd);

    expect(markerSource).toContain('if (app.isPackaged) {');
    expect(markerSource).toContain('process.env.COMMAND_EVE_RESOURCES_PATH = process.resourcesPath;');
    expect(markerSource).not.toContain('app.isPackaged && !process.env.COMMAND_EVE_RESOURCES_PATH');
  });

  it('registers every renderer-declared runtime provider in the active app entrypoint', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../packages/desktop/src/index.ts'), 'utf8');
    for (const provider of [
      'runtimeStatus',
      'ensureAssistant',
      'ensureLocalModelTier',
      'warmLocalModel',
      'evaluateGateDecision',
    ]) {
      expect(source).toContain(`ipcBridge.commandEve.${provider}.provider`);
    }
  });

  it('checks the completed runtime receipt before a new bootstrap can overwrite it', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../packages/desktop/src/index.ts'), 'utf8');
    const waitDecision = source.indexOf('const mustWaitForRuntimeBootstrap =');
    const bootstrapOptions = source.indexOf('const bootstrapOptions =', waitDecision);
    const blockingBootstrapStart = source.indexOf(
      'await ensureCommandEveRuntimeBootstrap(bootstrapOptions)',
      waitDecision
    );
    const deferredBootstrapStart = source.indexOf(
      'void ensureCommandEveRuntimeBootstrap(bootstrapOptions)',
      waitDecision
    );

    expect(waitDecision).toBeGreaterThan(-1);
    expect(bootstrapOptions).toBeGreaterThan(waitDecision);
    expect(blockingBootstrapStart).toBeGreaterThan(waitDecision);
    expect(deferredBootstrapStart).toBeGreaterThan(waitDecision);
  });

  it('never falls back to loading a local model before backend settings are readable', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../packages/desktop/src/index.ts'), 'utf8');
    const warmupStart = source.indexOf('function scheduleCommandEveLocalModelWarmup(');
    const warmupEnd = source.indexOf('function registerCronResumeBridge(', warmupStart);
    const warmupSource = source.slice(warmupStart, warmupEnd);

    expect(warmupSource).toContain('await waitForCommandEveBackendPort(30_000)');
    expect(warmupSource).toContain('skipping speculative warm-up');
    expect(warmupSource).not.toContain("lane = { lane: 'local' }");
  });

  it('gates every managed local route on the exact release receipt and never downloads from chat', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../packages/desktop/src/index.ts'), 'utf8');
    const resolverStart = source.indexOf('function buildCommandEveManagedLocalOpenAiRoutingResolver(');
    const resolverEnd = source.indexOf('function buildCommandEveShimEgressRedactionModeResolver(', resolverStart);
    const resolverSource = source.slice(resolverStart, resolverEnd);

    expect(resolverSource).toContain(
      'runtimeReceiptAllowsLocalModelRequest(receipt, app.getVersion(), normalizedModel)'
    );
    expect(resolverSource).not.toContain("requestedTier.runtime === 'ollama'");
    expect(resolverSource).toContain('autoProvision: false');
    expect(resolverSource).not.toContain('autoProvision: true');
  });

  it('allows the 384 GB Colibri download only through the explicit model-settings action', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../packages/desktop/src/index.ts'), 'utf8');
    const providerStart = source.indexOf('ipcBridge.commandEve.ensureLocalModelTier.provider');
    const providerEnd = source.indexOf('ipcBridge.commandEve.warmLocalModel.provider', providerStart);
    const providerSource = source.slice(providerStart, providerEnd);

    expect(providerSource).toContain('allowColibriDownload: true');
  });

  it('cancels deferred runtime work after a known backend startup failure', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../packages/desktop/src/index.ts'), 'utf8');
    const warmupStart = source.indexOf('function scheduleCommandEveLocalModelWarmup(');
    const warmupEnd = source.indexOf('function registerCronResumeBridge(', warmupStart);
    const warmupSource = source.slice(warmupStart, warmupEnd);
    const backendFailureStart = source.indexOf("console.error('[CommandEVE] Failed to start aioncore:'");
    const backendFailureEnd = source.indexOf('// One-shot WebUI admin credential migration', backendFailureStart);
    const backendFailureSource = source.slice(backendFailureStart, backendFailureEnd);

    expect(warmupSource).toContain('if (backendStartupFailed) return;');
    expect(backendFailureSource).toContain('runDeferredCommandEveRuntimeBootstrap = undefined;');
  });
});
