#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { createCanvas } from '@napi-rs/canvas';

const PRODUCTION_DATA_ROOT = path.join(os.homedir(), 'Library', 'Application Support', 'Command EVE', 'command-eve');
const ENTITLEMENT_DIR = path.join(PRODUCTION_DATA_ROOT, 'command-eve-runtime', 'entitlement');
const EVE_MULTIMODAL_FUNCTION_URL = 'https://unvbeothoimlzlolxucl.supabase.co/functions/v1/eve-multimodal';
const EVE_INFERENCE_FUNCTION_URL = 'https://unvbeothoimlzlolxucl.supabase.co/functions/v1/eve-inference';
const CREDITS_STATUS_FUNCTION_URL = 'https://unvbeothoimlzlolxucl.supabase.co/functions/v1/credits-status';
const MY_LICENSE_URL = 'https://unvbeothoimlzlolxucl.supabase.co/functions/v1/my-license';
const COMMAND_EVE_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVudmJlb3Rob2ltbHpsb2x4dWNsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEyMDI2MzQsImV4cCI6MjA5Njc3ODYzNH0.yL0mW3xbsSJHvO6PG4h8TrBFoCEZy6jAt7MLb1cGAys';
const KEYCHAIN_SERVICES = ['Command EVE Safe Storage', 'AionUi Safe Storage'];
const OCR_MARKER = 'COMMAND EVE 1814 OCR LIVE GATE 7F3A';
const SMOKE_MODE = process.env.COMMAND_EVE_1814_LIVE_SMOKE_MODE || 'all';
const INFERENCE_TIERS = Object.freeze([
  { tier: 'standard', model: 'deepseek/deepseek-v4-flash', marker: 'CEVE_1814_STANDARD_ZDR_OK' },
  { tier: 'high', model: 'deepseek/deepseek-v4-pro', marker: 'CEVE_1814_HIGH_ZDR_OK' },
  { tier: 'xhigh', model: 'z-ai/glm-5.2', marker: 'CEVE_1814_XHIGH_ZDR_OK' },
]);
const KIMI_AGENT_TIERS = Object.freeze([
  { tier: 'max', modelFragment: 'kimi-k2.6' },
  { tier: 'ultra', modelFragment: 'kimi-k3' },
]);

function print(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function fail(reasonCode, detail) {
  return {
    ok: false,
    version: 'command-eve-1814-live-smoke/v1',
    reason_code: reasonCode,
    ...(detail ? { detail: String(detail).replace(/\s+/g, ' ').slice(0, 240) } : {}),
  };
}

function isWellFormedWire(value) {
  if (typeof value !== 'string') return false;
  const parts = value.trim().split('.');
  return (
    parts.length === 4 &&
    parts[0] === 'CEVE' &&
    (parts[1] === 'v1' || parts[1] === 'v2') &&
    Boolean(parts[2]) &&
    Boolean(parts[3])
  );
}

function readSafeStoragePassword() {
  for (const service of KEYCHAIN_SERVICES) {
    try {
      const value = execFileSync('/usr/bin/security', ['find-generic-password', '-w', '-s', service], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (value) return value;
    } catch {
      // Try the next historical product name.
    }
  }
  throw new Error('COMMAND_EVE_SAFE_STORAGE_KEY_NOT_FOUND');
}

function decryptSafeStorageRef(ref) {
  if (typeof ref !== 'string' || !ref.startsWith('keychain:v1:')) throw new Error('KEYCHAIN_REF_INVALID');
  const encrypted = Buffer.from(ref.slice('keychain:v1:'.length), 'base64');
  if (encrypted.subarray(0, 3).toString('ascii') !== 'v10') throw new Error('SAFE_STORAGE_CIPHERTEXT_UNSUPPORTED');
  const password = readSafeStoragePassword();
  const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  return Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()])
    .toString('utf8')
    .trim();
}

async function readJson(response) {
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > 12 * 1024 * 1024) throw new Error('RESPONSE_TOO_LARGE');
  return { response, body: JSON.parse(text) };
}

