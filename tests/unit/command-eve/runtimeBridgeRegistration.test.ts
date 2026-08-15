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

  it('registers and navigation-guards browser guests in MAIN before renderer crash recovery', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../packages/desktop/src/index.ts'), 'utf8');
    const didAttach = source.indexOf("mainWindow.webContents.on('did-attach-webview'");
    const rendererGone = source.indexOf("mainWindow.webContents.on('render-process-gone'");

    expect(didAttach).toBeGreaterThan(-1);
    const guestLifecycle = source.slice(didAttach, rendererGone);
    expect(guestLifecycle).toContain('getCdpBridgeHandle()?.registerGuest(guest)');
    expect(guestLifecycle).toContain("guest.on('will-navigate'");
    expect(guestLifecycle).toContain("guest.on('will-redirect'");
    expect(guestLifecycle).toContain("guest.setWindowOpenHandler(() => ({ action: 'deny' }))");
    expect(source.slice(rendererGone, rendererGone + 800)).toContain(
      "getCdpBridgeHandle()?.detachActiveTarget('main renderer process exited')"
    );
  });

  it('decides ABI recovery before AionCore starts while compatible warm boots remain deferred', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../packages/desktop/src/index.ts'), 'utf8');
    const bootstrapOptions = source.indexOf('const bootstrapOptions =');
    const deferredHelper = source.indexOf('const deferRemainingRuntimeBootstrap =');
    const automaticWait = source.indexOf('let automaticRuntimeRepairReason:');
    const earlyFailClosed = source.indexOf('commandEveAutomaticRuntimeRepairRequired = app.isPackaged;');
    const ancestryGate = source.indexOf('!commandEveRuntimeManagedAncestryIsSafe({', automaticWait);
    const shimStart = source.indexOf('const shimUrl = rememberCommandEveOllamaShimUrl(', automaticWait);
    const waitDecision = source.indexOf('const mustWaitForRuntimeBootstrap =');
    const blockingBootstrapStart = source.indexOf(
      'const receipt = await ensureCommandEveRuntimeBootstrap({',
      waitDecision
    );
    const deferredBootstrapStart = source.indexOf(
      'void ensureCommandEveRuntimeBootstrap(bootstrapOptions)',
      deferredHelper
    );
    const backendStart = source.indexOf('// Start aioncore only after initializeProcess()', waitDecision);

    expect(earlyFailClosed).toBeGreaterThan(-1);
    expect(automaticWait).toBeGreaterThan(earlyFailClosed);
    expect(ancestryGate).toBeGreaterThan(automaticWait);
    expect(shimStart).toBeGreaterThan(ancestryGate);
    expect(bootstrapOptions).toBeGreaterThan(shimStart);
    expect(deferredHelper).toBeGreaterThan(bootstrapOptions);
    expect(deferredBootstrapStart).toBeGreaterThan(deferredHelper);
    expect(waitDecision).toBeGreaterThan(-1);
    expect(waitDecision).toBeGreaterThan(bootstrapOptions);
    expect(blockingBootstrapStart).toBeGreaterThan(waitDecision);
    expect(backendStart).toBeGreaterThan(blockingBootstrapStart);
    expect(source.slice(automaticWait, backendStart)).toContain('commandEveAutomaticRuntimeRepairRequired ||');
    expect(source.slice(automaticWait, backendStart)).toContain('canonicalUserDataPath: canonicalRuntimeUserDataPath');
    expect(source.slice(earlyFailClosed, automaticWait)).toContain(
      "const requirePackagedHermesRuntime = app.isPackaged && process.platform === 'darwin'"
    );
    expect(source.slice(automaticWait, backendStart)).toContain('requireBundledPython: requirePackagedHermesRuntime');
    expect(source.slice(bootstrapOptions, waitDecision)).toContain(
      'requireBundledPython: requirePackagedHermesRuntime'
    );
    expect(source.slice(waitDecision, backendStart)).toContain(
      'stopAfterHermesRuntimeReady: commandEveAutomaticRuntimeRepairRequired'
    );
    expect(source.slice(waitDecision, backendStart)).toContain('deferRemainingRuntimeBootstrap(true)');
    expect(source.slice(automaticWait, backendStart)).toContain('commandEveRuntimeVenvIsBackendAdmissible');
    expect(source.slice(automaticWait, backendStart)).toContain('throw new Error(');
    expect(source.slice(automaticWait, waitDecision)).toContain(
      "automaticRuntimeRepairReason = 'python_venv_recovery'"
    );
    expect(source.slice(backendStart - 500, backendStart)).toContain(
      '!commandEveOllamaShimUrl || commandEveAutomaticRuntimeRepairRequired'
    );
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

  it('never schedules a cloud inference warm-up, and never warns about not doing it', () => {
    // MAT-1749. Startup used to fire a metered EVE turn to warm the edge, then warn
    // whenever that failed. Both are gone: no scheduler call, so no request and no
    // per-launch warning. A warning here would describe a decision, not a problem,
    // and would train operators to ignore the warnings that do matter.
    const source = fs.readFileSync(path.resolve(__dirname, '../../../packages/desktop/src/index.ts'), 'utf8');
    const warmupStart = source.indexOf('function scheduleCommandEveLocalModelWarmup(');
    const warmupEnd = source.indexOf('function registerCronResumeBridge(', warmupStart);
    const warmupSource = source.slice(warmupStart, warmupEnd);

    const eveBranchStart = warmupSource.indexOf("if (lane.lane === 'eve') {");
    const eveBranchEnd = warmupSource.indexOf('// Local lane:', eveBranchStart);
    expect(eveBranchStart).toBeGreaterThan(-1);
    expect(eveBranchEnd).toBeGreaterThan(eveBranchStart);
    const eveBranch = warmupSource.slice(eveBranchStart, eveBranchEnd);

    // The cloud branch does nothing and says nothing. (The lane-RESOLUTION failure
    // above it still warns, and should — that one is a genuine problem.)
    expect(eveBranch).not.toContain('console.warn');
    expect(eveBranch).not.toContain('Warmup(');
    expect(warmupSource).not.toContain('scheduleCommandEveEveLaneWarmup');
    expect(warmupSource).not.toContain('eveWarmup');
    // Gone from the file, not merely unreferenced from this branch.
    expect(source).not.toContain('function scheduleCommandEveEveLaneWarmup(');
    // The LOCAL model warm-up must survive untouched — this fix must not cost the
    // local lane its warm start.
    expect(warmupSource).toContain('ensureCommandEveLocalModelWarmup(receipt, shimUrl, warmup, mark)');
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

  it('threads the trusted canonical Electron data root through every production bootstrap entrypoint', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../packages/desktop/src/index.ts'), 'utf8');
    const ensureStart = source.indexOf('ipcBridge.commandEve.ensureLocalModelTier.provider');
    const warmStart = source.indexOf('ipcBridge.commandEve.warmLocalModel.provider', ensureStart);
    const providerEnd = source.indexOf('ipcBridge.commandEve.evaluateGateDecision.provider', warmStart);
    const ensureSource = source.slice(ensureStart, warmStart);
    const warmSource = source.slice(warmStart, providerEnd);
    const bootStart = source.indexOf('commandEveAutomaticRuntimeRepairRequired = app.isPackaged;');
    const bootEnd = source.indexOf('// Start aioncore only after initializeProcess()', bootStart);
    const bootSource = source.slice(bootStart, bootEnd);

    for (const entrypoint of [ensureSource, warmSource]) {
      expect(entrypoint).toContain('getCanonicalDataPath');
      expect(entrypoint).toContain('canonicalUserDataPath');
      expect(entrypoint).toContain("app.isPackaged && process.platform === 'darwin'");
      expect(entrypoint).toContain('requireBundledPython');
    }
    expect(bootSource).toContain('const canonicalRuntimeUserDataPath = getCanonicalDataPath();');
    expect(bootSource).not.toContain("path.join(\n      app.getPath('userData')");

    const utilsSource = fs.readFileSync(
      path.resolve(__dirname, '../../../packages/desktop/src/process/utils/utils.ts'),
      'utf8'
    );
    expect(utilsSource).toContain('export const getCanonicalDataPath = (): string =>');
    expect(utilsSource).toContain('const dataPath = getCanonicalDataPath();');
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
