import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  inspectFinalAioncoreArtifact,
  verifyFinalAioncoreArtifactReceipt,
  writeFinalAioncoreArtifactReceipt,
} = require('../../../scripts/finalAioncoreArtifactReceipt.js');

describe('final AionCore artifact receipt', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  });

  function makeFixture(options: { scope?: string } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-final-aioncore-'));
    tempDirs.push(root);
    const outDir = path.join(root, 'out');
    const appPath = path.join(outDir, 'mac-arm64', 'Command EVE.app');
    const runtimeDir = path.join(appPath, 'Contents', 'Resources', 'bundled-aioncore', 'darwin-arm64');
    fs.mkdirSync(runtimeDir, { recursive: true });
    const binaryPath = path.join(runtimeDir, 'aioncore');
    fs.writeFileSync(binaryPath, 'developer-id-signed-final-bytes');
    const preSignBinarySha256 = createHash('sha256').update('verified-pre-sign-input').digest('hex');
    fs.writeFileSync(
      path.join(runtimeDir, 'manifest.json'),
      JSON.stringify({
        platform: 'darwin',
        arch: 'arm64',
        version: 'v0.1.37',
        sourceType: 'command-eve-local-build',
        source: { commit: '73f27b5' },
        sourceSha256: preSignBinarySha256,
        binarySha256: preSignBinarySha256,
        preSignBinarySha256,
        binarySha256Scope: options.scope ?? 'pre-sign-input',
      })
    );
    return { root, outDir, appPath, binaryPath, preSignBinarySha256 };
  }

  const deps = {
    now: new Date('2026-07-10T21:30:00Z'),
    verifyCodeSignature: () => undefined,
  };

  it('separates verified pre-sign provenance from the signed delivery hash outside the app seal', () => {
    const fixture = makeFixture();
    const receiptPath = writeFinalAioncoreArtifactReceipt(
      { appPath: fixture.appPath, outDir: fixture.outDir, version: '1.7.92', productName: 'Command EVE' },
      deps
    );
    const receiptText = fs.readFileSync(receiptPath, 'utf8');
    const receipt = JSON.parse(receiptText);

    expect(receiptPath.startsWith(fixture.appPath)).toBe(false);
    expect(receiptText).not.toContain(fixture.root);
    expect(receipt.aioncore.preSignBinarySha256).toBe(fixture.preSignBinarySha256);
    expect(receipt.aioncore.finalArtifactSha256).toBe(
      createHash('sha256').update(fs.readFileSync(fixture.binaryPath)).digest('hex')
    );
    expect(receipt.aioncore.finalArtifactSha256).not.toBe(receipt.aioncore.preSignBinarySha256);
    expect(receipt.integrity).toEqual({
      manifestHashScope: 'pre-sign-input',
      finalArtifactHashScope: 'post-sign-delivery-artifact',
      signingChangedBytes: true,
    });
    expect(() =>
      verifyFinalAioncoreArtifactReceipt(
        { appPath: fixture.appPath, outDir: fixture.outDir, version: '1.7.92', productName: 'Command EVE' },
        deps
      )
    ).not.toThrow();
  });

  it('fails closed when the signed AionCore changes after the receipt is written', () => {
    const fixture = makeFixture();
    const options = {
      appPath: fixture.appPath,
      outDir: fixture.outDir,
      version: '1.7.92',
      productName: 'Command EVE',
    };
    writeFinalAioncoreArtifactReceipt(options, deps);
    fs.appendFileSync(fixture.binaryPath, '-tampered');

    expect(() => verifyFinalAioncoreArtifactReceipt(options, deps)).toThrow(
      /receipt does not match the signed app bytes/
    );
  });

  it('refuses an ambiguous legacy manifest that presents its hash without a pre-sign scope', () => {
    const fixture = makeFixture({ scope: 'final-artifact' });

    expect(() =>
      inspectFinalAioncoreArtifact(
        { appPath: fixture.appPath, outDir: fixture.outDir, version: '1.7.92', productName: 'Command EVE' },
        deps
      )
    ).toThrow(/binarySha256Scope must be pre-sign-input/);
  });

  it('requires a verifiable code signature before issuing a final receipt', () => {
    const fixture = makeFixture();

    expect(() =>
      writeFinalAioncoreArtifactReceipt(
        { appPath: fixture.appPath, outDir: fixture.outDir, version: '1.7.92', productName: 'Command EVE' },
        {
          now: deps.now,
          verifyCodeSignature: () => {
            throw new Error('invalid signature');
          },
        }
      )
    ).toThrow(/invalid signature/);
  });
});
