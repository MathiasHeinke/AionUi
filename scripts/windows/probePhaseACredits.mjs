#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const CREDITS_STATUS_FUNCTION_URL = 'https://unvbeothoimlzlolxucl.supabase.co/functions/v1/credits-status';
const CREDITS_TIERS = new Set(['free', 'solo', 'starter']);

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || '' : '';
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function writeAtomicJson(filePath, value) {
  const absolutePath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, absolutePath);
}

async function main() {
  const outputPath = argument('--out');
  const wire = process.env.COMMAND_EVE_PHASE_A_LICENSE?.trim() || '';
  if (!outputPath) throw new Error('--out is required');
  if (!wire) throw new Error('COMMAND_EVE_PHASE_A_LICENSE is unavailable');

  const response = await fetch(CREDITS_STATUS_FUNCTION_URL, {
    method: 'GET',
    headers: { Authorization: `Bearer ${wire}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  const raw = await response.json().catch(() => null);
  const valid =
    response.ok &&
    raw &&
    CREDITS_TIERS.has(raw.tier) &&
    finiteNonNegative(raw.included_allowance_credits_remaining) &&
    finiteNonNegative(raw.purchased_credits_remaining) &&
    finiteNonNegative(raw.free_actions_used_this_period) &&
    finiteNonNegative(raw.free_cap) &&
    typeof raw.period_start === 'string' &&
    raw.period_start.length > 0;
  const result = valid
    ? {
        ok: true,
        tier: raw.tier,
        included_allowance_credits_remaining: raw.included_allowance_credits_remaining,
        purchased_credits_remaining: raw.purchased_credits_remaining,
        free_actions_used_this_period: raw.free_actions_used_this_period,
        free_cap: raw.free_cap,
        period_start: raw.period_start,
      }
    : { ok: false, http_status: response.status };
  writeAtomicJson(outputPath, result);
  if (!valid) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[probe-phase-a-credits] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
