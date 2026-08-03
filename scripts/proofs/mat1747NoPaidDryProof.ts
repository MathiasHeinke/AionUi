/**
 * MAT-1747 PROOF 2 — bounded NO-PAID end-to-end dry harness.
 *
 * Runs the REAL chain with only the outermost edges stubbed:
 *
 *   seed artifact store (real saveVideoArtifactRecord)
 *   → licence wire at rest (real storeLicenseWire/readLicenseWire; ONLY the OS
 *     safeStorage primitive is replaced via the documented test hook
 *     setSafeStorageForTesting — stated, everything else on that path is real)
 *   → context envelope (real handleCommandEveArtifactContextEnvelope: real
 *     handle mint, real turn record, real spend-permit mint, the 1.820.2
 *     eligibility resolver asked live — the seeded wire makes this seat
 *     ELIGIBLE, so advertisement must happen with the env UNSET)
 *   → REAL loopback HTTP route (startCommandEveOllamaOpenAiShim with
 *     artifactCapabilityCallHandler wired the way index.ts wires it)
 *   → artifact_get (free) and video_edit refusals through real HTTP
 *   → the REAL built MCP child (out/main/builtin-mcp-eve-artifacts.js) as a
 *     stdio JSON-RPC peer: initialize, tools/list, tools/call
 *
 * NO provider, NO debit: globalThis.fetch is wrapped — loopback calls pass
 * through to real fetch, every non-loopback URL is recorded and refused. The
 * harness asserts at the end that zero non-loopback attempts were made.
 *
 * Bundled to CJS by scripts/proofs/run-mat1747-no-paid-dry-proof.mjs and run
 * with plain node.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { setSafeStorageForTesting } from '@/common/config/keychain';
import { readLicenseWire, storeLicenseWire } from '@/common/config/licenseWireAtRest';
import {
  artifactCapabilityCallHandler,
  provisionArtifactCapabilityBearerFile,
  resolveArtifactCapabilityBearer,
  type ArtifactCapabilityLoopbackDeps,
} from '@process/commandEve/artifactCapabilityLoopback';
import { isAgentVideoEditAdvertisingEnabled } from '@process/commandEve/agentVideoEditFlag';
import {
  buildConversationArtifactEnvelopeEntries,
  readArtifactCapabilityGrant,
} from '@process/commandEve/artifactCapabilityHandleStore';
import { areCommandEveFileSelectionPathsGranted } from '@process/commandEve/fileSelectionGrantCore';
import { startCommandEveOllamaOpenAiShim } from '@process/commandEve/ollamaOpenAiShim';
import { getActiveSeatId } from '@process/commandEve/seatContextCore';
import {
  listVideoArtifactRecords,
  saveGeneratedVideoFile,
  saveVideoArtifactRecord,
} from '@process/commandEve/videoArtifactStore';
import {
  denyVideoEditSpend,
  issueVideoEditSpendPermit,
  reinitializeVideoEditSpendStore,
  readVideoEditSpendPermitRecord,
  readVideoEditSpendStoreHealth,
  recordActiveUserTurn,
} from '@process/commandEve/videoEditSpendPermitStore';
import { readBoundedImageSource } from '@process/commandEve/document/imageIntelligenceService';
import {
  handleCommandEveArtifactContextEnvelope,
  handleCommandEveVideoEdit,
} from '@process/bridge/commandEveVideoBridge';
import type { CommandEveVideoConversationArtifact } from '@/common/config/videoGenerationRequestCore';

let failures = 0;
function step(name: string, ok: boolean, evidence = ''): void {
  // eslint-disable-next-line no-console
  console.log(`PROOF-STEP ${ok ? 'PASS' : 'FAIL'} :: ${name}${evidence ? ` :: ${evidence}` : ''}`);
  if (!ok) failures += 1;
}
function evidence(label: string, value: string): void {
  // eslint-disable-next-line no-console
  console.log(`PROOF-EVIDENCE ${label} :: ${value}`);
}

// ---- fetch boundary: loopback passes through, everything else is recorded
// and refused. This is the ONLY network edge in the whole chain.
const nonLoopbackFetchAttempts: string[] = [];
const realFetch = globalThis.fetch;
function isLoopback(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(parsed.hostname);
  } catch {
    return false;
  }
}
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (!isLoopback(url)) {
    nonLoopbackFetchAttempts.push(url);
    throw new Error(`PROOF-BLOCKED non-loopback fetch: ${url}`);
  }
  return realFetch(input, init);
}) as typeof fetch;

// The OS keychain primitive — the ONLY stubbed edge besides the network
// boundary. Documented test hook in common/config/keychain.ts; the licence
// wire file format, ref handling and well-formedness checks all run for real.
setSafeStorageForTesting({
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(plain, 'utf8'),
  decryptString: (cipher) => Buffer.from(cipher).toString('utf8'),
});

const CONVERSATION_ID = 'proof-conversation-mat1747';

function walkFiles(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, acc);
    else if (entry.isFile()) acc.push(full);
  }
  return acc;
}

interface McpChild {
  send: (message: Record<string, unknown>) => void;
  nextResponse: (id: number) => Promise<Record<string, unknown>>;
  close: () => void;
}

function spawnMcpChild(scriptPath: string, env: NodeJS.ProcessEnv): McpChild {
  const child = spawn(process.execPath, [scriptPath], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    try {
      const message = JSON.parse(line) as Record<string, unknown>;
      const id = typeof message.id === 'number' ? message.id : undefined;
      if (id !== undefined && pending.has(id)) {
        pending.get(id)?.(message);
        pending.delete(id);
      }
    } catch {
      /* non-JSON child output ignored */
    }
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  return {
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
    nextResponse: (id) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`MCP child response timeout for id=${id}; stderr=${stderr}`)),
          10000
        );
        pending.set(id, (value) => {
          clearTimeout(timer);
          resolve(value);
        });
      }),
    close: () => child.kill(),
  };
}