async function postJson(url, body, bearer, timeoutMs, extraHeaders = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await readJson(
      await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bearer}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...extraHeaders,
        },
        body: JSON.stringify(body),
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
      })
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function getJson(url, bearer, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await readJson(
      await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' },
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
      })
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function loadLicenseWire() {
  const wirePath = path.join(ENTITLEMENT_DIR, 'license-wire.json');
  if (fs.existsSync(wirePath)) {
    const record = JSON.parse(fs.readFileSync(wirePath, 'utf8'));
    const wire = decryptSafeStorageRef(record?.wire_ref);
    if (!isWellFormedWire(wire)) throw new Error('LICENSE_WIRE_FORMAT_INVALID');
    return wire;
  }

  const sessionRecord = JSON.parse(fs.readFileSync(path.join(ENTITLEMENT_DIR, 'session.enc'), 'utf8'));
  const session = JSON.parse(decryptSafeStorageRef(sessionRecord?.session_ref));
  if (typeof session?.access_token !== 'string' || !session.access_token) {
    throw new Error('SESSION_ACCESS_TOKEN_INVALID');
  }
  const license = await postJson(MY_LICENSE_URL, {}, session.access_token, 20_000, {
    apikey: COMMAND_EVE_SUPABASE_ANON_KEY,
  });
  if (!license.response.ok) throw new Error(`MY_LICENSE_HTTP_${license.response.status}`);
  const wire = license.body?.code || license.body?.license_code || license.body?.wire;
  if (!isWellFormedWire(wire)) {
    const status =
      typeof license.body?.status === 'string' ? license.body.status.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) : '';
    throw new Error(status ? `MY_LICENSE_NO_CODE_${status}` : 'MY_LICENSE_NO_CODE');
  }
  return wire.trim();
}

