#!/usr/bin/env node
/**
 * MAT-1747 PROOF 1 runner — packaged emitted-config proof.
 *
 * Phase A (staged approximation, always runnable):
 *   1. Builds the real builtin MCP scripts (scripts/build-mcp-servers.js).
 *   2. Bundles the harness (mat1747EmittedConfigProof.ts) to
 *      out/main/proof-mat1747-emitted-config.cjs so require.main.filename sits
 *      next to the real built script — the same resolution the dev main
 *      process uses.
 *   3. Stages a resources tree with a REAL node executable at the exact
 *      managed-resources layout resolveCommandEveManagedNodeExecutable demands.
 *      APPROXIMATION, stated: this node is the host's own binary copied into
 *      the layout, NOT the signed AionCore managed-resources bundle (that
 *      payload is a pinned source build, unavailable in this environment).
 *   4. Runs the real provisionSeatRuntimeFiles composition for an ELIGIBLE seat
 *      (licence wire seeded, env unset — the 1.820.2 default-on posture) and a
 *      KILL-SWITCHED one (env '0'), and diffs the two emitted configs.
 *
 * Phase B (packaged layout, when out-proof/mac-arm64/Command EVE.app exists):
 *   Runs the SAME harness bundle from inside the packaged tree's
 *   app.asar.unpacked/out/main/ — the exact baseDir packaged Electron computes
 *   after its app.asar -> app.asar.unpacked replacement — against the real
 *   packaged Contents/Resources. This is where the shipping asarUnpack list is
 *   judged against reality.
 */