async function mcpRoundTrip(
  scriptPath: string,
  env: NodeJS.ProcessEnv,
  handle: string
): Promise<{ toolNames: string[]; callResult: unknown }> {
  const child = spawnMcpChild(scriptPath, env);
  try {
    child.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'mat1747-proof', version: '0.1.0' },
      },
    });
    await child.nextResponse(1);
    child.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    child.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const listResponse = await child.nextResponse(2);
    const tools = ((listResponse.result as Record<string, unknown>)?.tools ?? []) as Array<{ name: string }>;
    const toolNames = tools.map((tool) => tool.name);
    let callResult: unknown = null;
    if (handle && toolNames.includes('eve_artifact_get')) {
      child.send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'eve_artifact_get', arguments: { handle } },
      });
      const callResponse = await child.nextResponse(3);
      const content = ((callResponse.result as Record<string, unknown>)?.content ?? []) as Array<{ text?: string }>;
      callResult = content[0]?.text ? JSON.parse(content[0].text) : callResponse;
    }
    return { toolNames, callResult };
  } finally {
    child.close();
  }
}

async function postLoopback(
  baseUrl: string,
  bearerFile: string,
  body: Record<string, unknown>
): Promise<{ status: number; payload: Record<string, unknown> }> {
  const bearer = fs.readFileSync(bearerFile, 'utf8').trim();
  const response = await realFetch(`${baseUrl}/eve/artifact/call`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, payload: (await response.json()) as Record<string, unknown> };
}

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mat1747-proof2-'));
  const dataPath = path.join(tmp, 'userData');
  fs.mkdirSync(dataPath, { recursive: true });
  evidence('temp dataPath', dataPath);

  // ---- 1. seed a REAL artifact record -------------------------------------
  const mediaDir = path.join(tmp, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const clipBytes = crypto.randomBytes(4096);
  const clipPath = path.join(mediaDir, 'clip.mp4');
  fs.writeFileSync(clipPath, clipBytes, { mode: 0o600 });
  const artifact: CommandEveVideoConversationArtifact = {
    id: 'proof-artifact-0001',
    conversation_id: CONVERSATION_ID,
    kind: 'video',
    status: 'active',
    payload: {
      artifact_type: 'video',
      title: 'Video 720p',
      description: '720p · 5s · ca. 500 Credits · grok-imagine-video',
      path: clipPath,
      mime_type: 'video/mp4',
      hash: crypto.createHash('sha256').update(clipBytes).digest('hex'),
      size: clipBytes.length,
      duration_seconds: 5,
      origin_capability: 'video_generation',
      tier_id: 'fast',
    },
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  saveVideoArtifactRecord(dataPath, artifact);
  const seeded = fs.existsSync(
    path.join(dataPath, 'command-eve-video-artifacts', CONVERSATION_ID, `${artifact.id}.json`)
  );
  step('real artifact record seeded on disk', seeded);

  // ---- 2. licence wire via the REAL at-rest path ---------------------------
  const wire = `CEVE.v2.${Buffer.from('proof-payload').toString('base64')}.${Buffer.from('proof-signature').toString('base64')}`;
  const stored = storeLicenseWire(dataPath, wire);
  const readBack = readLicenseWire(dataPath);
  step(
    'licence wire stored + read back via real licenseWireAtRest (only OS safeStorage stubbed)',
    stored.ok && readBack.ok && readBack.wire === wire,
    `store=${stored.outcome} read=${readBack.outcome}`
  );

  // ---- 3. spend-store process gate (the real startup sweep) -----------------
  const health = reinitializeVideoEditSpendStore(dataPath);
  step(
    'spend store reinitialized healthy',
    health === 'healthy' && readVideoEditSpendStoreHealth() === 'healthy',
    health
  );

  // ---- 4. REAL envelope on an ELIGIBLE seat, env UNSET (the 1.820.2 default) --
  // The licence wire seeded in step 2 is what makes this seat eligible; the env
  // flag is deliberately ABSENT so what is proven is the default-on posture,
  // not an opt-in. The production dep set (productionEnvelopeDeps), with ONLY
  // getDataPath re-pointed at the temp store. Every other member is the real
  // function the main process uses — including the one eligibility resolver.
  const envelopeDeps = {
    getDataPath: () => dataPath,
    buildEntries: buildConversationArtifactEnvelopeEntries,
    issuePermit: issueVideoEditSpendPermit,
    recordActiveTurn: recordActiveUserTurn,
    denySpend: denyVideoEditSpend,
    isVideoEditEnabled: () => isAgentVideoEditAdvertisingEnabled(dataPath),
    getActiveSeatId,
    areFileSelectionPathsGranted: areCommandEveFileSelectionPathsGranted,
    readImageSource: (filePath: string) => readBoundedImageSource(filePath),
  };
  const envelopeResult = await handleCommandEveArtifactContextEnvelope(
    { conversationId: CONVERSATION_ID, userTurnText: 'Gib der Aubergine ein Gesicht.' },
    envelopeDeps
  );
  evidence('envelope (verbatim)', envelopeResult.envelope);
  const handle = /evecap_[0-9a-f]{64}/.exec(envelopeResult.envelope)?.[0] ?? '';
  const permit = /evespend_[0-9a-f]{64}/.exec(envelopeResult.envelope)?.[0] ?? '';
  step('envelope mints a capability handle (real mint)', Boolean(handle), handle ? `${handle.slice(0, 18)}…` : 'none');
  step(
    'envelope mints a spend permit on an eligible seat BY DEFAULT, env unset (real mint)',
    Boolean(permit),
    permit ? `${permit.slice(0, 20)}…` : 'none'
  );
  step(
    'envelope advertises eve_video_edit on an eligible seat BY DEFAULT',
    envelopeResult.envelope.includes('eve_video_edit')
  );
  step(
    'envelope carries no filesystem path',
    !envelopeResult.envelope.includes(clipPath) && !envelopeResult.envelope.includes(tmp)
  );

  // ---- 5. REAL loopback HTTP route, wired the way main wires it -------------
  const bearerFile = provisionArtifactCapabilityBearerFile(dataPath);
  step(
    'bearer file provisioned 0600',
    Boolean(bearerFile) && (fs.statSync(bearerFile).mode & 0o777) === 0o600,
    bearerFile
  );
  const loopbackDeps: ArtifactCapabilityLoopbackDeps = {
    getDataPath: () => dataPath,
    listArtifactRecords: listVideoArtifactRecords,
    readGrant: readArtifactCapabilityGrant,
    isVideoEditEnabled: () => isAgentVideoEditAdvertisingEnabled(dataPath),
    // Only videoEdit is re-pointed so the shared paid handler resolves THIS
    // temp dataPath. Every gate inside it (flag, store health, deny, grant,
    // permit, licence, lock, consume) is the real function, and its provider
    // fetch crosses the recording boundary above.
    videoEdit: (request) =>
      handleCommandEveVideoEdit(request, {
        getDataPath: () => dataPath,
        fetch: globalThis.fetch,
        newRequestId: () => crypto.randomUUID(),
        newArtifactId: () => crypto.randomUUID(),
        getActiveSeatId,
        areFileSelectionPathsGranted: areCommandEveFileSelectionPathsGranted,
        readImageSource: (filePath: string) => readBoundedImageSource(filePath),
        saveVideoFile: saveGeneratedVideoFile,
        saveArtifactRecord: saveVideoArtifactRecord,
      }),
  };
  const shimUrl = await startCommandEveOllamaOpenAiShim({
    port: 0,
    artifactCapabilityBearer: resolveArtifactCapabilityBearer,
    artifactCapabilityCall: (body) => artifactCapabilityCallHandler(body, loopbackDeps),
  });
  evidence('real shim listening', shimUrl);
  step('real loopback route up (same registration as index.ts)', shimUrl.startsWith('http://127.0.0.1:'));

  // 5a. artifact_get with the minted handle — free, 200, metadata only.
  const getResult = await postLoopback(shimUrl, bearerFile, { operation: 'artifact_get', handle });
  evidence('artifact_get response', JSON.stringify(getResult));
  step('artifact_get → 200 with artifact metadata', getResult.status === 200 && getResult.payload.ok === true);
  step(
    'artifact_get payload carries NO path and NO bytes',
    !JSON.stringify(getResult.payload).includes(clipPath) && !JSON.stringify(getResult.payload).includes('base64')
  );

  // 5b. wrong bearer → 404 (route fails closed).
  const wrongBearer = await realFetch(`${shimUrl}/eve/artifact/call`, {
    method: 'POST',
    headers: { Authorization: 'Bearer deadbeef', 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation: 'artifact_get', handle }),
  });
  step('wrong bearer → 404', wrongBearer.status === 404, `status=${wrongBearer.status}`);

  // ---- 6. video_edit with NO permit — machine refusal, nothing spent --------
  const noPermit = await postLoopback(shimUrl, bearerFile, {
    operation: 'video_edit',
    handle,
    permit: '',
    instruction: 'Gib der Aubergine ein Gesicht.',
  });
  evidence('video_edit(no permit) response', JSON.stringify(noPermit));
  step(
    'video_edit without permit → 400 with machine reason',
    noPermit.status === 400 &&
      typeof noPermit.payload.reason === 'string' &&
      String(noPermit.payload.reason).length > 0,
    `reason=${String(noPermit.payload.reason)}`
  );
  const permitRecord = readVideoEditSpendPermitRecord(dataPath, permit);
  evidence('minted permit record after refusal', JSON.stringify(permitRecord));
  const receiptFiles = walkFiles(dataPath).filter(
    (file) => file.endsWith('.result.json') || file.endsWith('.spent.json')
  );
  step('minted permit NOT consumed by the refused call', permitRecord !== undefined && receiptFiles.length === 0);
  step('no completion/debit receipt files anywhere in the store', receiptFiles.length === 0, receiptFiles.join(','));

  // ---- 7. video_edit with the KILL-SWITCH ('0') → 403 agent-video-edit-disabled
  // Exactly '0' closes even this eligible, wire-seeded seat — the emergency OFF
  // that requires no credential deletion.
  process.env.COMMAND_EVE_ENABLE_AGENT_VIDEO_EDIT = '0';
  const flagOff = await postLoopback(shimUrl, bearerFile, {
    operation: 'video_edit',
    handle,
    permit,
    instruction: 'Gib der Aubergine ein Gesicht.',
  });
  evidence("video_edit(kill-switch '0') response", JSON.stringify(flagOff));
  step(
    "video_edit with kill-switch '0' → 403 agent-video-edit-disabled",
    flagOff.status === 403 && flagOff.payload.reason === 'agent-video-edit-disabled'
  );

  // 7b. and the kill-switched envelope carries no spend authority at all.
  const offEnvelope = await handleCommandEveArtifactContextEnvelope(
    { conversationId: CONVERSATION_ID, userTurnText: 'Noch ein Versuch.' },
    envelopeDeps
  );
  step(
    'kill-switched envelope advertises NO paid capability and mints NO permit',
    !offEnvelope.envelope.includes('eve_video_edit') && !/evespend_/.test(offEnvelope.envelope)
  );
  delete process.env.COMMAND_EVE_ENABLE_AGENT_VIDEO_EDIT;

  // ---- 8. the REAL built MCP child over stdio --------------------------------
  const mcpScript = path.resolve(__dirname, '../../../out/main/builtin-mcp-eve-artifacts.js');
  step('built MCP child script present', fs.existsSync(mcpScript), mcpScript);
  if (fs.existsSync(mcpScript)) {
    const childEnv = {
      AIONUI_EVE_ARTIFACT_BASE_URL: shimUrl,
      AIONUI_EVE_ARTIFACT_BEARER_FILE: bearerFile,
      COMMAND_EVE_ENABLE_AGENT_VIDEO_EDIT: '1',
    };
    const onRoundTrip = await mcpRoundTrip(mcpScript, childEnv, handle);
    evidence('MCP tools/list (flag ON)', onRoundTrip.toolNames.join(','));
    evidence('MCP eve_artifact_get result', JSON.stringify(onRoundTrip.callResult));
    step(
      'MCP child (flag ON) advertises eve_artifact_get + eve_artifact_list + eve_video_edit',
      onRoundTrip.toolNames.includes('eve_artifact_get') &&
        onRoundTrip.toolNames.includes('eve_artifact_list') &&
        onRoundTrip.toolNames.includes('eve_video_edit')
    );
    step(
      'MCP tools/call eve_artifact_get → ok:true metadata (real loopback round trip)',
      (onRoundTrip.callResult as Record<string, unknown>)?.ok === true
    );

    const offRoundTrip = await mcpRoundTrip(mcpScript, { ...childEnv, COMMAND_EVE_ENABLE_AGENT_VIDEO_EDIT: '0' }, '');
    evidence('MCP tools/list (flag OFF)', offRoundTrip.toolNames.join(','));
    step(
      'MCP child (flag OFF) does NOT advertise eve_video_edit',
      !offRoundTrip.toolNames.includes('eve_video_edit') && offRoundTrip.toolNames.includes('eve_artifact_get')
    );
  }

  // ---- 9. the money boundary --------------------------------------------------
  step(
    'ZERO non-loopback fetch attempts for the entire run',
    nonLoopbackFetchAttempts.length === 0,
    nonLoopbackFetchAttempts.join(',') || 'none'
  );
  const finalReceipts = walkFiles(dataPath).filter(
    (file) => file.endsWith('.result.json') || file.endsWith('.spent.json')
  );
  step(
    'ZERO spend receipts / debit records on disk at end of run',
    finalReceipts.length === 0,
    finalReceipts.join(',') || 'none'
  );

  // eslint-disable-next-line no-console
  console.log(`PROOF-RESULT ${failures === 0 ? 'PASS' : 'FAIL'} (${failures} failed steps)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('PROOF-RESULT ERROR ::', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
