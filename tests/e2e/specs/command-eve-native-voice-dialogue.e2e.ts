import { expect, test, type ElectronApplication, type Page, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COMMAND_EVE_E2E_PACKAGED_ATTACHMENT_MARKER } from '../../../packages/desktop/src/common/platform/userDataPath';
import { closeSharedElectronAppForIsolatedSpec } from '../fixtures';
import { invokeBridge } from '../helpers/bridge/invoke';

const RUN_NATIVE_VOICE_E2E = process.env.RUN_COMMAND_EVE_NATIVE_VOICE_E2E === '1';
const scratchRoot = RUN_NATIVE_VOICE_E2E
  ? fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-native-voice-e2e-'))
  : path.join(os.tmpdir(), 'command-eve-native-voice-e2e-disabled');
const userDataDir = path.join(scratchRoot, 'user-data');
const isolatedHomeDir = path.join(scratchRoot, 'home');

type PerformanceMark = {
  stage: string;
  turnId?: string;
  atEpochMs: number;
};

type RuntimeManifest = {
  release?: string;
  hermes?: { version?: string };
  local_runtime?: { default_tier_id?: string };
};

function requiredPath(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the real native-voice Electron gate`);
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) throw new Error(`${name} does not exist: ${resolved}`);
  return resolved;
}

function requiredCommit(): string {
  const value = process.env.COMMAND_EVE_VOICE_E2E_APP_COMMIT?.trim() ?? '';
  if (!/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error('COMMAND_EVE_VOICE_E2E_APP_COMMIT must be the exact 40-character packaged source commit');
  }
  return value;
}

function resolveRuntimeManifest(executablePath: string): { manifest: RuntimeManifest; manifestPath: string } {
  const executableDir = path.dirname(executablePath);
  const candidates = [
    path.resolve(executableDir, '..', 'Resources', 'command-eve-runtime-bootstrap.json'),
    path.resolve(executableDir, 'resources', 'command-eve-runtime-bootstrap.json'),
    path.resolve(executableDir, '..', 'resources', 'command-eve-runtime-bootstrap.json'),
  ];
  const manifestPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!manifestPath) throw new Error('Packaged runtime manifest was not found beside the measured executable');
  const packageMarkerPath = path.join(path.dirname(manifestPath), COMMAND_EVE_E2E_PACKAGED_ATTACHMENT_MARKER);
  if (!fs.existsSync(packageMarkerPath)) {
    throw new Error(
      `Non-distributable packaged-QA marker is missing: ${packageMarkerPath}. ` +
        'Build with COMMAND_EVE_E2E_PACKAGED_BUILD=1 and packages/desktop/electron-builder.e2e.yml. ' +
        'Raw AIONUI_E2E_TEST or COMMAND_EVE_E2E_PACKAGED_ATTACHMENT flags must not enable packaged CDP.'
    );
  }
  return {
    manifestPath,
    manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as RuntimeManifest,
  };
}

function localOnlyEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: isolatedHomeDir,
    XDG_CONFIG_HOME: path.join(isolatedHomeDir, '.config'),
    XDG_CACHE_HOME: path.join(isolatedHomeDir, '.cache'),
    ACP_PERF: '1',
    AIONUI_DISABLE_AUTO_UPDATE: '1',
    AIONUI_DISABLE_DEVTOOLS: '1',
    AIONUI_E2E_TEST: '1',
    AIONUI_MULTI_INSTANCE: '1',
    AIONUI_CDP_PORT: '0',
    COMMAND_EVE_E2E_PACKAGED_ATTACHMENT: '1',
    COMMAND_EVE_REGISTRATION_REQUIRED: '0',
    NODE_ENV: 'production',
  };
  [
    'ANTHROPIC_API_KEY',
    'DEEPGRAM_API_KEY',
    'GROQ_API_KEY',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
    'GOOGLE_API_KEY',
  ].forEach((key) => delete env[key]);
  return env;
}

async function launchVoiceApp(executablePath: string, audioPath: string): Promise<ElectronApplication> {
  fs.mkdirSync(isolatedHomeDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  const args = [
    `--user-data-dir=${userDataDir}`,
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${audioPath}`,
  ];
  if (process.platform === 'darwin') args.push('--use-mock-keychain');
  if (process.platform === 'linux' && process.env.CI) args.push('--no-sandbox');
  return electron.launch({
    executablePath,
    args,
    cwd: path.dirname(executablePath),
    env: localOnlyEnvironment(),
    timeout: 180_000,
  });
}

