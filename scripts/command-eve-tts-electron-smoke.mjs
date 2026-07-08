#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import process from 'node:process';
import { app, safeStorage } from 'electron';
import {
  COMMAND_EVE_TTS_SMOKE_MAX_RESPONSE_BYTES,
  EVE_MULTIMODAL_FUNCTION_URL,
  KEYCHAIN_REF_PREFIX,
  buildCommandEveTtsSmokeRequest,
  commandEveTtsSmokeConsentPath,
  commandEveTtsSmokeLicenseWirePath,
  isWellFormedCeveWire,
  parseCommandEveTtsSmokeConsent,
  parseCommandEveTtsSmokeLicenseWireRecord,
  redactServerControlledMessage,
  resolveCommandEveTtsSmokeUserDataPath,
  summarizeCommandEveTtsSmokeResponse,
} from './command-eve-tts-electron-smoke-core.mjs';

const HARD_TIMEOUT_MS = Number.parseInt(process.env.COMMAND_EVE_TTS_SMOKE_HARD_TIMEOUT_MS || '120000', 10);
const HEARTBEAT_MS = Number.parseInt(process.env.COMMAND_EVE_TTS_SMOKE_HEARTBEAT_MS || '15000', 10);
const ELECTRON_READY_WAIT_MS = Number.parseInt(process.env.COMMAND_EVE_TTS_SMOKE_ELECTRON_READY_WAIT_MS || '3000', 10);

function print(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function fail(reasonCode, extra = {}) {
  return {
    ok: false,
    version: 'command-eve-tts-electron-smoke/v0',
    reason_code: reasonCode,
    ...extra,
  };
}

function readFileUtf8(filePath) {
  try {
    return { ok: true, text: fs.readFileSync(filePath, 'utf8') };
  } catch (error) {
    return {
      ok: false,
      reason_code: 'SMOKE_FILE_READ_FAILED',
      message: error instanceof Error ? redactServerControlledMessage(error.message) : undefined,
    };
  }
}

function decryptLicenseWire(wireRef) {
  if (!safeStorage || safeStorage.isEncryptionAvailable() !== true) {
    return { ok: false, reason_code: 'KEYCHAIN_UNAVAILABLE' };
  }
  if (!wireRef.startsWith(KEYCHAIN_REF_PREFIX)) {
    return { ok: false, reason_code: 'LICENSE_WIRE_NOT_A_REF' };
  }
  try {
    const encrypted = Buffer.from(wireRef.slice(KEYCHAIN_REF_PREFIX.length), 'base64');
    const wire = safeStorage.decryptString(encrypted);
    if (!isWellFormedCeveWire(wire)) {
      return { ok: false, reason_code: 'LICENSE_WIRE_FORMAT_INVALID' };
    }
    return { ok: true, wire: wire.trim() };
  } catch {
    return { ok: false, reason_code: 'KEYCHAIN_DECRYPT_FAILED' };
  }
}

async function readLimitedResponseText(response) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > COMMAND_EVE_TTS_SMOKE_MAX_RESPONSE_BYTES) {
    return { ok: false, reason_code: 'EVE_MULTIMODAL_TTS_RESPONSE_TOO_LARGE' };
  }
  const text = await response.text();
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > COMMAND_EVE_TTS_SMOKE_MAX_RESPONSE_BYTES) {
    return { ok: false, reason_code: 'EVE_MULTIMODAL_TTS_RESPONSE_TOO_LARGE' };
  }
  return { ok: true, text };
}

