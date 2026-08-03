/**
 * MAT-1747 PROOF 1 — emitted-config harness.
 *
 * Runs the REAL seat-runtime provisioning composition
 * (`provisionSeatRuntimeFiles` → `writeHermesRuntimeFiles`, the exact function
 * that calls `buildCommandEveArtifactContextHermesMcpServer` at
 * runtimeBootstrapCore.ts:5624) against production-like inputs, then inspects
 * the emitted Hermes `config.yaml` on disk.
 *
 * This file is bundled to a self-contained CJS by the runner
 * (scripts/proofs/run-mat1747-packaged-config-proof.mjs) and executed with
 * plain `node`, so `require.main.filename` — and therefore
 * `getBuiltinMcpScriptPath('builtin-mcp-eve-artifacts')` — resolves against the
 * REAL location of the built MCP script, exactly as the packaged main process
 * resolves it.
 *
 * Stated seams (nothing else is substituted):
 *  - `process.resourcesPath` is assigned from --resources; packaged Electron
 *    sets the same property to Contents/Resources.
 *  - When run from a copied bundle inside `app.asar.unpacked/out/main/`, the
 *    script-path candidate equals the one packaged Electron computes after its
 *    `app.asar` → `app.asar.unpacked` replacement.
 *  - The OS safeStorage primitive is replaced via the documented test hook
 *    setSafeStorageForTesting, so a REAL licence wire can be stored and read
 *    through the real licenseWireAtRest path. Everything else on that path —
 *    the file format, the ref handling, the well-formedness check — runs for
 *    real.
 *
 * POST-1.820.2 PHASE MEANINGS: eligibility comes from the licence wire, not
 * from the env. `--flag on` seeds the wire and leaves the env UNSET — the
 * eligible seat must emit the paid-tool env line BY DEFAULT. `--flag off`
 * keeps the wire and sets exactly `'0'` — the kill-switch must suppress the
 * line even on an eligible seat.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  provisionSeatRuntimeFiles,
  resolveCommandEveManagedNodeExecutable,
} from '@process/commandEve/runtimeBootstrapCore';
import { getBuiltinMcpScriptPath } from '@process/utils/builtinMcpPath';
import { setSafeStorageForTesting } from '@/common/config/keychain';
import { readLicenseWire, storeLicenseWire } from '@/common/config/licenseWireAtRest';

function argOf(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? '') : '';
}

let failures = 0;
function step(name: string, ok: boolean, evidence = ''): void {
  // eslint-disable-next-line no-console
  console.log(`PROOF-STEP ${ok ? 'PASS' : 'FAIL'} :: ${name}${evidence ? ` :: ${evidence}` : ''}`);
  if (!ok) failures += 1;
}

function modeOf(file: string): string {
  return (fs.statSync(file).mode & 0o777).toString(8).padStart(3, '0');
}

function main(): void {
  const userData = argOf('userdata');
  const resources = argOf('resources');
  const flag = argOf('flag');
  if (!userData || !resources || (flag !== 'on' && flag !== 'off')) {
    throw new Error('usage: proof --userdata <dir> --resources <dir> --flag on|off');
  }

  Object.defineProperty(process, 'resourcesPath', { value: path.resolve(resources), configurable: true });

  // The ONLY stubbed edge: the OS keychain primitive, so a licence wire can be
  // seeded through the real at-rest store. Post-1.820.2 that wire — not the env
  // — is what makes a seat eligible for the paid-tool advertisement.
  setSafeStorageForTesting({
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(plain, 'utf8'),
    decryptString: (cipher: Buffer) => Buffer.from(cipher).toString('utf8'),
  });
  const wire = `CEVE.v2.${Buffer.from('proof-payload').toString('base64')}.${Buffer.from('proof-signature').toString('base64')}`;
  const wireStored = storeLicenseWire(userData, wire);
  const wireRead = readLicenseWire(userData);
  step(
    'licence wire seeded + readable via real licenseWireAtRest (seat is ELIGIBLE)',
    wireStored.ok && wireRead.ok && wireRead.wire === wire,
    `store=${wireStored.outcome} read=${wireRead.outcome}`
  );

  if (flag === 'on') {
    // Eligible seat, env UNSET: the 1.820.2 default-on posture itself is what
    // is being proven, so no opt-in value may be present.
    delete process.env.COMMAND_EVE_ENABLE_AGENT_VIDEO_EDIT;
  } else {
    // The kill-switch: exactly '0' closes even an eligible seat.
    process.env.COMMAND_EVE_ENABLE_AGENT_VIDEO_EDIT = '0';
  }

  // The exact preconditions writeHermesRuntimeFiles evaluates at
  // runtimeBootstrapCore.ts:5604-5623, printed BEFORE provisioning so a
  // no-server outcome names which gate closed.
  const managedNode = resolveCommandEveManagedNodeExecutable(process.resourcesPath);
  const scriptCandidate = getBuiltinMcpScriptPath('builtin-mcp-eve-artifacts');
  // eslint-disable-next-line no-console
  console.log(
    `PROOF-EVIDENCE preconditions :: managedNode=${managedNode || 'EMPTY'} :: scriptCandidate=${scriptCandidate} :: scriptExists=${fs.existsSync(scriptCandidate)}`
  );

  const result = provisionSeatRuntimeFiles({
    userDataPath: userData,
    resourcesPath: path.resolve(resources),
    egressProxyUrl: 'http://127.0.0.1:25811',
    seatId: null,
  });
  step('provisionSeatRuntimeFiles ok', result.ok === true, result.error ?? `hermes_home=${result.hermes_home}`);
  if (!result.ok) {
    // eslint-disable-next-line no-console
    console.log('PROOF-RESULT FAIL');
    process.exit(1);
  }

  const configFile = path.join(result.hermes_home, 'config.yaml');
  const config = fs.readFileSync(configFile, 'utf8');
  step('config.yaml mode 0600', modeOf(configFile) === '600', `mode=${modeOf(configFile)}`);

  const marker = 'mcp_servers:';
  const start = config.indexOf(marker);
  const blockLines: string[] = [];
  if (start >= 0) {
    for (const line of config.slice(start).split('\n')) {
      if (blockLines.length > 0 && /^\S/.test(line)) break;
      blockLines.push(line);
    }
  }
  const block = blockLines.join('\n');
  // eslint-disable-next-line no-console
  console.log('PROOF-EVIDENCE mcp_servers-block-begin\n' + block + '\nPROOF-EVIDENCE mcp_servers-block-end');

  const hasServer = blockLines.some((line) => line.includes('aionui-eve-artifacts'));
  step('emitted config contains aionui-eve-artifacts', hasServer);
  if (!hasServer) {
    // A valid outcome the CALLER judges: a fail-closed composition emits no
    // server at all rather than a half-configured one. Distinct marker so a
    // runner can tell "correctly absent" from "present but broken".
    // eslint-disable-next-line no-console
    console.log('PROOF-RESULT NO-SERVER-EMITTED');
    process.exit(0);
  }

  const commandLine = blockLines.find((line) => line.trim().startsWith('command:')) ?? '';
  step(
    'command is the staged managed node',
    commandLine.includes(path.join('bundled-aioncore', 'darwin-arm64', 'managed-resources', 'node')),
    commandLine.trim()
  );
  step(
    'env AIONUI_EVE_ARTIFACT_BASE_URL loopback',
    blockLines.some((line) => line.includes('AIONUI_EVE_ARTIFACT_BASE_URL": "http://127.0.0.1:25811"')),
    ''
  );

  const bearerLine = blockLines.find((line) => line.includes('AIONUI_EVE_ARTIFACT_BEARER_FILE')) ?? '';
  const bearerMatch = /AIONUI_EVE_ARTIFACT_BEARER_FILE": "([^"]+)"/.exec(bearerLine);
  const bearerFile = bearerMatch?.[1] ?? '';
  step('bearer file path absolute', path.isAbsolute(bearerFile), bearerFile);
  step(
    'bearer file exists and is 0600',
    Boolean(bearerFile) && fs.existsSync(bearerFile) && modeOf(bearerFile) === '600',
    bearerFile ? `mode=${fs.existsSync(bearerFile) ? modeOf(bearerFile) : 'missing'}` : 'missing'
  );
  step(
    'bearer secret NOT present in config.yaml',
    !config.includes(fs.existsSync(bearerFile) ? fs.readFileSync(bearerFile, 'utf8').trim() : 'impossible-sentinel'),
    'only the 0600 file PATH is emitted'
  );

  const argsLine = blockLines.find((line) => line.trim().startsWith('- ')) ?? '';
  const scriptMatch = /- "([^"]+)"/.exec(argsLine.trim());
  const scriptPath = scriptMatch?.[1] ?? '';
  step('script path absolute and exists', path.isAbsolute(scriptPath) && fs.existsSync(scriptPath), scriptPath);

  const flagKeyPresent = blockLines.some((line) => line.includes('COMMAND_EVE_ENABLE_AGENT_VIDEO_EDIT'));
  const flagLinePresent = blockLines.some((line) => line.includes('COMMAND_EVE_ENABLE_AGENT_VIDEO_EDIT": "1"'));
  if (flag === 'on') {
    step(
      'eligible seat (wire readable, env unset) emits COMMAND_EVE_ENABLE_AGENT_VIDEO_EDIT: "1" BY DEFAULT',
      flagLinePresent
    );
  } else {
    step("kill-switch '0' emits NO paid-tool env key even on an eligible seat", !flagKeyPresent);
  }

  // eslint-disable-next-line no-console
  console.log(`PROOF-RESULT ${failures === 0 ? 'PASS' : 'FAIL'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