function createImageOnlyPdf() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-1814-live-smoke-'));
  const imagePath = path.join(tempDir, 'scan.png');
  try {
    fs.chmodSync(tempDir, 0o700);
    const canvas = createCanvas(1240, 1754);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#111827';
    context.font = 'bold 42px sans-serif';
    context.fillText(OCR_MARKER, 90, 180);
    context.font = '28px sans-serif';
    context.fillText('Synthetic scanned document for the Command EVE release gate.', 90, 250);
    fs.writeFileSync(imagePath, canvas.toBuffer('image/png'), { mode: 0o600, flag: 'wx' });
    return execFileSync('/usr/sbin/cupsfilter', ['-m', 'application/pdf', imagePath], {
      encoding: 'buffer',
      maxBuffer: 25 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function summarizePdfOcr(result, expectedSha256) {
  const body = result.body;
  const text = body?.artifact?.text;
  const valid =
    result.response.ok &&
    body?.ok === true &&
    body?.provider === 'openrouter' &&
    body?.capability === 'document_ocr' &&
    body?.reason === 'provider-complete' &&
    body?.residency?.effectiveResidency === 'global_cloud' &&
    body?.residency?.confirmation === 'zdr-enforced-global' &&
    body?.document?.engine === 'mistral-ocr' &&
    body?.document?.zdr_enforced === true &&
    body?.document?.data_collection === 'deny' &&
    body?.document?.page_count === 1 &&
    body?.usage?.metering === 'daily-page-cap' &&
    body?.usage?.pages_reserved === 1 &&
    Number.isInteger(body?.usage?.tenant_pages_used_today) &&
    Number.isInteger(body?.usage?.tenant_page_cap) &&
    body.usage.tenant_pages_used_today <= body.usage.tenant_page_cap &&
    Number.isInteger(body?.usage?.global_pages_used_today) &&
    Number.isInteger(body?.usage?.global_page_cap) &&
    body.usage.global_pages_used_today <= body.usage.global_page_cap &&
    typeof text === 'string' &&
    text.includes('## Page 1') &&
    text.toUpperCase().includes(OCR_MARKER);
  if (!valid) throw new Error(`PDF_OCR_BAD_RECEIPT_HTTP_${result.response.status}`);
  return {
    ok: true,
    http_status: result.response.status,
    provider: body.provider,
    capability: body.capability,
    engine: body.document.engine,
    model: body.document.model,
    page_count: body.document.page_count,
    zdr_enforced: body.document.zdr_enforced,
    data_collection: body.document.data_collection,
    marker_verified: true,
    source_sha256: expectedSha256,
    response_bytes: body.artifact.bytes,
    usage: {
      metering: body.usage.metering,
      pages_reserved: body.usage.pages_reserved,
      tenant_pages_used_today: body.usage.tenant_pages_used_today,
      tenant_page_cap: body.usage.tenant_page_cap,
      global_pages_used_today: body.usage.global_pages_used_today,
      global_page_cap: body.usage.global_page_cap,
    },
  };
}

function summarizeInferenceTier(result, expected) {
  const body = result.body;
  if (!result.response.ok) {
    const upstream = [body?.error, body?.upstream_status, body?.upstream_code, body?.upstream_message]
      .filter((value) => value !== undefined && value !== null)
      .map((value) => String(value).replace(/\b(?:sk-or-v1|sk|xai)-[A-Za-z0-9._-]+\b/gi, '[REDACTED]'))
      .join(':')
      .slice(0, 320);
    throw new Error(
      `INFERENCE_${expected.tier.toUpperCase()}_HTTP_${result.response.status}${upstream ? `:${upstream}` : ''}`
    );
  }
  const choice = body?.choices?.[0];
  const content = choice?.message?.content;
  const valid =
    body?.model === expected.model &&
    typeof content === 'string' &&
    content.includes(expected.marker) &&
    Number.isFinite(body?.usage?.prompt_tokens) &&
    Number.isFinite(body?.usage?.completion_tokens);
  if (!valid) throw new Error(`INFERENCE_${expected.tier.toUpperCase()}_BAD_RECEIPT`);
  return {
    ok: true,
    http_status: result.response.status,
    tier: expected.tier,
    model: body.model,
    marker_verified: true,
    finish_reason: choice?.finish_reason,
    usage: {
      prompt_tokens: body.usage.prompt_tokens,
      completion_tokens: body.usage.completion_tokens,
      total_tokens: body.usage.total_tokens,
    },
  };
}

async function runInferenceTierSmoke(licenseWire, expected) {
  const result = await postJson(
    EVE_INFERENCE_FUNCTION_URL,
    {
      tier: expected.tier,
      stream: false,
      messages: [
        {
          role: 'user',
          content: `Reply with exactly ${expected.marker}`,
        },
      ],
      temperature: 0,
    },
    licenseWire,
    150_000
  );
  return summarizeInferenceTier(result, expected);
}

function summarizeKimi(result, expected) {
  const body = result.body;
  if (!result.response.ok) {
    const diagnostic = [body?.error, body?.upstream_status, body?.upstream_code, body?.upstream_message]
      .filter((value) => value !== undefined && value !== null)
      .map((value) => String(value).replace(/\b(?:sk-or-v1|sk|xai)-[A-Za-z0-9._-]+\b/gi, '[REDACTED]'))
      .join(':')
      .slice(0, 320);
    throw new Error(
      `KIMI_${expected.tier.toUpperCase()}_HTTP_${result.response.status}${diagnostic ? `:${diagnostic}` : ''}`
    );
  }
  const choice = body?.choices?.[0];
  const toolCall = choice?.message?.tool_calls?.[0];
  let args = null;
  try {
    args = JSON.parse(toolCall?.function?.arguments || 'null');
  } catch {
    args = null;
  }
  const valid =
    result.response.ok &&
    typeof body?.model === 'string' &&
    body.model.includes(expected.modelFragment) &&
    choice?.finish_reason === 'tool_calls' &&
    toolCall?.function?.name === 'multiply' &&
    args?.a === 6 &&
    args?.b === 7;
  if (!valid) {
    const diagnostic = JSON.stringify({
      model: typeof body?.model === 'string' ? body.model.slice(0, 120) : null,
      finish_reason: typeof choice?.finish_reason === 'string' ? choice.finish_reason.slice(0, 40) : null,
      tool_name: typeof toolCall?.function?.name === 'string' ? toolCall.function.name.slice(0, 80) : null,
      arguments_valid: args?.a === 6 && args?.b === 7,
      tool_call_count: Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls.length : 0,
      error:
        typeof body?.error === 'string'
          ? body.error.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80)
          : body?.error && typeof body.error === 'object' && !Array.isArray(body.error)
            ? {
                code:
                  typeof body.error.code === 'string'
                    ? body.error.code.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80)
                    : null,
                message:
                  typeof body.error.message === 'string'
                    ? body.error.message
                        .replace(/\b(?:sk-or-v1|sk|xai)-[A-Za-z0-9._-]+\b/gi, '[REDACTED]')
                        .replace(/\s+/g, ' ')
                        .slice(0, 160)
                    : null,
              }
            : null,
      reason_code:
        typeof body?.reason_code === 'string' ? body.reason_code.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) : null,
      upstream_status: Number.isInteger(body?.upstream_status) ? body.upstream_status : null,
      response_keys:
        body && typeof body === 'object' && !Array.isArray(body)
          ? Object.keys(body)
              .filter((key) => /^[A-Za-z0-9_]{1,40}$/.test(key))
              .slice(0, 20)
          : [],
    });
    throw new Error(`KIMI_${expected.tier.toUpperCase()}_BAD_RESPONSE_HTTP_${result.response.status}:${diagnostic}`);
  }
  return {
    ok: true,
    http_status: result.response.status,
    tier: expected.tier,
    model: body.model,
    finish_reason: choice.finish_reason,
    tool_name: toolCall.function.name,
    tool_arguments_verified: true,
    usage: {
      prompt_tokens: body?.usage?.prompt_tokens,
      completion_tokens: body?.usage?.completion_tokens,
      total_tokens: body?.usage?.total_tokens,
    },
  };
}

