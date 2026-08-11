import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMAND_EVE_E2E_PACKAGED_ATTACHMENT_MARKER } from '../../../packages/desktop/src/common/platform/userDataPath';
import {
  COMMAND_EVE_PACKAGED_QA_ATTACHMENT_ENV,
  commandEvePackagedQaLaunchEnv,
  requireCommandEvePackagedQaAttachment,
} from '../../../scripts/command-eve/ttft/packaged-qa-attachment';

const makeResourcesDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-ttft-qa-attachment-'));

const writeManifest = (resourcesDir: string): string => {
  const manifestPath = path.join(resourcesDir, 'command-eve-runtime-bootstrap.json');
  fs.writeFileSync(manifestPath, '{"release":"1.822.2"}\n', 'utf8');
  return manifestPath;
};

describe('Command EVE TTFT packaged QA attachment', () => {
  it('returns marker proof when the baked marker sits beside the runtime manifest', () => {
    const resourcesDir = makeResourcesDir();
    const manifestPath = writeManifest(resourcesDir);
    fs.writeFileSync(
      path.join(resourcesDir, COMMAND_EVE_E2E_PACKAGED_ATTACHMENT_MARKER),
      'non-distributable-playwright-attachment\n',
      'utf8'
    );

    const proof = requireCommandEvePackagedQaAttachment(manifestPath);

    expect(proof.marker).toBe(COMMAND_EVE_E2E_PACKAGED_ATTACHMENT_MARKER);
    expect(proof.markerPath).toBe(path.join(resourcesDir, COMMAND_EVE_E2E_PACKAGED_ATTACHMENT_MARKER));
    expect(proof.verifiedAtEpochMs).toBeGreaterThan(0);
  });

  it('fails closed before launch when the marker is absent', () => {
    const resourcesDir = makeResourcesDir();
    const manifestPath = writeManifest(resourcesDir);

    expect(() => requireCommandEvePackagedQaAttachment(manifestPath)).toThrowError(
      /Non-distributable packaged-QA marker is missing.*COMMAND_EVE_E2E_PACKAGED_BUILD=1/s
    );
  });

  it('requires the marker in the manifest directory, not anywhere else on disk', () => {
    const resourcesDir = makeResourcesDir();
    const manifestPath = writeManifest(resourcesDir);
    const elsewhere = makeResourcesDir();
    fs.writeFileSync(path.join(elsewhere, COMMAND_EVE_E2E_PACKAGED_ATTACHMENT_MARKER), 'decoy\n', 'utf8');

    expect(() => requireCommandEvePackagedQaAttachment(manifestPath)).toThrowError(/marker is missing/);
  });

  it('keeps the raw-flag warning in the failure message so production CDP stays fail-closed', () => {
    const resourcesDir = makeResourcesDir();
    const manifestPath = writeManifest(resourcesDir);

    expect(() => requireCommandEvePackagedQaAttachment(manifestPath)).toThrowError(
      /Raw AIONUI_E2E_TEST or COMMAND_EVE_E2E_PACKAGED_ATTACHMENT flags must not enable packaged CDP\./
    );
  });

  it('supplies both runtime authorization flags for packaged launches only', () => {
    expect(commandEvePackagedQaLaunchEnv(true)).toEqual({
      AIONUI_E2E_TEST: '1',
      COMMAND_EVE_E2E_PACKAGED_ATTACHMENT: '1',
    });
    expect(commandEvePackagedQaLaunchEnv(false)).toEqual({});
  });

  it('uses exactly the flag values the runtime gate checks', () => {
    expect(COMMAND_EVE_PACKAGED_QA_ATTACHMENT_ENV).toEqual({
      AIONUI_E2E_TEST: '1',
      COMMAND_EVE_E2E_PACKAGED_ATTACHMENT: '1',
    });
  });
});