async function resolveMainWindow(app: ElectronApplication): Promise<Page> {
  const existing = app.windows().find((window) => !window.url().startsWith('devtools://'));
  const page = existing ?? (await app.waitForEvent('window', { timeout: 120_000 }));
  await page.waitForLoadState('domcontentloaded');
  return page;
}

async function closeApp(app: ElectronApplication | null): Promise<void> {
  if (!app) return;
  try {
    await app.evaluate(async ({ app: electronApp }) => electronApp.exit(0));
  } catch {
    // The isolated app may already have exited after a failed assertion.
  }
  await app.close().catch(() => {});
}

async function openGuid(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/guid';
  });
  await page.locator('.guid-input-card-shell textarea').waitFor({ state: 'visible', timeout: 60_000 });
}

async function forceManifestLocalSelection(page: Page, tierId: string): Promise<string> {
  const activeSeat = await invokeBridge<{ success?: boolean; data?: { seat_id?: string } } | { seat_id?: string }>(
    page,
    'command-eve.active-seat',
    undefined,
    15_000
  );
  const seatId =
    ('data' in activeSeat ? activeSeat.data?.seat_id : undefined) ||
    ('seat_id' in activeSeat ? activeSeat.seat_id : undefined) ||
    'seat-1';
  const normalizedSeatId = seatId.trim().toLowerCase();
  const settingsKey =
    !normalizedSeatId || normalizedSeatId === 'default' || normalizedSeatId === 'seat-1'
      ? 'commandEve.inferenceSelection'
      : `seat:${normalizedSeatId}:commandEve.inferenceSelection`;
  const selection = `command-eve-local:${tierId}`;
  await page.evaluate(
    async ({ key, value }) => {
      const runtimeWindow = window as Window & {
        __backendPort?: number;
        __aionBackend?: { getPort?: () => number };
      };
      const port = runtimeWindow.__aionBackend?.getPort?.() ?? runtimeWindow.__backendPort;
      if (!port) throw new Error('backend port unavailable');
      const response = await fetch(`http://127.0.0.1:${port}/api/settings/client`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value }),
      });
      if (!response.ok) throw new Error(`local selection write failed: ${response.status}`);
    },
    { key: settingsKey, value: selection }
  );
  await page.reload();
  await page.waitForSelector('body', { state: 'visible' });
  return selection;
}

async function installPerformanceCollector(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window as Window & {
      __commandEveNativeVoiceMarks?: PerformanceMark[];
      __commandEveNativeVoiceMarksCleanup?: () => void;
    };
    state.__commandEveNativeVoiceMarksCleanup?.();
    state.__commandEveNativeVoiceMarks = [];
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<PerformanceMark>).detail;
      if (detail?.stage) state.__commandEveNativeVoiceMarks?.push(detail);
    };
    window.addEventListener('command-eve:acp-performance-mark', listener);
    state.__commandEveNativeVoiceMarksCleanup = () =>
      window.removeEventListener('command-eve:acp-performance-mark', listener);
  });
}

async function readPerformanceMarks(page: Page): Promise<PerformanceMark[]> {
  return page.evaluate(
    () => (window as Window & { __commandEveNativeVoiceMarks?: PerformanceMark[] }).__commandEveNativeVoiceMarks ?? []
  );
}

async function waitForMark(page: Page, stage: string, timeout = 240_000): Promise<void> {
  await page.waitForFunction(
    (expectedStage) =>
      ((window as Window & { __commandEveNativeVoiceMarks?: PerformanceMark[] }).__commandEveNativeVoiceMarks ?? [])
        .map((mark) => mark.stage)
        .includes(expectedStage),
    stage,
    { timeout }
  );
}

