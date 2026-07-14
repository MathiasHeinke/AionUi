#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || '' : '';
}

function writeAtomicJson(filePath, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(temporaryPath, filePath);
}

async function main() {
  const userDataPath = argument('--data');
  const outputPath = argument('--out');
  const wire = String(process.env.COMMAND_EVE_PHASE_A_LICENSE || '').trim();
  if (!userDataPath || !outputPath) throw new Error('--data and --out are required');
  if (!wire) throw new Error('COMMAND_EVE_PHASE_A_LICENSE is unavailable');

  // safeStorage's Windows key material belongs to Electron's userData profile.
  // Bind the seeder to the same profile root the packaged app receives through
  // --user-data-dir, otherwise the app cannot decrypt this ciphertext.
  const profileRoot = path.dirname(path.resolve(userDataPath));
  app.setPath('userData', profileRoot);
  await app.whenReady();
  const profileBindingVerified = path.resolve(app.getPath('userData')).toLowerCase() === profileRoot.toLowerCase();
  if (!profileBindingVerified) throw new Error('Windows safeStorage seeder did not bind to the packaged app profile');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows safeStorage encryption is unavailable');
  const wireRef = `keychain:v1:${safeStorage.encryptString(wire).toString('base64')}`;
  const licensePath = path.resolve(userDataPath, 'command-eve-runtime', 'entitlement', 'license-wire.json');
  const record = {
    version: 'command-eve-license-wire/v0',
    wire_ref: wireRef,
    stored_at: new Date().toISOString(),
  };
  writeAtomicJson(licensePath, record);

  const decrypted = safeStorage.decryptString(Buffer.from(wireRef.slice('keychain:v1:'.length), 'base64'));
  const serialized = fs.readFileSync(licensePath, 'utf8');
  writeAtomicJson(path.resolve(outputPath), {
    schema_version: 'command-eve-phase-a-license-wire-proof/v1',
    profile_binding_verified: profileBindingVerified,
    encrypted_license_wire_present: wireRef.startsWith('keychain:v1:'),
    round_trip_verified: decrypted === wire,
    plaintext_license_wire_present: serialized.includes(wire),
    completion_sentinel: 'WIN_PHASE_A_LICENSE_WIRE_PROOF_COMPLETE',
  });
}

main()
  .then(() => app.quit())
  .catch((error) => {
    console.error(`[seed-phase-a-license] ${error instanceof Error ? error.message : String(error)}`);
    app.exit(1);
  });