async function postTtsSmoke(body, licenseWire) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35_000);
  try {
    const response = await fetch(EVE_MULTIMODAL_FUNCTION_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${licenseWire}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      redirect: 'error',
      cache: 'no-store',
      signal: controller.signal,
    });
    const responseText = await readLimitedResponseText(response);
    if (!responseText.ok) return responseText;
    const summarized = summarizeCommandEveTtsSmokeResponse(responseText.text, body.privacyLane);
    if (!response.ok && summarized.ok) {
      return fail(`EVE_MULTIMODAL_TTS_HTTP_${response.status}`, { http_status: response.status });
    }
    return {
      ...summarized,
      ...(response.ok ? {} : { http_status: response.status }),
    };
  } catch (error) {
    return fail(
      error instanceof Error && error.name === 'AbortError'
        ? 'EVE_MULTIMODAL_TTS_TIMEOUT'
        : 'EVE_MULTIMODAL_TTS_FAILED',
      {
        message: error instanceof Error ? redactServerControlledMessage(error.message) : undefined,
      }
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForElectronReady() {
  if (app.isReady()) return 'ready';
  const waitMs = Number.isFinite(ELECTRON_READY_WAIT_MS) && ELECTRON_READY_WAIT_MS > 0 ? ELECTRON_READY_WAIT_MS : 3000;
  return Promise.race([
    app.whenReady().then(() => 'ready'),
    new Promise((resolve) => {
      setTimeout(() => resolve('soft-timeout'), waitMs);
    }),
  ]);
}

async function runSmoke(setStage) {
  setStage('electron_ready');
  const electronReadyState = await waitForElectronReady();

  setStage('resolve_user_data');
  const userDataPath = resolveCommandEveTtsSmokeUserDataPath({
    env: process.env,
    homeDir: os.homedir(),
    platform: process.platform,
    appUserDataPath: app.getPath('userData'),
    existsSync: fs.existsSync,
  });

  setStage('read_license_wire');
  const licensePath = commandEveTtsSmokeLicenseWirePath(userDataPath);
  const licenseRecord = readFileUtf8(licensePath);
  if (!licenseRecord.ok) {
    return fail('LICENSE_WIRE_MISSING', { userDataPath, licensePath });
  }
  const parsedLicense = parseCommandEveTtsSmokeLicenseWireRecord(licenseRecord.text);
  if (!parsedLicense.ok) {
    return fail(parsedLicense.reason_code, { userDataPath, licensePath });
  }
  setStage('decrypt_license_wire');
  const decrypted = decryptLicenseWire(parsedLicense.wire_ref);
  if (!decrypted.ok) {
    return fail(decrypted.reason_code, { userDataPath, licensePath });
  }

  setStage('read_tts_consent');
  const consentPath = commandEveTtsSmokeConsentPath(userDataPath);
  const consentFile = readFileUtf8(consentPath);
  const consent = parseCommandEveTtsSmokeConsent(consentFile.ok ? consentFile.text : undefined);
  if (consent.consent !== true) {
    return fail('EVE_MULTIMODAL_TTS_PRIVACY_CONSENT_REQUIRED', { userDataPath, consentPath });
  }

  setStage('build_tts_request');
  const request = buildCommandEveTtsSmokeRequest({
    text: process.env.COMMAND_EVE_TTS_SMOKE_TEXT || 'Command EVE cloud TTS smoke check.',
    privacyLane: consent.privacyLane,
    voiceId: process.env.COMMAND_EVE_TTS_SMOKE_VOICE || 'eve',
    language: process.env.COMMAND_EVE_TTS_SMOKE_LANGUAGE || 'de-DE',
    requestId: process.env.COMMAND_EVE_TTS_SMOKE_REQUEST_ID || `tts-smoke-${Date.now()}`,
  });
  if (!request.ok) {
    return fail(request.reason_code, { userDataPath, consentPath });
  }

  setStage('post_tts_gateway');
  const result = await postTtsSmoke(request.body, decrypted.wire);
  setStage('summarize_result');
  return {
    version: 'command-eve-tts-electron-smoke/v0',
    userDataPath,
    functionUrl: EVE_MULTIMODAL_FUNCTION_URL,
    electronReadyState,
    privacyLane: request.privacyLane,
    request: {
      provider: request.body.provider,
      capability: request.body.capability,
      directProviderKeyPresentInDesktop: request.body.directProviderKeyPresentInDesktop,
      voice_id: request.body.voice_id,
      language: request.body.language,
      text_length: request.body.text.length,
      requestId: request.body.requestId,
    },
    ...result,
  };
}

let stage = 'boot';
let done = false;
const startedAt = Date.now();
const setStage = (nextStage) => {
  stage = nextStage;
};

const hardTimeout = setTimeout(
  () => {
    if (done) return;
    done = true;
    print(
      fail('EVE_MULTIMODAL_TTS_SMOKE_TIMEOUT', {
        stage,
        elapsed_ms: Date.now() - startedAt,
      })
    );
    app.exit(1);
  },
  Number.isFinite(HARD_TIMEOUT_MS) && HARD_TIMEOUT_MS > 0 ? HARD_TIMEOUT_MS : 120000
);

const heartbeat = setInterval(
  () => {
    if (done) return;
    process.stderr.write(`[command-eve:smoke:cloud-tts] stage=${stage} elapsed_ms=${Date.now() - startedAt}\n`);
  },
  Number.isFinite(HEARTBEAT_MS) && HEARTBEAT_MS > 0 ? HEARTBEAT_MS : 15000
);

try {
  const result = await runSmoke(setStage);
  done = true;
  print(result);
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  done = true;
  print(
    fail('EVE_MULTIMODAL_TTS_SMOKE_CRASHED', {
      stage,
      message: error instanceof Error ? redactServerControlledMessage(error.message) : undefined,
    })
  );
  process.exitCode = 1;
} finally {
  clearTimeout(hardTimeout);
  clearInterval(heartbeat);
  app.quit();
}