async function runKimiAgentSmoke(licenseWire, expected) {
  const result = await postJson(
    EVE_INFERENCE_FUNCTION_URL,
    {
      tier: expected.tier,
      stream: false,
      messages: [
        {
          role: 'user',
          content: 'Call multiply exactly once with a=6 and b=7. Do not answer in prose.',
        },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'multiply',
            description: 'Multiply two integers.',
            parameters: {
              type: 'object',
              properties: {
                a: { type: 'integer' },
                b: { type: 'integer' },
              },
              required: ['a', 'b'],
              additionalProperties: false,
            },
          },
        },
      ],
      tool_choice: 'auto',
    },
    licenseWire,
    150_000
  );
  return summarizeKimi(result, expected);
}

function summarizeCreditsStatus(result) {
  const body = result.body;
  const valid =
    result.response.ok &&
    ['free', 'solo', 'starter'].includes(body?.tier) &&
    Number.isFinite(body?.included_allowance_credits_remaining) &&
    body.included_allowance_credits_remaining >= 0 &&
    Number.isFinite(body?.purchased_credits_remaining) &&
    body.purchased_credits_remaining >= 0;
  if (!valid) throw new Error(`CREDITS_STATUS_BAD_RECEIPT_HTTP_${result.response.status}`);
  return {
    ok: true,
    tier: body.tier,
    included_allowance_credits_remaining: body.included_allowance_credits_remaining,
    purchased_credits_remaining: body.purchased_credits_remaining,
    has_active_topup: body.has_active_topup === true,
    metered_cloud_levels_available:
      body.has_active_topup === true ||
      body.tier !== 'free' ||
      body.included_allowance_credits_remaining > 0 ||
      body.purchased_credits_remaining > 0,
  };
}

async function run() {
  if (!['all', 'credits', 'pdf', 'inference', 'kimi', 'maximum', 'ultra'].includes(SMOKE_MODE)) {
    throw new Error('LIVE_SMOKE_BAD_MODE');
  }
  const licenseWire = await loadLicenseWire();
  let creditsStatus;
  if (SMOKE_MODE === 'all' || SMOKE_MODE === 'credits') {
    creditsStatus = summarizeCreditsStatus(await getJson(CREDITS_STATUS_FUNCTION_URL, licenseWire, 30_000));
  }
  let pdfOcr;
  if (SMOKE_MODE === 'all' || SMOKE_MODE === 'pdf') {
    const pdfBytes = createImageOnlyPdf();
    const pdfSha256 = crypto.createHash('sha256').update(pdfBytes).digest('hex');
    const result = await postJson(
      EVE_MULTIMODAL_FUNCTION_URL,
      {
        provider: 'openrouter',
        capability: 'document_ocr',
        privacyLane: 'cloud_auto',
        directProviderKeyPresentInDesktop: false,
        file_name: 'command-eve-1814-live-gate.pdf',
        file_sha256: pdfSha256,
        page_count: 1,
        file_data_base64: pdfBytes.toString('base64'),
        requestId: `pdf-1814-live-${Date.now()}`,
      },
      licenseWire,
      120_000
    );
    pdfOcr = summarizePdfOcr(result, pdfSha256);
  }

  let inferenceTiers;
  if (SMOKE_MODE === 'all' || SMOKE_MODE === 'inference') {
    inferenceTiers = [];
    for (const tier of INFERENCE_TIERS) {
      inferenceTiers.push(await runInferenceTierSmoke(licenseWire, tier));
    }
  }

  let kimiMaximum;
  if (SMOKE_MODE === 'all' || SMOKE_MODE === 'maximum') {
    kimiMaximum = await runKimiAgentSmoke(licenseWire, KIMI_AGENT_TIERS[0]);
  }
  let kimiUltra;
  if (SMOKE_MODE === 'all' || SMOKE_MODE === 'kimi' || SMOKE_MODE === 'ultra') {
    kimiUltra = await runKimiAgentSmoke(licenseWire, KIMI_AGENT_TIERS[1]);
  }

  return {
    ok: true,
    version: 'command-eve-1814-live-smoke/v1',
    mode: SMOKE_MODE,
    credential_exposed: false,
    provider_key_in_desktop: false,
    ...(creditsStatus ? { credits_status: creditsStatus } : {}),
    ...(pdfOcr ? { pdf_ocr: pdfOcr } : {}),
    ...(inferenceTiers ? { inference_tiers: inferenceTiers, free_lane_model_route_covered_by: 'standard' } : {}),
    ...(kimiMaximum ? { kimi_maximum: kimiMaximum } : {}),
    ...(kimiUltra ? { kimi_ultra: kimiUltra } : {}),
  };
}

try {
  const result = await run();
  print(result);
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  print(fail('LIVE_SMOKE_FAILED', error instanceof Error ? error.message : error));
  process.exitCode = 1;
}
