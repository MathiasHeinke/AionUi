import assert from 'node:assert/strict';
import test from 'node:test';

import { scanForPrivateKeys } from './verify-no-private-keys.mjs';

const PEM_PRIVATE = '-----BEGIN PRIVATE KEY-----\nMIIBogIBAAJBALe0\n-----END PRIVATE KEY-----\n';
const PEM_PUBLIC = '-----BEGIN PUBLIC KEY-----\nMIIBogIBAAJBALe0\n-----END PUBLIC KEY-----\n';

// In-memory fs surface: walk() receives a flat root whose entries are the
// given filenames; statSize/readText serve the mapped contents.
function depsFor(files) {
  return {
    readdir: (dir) => Object.keys(files).map((name) => ({ name, isDirectory: () => false, isFile: () => true })),
    statSize: (file) => files[file.split('/').pop()].length,
    readText: (file) => files[file.split('/').pop()],
  };
}

test('flags a private key renamed to a .txt file (F-10)', () => {
  const findings = scanForPrivateKeys(['root'], depsFor({ 'license.txt': PEM_PRIVATE }));
  assert.equal(findings.length, 1);
  assert.match(findings[0].reason, /renamed text file/);
});

test('flags a private key renamed to a .dat file (F-10)', () => {
  const findings = scanForPrivateKeys(['root'], depsFor({ 'keys.dat': PEM_PRIVATE }));
  assert.equal(findings.length, 1);
});

test('does not flag documentation that merely quotes the header inline', () => {
  const doc = 'How to rotate keys:\n\nRun `openssl genrsa` and you get a -----BEGIN PRIVATE KEY----- block.\n';
  const findings = scanForPrivateKeys(['root'], depsFor({ 'README.txt': doc }));
  assert.equal(findings.length, 0);
});

test('does not flag a public key in a .txt file', () => {
  const findings = scanForPrivateKeys(['root'], depsFor({ 'pubkey.txt': PEM_PUBLIC }));
  assert.equal(findings.length, 0);
});

test('content-scans real key-file extensions anywhere in the file', () => {
  const padded = `-----BEGIN PRIVATE KEY-----\nMIIBogIBAAJBALe0\n-----END PRIVATE KEY-----\n`;
  const findings = scanForPrivateKeys(['root'], depsFor({ 'backup.pem': padded }));
  assert.equal(findings.length, 1);
  assert.match(findings[0].reason, /PRIVATE KEY material/);
});

test('flags the private signing-key filename pattern regardless of content', () => {
  const findings = scanForPrivateKeys(['root'], depsFor({ 'license-signing.key': 'not even a pem\n' }));
  assert.equal(findings.length, 1);
  assert.match(findings[0].reason, /filename/);
});

test('ignores oversized text files (not key-shaped)', () => {
  const findings = scanForPrivateKeys(['root'], depsFor({ 'big.txt': `${'x'.repeat(64 * 1024)}\n${PEM_PRIVATE}` }));
  assert.equal(findings.length, 0);
});