const { execFileSync, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const PROOF_OUT = path.join(ROOT, 'out', 'main', 'proof-mat1747-emitted-config.cjs');
const APP = path.join(ROOT, 'out-proof', 'mac-arm64', 'Command EVE.app');

let failures = 0;
const note = (msg) => console.log(`PROOF-NOTE :: ${msg}`);
const step = (name, ok, evidence = '') => {
  console.log(`PROOF-STEP ${ok ? 'PASS' : 'FAIL'} :: ${name}${evidence ? ` :: ${evidence}` : ''}`);
  if (!ok) failures += 1;
};

function bundleHarness() {
  const esbuild = require('esbuild');
  esbuild.buildSync({
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron', 'better-sqlite3', 'sharp', '@napi-rs/canvas'],
    tsconfig: path.join(ROOT, 'tsconfig.json'),
    loader: { '.wasm': 'empty' },
    define: { 'import.meta.url': JSON.stringify('file:///proof') },
    entryPoints: [path.join(ROOT, 'scripts/proofs/mat1747EmittedConfigProof.ts')],
    outfile: PROOF_OUT,
  });
}

function stageResources(base) {
  const nodeDir = path.join(base, 'bundled-aioncore', 'darwin-arm64', 'managed-resources', 'node', 'v22-host');
  fs.mkdirSync(path.join(nodeDir, 'bin'), { recursive: true });
  fs.copyFileSync(process.execPath, path.join(nodeDir, 'bin', 'node'));
  fs.chmodSync(path.join(nodeDir, 'bin', 'node'), 0o755);
  return base;
}

function runHarness(userData, resources, flag, harnessPath = PROOF_OUT) {
  try {
    return execFileSync(
      process.execPath,
      [harnessPath, '--userdata', userData, '--resources', resources, '--flag', flag],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
  } catch (error) {
    // A FAILING harness exits 1 — its stdout IS the evidence. Return it.
    return `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
}

function main() {
  // 1. real built MCP scripts
  if (!fs.existsSync(path.join(ROOT, 'out/main/builtin-mcp-eve-artifacts.js'))) {
    execSync('node scripts/build-mcp-servers.js', { cwd: ROOT, stdio: 'inherit' });
  }
  step(
    'built builtin-mcp-eve-artifacts.js present',
    fs.existsSync(path.join(ROOT, 'out/main/builtin-mcp-eve-artifacts.js'))
  );

  bundleHarness();
  step('harness bundled to out/main', fs.existsSync(PROOF_OUT));

  // ---- Phase A: staged approximation --------------------------------------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mat1747-proof1-'));
  const stagedResources = stageResources(path.join(tmp, 'resources'));
  note(`staged resources at ${stagedResources} (host node binary standing in for the signed managed bundle)`);
  const userData = path.join(tmp, 'userData');

  console.log('=== PHASE A1: ELIGIBLE seat (licence wire seeded, env UNSET — the 1.820.2 default-on posture) ===');
  const onOut = runHarness(userData, stagedResources, 'on');
  process.stdout.write(onOut);
  step('Phase A1 harness result: PASS', onOut.includes('PROOF-RESULT PASS'));
  const hermesHome = /hermes_home=([^\s]+)/.exec(onOut)?.[1] ?? '';
  step('harness reported hermes_home', Boolean(hermesHome), hermesHome);
  const configFile = path.join(hermesHome, 'config.yaml');
  const onConfig = fs.readFileSync(configFile, 'utf8');

  console.log("=== PHASE A2: kill-switch '0' (same userData + licence wire, idempotent re-provision) ===");
  const offOut = runHarness(userData, stagedResources, 'off');
  process.stdout.write(offOut);
  step('Phase A2 harness result: PASS', offOut.includes('PROOF-RESULT PASS'));
  const offConfig = fs.readFileSync(configFile, 'utf8');

  const onLines = onConfig.split('\n');
  const offLines = offConfig.split('\n');
  const offSet = new Set(offLines);
  const onSet = new Set(onLines);
  const onlyOn = onLines.filter((line) => !offSet.has(line));
  const onlyOff = offLines.filter((line) => !onSet.has(line));
  console.log('PROOF-EVIDENCE config-diff-begin');
  console.log(`lines only in ON : ${JSON.stringify(onlyOn)}`);
  console.log(`lines only in OFF: ${JSON.stringify(onlyOff)}`);
  console.log('PROOF-EVIDENCE config-diff-end');
  step(
    'ON/OFF configs differ ONLY by the paid-tool env line',
    onlyOn.length === 1 && onlyOn[0].includes('COMMAND_EVE_ENABLE_AGENT_VIDEO_EDIT": "1"') && onlyOff.length === 0,
    ''
  );

  // ---- Phase B: packaged layout -------------------------------------------
  if (!fs.existsSync(APP)) {
    note(`packaged proof app not found at ${APP} — Phase B skipped (electron-builder --dir did not complete)`);
  } else {
    const resourcesDir = path.join(APP, 'Contents', 'Resources');
    const unpackedMain = path.join(resourcesDir, 'app.asar.unpacked', 'out', 'main');
    // Restore the AS-BUILT state: earlier proof runs supplement the proof app
    // (staged harness copy, staged aioncore node), so a re-run must first
    // remove exactly those supplements. The artifact script itself is NOT
    // removed: after the 2026-08-03 asarUnpack fix it IS part of the as-built
    // state — deleting it would recreate the defect the fix closed.
    fs.rmSync(path.join(unpackedMain, 'proof-mat1747-emitted-config.cjs'), { force: true });
    fs.rmSync(path.join(resourcesDir, 'bundled-aioncore'), { recursive: true, force: true });
    console.log('=== PHASE B: packaged --dir app (unsigned, NO afterPack, aioncore/python/hub payloads pruned) ===');
    const asarBin = path.join(
      ROOT,
      'node_modules',
      '.bun',
      '@electron+asar@3.4.1',
      'node_modules',
      '@electron',
      'asar',
      'bin',
      'asar.js'
    );
    const asarList = execFileSync(process.execPath, [asarBin, 'list', path.join(resourcesDir, 'app.asar')], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
    });
    const inAsar = asarList.split('\n').filter((line) => line.includes('builtin-mcp'));
    // NOTE: asarUnpack entries ALWAYS still appear in `asar list` — the
    // archive manifest lists every file. This print is informational only;
    // the decisive checks are the physical app.asar.unpacked presence below
    // and external-node execution (proven by the no-paid dry proof's real
    // MCP stdio child run).
    console.log(
      'PROOF-EVIDENCE builtin-mcp entries inside app.asar (informational; presence here is normal for asarUnpack):\n' +
        (inAsar.length ? inAsar.join('\n') : '(none)')
    );
    const unpackedScript = path.join(unpackedMain, 'builtin-mcp-eve-artifacts.js');
    step(
      'SHIPPING CONFIG: builtin-mcp-eve-artifacts.js unpacked for external node',
      fs.existsSync(unpackedScript),
      fs.existsSync(unpackedScript)
        ? unpackedScript
        : 'MISSING from app.asar.unpacked — external node cannot execute a script inside app.asar; packaged emission precondition fs.existsSync(scriptPath) FAILS'
    );
    step(
      'control: builtin-mcp-image-gen.js IS unpacked (it is in the shipping asarUnpack list)',
      fs.existsSync(path.join(unpackedMain, 'builtin-mcp-image-gen.js'))
    );

    // B2: run the harness from the packaged baseDir against packaged Resources.
    // As-built now has the script unpacked but NO managed node (the proof
    // config prunes the aioncore payload), so emission must still fail closed —
    // on the NODE precondition this time, proving the script fix did not
    // weaken the other two preconditions.
    fs.mkdirSync(unpackedMain, { recursive: true });
    const packagedHarness = path.join(unpackedMain, 'proof-mat1747-emitted-config.cjs');
    fs.copyFileSync(PROOF_OUT, packagedHarness);
    console.log(
      '=== PHASE B2: emission against packaged Contents/Resources, flag ON, script unpacked, no managed node ==='
    );
    const bOut = runHarness(path.join(tmp, 'userData-packaged'), resourcesDir, 'on', packagedHarness);
    process.stdout.write(bOut);
    step(
      'packaged layout with the script unpacked but no managed node still emits NO artifact server',
      bOut.includes('PROOF-RESULT NO-SERVER-EMITTED'),
      'the managed-node precondition fails closed — no half-configured server is emitted'
    );

    // B2b: the positive case for the FIXED shipping config — stage ONLY the
    // managed node (the payload the signed release build carries). The script
    // is already unpacked by the shipping asarUnpack list. Emission must PASS.
    stageResources(resourcesDir);
    console.log('=== PHASE B2b: packaged tree, script unpacked by shipping config + staged managed node ===');
    const b2bOut = runHarness(path.join(tmp, 'userData-packaged-node-only'), resourcesDir, 'on', packagedHarness);
    process.stdout.write(b2bOut);
    step(
      'with the script unpacked by the SHIPPING config and a managed node present, packaged layout emits the server',
      b2bOut.includes('PROOF-RESULT PASS'),
      'this is the fixed shipping path, not a supplement'
    );

    // B3: NEGATIVE CONTROL — move the unpacked script aside, prove the
    // fail-closed posture is still intact, then restore it byte-for-byte.
    const stashedScript = `${unpackedScript}.proof-stash`;
    fs.renameSync(unpackedScript, stashedScript);
    console.log('=== PHASE B3: negative control (script temporarily removed from unpacked) ===');
    const b3Out = runHarness(path.join(tmp, 'userData-packaged-fixed'), resourcesDir, 'on', packagedHarness);
    process.stdout.write(b3Out);
    fs.renameSync(stashedScript, unpackedScript);
    step(
      'without the unpacked script the packaged layout still refuses to emit (fail-closed intact)',
      b3Out.includes('PROOF-RESULT NO-SERVER-EMITTED'),
      'the existsSync precondition fails closed — no half-configured server is emitted'
    );
    step('negative-control script restored after B3', fs.existsSync(unpackedScript));
  }

  console.log(`PROOF-RESULT ${failures === 0 ? 'PASS' : 'FAIL'} (${failures} failed steps)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
