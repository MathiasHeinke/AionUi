#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { activateEntitlement, registerTenant } from '../../packages/desktop/src/process/commandEve/entitlementCore';

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || '' : '';
}

function writeAtomicJson(filePath: string, value: unknown): void {
  const absolutePath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, absolutePath);
}

function main(): void {
  const userDataPath = argument('--data');
  const outputPath = argument('--out');
  const wire = process.env.COMMAND_EVE_PHASE_A_LICENSE?.trim() || '';
  if (!userDataPath || !outputPath) throw new Error('--data and --out are required');
  if (!wire) throw new Error('COMMAND_EVE_PHASE_A_LICENSE is unavailable');

  const options = {
    userDataPath: path.resolve(userDataPath),
    bundledPublicKeyPath: path.resolve('public/command-eve-license-public-key.pem'),
  };
  const registration = registerTenant(
    {
      name: 'Phase A Runner',
      company: 'Command EVE Windows Proof',
      email: 'windows-phase-a@example.invalid',
      consent: true,
    },
    options
  );
  const activation = registration.ok ? activateEntitlement({ code: wire }, options) : null;
  const result = {
    schema_version: 'command-eve-phase-a-seat-provision/v1',
    registration_ok: registration.ok,
    registration_reason_code: registration.reason_code || null,
    entitlement_activation_ok: activation?.ok === true,
    entitlement_reason_code: activation?.reason_code || null,
    completion_sentinel: 'WIN_PHASE_A_SEAT_PROVISION_COMPLETE',
  };
  writeAtomicJson(outputPath, result);
  if (!result.registration_ok || !result.entitlement_activation_ok) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    main();
  } catch (error) {
    console.error(`[provision-phase-a-test-seat] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
