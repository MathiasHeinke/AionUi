/**
 * Command EVE ACP TTFT benchmark.
 *
 * The harness is fail-closed to a persisted `command-eve-local:*` selection.
 * It never sets a cloud lane, never supplies a provider credential and aborts
 * before the first send when local-selection truth cannot be proven.
 *
 * Example (development bundle):
 *   bunx tsx scripts/command-eve/ttft/benchmark.ts \
 *     --cohort warm_existing_session --sessions 5 \
 *     --user-data-dir /tmp/command-eve-ttft-profile --capture-only
 *
 * Example (unsigned non-distributable QA package with the baked attachment
 * marker, built via `bun run command-eve:package:e2e-attachment`):
 *   bunx tsx scripts/command-eve/ttft/benchmark.ts \
 *     --executable out/e2e-packaged/mac-arm64/Command\ EVE.app/Contents/MacOS/Command\ EVE \
 *     --app-commit <40-character-source-commit> \
 *     --cohort cold_start_chat --sessions 5 \
 *     --user-data-dir /tmp/command-eve-ttft-profile --capture-only
 *
 * Packaged runs preflight the non-distributable QA attachment marker beside
 * the runtime manifest before launch and only then supply the runtime
 * authorization flags; a production package without the marker fails fast.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import {
  EVE_LOCAL_PICKER_TIERS,
  isLocalSelection,
  localTierValue,
} from '../../../packages/desktop/src/common/config/eveInferenceCore';
import { ACP_PERFORMANCE_MARK_EVENT } from '../../../packages/desktop/src/renderer/utils/performance/acpPerformanceMarks';
import type { AcpPerformanceMark } from '../../../packages/desktop/src/renderer/utils/performance/acpPerformanceMarks';
import {
  buildCommandEveTtftReceipt,
  COMMAND_EVE_TTFT_RECEIPT_VERSION,
  COMMAND_EVE_TTFT_STAGES,
  evaluateCommandEveTtftRegression,
  summarizeCommandEveTtftMetric,
  type CommandEveTtftCohort,
  type CommandEveTtftMetricName,
  type CommandEveTtftMilestone,
  type CommandEveTtftReceipt,
  type CommandEveTtftStage,
} from './receipt-core';
import {
  buildCommandEveTtftFormalReceipt,
  isCommandEveTtftVisibleElement,
  selectCommandEveTtftAttemptBinding,
  selectCommandEveTtftProviderTurnBinding,
  selectCommandEveTtftUpstreamEvidence,
  type CommandEveTtftAttemptBinding,
  type CommandEveTtftFormalReceipt,
  type CommandEveTtftProviderTurnBindingEvidence,
  type CommandEveTtftRuntimeReadinessEvidence,
  type CommandEveTtftUpstreamEvidence,
  type CommandEveTtftVisibleElementSnapshot,
} from './formal-core';
import {
  commandEvePackagedQaLaunchEnv,
  requireCommandEvePackagedQaAttachment,
  type CommandEvePackagedQaAttachmentProof,
} from './packaged-qa-attachment';
import { resolveCommandEveTtftRuntimeRoot } from './profile-core';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');
const GUID_INPUT = '.guid-input-card-shell textarea';
const EXISTING_INPUT = '.acp-send-box textarea';
const LOCAL_SELECTION_KEY = 'commandEve.inferenceSelection';
const LOCAL_MODEL_TIER_KEY = 'commandEve.localModelTierId';
const RESPONSE_TIMEOUT_MS = 180_000;
const PAGE_EVALUATE_NAME_HELPER =
  "globalThis.__name ??= (target, value) => Object.defineProperty(target, 'name', { value, configurable: true });";
type Args = {
  cohort: CommandEveTtftCohort;
  sessions: number;
  executablePath: string | null;
  userDataDir: string;
  outputPath: string | null;
  baselinePath: string | null;
  captureOnly: boolean;
  prompt: string;
  tts: boolean;
  prepareLocalDefault: boolean;
  appCommitOverride: string | null;
};

type ArtifactTruth = {
  releaseVersion: string;
  hermesVersion: string;
  appCommit: string;
  appCommitSource: CommandEveTtftReceipt['appCommitSource'];
  manifestPath: string;
  launchedAppVersion: string;
  packagedQaAttachment: CommandEvePackagedQaAttachmentProof | null;
};

type AppHandle = {
  app: ElectronApplication;
  page: Page;
  appProcessStartedAt: number;
  rendererUsableAt: number;
  logPath: string;
  launchLogOffset: number;
  artifactTruth: ArtifactTruth;
};

type RendererCollector = {
  marks: AcpPerformanceMark[];
  firstVisibleAt: number | null;
  firstVisibleMessageId: string | null;
  firstVisibleSnapshot: CommandEveTtftVisibleElementSnapshot | null;
  measuredConversationId: string | null;
  measuredTurnId: string | null;
};

type MeasuredReceipt = CommandEveTtftReceipt & { formal: CommandEveTtftFormalReceipt };

type LocalOnlyProof = {
  activeSeatId: string;
  selection: string;
  settingsKey: string;
};

type SuiteReport = {
  version: 'command-eve-ttft-suite/v2';
  generatedAt: string;
  cohort: CommandEveTtftCohort;
  sessionsRequested: number;
  executionMode: 'development' | 'packaged';
  executablePath: string | null;
  userDataDir: string;
  inputMode: 'typed';
  nativeVoiceE2eCovered: false;
  promptTemplateSha256: string;
  ttsPlaybackRequested: boolean;
  artifactTruth: ArtifactTruth;
  localOnlyProof: LocalOnlyProof;
  requiredStages: CommandEveTtftStage[];
  missingRequiredStages: Array<{ iteration: number; stages: CommandEveTtftStage[] }>;
  summaries: Record<CommandEveTtftMetricName, ReturnType<typeof summarizeCommandEveTtftMetric>>;
  baselineImport: {
    path: string | null;
    imported: number;
    compatible: number;
    rejected: number;
  };
  regressionOutcome: 'PASS' | 'FAIL' | 'INSUFFICIENT_EVIDENCE' | 'CAPTURE_ONLY';
  formalOutcome: 'PASS' | 'INSUFFICIENT_EVIDENCE';
  suiteOutcome: 'PASS' | 'FAIL' | 'INSUFFICIENT_EVIDENCE' | 'CAPTURE_ONLY';
  regressionGates: ReturnType<typeof evaluateCommandEveTtftRegression>[];
  receipts: MeasuredReceipt[];
};

function parseArgs(argv = process.argv.slice(2)): Args {
  let cohort: CommandEveTtftCohort = 'warm_existing_session';
  let sessions = 5;
  let executablePath: string | null = null;
  let userDataDir = '';
  let outputPath: string | null = null;
  let baselinePath: string | null = null;
  let captureOnly = false;
  let prompt = 'Antworte nur mit dem Wort bereit.';
  let tts = false;
  let prepareLocalDefault = false;
  let appCommitOverride: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (flag === '--cohort' && next) {
      if (!['cold_start_chat', 'warm_start_chat', 'warm_existing_session'].includes(next)) {
        throw new Error(`Unsupported cohort: ${next}`);
      }
      cohort = next as CommandEveTtftCohort;
      index += 1;
    } else if (flag === '--sessions' && next) {
      sessions = Number.parseInt(next, 10);
      index += 1;
    } else if (flag === '--executable' && next) {
      executablePath = path.resolve(next);
      index += 1;
    } else if (flag === '--user-data-dir' && next) {
      userDataDir = path.resolve(next);
      index += 1;
    } else if (flag === '--output' && next) {
      outputPath = path.resolve(next);
      index += 1;
    } else if (flag === '--baseline' && next) {
      baselinePath = path.resolve(next);
      index += 1;
    } else if (flag === '--prompt' && next) {
      prompt = next;
      index += 1;
    } else if (flag === '--tts') {
      tts = true;
    } else if (flag === '--voice') {
      throw new Error(
        '--voice is not a native voice E2E; use --tts for typed-turn TTS timing and the dedicated Electron voice E2E for mic/STT'
      );
    } else if (flag === '--capture-only') {
      captureOnly = true;
    } else if (flag === '--prepare-local-default') {
      prepareLocalDefault = true;
    } else if (flag === '--app-commit' && next) {
      appCommitOverride = next.trim();
      index += 1;
    }
  }

  if (!Number.isFinite(sessions) || sessions < 1) throw new Error('--sessions must be a positive integer');
  if (!userDataDir) {
    throw new Error('--user-data-dir is required so the benchmark never mutates the operator profile');
  }
  if (executablePath && !fs.existsSync(executablePath)) {
    throw new Error(`Packaged executable not found: ${executablePath}`);
  }
  if (executablePath && !/^[0-9a-f]{40}$/i.test(appCommitOverride ?? '')) {
    throw new Error('--app-commit with the exact 40-character packaged source commit is required');
  }
  if (Boolean(baselinePath) === captureOnly) {
    throw new Error('Choose exactly one measurement mode: --baseline <receipt> or --capture-only');
  }
  assertSafeUserDataDir(userDataDir);
  return {
    cohort,
    sessions,
    executablePath,
    userDataDir,
    outputPath,
    baselinePath,
    captureOnly,
    prompt,
    tts,
    prepareLocalDefault,
    appCommitOverride,
  };
}

function assertSafeUserDataDir(userDataDir: string): void {
  const liveRoots = ['Command EVE', 'Command EVE-dev', 'Command EVE-dev-2', 'AionUi', 'AionUi-Dev'].map((name) =>
    path.resolve(os.homedir(), 'Library', 'Application Support', name)
  );
  const unsafe = liveRoots.find((root) => {
    const relative = path.relative(root, userDataDir);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
  if (unsafe) {
    throw new Error(`Refusing live operator profile as --user-data-dir: ${unsafe}`);
  }
}

function resolveLogPath(userDataDir: string): string {
  return path.join(userDataDir, 'command-eve-ttft-runtime.log');
}

function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function readFromOffset(filePath: string, offset: number): string[] {
  try {
    const currentSize = fs.statSync(filePath).size;
    if (currentSize <= offset) return [];
    const descriptor = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(currentSize - offset);
    fs.readSync(descriptor, buffer, 0, buffer.length, offset);
    fs.closeSync(descriptor);
    return buffer.toString('utf8').split('\n');
  } catch {
    return [];
  }
}

function logTimestamp(line: string): number | null {
  const match = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\]/.exec(line);
  if (!match) return null;
  const parsed = Date.parse(match[1].replace(' ', 'T'));
  return Number.isFinite(parsed) ? parsed : null;
}

function runtimeMilestone(
  lines: string[],
  pattern: RegExp,
  evidence: string,
  bounds?: { notBefore?: number; notAfter?: number }
): CommandEveTtftMilestone {
  const line = lines.find((candidate) => {
    if (!pattern.test(candidate)) return false;
    const timestamp = logTimestamp(candidate);
    if (timestamp === null) return false;
    if (bounds?.notBefore !== undefined && timestamp < bounds.notBefore) return false;
    if (bounds?.notAfter !== undefined && timestamp > bounds.notAfter) return false;
    return true;
  });
  const atEpochMs = line ? logTimestamp(line) : null;
  return atEpochMs === null
    ? { status: 'unavailable', reason: `${evidence} log line was not observed with a timestamp` }
    : { status: 'observed', atEpochMs, source: 'runtime_log', evidence };
}

function preferObservedMilestone(
  primary: CommandEveTtftMilestone,
  fallback: () => CommandEveTtftMilestone
): CommandEveTtftMilestone {
  return primary.status === 'observed' ? primary : fallback();
}

function exactRuntimeReadinessEvidence(
  lines: string[],
  conversationId: string,
  turnId: string,
  notAfterEpochMs: number
): CommandEveTtftRuntimeReadinessEvidence | null {
  const matchingTimestamp = (pattern: RegExp, requireTurn: boolean): number | null => {
    const matches = lines.filter((line) => {
      const timestamp = logTimestamp(line);
      return (
        timestamp !== null &&
        timestamp <= notAfterEpochMs &&
        pattern.test(line) &&
        line.includes(conversationId) &&
        (!requireTurn || line.includes(turnId))
      );
    });
    return matches.length > 0 ? logTimestamp(matches.at(-1) as string) : null;
  };
  const taskReadyAtEpochMs = matchingTimestamp(/Agent task ready/, true);
  const hermesSessionReadyAtEpochMs = matchingTimestamp(/ACP session warmed up/, false);
  if (taskReadyAtEpochMs === null || hermesSessionReadyAtEpochMs === null) return null;
  return {
    conversationId,
    turnId,
    taskReadyAtEpochMs,
    hermesSessionReadyAtEpochMs,
  };
}

function uniqueUpstreamEvidence(
  lines: string[],
  binding: CommandEveTtftProviderTurnBindingEvidence | null,
  notBeforeEpochMs: number,
  notAfterEpochMs: number
): { evidence: CommandEveTtftUpstreamEvidence | null; violations: string[] } {
  return selectCommandEveTtftUpstreamEvidence({ lines, binding, notBeforeEpochMs, notAfterEpochMs });
}

function observed(
  atEpochMs: number,
  source: Extract<CommandEveTtftMilestone, { status: 'observed' }>['source'],
  evidence: string
): CommandEveTtftMilestone {
  return { status: 'observed', atEpochMs, source, evidence };
}

function rendererMark(
  marks: AcpPerformanceMark[],
  stage: AcpPerformanceMark['stage'],
  options: { notBefore?: number; turnId?: string | null } = {}
): CommandEveTtftMilestone {
  const mark = marks.find(
    (candidate) =>
      candidate.stage === stage &&
      (options.notBefore === undefined || candidate.atEpochMs >= options.notBefore) &&
      (options.turnId === undefined || (Boolean(options.turnId) && candidate.turnId === options.turnId))
  );
  return mark
    ? observed(mark.atEpochMs, 'renderer_event', `content-free ${stage} event`)
    : { status: 'unavailable', reason: `renderer did not emit ${stage}` };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function resolveMainWindow(app: ElectronApplication): Promise<Page> {
  const existing = app.windows().find((window) => !window.url().startsWith('devtools://'));
  if (existing) {
    await existing.waitForLoadState('domcontentloaded');
    return existing;
  }
  const window = await app.waitForEvent('window', { timeout: 60_000 });
  await window.waitForLoadState('domcontentloaded');
  return window;
}

async function installPageEvaluateNameHelper(page: Page): Promise<void> {
  // tsx preserves nested function names with a module-scoped __name helper.
  // Playwright serializes evaluate bodies without that module scope.
  await page.addInitScript({ content: PAGE_EVALUATE_NAME_HELPER });
  await page.evaluate(PAGE_EVALUATE_NAME_HELPER);
}

async function navigateToGuid(page: Page): Promise<number> {
  if (!page.url().includes('#/guid')) {
    await page.evaluate(() => window.location.assign('#/guid'));
  }
  await page.locator(GUID_INPUT).waitFor({ state: 'visible', timeout: 60_000 });
  return Date.now();
}

async function launchApp(args: Args): Promise<AppHandle> {
  fs.mkdirSync(args.userDataDir, { recursive: true });
  const packaged = Boolean(args.executablePath);
  const logPath = resolveLogPath(args.userDataDir);
  const launchLogOffset = fileSize(logPath);
  // Fail fast before electron.launch: Playwright attaches to a packaged app
  // through Node --inspect and Chromium remote-debugging switches that the
  // production CDP policy strips unless the baked QA marker is present beside
  // the runtime manifest. Without this preflight a missing marker surfaces
  // only as a launch timeout with no measurement evidence.
  const manifestPath = resolveArtifactManifestPath(args);
  const packagedQaAttachment = packaged ? requireCommandEvePackagedQaAttachment(manifestPath) : null;
  const appProcessStartedAt = Date.now();
  const commonEnv = {
    ...process.env,
    ...commandEvePackagedQaLaunchEnv(packaged),
    ACP_PERF: '1',
    AIONUI_DISABLE_AUTO_UPDATE: '1',
    AIONUI_DISABLE_DEVTOOLS: '1',
    AIONUI_MULTI_INSTANCE: '1',
    AIONUI_CDP_PORT: '0',
    COMMAND_EVE_REGISTRATION_REQUIRED: '0',
    COMMAND_EVE_BENCHMARK_LOG_PATH: logPath,
    NODE_ENV: packaged ? 'production' : 'development',
  };
  const userDataArg = `--user-data-dir=${args.userDataDir}`;
  const app = await electron.launch(
    packaged
      ? {
          executablePath: args.executablePath as string,
          args: [userDataArg, '--use-mock-keychain'],
          cwd: PROJECT_ROOT,
          env: commonEnv,
          timeout: 90_000,
        }
      : {
          args: ['.', userDataArg],
          cwd: PROJECT_ROOT,
          env: commonEnv,
          timeout: 90_000,
        }
  );
  try {
    // Packaged Electron can collect Playwright's initial main-process evaluate
    // promise while startup is still creating the first renderer. Attach to the
    // loaded window first; measurement timestamps below remain unchanged.
    const page = await resolveMainWindow(app);
    await installPageEvaluateNameHelper(page);
    const launchedAppVersion = await app.evaluate(({ app: electronApp }) => electronApp.getVersion());
    const artifactTruth = releaseTruth(args, launchedAppVersion, manifestPath, packagedQaAttachment);
    const rendererUsableAt = await navigateToGuid(page);
    if (args.tts) {
      await page.evaluate(() => {
        window.localStorage.setItem('command-eve.voice-dialogue.enabled', 'true');
        window.dispatchEvent(new Event('command-eve:voice-dialogue-preference'));
      });
    }
    return { app, page, appProcessStartedAt, rendererUsableAt, logPath, launchLogOffset, artifactTruth };
  } catch (error) {
    await app.close().catch((): undefined => undefined);
    throw error;
  }
}

async function invokeBridge<T>(page: Page, key: string, data?: unknown, timeoutMs = 10_000): Promise<T> {
  return page.evaluate(
    async ({ requestKey, requestData, requestTimeoutMs }) => {
      const api = (window as unknown as { electronAPI?: { emit?: Function; on?: Function } }).electronAPI;
      if (!api?.emit || !api?.on) throw new Error('electronAPI bridge unavailable');
      const id = `${requestKey}${Math.floor(Math.random() * 0x1_0000_0000)
        .toString(16)
        .padStart(8, '0')}`;
      const callbackName = `subscribe.callback-${requestKey}${id}`;
      return new Promise<unknown>((resolve, reject) => {
        let settled = false;
        const off = api.on?.((payload: { value: unknown }) => {
          const raw = payload?.value;
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw as { name?: string; data?: unknown });
          if (parsed?.name !== callbackName || settled) return;
          settled = true;
          off?.();
          window.clearTimeout(timer);
          resolve(parsed.data);
        });
        const timer = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          off?.();
          reject(new Error(`Bridge timeout: ${requestKey}`));
        }, requestTimeoutMs);
        api.emit?.(`subscribe-${requestKey}`, { id, data: requestData });
      });
    },
    { requestKey: key, requestData: data, requestTimeoutMs: timeoutMs }
  ) as Promise<T>;
}

async function assertLocalOnly(page: Page): Promise<LocalOnlyProof> {
  const activeSeat = await invokeBridge<{
    success?: boolean;
    data?: { ok?: boolean; seat_id?: string };
  }>(page, 'command-eve.active-seat');
  const activeSeatId = activeSeat.data?.seat_id;
  if (!activeSeat.success || !activeSeat.data?.ok || !activeSeatId) {
    throw new Error('BLOCKED_LOCAL_ONLY: active seat could not be proven before send');
  }

  const settings = await page.evaluate(async (): Promise<Record<string, unknown>> => {
    const runtimeWindow = window as Window & {
      __backendPort?: number;
      __aionBackend?: { getPort?: () => number };
    };
    const port = runtimeWindow.__aionBackend?.getPort?.() ?? runtimeWindow.__backendPort;
    if (!port) throw new Error('backend port unavailable');
    const response = await fetch(`http://127.0.0.1:${port}/api/settings/client`);
    if (!response.ok) throw new Error(`settings read failed: ${response.status}`);
    const payload = (await response.json()) as Record<string, unknown>;
    const data = payload.data;
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : payload;
  });
  const settingsKey = activeSeatId === 'seat-1' ? LOCAL_SELECTION_KEY : `seat:${activeSeatId}:${LOCAL_SELECTION_KEY}`;
  const selection = settings[settingsKey];
  if (typeof selection !== 'string' || !isLocalSelection(selection)) {
    throw new Error(`BLOCKED_LOCAL_ONLY: ${settingsKey} is not a command-eve-local selection; no request was sent`);
  }
  return { activeSeatId, selection, settingsKey };
}

async function prepareManifestLocalDefault(page: Page, manifestPath: string): Promise<void> {
  const activeSeat = await invokeBridge<{
    success?: boolean;
    data?: { ok?: boolean; seat_id?: string };
  }>(page, 'command-eve.active-seat');
  const activeSeatId = activeSeat.data?.seat_id;
  if (!activeSeat.success || !activeSeat.data?.ok || !activeSeatId) {
    throw new Error('BLOCKED_LOCAL_ONLY: cannot prepare local default without active-seat proof');
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    local_runtime?: { default_tier_id?: string };
  };
  const tierId = manifest.local_runtime?.default_tier_id;
  if (!tierId) throw new Error('BLOCKED_LOCAL_ONLY: runtime manifest has no local default tier');
  const pickerTier = EVE_LOCAL_PICKER_TIERS.find((tier) => tier.localTierId === tierId);
  if (!pickerTier) {
    throw new Error(`BLOCKED_LOCAL_ONLY: runtime manifest default tier ${tierId} has no product picker mapping`);
  }
  const selection = localTierValue(pickerTier.id);
  if (!isLocalSelection(selection)) throw new Error('BLOCKED_LOCAL_ONLY: manifest local selection is invalid');
  const settingsKey = activeSeatId === 'seat-1' ? LOCAL_SELECTION_KEY : `seat:${activeSeatId}:${LOCAL_SELECTION_KEY}`;
  await page.evaluate(
    async ({ selectionKey, selectionValue, tierKey, tierValue }) => {
      const runtimeWindow = window as Window & {
        __backendPort?: number;
        __aionBackend?: { getPort?: () => number };
      };
      const port = runtimeWindow.__aionBackend?.getPort?.() ?? runtimeWindow.__backendPort;
      if (!port) throw new Error('backend port unavailable');
      const response = await fetch(`http://127.0.0.1:${port}/api/settings/client`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // Mirror Settings → Modell exactly: the install-global tier drives
        // bootstrap/ACP model selection, while the seat-scoped picker value
        // activates the private lane. Writing only one key measures a state the
        // product UI never creates.
        body: JSON.stringify({ [tierKey]: tierValue, [selectionKey]: selectionValue }),
      });
      if (!response.ok) throw new Error(`local-selection write failed: ${response.status}`);
    },
    {
      selectionKey: settingsKey,
      selectionValue: selection,
      tierKey: LOCAL_MODEL_TIER_KEY,
      tierValue: tierId,
    }
  );
}

async function resetRendererCollector(page: Page): Promise<void> {
  await page.evaluate((eventName) => {
    type CollectorWindow = Window & {
      __commandEveTtftCleanup?: () => void;
      __commandEveTtftMarks?: AcpPerformanceMark[];
      __commandEveTtftFirstVisibleAt?: number | null;
      __commandEveTtftFirstVisibleMessageId?: string | null;
      __commandEveTtftFirstVisibleSnapshot?: CommandEveTtftVisibleElementSnapshot | null;
      __commandEveTtftMeasuredConversationId?: string | null;
      __commandEveTtftMeasuredTurnId?: string | null;
      __commandEveTtftTargetMessageId?: string | null;
      __commandEveTtftNotBefore?: number | null;
      __commandEveTtftObserveVisibleReply?: () => void;
    };
    const state = window as CollectorWindow;
    state.__commandEveTtftCleanup?.();
    state.__commandEveTtftMarks = [];
    state.__commandEveTtftFirstVisibleAt = null;
    state.__commandEveTtftFirstVisibleMessageId = null;
    state.__commandEveTtftFirstVisibleSnapshot = null;
    state.__commandEveTtftMeasuredConversationId = null;
    state.__commandEveTtftMeasuredTurnId = null;
    state.__commandEveTtftTargetMessageId = null;
    state.__commandEveTtftNotBefore = null;
    let visibleFramePending = false;
    const baselineMessageIds = new Set(
      Array.from(document.querySelectorAll<HTMLElement>('[data-stream-message-id]'))
        .map((element) => element.dataset.streamMessageId)
        .filter((value): value is string => Boolean(value))
    );
    const visibleStreamMessageSnapshot = (
      element: HTMLElement,
      expectedMessageId: string
    ): CommandEveTtftVisibleElementSnapshot => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        connected: element.isConnected,
        documentVisible: document.visibilityState === 'visible',
        messageId: element.dataset.streamMessageId ?? null,
        expectedMessageId,
        hasText: Boolean(element.textContent?.trim()),
        display: style.display,
        visibility: style.visibility,
        opacity: Number.parseFloat(style.opacity || '1'),
        width: rect.width,
        height: rect.height,
      };
    };
    const isVisibleStreamMessage = (snapshot: CommandEveTtftVisibleElementSnapshot): boolean => {
      return (
        snapshot.connected &&
        snapshot.documentVisible &&
        snapshot.messageId === snapshot.expectedMessageId &&
        snapshot.hasText &&
        snapshot.display !== 'none' &&
        snapshot.visibility !== 'hidden' &&
        snapshot.opacity > 0 &&
        snapshot.width > 0 &&
        snapshot.height > 0
      );
    };
    const observeVisibleReply = () => {
      if (state.__commandEveTtftFirstVisibleAt !== null || visibleFramePending) return;
      const targetMessageId = state.__commandEveTtftTargetMessageId;
      if (!targetMessageId || baselineMessageIds.has(targetMessageId)) return;
      const fresh = Array.from(document.querySelectorAll<HTMLElement>('[data-stream-message-id]')).find(
        (element) => element.dataset.streamMessageId === targetMessageId && Boolean(element.textContent?.trim())
      );
      if (!fresh) return;
      if (!isVisibleStreamMessage(visibleStreamMessageSnapshot(fresh, targetMessageId))) return;
      visibleFramePending = true;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          visibleFramePending = false;
          const secondFrameSnapshot =
            typeof state.__commandEveTtftTargetMessageId === 'string'
              ? visibleStreamMessageSnapshot(fresh, state.__commandEveTtftTargetMessageId)
              : null;
          if (
            state.__commandEveTtftFirstVisibleAt === null &&
            secondFrameSnapshot &&
            isVisibleStreamMessage(secondFrameSnapshot)
          ) {
            state.__commandEveTtftFirstVisibleAt = Date.now();
            state.__commandEveTtftFirstVisibleMessageId = fresh.dataset.streamMessageId ?? null;
            state.__commandEveTtftFirstVisibleSnapshot = secondFrameSnapshot;
          }
        });
      });
    };
    state.__commandEveTtftObserveVisibleReply = observeVisibleReply;
    const markListener = (event: Event) => {
      const detail = (event as CustomEvent<AcpPerformanceMark>).detail;
      if (detail?.version !== 'command-eve-acp-performance-mark/v1') return;
      state.__commandEveTtftMarks?.push(detail);
      const notBefore = state.__commandEveTtftNotBefore;
      if (typeof notBefore !== 'number' || detail.atEpochMs < notBefore) return;
      if (
        detail.stage === 'first_output_state' &&
        detail.conversationId === state.__commandEveTtftMeasuredConversationId &&
        detail.turnId === state.__commandEveTtftMeasuredTurnId &&
        detail.messageId
      ) {
        state.__commandEveTtftTargetMessageId = detail.messageId;
        observeVisibleReply();
      }
    };
    const observer = new MutationObserver(observeVisibleReply);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden'],
      childList: true,
      characterData: true,
      subtree: true,
    });
    window.addEventListener(eventName, markListener);
    state.__commandEveTtftCleanup = () => {
      observer.disconnect();
      window.removeEventListener(eventName, markListener);
      delete state.__commandEveTtftObserveVisibleReply;
    };
  }, ACP_PERFORMANCE_MARK_EVENT);
}

async function armRendererCollector(page: Page, notBeforeEpochMs: number): Promise<void> {
  await page.evaluate((notBefore) => {
    const state = window as Window & {
      __commandEveTtftNotBefore?: number | null;
      __commandEveTtftMeasuredConversationId?: string | null;
      __commandEveTtftMeasuredTurnId?: string | null;
      __commandEveTtftTargetMessageId?: string | null;
    };
    state.__commandEveTtftNotBefore = notBefore;
    state.__commandEveTtftMeasuredConversationId = null;
    state.__commandEveTtftMeasuredTurnId = null;
    state.__commandEveTtftTargetMessageId = null;
  }, notBeforeEpochMs);
}

async function readRendererCollector(page: Page): Promise<RendererCollector> {
  return page.evaluate(() => {
    const state = window as Window & {
      __commandEveTtftMarks?: AcpPerformanceMark[];
      __commandEveTtftFirstVisibleAt?: number | null;
      __commandEveTtftFirstVisibleMessageId?: string | null;
      __commandEveTtftFirstVisibleSnapshot?: CommandEveTtftVisibleElementSnapshot | null;
      __commandEveTtftMeasuredConversationId?: string | null;
      __commandEveTtftMeasuredTurnId?: string | null;
    };
    return {
      marks: state.__commandEveTtftMarks ?? [],
      firstVisibleAt: state.__commandEveTtftFirstVisibleAt ?? null,
      firstVisibleMessageId: state.__commandEveTtftFirstVisibleMessageId ?? null,
      firstVisibleSnapshot: state.__commandEveTtftFirstVisibleSnapshot ?? null,
      measuredConversationId: state.__commandEveTtftMeasuredConversationId ?? null,
      measuredTurnId: state.__commandEveTtftMeasuredTurnId ?? null,
    };
  });
}

async function waitForExactTurnAdmission(
  page: Page,
  expectedConversationId: string,
  notBeforeEpochMs: number
): Promise<CommandEveTtftAttemptBinding> {
  await page.waitForFunction(
    ({ conversationId, notBefore }) => {
      const marks = (window as Window & { __commandEveTtftMarks?: AcpPerformanceMark[] }).__commandEveTtftMarks ?? [];
      return marks.some(
        (admission) =>
          admission.stage === 'turn_admitted' &&
          admission.conversationId === conversationId &&
          marks.some(
            (submit) =>
              submit.stage === 'submit_started' &&
              submit.conversationId === conversationId &&
              submit.atEpochMs >= notBefore &&
              submit.attemptId === admission.attemptId &&
              submit.seatGeneration === admission.seatGeneration
          )
      );
    },
    { conversationId: expectedConversationId, notBefore: notBeforeEpochMs },
    { timeout: RESPONSE_TIMEOUT_MS }
  );
  const collector = await readRendererCollector(page);
  const selection = selectCommandEveTtftAttemptBinding({
    marks: collector.marks,
    expectedConversationId,
    notBeforeEpochMs,
  });
  if (!selection.binding) {
    throw new Error(`exact TTFT submit/admission binding failed: ${selection.violations.join('; ')}`);
  }
  await page.evaluate((binding) => {
    const state = window as Window & {
      __commandEveTtftMarks?: AcpPerformanceMark[];
      __commandEveTtftMeasuredConversationId?: string | null;
      __commandEveTtftMeasuredTurnId?: string | null;
      __commandEveTtftTargetMessageId?: string | null;
      __commandEveTtftObserveVisibleReply?: () => void;
    };
    state.__commandEveTtftMeasuredConversationId = binding.conversationId;
    state.__commandEveTtftMeasuredTurnId = binding.turnId;
    const firstOutput = (state.__commandEveTtftMarks ?? []).find(
      (mark) =>
        mark.stage === 'first_output_state' &&
        mark.conversationId === binding.conversationId &&
        mark.turnId === binding.turnId &&
        Boolean(mark.messageId)
    );
    if (firstOutput?.messageId) state.__commandEveTtftTargetMessageId = firstOutput.messageId;
    state.__commandEveTtftObserveVisibleReply?.();
  }, selection.binding);
  return selection.binding;
}

async function waitForTerminalMark(page: Page, turnId: string): Promise<void> {
  await page.waitForFunction(
    (expectedTurnId) =>
      ((window as Window & { __commandEveTtftMarks?: AcpPerformanceMark[] }).__commandEveTtftMarks ?? []).some(
        (mark) => mark.stage === 'response_finished' && mark.turnId === expectedTurnId
      ),
    turnId,
    { timeout: RESPONSE_TIMEOUT_MS }
  );
  await page.waitForFunction(
    () =>
      (window as Window & { __commandEveTtftFirstVisibleAt?: number | null }).__commandEveTtftFirstVisibleAt != null,
    undefined,
    { timeout: 10_000 }
  );
}

function gitArtifactIdentity(): string {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim();
    return dirty ? `${commit}+dirty` : commit;
  } catch {
    return 'unknown';
  }
}

function resolveArtifactManifestPath(args: Args): string {
  if (!args.executablePath) {
    return path.join(PROJECT_ROOT, 'public/command-eve-runtime-bootstrap.json');
  }
  const executableDir = path.dirname(args.executablePath);
  const candidates = [
    path.resolve(executableDir, '..', 'Resources', 'command-eve-runtime-bootstrap.json'),
    path.resolve(executableDir, 'resources', 'command-eve-runtime-bootstrap.json'),
    path.resolve(executableDir, '..', 'resources', 'command-eve-runtime-bootstrap.json'),
  ];
  const manifestPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!manifestPath) {
    throw new Error('Packaged runtime manifest not found beside the measured executable');
  }
  return manifestPath;
}

function releaseTruth(
  args: Args,
  launchedAppVersion: string,
  manifestPath: string,
  packagedQaAttachment: CommandEvePackagedQaAttachmentProof | null
): ArtifactTruth {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    hermes?: { version?: string };
    release?: string;
  };
  const releaseVersion = manifest.release;
  const hermesVersion = manifest.hermes?.version;
  if (!releaseVersion || !hermesVersion) {
    throw new Error(`Runtime manifest is missing release/Hermes truth: ${manifestPath}`);
  }
  if (launchedAppVersion !== releaseVersion) {
    throw new Error(
      `Artifact version mismatch: launched app=${launchedAppVersion}, runtime manifest=${releaseVersion}`
    );
  }
  return {
    releaseVersion,
    hermesVersion,
    appCommit: args.appCommitOverride ?? gitArtifactIdentity(),
    appCommitSource: args.executablePath ? 'packaged_cli_assertion' : 'development_git_head',
    manifestPath,
    launchedAppVersion,
    packagedQaAttachment,
  };
}

async function runMeasuredTurn(input: {
  args: Args;
  handle: AppHandle;
  iteration: number;
  surface: 'start_chat' | 'existing_session';
  includeColdMilestones: boolean;
  logOffset?: number;
  localOnlyProof: LocalOnlyProof;
  sessionReadiness?: Partial<
    Pick<CommandEveTtftReceipt['milestones'], 'hermes_spawned' | 'hermes_ready' | 'acp_session_ready'>
  >;
}): Promise<MeasuredReceipt> {
  const { page } = input.handle;
  if (input.surface === 'start_chat') {
    await navigateToGuid(page);
  } else {
    await page.locator(EXISTING_INPUT).waitFor({ state: 'visible', timeout: 30_000 });
  }
  const logOffset = input.logOffset ?? fileSize(input.handle.logPath);
  const runtimeRoot = resolveCommandEveTtftRuntimeRoot(input.args.userDataDir);
  const upstreamHistoryPath = path.join(runtimeRoot, 'upstream-outcome-history.jsonl');
  const upstreamHistoryOffset = fileSize(upstreamHistoryPath);
  const providerTurnBindingHistoryPath = path.join(runtimeRoot, 'provider-turn-binding-history.jsonl');
  const providerTurnBindingHistoryOffset = fileSize(providerTurnBindingHistoryPath);
  await resetRendererCollector(page);
  const textarea = page.locator(input.surface === 'start_chat' ? GUID_INPUT : EXISTING_INPUT).last();
  const measuredPrompt = `${input.args.prompt} [${input.iteration}]`;
  await textarea.fill(measuredPrompt);
  let measuredConversationId = input.surface === 'existing_session' ? windowConversationId(page.url()) : null;
  const sendActionAt = Date.now();
  await armRendererCollector(page, sendActionAt);
  await textarea.press('Enter');
  if (input.surface === 'start_chat') {
    await page.waitForFunction(() => window.location.hash.includes('/conversation/'), undefined, {
      timeout: RESPONSE_TIMEOUT_MS,
    });
    measuredConversationId = windowConversationId(page.url());
  }
  if (!measuredConversationId) throw new Error('measured composer conversation id is unavailable');
  const attemptBinding = await waitForExactTurnAdmission(page, measuredConversationId, sendActionAt);
  const measuredTurnId = attemptBinding.turnId;
  await waitForTerminalMark(page, measuredTurnId);
  if (input.args.tts) {
    await page
      .waitForFunction(
        () =>
          ((window as Window & { __commandEveTtftMarks?: AcpPerformanceMark[] }).__commandEveTtftMarks ?? []).some(
            (mark) => mark.stage === 'tts_playback_started'
          ),
        undefined,
        { timeout: 5_000 }
      )
      .catch((): undefined => undefined);
  }
  const collector = await readRendererCollector(page);
  const firstVisibleVerified =
    collector.firstVisibleSnapshot !== null && isCommandEveTtftVisibleElement(collector.firstVisibleSnapshot);
  const logLines = readFromOffset(input.handle.logPath, logOffset);
  const terminalAtEpochMs = collector.marks.find(
    (mark) => mark.stage === 'response_finished' && mark.turnId === measuredTurnId
  )?.atEpochMs;
  const requestAccepted = rendererMark(collector.marks, 'request_accepted', { turnId: measuredTurnId });
  const requestAcceptedAt = requestAccepted.status === 'observed' ? requestAccepted.atEpochMs : sendActionAt;
  const milestones: Partial<Record<CommandEveTtftStage, CommandEveTtftMilestone>> = {
    app_process_started: input.includeColdMilestones
      ? observed(
          input.handle.appProcessStartedAt,
          'harness',
          'harness invoked electron.launch (deterministic cold-start boundary)'
        )
      : { status: 'unavailable', reason: 'warm cohort does not claim cold app startup' },
    renderer_usable: input.includeColdMilestones
      ? observed(input.handle.rendererUsableAt, 'harness', 'start-chat textarea became visible')
      : { status: 'unavailable', reason: 'warm cohort does not claim cold renderer startup' },
    hermes_spawned:
      input.sessionReadiness?.hermes_spawned ??
      runtimeMilestone(
        logLines,
        /\[ACP-PERF\].*process spawned|CLI process spawned \(SDK mode\).*command=program=.*\/hermes(?:\s|")/,
        'Hermes process spawned'
      ),
    hermes_ready:
      input.sessionReadiness?.hermes_ready ??
      runtimeMilestone(
        logLines,
        /\[ACP-PERF\] connect: protocol initialized|\[ACP\] <- \$initialize direction="agent_response" method="initialize"/,
        'Hermes ACP protocol initialized'
      ),
    acp_session_ready:
      input.sessionReadiness?.acp_session_ready ??
      preferObservedMilestone(rendererMark(collector.marks, 'acp_session_ready', { notBefore: sendActionAt }), () =>
        runtimeMilestone(logLines, /ACP session warmed up/, 'AionCore ACP session warmed up', {
          notBefore: sendActionAt,
          notAfter: requestAcceptedAt,
        })
      ),
    send_action: observed(sendActionAt, 'harness', 'Enter dispatched from the measured composer'),
    request_accepted: requestAccepted,
    model_request_started: preferObservedMilestone(
      rendererMark(collector.marks, 'model_request_started', { turnId: measuredTurnId }),
      () =>
        runtimeMilestone(
          logLines,
          /OpenAI client created \(chat_completion_stream_request, shared=False\)/,
          'Hermes upstream model request started',
          { notBefore: requestAcceptedAt, notAfter: terminalAtEpochMs }
        )
    ),
    model_first_token: {
      status: 'unavailable',
      reason: 'ACP transport chunks are not exact upstream/local model first-token evidence',
    },
    acp_first_text: rendererMark(collector.marks, 'acp_first_text', { turnId: measuredTurnId }),
    renderer_first_visible:
      collector.firstVisibleAt === null ||
      !collector.firstVisibleMessageId ||
      !firstVisibleVerified ||
      collector.measuredTurnId !== measuredTurnId
        ? {
            status: 'unavailable',
            reason: 'the admitted turn output did not pass the exact-message visible-layout boundary',
          }
        : observed(
            collector.firstVisibleAt,
            'harness',
            'the exact first_output_state message passed visible layout checks after two animation-frame boundaries'
          ),
    response_finished: rendererMark(collector.marks, 'response_finished', { turnId: measuredTurnId }),
    tts_playback_started: input.args.tts
      ? rendererMark(collector.marks, 'tts_playback_started', { turnId: measuredTurnId })
      : { status: 'unavailable', reason: 'typed-turn TTS playback timing was not requested' },
  };
  const receipt = buildCommandEveTtftReceipt({
    releaseVersion: input.handle.artifactTruth.releaseVersion,
    hermesVersion: input.handle.artifactTruth.hermesVersion,
    appCommit: input.handle.artifactTruth.appCommit,
    appCommitSource: input.handle.artifactTruth.appCommitSource,
    promptSha256: sha256(measuredPrompt),
    runtimeSelection: input.localOnlyProof.selection,
    cohort: input.args.cohort,
    iteration: input.iteration,
    milestones,
  });
  const providerTurnBindingSelection =
    terminalAtEpochMs === undefined
      ? { evidence: null, violations: ['terminal timestamp unavailable for provider turn binding correlation'] }
      : selectCommandEveTtftProviderTurnBinding({
          lines: readFromOffset(providerTurnBindingHistoryPath, providerTurnBindingHistoryOffset),
          expectedConversationId: measuredConversationId,
          expectedAionCoreTurnId: measuredTurnId,
          notBeforeEpochMs: sendActionAt,
          notAfterEpochMs: terminalAtEpochMs,
        });
  const upstreamSelection =
    terminalAtEpochMs === undefined
      ? { evidence: null, violations: ['terminal timestamp unavailable for provider receipt correlation'] }
      : uniqueUpstreamEvidence(
          readFromOffset(upstreamHistoryPath, upstreamHistoryOffset),
          providerTurnBindingSelection.evidence,
          sendActionAt,
          terminalAtEpochMs
        );
  const formal = buildCommandEveTtftFormalReceipt({
    notBeforeEpochMs: sendActionAt,
    marks: collector.marks,
    attemptBinding,
    firstVisible:
      collector.firstVisibleAt !== null && collector.firstVisibleMessageId && firstVisibleVerified
        ? { messageId: collector.firstVisibleMessageId, atEpochMs: collector.firstVisibleAt }
        : null,
    runtimeReadiness:
      terminalAtEpochMs !== undefined
        ? exactRuntimeReadinessEvidence(
            readFromOffset(input.handle.logPath, 0),
            measuredConversationId,
            measuredTurnId,
            terminalAtEpochMs
          )
        : null,
    providerTurnBinding: providerTurnBindingSelection.evidence,
    upstream: upstreamSelection.evidence,
    evidenceViolations: [...providerTurnBindingSelection.violations, ...upstreamSelection.violations],
  });
  return { ...receipt, formal };
}

async function removeCurrentConversation(page: Page): Promise<void> {
  const match = windowConversationId(page.url());
  if (!match) return;
  await invokeBridge(page, 'remove-conversation', { id: match }, 15_000).catch((): undefined => undefined);
  await navigateToGuid(page);
}

function windowConversationId(url: string): string | null {
  const hash = new URL(url).hash;
  const value = hash.split('/conversation/')[1]?.split(/[?#]/)[0];
  return value || null;
}

async function seedExistingConversation(
  args: Args,
  handle: AppHandle,
  localOnlyProof: LocalOnlyProof
): Promise<MeasuredReceipt> {
  const receipt = await runMeasuredTurn({
    args: { ...args, cohort: 'warm_start_chat', tts: false },
    handle,
    iteration: 0,
    surface: 'start_chat',
    includeColdMilestones: false,
    logOffset: handle.launchLogOffset,
    localOnlyProof,
  });
  await handle.page.locator(EXISTING_INPUT).waitFor({ state: 'visible', timeout: 30_000 });
  return receipt;
}

async function closeApp(handle: AppHandle): Promise<void> {
  try {
    await handle.app.evaluate(async ({ app }) => app.exit(0));
  } catch {
    // Closing an already-exited local benchmark app is harmless.
  }
  await handle.app.close().catch((): undefined => undefined);
}

function requiredStages(args: Args): CommandEveTtftStage[] {
  const stages: CommandEveTtftStage[] = [
    'hermes_spawned',
    'hermes_ready',
    'acp_session_ready',
    'send_action',
    'request_accepted',
    'model_request_started',
    'acp_first_text',
    'renderer_first_visible',
    'response_finished',
  ];
  if (args.cohort === 'cold_start_chat') stages.unshift('app_process_started', 'renderer_usable');
  if (args.tts) stages.push('tts_playback_started');
  return stages;
}

const ALL_TTFT_METRICS = [
  'coldAppToRendererMs',
  'coldAppToHermesReadyMs',
  'coldAppToAcpSessionReadyMs',
  'sendToAcpSessionReadyMs',
  'sendToRequestAcceptedMs',
  'sendToModelFirstTokenMs',
  'sendToAcpFirstTextMs',
  'sendToFirstVisibleMs',
  'acpToRendererMs',
  'responseToTtsMs',
] satisfies CommandEveTtftMetricName[];

function requiredRegressionMetrics(args: Args): CommandEveTtftMetricName[] {
  const metrics: CommandEveTtftMetricName[] = [
    'sendToRequestAcceptedMs',
    'sendToAcpFirstTextMs',
    'sendToFirstVisibleMs',
    'acpToRendererMs',
  ];
  if (args.cohort === 'cold_start_chat') {
    metrics.unshift('coldAppToRendererMs', 'coldAppToHermesReadyMs', 'coldAppToAcpSessionReadyMs');
  }
  if (args.cohort !== 'warm_existing_session') metrics.push('sendToAcpSessionReadyMs');
  if (args.tts) metrics.push('responseToTtsMs');
  return metrics;
}

function defaultOutputPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(PROJECT_ROOT, 'scripts/benchmark-results', `command-eve-ttft-${stamp}.json`);
}

function readBaseline(filePath: string | null): unknown[] {
  if (!filePath) return [];
  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object' && Array.isArray((payload as { receipts?: unknown }).receipts)) {
    return (payload as { receipts: unknown[] }).receipts;
  }
  return [];
}

function isValidBaselineReceipt(value: unknown): value is CommandEveTtftReceipt {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Partial<CommandEveTtftReceipt>;
  return (
    receipt.version === COMMAND_EVE_TTFT_RECEIPT_VERSION &&
    typeof receipt.promptSha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(receipt.promptSha256) &&
    receipt.chronology?.valid === true &&
    Array.isArray(receipt.chronology.violations) &&
    receipt.chronology.violations.length === 0 &&
    Boolean(receipt.milestones) &&
    Boolean(receipt.metrics)
  );
}

async function main(): Promise<void> {
  const args = parseArgs();
  const receipts: MeasuredReceipt[] = [];
  let localOnlyProof: LocalOnlyProof | null = null;
  let artifactTruth: ArtifactTruth | null = null;

  if (args.prepareLocalDefault) {
    const preparationHandle = await launchApp({ ...args, tts: false });
    try {
      await prepareManifestLocalDefault(preparationHandle.page, preparationHandle.artifactTruth.manifestPath);
    } finally {
      await closeApp(preparationHandle);
    }
  }

  if (args.cohort === 'cold_start_chat') {
    for (let iteration = 1; iteration <= args.sessions; iteration += 1) {
      const handle = await launchApp(args);
      try {
        artifactTruth ??= handle.artifactTruth;
        const proof = await assertLocalOnly(handle.page);
        localOnlyProof ??= proof;
        receipts.push(
          await runMeasuredTurn({
            args,
            handle,
            iteration,
            surface: 'start_chat',
            includeColdMilestones: true,
            logOffset: handle.launchLogOffset,
            localOnlyProof: proof,
          })
        );
      } finally {
        await closeApp(handle);
      }
    }
  } else {
    const handle = await launchApp(args);
    try {
      artifactTruth = handle.artifactTruth;
      localOnlyProof = await assertLocalOnly(handle.page);
      const seedReceipt =
        args.cohort === 'warm_existing_session' ? await seedExistingConversation(args, handle, localOnlyProof) : null;
      let sessionReadiness:
        | Partial<Pick<CommandEveTtftReceipt['milestones'], 'hermes_spawned' | 'hermes_ready' | 'acp_session_ready'>>
        | undefined = seedReceipt
        ? {
            hermes_spawned: seedReceipt.milestones.hermes_spawned,
            hermes_ready: seedReceipt.milestones.hermes_ready,
            acp_session_ready: seedReceipt.milestones.acp_session_ready,
          }
        : undefined;
      for (let iteration = 1; iteration <= args.sessions; iteration += 1) {
        const receipt = await runMeasuredTurn({
          args,
          handle,
          iteration,
          surface: args.cohort === 'warm_start_chat' ? 'start_chat' : 'existing_session',
          includeColdMilestones: false,
          ...(iteration === 1 && args.cohort === 'warm_start_chat' ? { logOffset: handle.launchLogOffset } : {}),
          localOnlyProof,
          sessionReadiness,
        });
        receipts.push(receipt);
        if (args.cohort === 'warm_start_chat' && !sessionReadiness) {
          sessionReadiness = {
            hermes_spawned: receipt.milestones.hermes_spawned,
            hermes_ready: receipt.milestones.hermes_ready,
          };
        }
        if (args.cohort === 'warm_start_chat') await removeCurrentConversation(handle.page);
      }
    } finally {
      await closeApp(handle);
    }
  }

  if (!localOnlyProof) throw new Error('BLOCKED_LOCAL_ONLY: no local-only proof was collected');
  if (!artifactTruth) throw new Error('No artifact truth was collected from the launched application');
  const required = requiredStages(args);
  const missingRequiredStages = receipts.flatMap((receipt) => {
    const stages = required.filter((stage) => receipt.milestones[stage].status !== 'observed');
    return stages.length > 0 ? [{ iteration: receipt.iteration, stages }] : [];
  });
  const importedBaseline = readBaseline(args.baselinePath);
  const candidatePromptHashes = new Set(receipts.map((receipt) => receipt.promptSha256));
  const baselineReceipts = importedBaseline
    .filter(isValidBaselineReceipt)
    .filter(
      (receipt) =>
        receipt.cohort === args.cohort &&
        receipt.runtimeSelection === localOnlyProof.selection &&
        receipt.appCommitSource === artifactTruth.appCommitSource &&
        candidatePromptHashes.has(receipt.promptSha256)
    );
  const regressionGates = args.captureOnly
    ? []
    : requiredRegressionMetrics(args).map((metric) =>
        evaluateCommandEveTtftRegression({ baselineReceipts, candidateReceipts: receipts, metric })
      );
  const regressionOutcome: SuiteReport['regressionOutcome'] = args.captureOnly
    ? 'CAPTURE_ONLY'
    : regressionGates.some((gate) => gate.outcome === 'FAIL')
      ? 'FAIL'
      : regressionGates.some((gate) => gate.outcome === 'INSUFFICIENT_EVIDENCE')
        ? 'INSUFFICIENT_EVIDENCE'
        : 'PASS';
  const summaries = Object.fromEntries(
    ALL_TTFT_METRICS.map((metric) => [metric, summarizeCommandEveTtftMetric(receipts, metric)])
  ) as SuiteReport['summaries'];
  const chronologyInvalid = receipts.some((receipt) => !receipt.chronology.valid);
  const formalOutcome: SuiteReport['formalOutcome'] = receipts.every((receipt) => receipt.formal.outcome === 'PASS')
    ? 'PASS'
    : 'INSUFFICIENT_EVIDENCE';
  const suiteOutcome: SuiteReport['suiteOutcome'] =
    missingRequiredStages.length > 0 || chronologyInvalid || formalOutcome !== 'PASS'
      ? 'INSUFFICIENT_EVIDENCE'
      : regressionOutcome;
  const report: SuiteReport = {
    version: 'command-eve-ttft-suite/v2',
    generatedAt: new Date().toISOString(),
    cohort: args.cohort,
    sessionsRequested: args.sessions,
    executionMode: args.executablePath ? 'packaged' : 'development',
    executablePath: args.executablePath,
    userDataDir: args.userDataDir,
    inputMode: 'typed',
    nativeVoiceE2eCovered: false,
    promptTemplateSha256: sha256(args.prompt),
    ttsPlaybackRequested: args.tts,
    artifactTruth,
    localOnlyProof,
    requiredStages: required,
    missingRequiredStages,
    summaries,
    baselineImport: {
      path: args.baselinePath,
      imported: importedBaseline.length,
      compatible: baselineReceipts.length,
      rejected: importedBaseline.length - baselineReceipts.length,
    },
    regressionOutcome,
    formalOutcome,
    suiteOutcome,
    regressionGates,
    receipts,
  };
  const outputPath = args.outputPath ?? defaultOutputPath();
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`[command-eve:ttft] receipt=${outputPath}`);
  console.log(`[command-eve:ttft] local-only selection=${localOnlyProof.selection}`);
  console.log(`[command-eve:ttft] sessions=${receipts.length} missing=${missingRequiredStages.length}`);
  console.log(`[command-eve:ttft] regression=${regressionOutcome}`);
  console.log(`[command-eve:ttft] formal=${formalOutcome}`);
  console.log(`[command-eve:ttft] suite=${suiteOutcome}`);
  console.log(`[command-eve:ttft] send→visible p95=${summaries.sendToFirstVisibleMs.p95 ?? 'unavailable'}ms`);

  if (suiteOutcome === 'FAIL' || suiteOutcome === 'INSUFFICIENT_EVIDENCE') process.exitCode = 1;
}

main().catch((error) => {
  console.error('[command-eve:ttft] FAILED', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