test.describe.serial('Command EVE real native voice dialogue', () => {
  test.skip(
    !RUN_NATIVE_VOICE_E2E,
    'Set RUN_COMMAND_EVE_NATIVE_VOICE_E2E=1 through the dedicated package gate; an ordinary suite must not fake this proof.'
  );
  test.setTimeout(720_000);

  test.beforeAll(async () => {
    await closeSharedElectronAppForIsolatedSpec();
  });

  test.afterAll(async () => {
    fs.rmSync(scratchRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test('records, transcribes locally, edits, sends, streams, speaks, barges in, and survives restart', async ({
    browserName: _browserName,
  }, testInfo) => {
    const executablePath = requiredPath('COMMAND_EVE_VOICE_E2E_EXECUTABLE');
    const audioPath = requiredPath('COMMAND_EVE_VOICE_E2E_AUDIO_FILE');
    const appCommit = requiredCommit();
    const { manifest, manifestPath } = resolveRuntimeManifest(executablePath);
    if (!manifest.release || !manifest.hermes?.version || !manifest.local_runtime?.default_tier_id) {
      throw new Error(`Incomplete packaged runtime truth: ${manifestPath}`);
    }

    let app: ElectronApplication | null = await launchVoiceApp(executablePath, audioPath);
    try {
      let page = await resolveMainWindow(app);
      const launchedVersion = await app.evaluate(({ app: electronApp }) => electronApp.getVersion());
      expect(launchedVersion).toBe(manifest.release);
      expect(manifest.hermes.version).toBe('0.20.0');

      const localSelection = await forceManifestLocalSelection(page, manifest.local_runtime.default_tier_id);
      await openGuid(page);
      await page.setViewportSize({ width: 720, height: 780 });
      await page.emulateMedia({ colorScheme: 'dark' });

      const voiceToggle = page.getByTestId('voice-dialogue-toggle');
      const mic = page.getByTestId('speech-input-button');
      const guidInput = page.locator('.guid-input-card-shell textarea');
      await expect(voiceToggle).toBeVisible();
      await expect(mic).toBeVisible();
      if ((await voiceToggle.getAttribute('aria-pressed')) !== 'true') await voiceToggle.click();
      await expect(voiceToggle).toHaveAttribute('aria-pressed', 'true');

      await mic.click();
      await expect(voiceToggle).toHaveAttribute('data-phase', 'listening', { timeout: 15_000 });
      await page.waitForTimeout(1_500);
      await mic.click();
      await expect.poll(() => guidInput.inputValue(), { timeout: 240_000, intervals: [250, 500, 1_000] }).not.toBe('');
      const startTranscript = (await guidInput.inputValue()).trim();
      expect(startTranscript.length).toBeGreaterThan(0);
      const editedPrompt = `${startTranscript}\nAntworte auf Deutsch in mindestens acht kurzen Sätzen.`;
      await guidInput.fill(editedPrompt);
      await expect(guidInput).toHaveValue(editedPrompt);

      await installPerformanceCollector(page);
      await guidInput.press('Enter');
      await page.waitForFunction(() => window.location.hash.includes('/conversation/'), undefined, {
        timeout: 30_000,
      });
      await waitForMark(page, 'request_accepted');
      await waitForMark(page, 'acp_first_text');
      await expect(page.locator('[data-testid="message-text-left"]').last()).toContainText(/\S/, {
        timeout: 240_000,
      });
      await waitForMark(page, 'response_finished');
      await waitForMark(page, 'tts_playback_started', 30_000);
      const startTurnMarks = await readPerformanceMarks(page);

      const conversationMic = page.getByTestId('speech-input-button');
      await conversationMic.click();
      await expect(page.getByTestId('voice-dialogue-toggle')).toHaveAttribute('data-phase', 'listening', {
        timeout: 15_000,
      });
      await page.waitForTimeout(750);
      await conversationMic.click();
      const existingInput = page.locator('.acp-send-box textarea');
      await expect
        .poll(() => existingInput.inputValue(), { timeout: 240_000, intervals: [250, 500, 1_000] })
        .not.toBe('');
      const existingTranscript = (await existingInput.inputValue()).trim();
      const existingPrompt = `${existingTranscript}\nBearbeitet. Antworte erneut auf Deutsch in mindestens acht Sätzen.`;
      await existingInput.fill(existingPrompt);
      await expect(existingInput).toHaveValue(existingPrompt);

      await installPerformanceCollector(page);
      await existingInput.press('Enter');
      await waitForMark(page, 'request_accepted');
      await waitForMark(page, 'acp_first_text');
      await waitForMark(page, 'response_finished');
      await waitForMark(page, 'tts_playback_started', 30_000);
      const existingTurnMarks = await readPerformanceMarks(page);

      await existingInput.fill('Starte einen weiteren lokalen Turn, der sofort abgebrochen werden darf.');
      await installPerformanceCollector(page);
      await existingInput.press('Enter');
      await expect(page.getByTestId('voice-dialogue-toggle')).toHaveAttribute('data-phase', 'thinking', {
        timeout: 15_000,
      });
      await expect(conversationMic).toBeEnabled({ timeout: 15_000 });
      await conversationMic.click();
      await waitForMark(page, 'request_accepted');
      await waitForMark(page, 'turn_cancel_requested', 15_000);
      await waitForMark(page, 'turn_cancel_acknowledged', 30_000);
      await expect(page.getByTestId('voice-dialogue-toggle')).toHaveAttribute('data-phase', 'listening', {
        timeout: 15_000,
      });
      const cancelTurnMarks = await readPerformanceMarks(page);
      const acceptedCancelTurn = cancelTurnMarks.find((mark) => mark.stage === 'request_accepted')?.turnId;
      const canceledTurn = cancelTurnMarks.find((mark) => mark.stage === 'turn_cancel_requested')?.turnId;
      const acknowledgedCancelTurn = cancelTurnMarks.find((mark) => mark.stage === 'turn_cancel_acknowledged')?.turnId;
      expect(cancelTurnMarks.some((mark) => mark.stage === 'turn_cancel_failed')).toBe(false);
      expect(acceptedCancelTurn).toBeTruthy();
      expect(canceledTurn).toBe(acceptedCancelTurn);
      expect(acknowledgedCancelTurn).toBe(acceptedCancelTurn);
      await page.waitForTimeout(750);
      await conversationMic.click();
      await expect(page.getByTestId('voice-dialogue-toggle')).toHaveAttribute('data-phase', 'ready', {
        timeout: 240_000,
      });

      await closeApp(app);
      app = await launchVoiceApp(executablePath, audioPath);
      page = await resolveMainWindow(app);
      await openGuid(page);
      await expect(page.getByTestId('voice-dialogue-toggle')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('voice-dialogue-toggle')).toHaveAttribute('data-phase', 'ready');
      await expect(page.getByTestId('speech-input-button')).not.toHaveClass(/speech-input-button--listening/);
      await page.emulateMedia({ colorScheme: 'light' });
      await expect(page.getByTestId('voice-dialogue-toggle')).toBeVisible();

      await testInfo.attach('command-eve-native-voice-receipt', {
        body: Buffer.from(
          JSON.stringify(
            {
              version: 'command-eve-native-voice-e2e/v1',
              releaseVersion: manifest.release,
              hermesVersion: manifest.hermes.version,
              appCommit,
              appCommitSource: 'packaged_cli_assertion',
              localSelection,
              inputMode: 'fake-device-real-media-recorder',
              packagedQaAttachmentMarker: COMMAND_EVE_E2E_PACKAGED_ATTACHMENT_MARKER,
              sttLane: 'forced-local',
              ttsVoicePolicy: 'speechSynthesis-localService-required',
              startTranscriptLength: startTranscript.length,
              existingTranscriptLength: existingTranscript.length,
              startTurnComplete: true,
              existingTurnComplete: true,
              canceledTurnIdMatchedAcceptance: canceledTurn === acceptedCancelTurn,
              cancelAcknowledged: acknowledgedCancelTurn === acceptedCancelTurn,
              postRestartAlwaysListening: false,
              startTurnMarks: startTurnMarks.map((mark) => ({
                stage: mark.stage,
                turnIdPresent: Boolean(mark.turnId),
              })),
              existingTurnMarks: existingTurnMarks.map((mark) => ({
                stage: mark.stage,
                turnIdPresent: Boolean(mark.turnId),
              })),
              cancelTurnMarks: cancelTurnMarks.map((mark) => ({
                stage: mark.stage,
                turnIdPresent: Boolean(mark.turnId),
              })),
            },
            null,
            2
          )
        ),
        contentType: 'application/json',
      });
    } finally {
      await closeApp(app);
    }
  });
});
