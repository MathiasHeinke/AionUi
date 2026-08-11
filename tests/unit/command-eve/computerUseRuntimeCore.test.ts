import {
  COMMAND_EVE_CUA_DRIVER_PIN,
  grantCommandEveComputerUsePermissions,
  installCommandEveComputerUseDriver,
  issueCommandEveComputerUseNativeIntent,
  readCommandEveComputerUseStatus,
  revokeCommandEveComputerUsePermissionsGuide,
  type CommandEveComputerUseRunner,
} from '@/process/commandEve/computerUseRuntimeCore';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const roots: string[] = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-computer-use-'));
  roots.push(root);
  const hermesRoot = path.join(root, 'command-eve-runtime', 'hermes');
  const hermes = path.join(hermesRoot, 'hermes');
  const python = path.join(hermesRoot, 'venv', 'bin', 'python');
  const driver = path.join(root, 'cua-driver');
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.writeFileSync(hermes, 'hermes-fixture');
  fs.writeFileSync(python, 'python-fixture');
  fs.writeFileSync(driver, 'driver-fixture');
  return { root, hermes, python, driver };
}

function fixtureTrust(fx: ReturnType<typeof fixture>) {
  return {
    testTrust: {
      executableSha256: crypto.createHash('sha256').update(fs.readFileSync(fx.driver)).digest('hex'),
      identity: 'com.trycua.driver',
      teamIdentifier: 'CUAFIXTURE',
    },
  };
}

function doctorPayload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ schema_version: '1', overall: 'ok', checks: [], ...overrides });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Computer Use runtime adapter', () => {
  it('combines Hermes permission state, doctor and exact binary provenance', async () => {
    const fx = fixture();
    const runner: CommandEveComputerUseRunner = async (command, args) => {
      if (command === fx.python) {
        return {
          status: 0,
          stdout: JSON.stringify({ path: fx.driver, resolution: 'HERMES_CUA_DRIVER_CMD' }),
          stderr: '',
        };
      }
      if (command === '/usr/bin/codesign') {
        return {
          status: 0,
          stdout: '',
          stderr: 'Identifier=com.trycua.driver\nTeamIdentifier=CUAFIXTURE',
        };
      }
      if (args.includes('doctor')) {
        return {
          status: 0,
          stdout: doctorPayload({
            driver_version: `cua-driver ${COMMAND_EVE_CUA_DRIVER_PIN}`,
            checks: [{ name: 'bundle_identity', status: 'pass', message: 'signed' }],
          }),
          stderr: '',
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          platform: 'darwin',
          platform_supported: true,
          installed: true,
          version: `cua-driver ${COMMAND_EVE_CUA_DRIVER_PIN}`,
          ready: true,
          can_grant: true,
          accessibility: true,
          screen_recording: true,
          screen_recording_capturable: true,
          checks: [],
        }),
        stderr: '',
      };
    };

    const result = await readCommandEveComputerUseStatus({
      userDataPath: fx.root,
      platform: 'darwin',
      runner,
      env: { HERMES_CUA_DRIVER_CMD: fx.driver },
      ...fixtureTrust(fx),
    });

    expect(result).toMatchObject({ ok: true, state: 'ready', installed: true, ready: true });
    expect(result.provenance).toMatchObject({
      resolution: 'HERMES_CUA_DRIVER_CMD',
      driver_version: `cua-driver ${COMMAND_EVE_CUA_DRIVER_PIN}`,
      identity: 'com.trycua.driver',
      team_identifier: 'CUAFIXTURE',
      signature_valid: true,
      checksum_verified: true,
    });
    expect(result.provenance.executable_sha256).toBe(
      crypto.createHash('sha256').update('driver-fixture').digest('hex')
    );
    expect(result.provenance.expected_executable_sha256).toBe(result.provenance.executable_sha256);
    expect(result.checks).toContainEqual({ label: 'bundle_identity', status: 'pass', message: 'signed' });
  });

  it('reports a parsed missing-driver state as actionable instead of a bridge failure', async () => {
    const fx = fixture();
    const runner: CommandEveComputerUseRunner = async (command) => ({
      status: 1,
      stdout:
        command === fx.python
          ? JSON.stringify({ path: null, resolution: 'PATH_OR_CANONICAL_LOCATION' })
          : JSON.stringify({
              platform: 'darwin',
              platform_supported: true,
              installed: false,
              ready: null,
              can_grant: true,
              checks: [],
            }),
      stderr: '',
    });

    const result = await readCommandEveComputerUseStatus({ userDataPath: fx.root, platform: 'darwin', runner });
    expect(result).toMatchObject({
      ok: true,
      state: 'needs_install',
      installed: false,
      reason_code: 'CUA_DRIVER_MISSING',
    });
  });

  it('pins the upstream installer and keeps revoke OS-owned', async () => {
    const fx = fixture();
    const runner = vi.fn<CommandEveComputerUseRunner>(async (command, args) => {
      if (command === fx.python) {
        return {
          status: 0,
          stdout: JSON.stringify({ path: fx.driver, resolution: 'HERMES_CUA_DRIVER_CMD' }),
          stderr: '',
        };
      }
      if (command === '/usr/bin/codesign') {
        return { status: 0, stdout: '', stderr: 'Identifier=com.trycua.driver\nTeamIdentifier=CUAFIXTURE' };
      }
      if (args.includes('doctor')) {
        return { status: 0, stdout: doctorPayload(), stderr: '' };
      }
      if (args.includes('permissions')) {
        return {
          status: 0,
          stdout: JSON.stringify({
            platform: 'darwin',
            platform_supported: true,
            installed: true,
            version: `cua-driver ${COMMAND_EVE_CUA_DRIVER_PIN}`,
            ready: true,
            can_grant: true,
            accessibility: true,
            screen_recording: true,
            screen_recording_capturable: true,
            checks: [],
          }),
          stderr: '',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    const installed = await installCommandEveComputerUseDriver({
      userDataPath: fx.root,
      platform: 'darwin',
      runner,
      nativeIntent: issueCommandEveComputerUseNativeIntent('install', { seatId: 'seat-a', revision: 1 }),
      ...fixtureTrust(fx),
    });
    expect(installed).toMatchObject({ ok: true, state: 'ready' });
    const installCall = runner.mock.calls.find((call) => call[1].includes('install'));
    expect(installCall?.[1]).toEqual(['computer-use', 'install', '--upgrade']);
    expect(installCall?.[2].env.CUA_DRIVER_RS_VERSION).toBe(COMMAND_EVE_CUA_DRIVER_PIN);

    expect(revokeCommandEveComputerUsePermissionsGuide()).toMatchObject({
      ok: false,
      state: 'needs_user',
      reason_code: 'COMPUTER_USE_REVOKE_OS_OWNED',
    });
  });

  it('fails closed when an installed driver has an unknown version or macOS identity', async () => {
    const fx = fixture();
    const runner: CommandEveComputerUseRunner = async (command, args) => {
      if (command === fx.python) {
        return {
          status: 0,
          stdout: JSON.stringify({ path: fx.driver, resolution: 'HERMES_CUA_DRIVER_CMD' }),
          stderr: '',
        };
      }
      if (command === '/usr/bin/codesign') {
        return args.includes('-dv')
          ? { status: 0, stdout: '', stderr: 'Identifier=com.example.untrusted\nTeamIdentifier=UNKNOWN' }
          : { status: 0, stdout: '', stderr: '' };
      }
      if (args.includes('doctor')) return { status: 0, stdout: doctorPayload(), stderr: '' };
      return {
        status: 0,
        stdout: JSON.stringify({
          platform: 'darwin',
          platform_supported: true,
          installed: true,
          version: 'cua-driver 0.99.0',
          ready: true,
          can_grant: true,
          accessibility: true,
          screen_recording: true,
          screen_recording_capturable: true,
          checks: [],
        }),
        stderr: '',
      };
    };

    await expect(
      readCommandEveComputerUseStatus({ userDataPath: fx.root, platform: 'darwin', runner })
    ).resolves.toMatchObject({
      ok: true,
      ready: false,
      state: 'needs_user',
      reason_code: 'CUA_DRIVER_VERSION_MISMATCH',
    });
    await expect(
      grantCommandEveComputerUsePermissions({ userDataPath: fx.root, platform: 'darwin', runner })
    ).resolves.toMatchObject({
      ok: false,
      state: 'blocked',
      reason_code: 'COMPUTER_USE_CONFIRMATION_REQUIRED',
    });
    await expect(
      grantCommandEveComputerUsePermissions({
        userDataPath: fx.root,
        platform: 'darwin',
        runner,
        nativeIntent: issueCommandEveComputerUseNativeIntent('grant', { seatId: 'seat-a', revision: 1 }),
      })
    ).resolves.toMatchObject({
      ok: false,
      state: 'blocked',
      reason_code: 'CUA_DRIVER_PROVENANCE_MISMATCH',
    });
  });

  it('rejects a locally forged binary even when its reported version and identity look correct', async () => {
    const fx = fixture();
    const runner: CommandEveComputerUseRunner = async (command, args) => {
      if (command === fx.python) {
        return {
          status: 0,
          stdout: JSON.stringify({ path: fx.driver, resolution: 'HERMES_CUA_DRIVER_CMD' }),
          stderr: '',
        };
      }
      if (command === '/usr/bin/codesign') {
        return args.includes('-dv')
          ? {
              status: 0,
              stdout: '',
              stderr: 'Identifier=com.trycua.driver\nTeamIdentifier=YCK386LBJ7',
            }
          : { status: 0, stdout: '', stderr: '' };
      }
      if (args.includes('doctor')) return { status: 0, stdout: doctorPayload(), stderr: '' };
      return {
        status: 0,
        stdout: JSON.stringify({
          platform: 'darwin',
          platform_supported: true,
          installed: true,
          version: `cua-driver ${COMMAND_EVE_CUA_DRIVER_PIN}`,
          ready: true,
          can_grant: true,
          accessibility: true,
          screen_recording: true,
          screen_recording_capturable: true,
          checks: [],
        }),
        stderr: '',
      };
    };

    await expect(
      readCommandEveComputerUseStatus({ userDataPath: fx.root, platform: 'darwin', arch: 'arm64', runner })
    ).resolves.toMatchObject({
      ready: false,
      state: 'needs_user',
      reason_code: 'CUA_DRIVER_CHECKSUM_MISMATCH',
      provenance: {
        checksum_verified: false,
        signature_valid: true,
        identity: 'com.trycua.driver',
        team_identifier: 'YCK386LBJ7',
      },
    });
  });

  it('requires a fresh one-shot MAIN intent before install', async () => {
    const fx = fixture();
    const runner = vi.fn<CommandEveComputerUseRunner>(async () => ({
      status: 1,
      stdout: '',
      stderr: 'fixture installer refused',
    }));
    const intent = issueCommandEveComputerUseNativeIntent('install', { seatId: 'seat-a', revision: 3 });

    await expect(
      installCommandEveComputerUseDriver({ userDataPath: fx.root, platform: 'darwin', runner })
    ).resolves.toMatchObject({ reason_code: 'COMPUTER_USE_CONFIRMATION_REQUIRED' });
    await expect(
      installCommandEveComputerUseDriver({
        userDataPath: fx.root,
        platform: 'darwin',
        runner,
        nativeIntent: intent,
      })
    ).resolves.toMatchObject({ reason_code: 'COMPUTER_USE_NATIVE_ACTION_FAILED' });
    await expect(
      installCommandEveComputerUseDriver({
        userDataPath: fx.root,
        platform: 'darwin',
        runner,
        nativeIntent: intent,
      })
    ).resolves.toMatchObject({ reason_code: 'COMPUTER_USE_CONFIRMATION_REQUIRED' });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: 'degraded report',
      doctor: { status: 1, stdout: doctorPayload({ overall: 'degraded' }), stderr: '' },
    },
    {
      label: 'unknown schema',
      doctor: {
        status: 0,
        stdout: JSON.stringify({ schema_version: 'future', overall: 'ok', checks: [] }),
        stderr: '',
      },
    },
  ])('never reports ready when doctor has a $label', async ({ doctor }) => {
    const fx = fixture();
    const runner: CommandEveComputerUseRunner = async (command, args) => {
      if (command === fx.python) {
        return {
          status: 0,
          stdout: JSON.stringify({ path: fx.driver, resolution: 'HERMES_CUA_DRIVER_CMD' }),
          stderr: '',
        };
      }
      if (command === '/usr/bin/codesign') {
        return { status: 0, stdout: '', stderr: 'Identifier=com.trycua.driver\nTeamIdentifier=CUAFIXTURE' };
      }
      if (args.includes('doctor')) return doctor;
      return {
        status: 0,
        stdout: JSON.stringify({
          platform: 'darwin',
          platform_supported: true,
          installed: true,
          version: `cua-driver ${COMMAND_EVE_CUA_DRIVER_PIN}`,
          ready: true,
          can_grant: true,
          accessibility: true,
          screen_recording: true,
          screen_recording_capturable: true,
          checks: [],
        }),
        stderr: '',
      };
    };

    const result = await readCommandEveComputerUseStatus({
      userDataPath: fx.root,
      platform: 'darwin',
      runner,
      ...fixtureTrust(fx),
    });

    expect(result).toMatchObject({
      ok: true,
      ready: false,
      state: 'needs_user',
      reason_code: 'COMPUTER_USE_DOCTOR_FAILED',
    });
    expect(result.checks).toContainEqual(expect.objectContaining({ label: 'doctor', status: 'fail' }));
  });

  it('keeps a known macOS TCC degradation actionable as needs_permission', async () => {
    const fx = fixture();
    const runner: CommandEveComputerUseRunner = async (command, args) => {
      if (command === fx.python) {
        return {
          status: 0,
          stdout: JSON.stringify({ path: fx.driver, resolution: 'HERMES_CUA_DRIVER_CMD' }),
          stderr: '',
        };
      }
      if (command === '/usr/bin/codesign') {
        return { status: 0, stdout: '', stderr: 'Identifier=com.trycua.driver\nTeamIdentifier=CUAFIXTURE' };
      }
      if (args.includes('doctor')) {
        return {
          status: 1,
          stdout: doctorPayload({
            overall: 'degraded',
            checks: [{ name: 'tcc_accessibility', status: 'fail', message: 'permission denied' }],
          }),
          stderr: '',
        };
      }
      return {
        status: 1,
        stdout: JSON.stringify({
          platform: 'darwin',
          platform_supported: true,
          installed: true,
          version: `cua-driver ${COMMAND_EVE_CUA_DRIVER_PIN}`,
          ready: false,
          can_grant: true,
          accessibility: false,
          screen_recording: false,
          screen_recording_capturable: false,
          checks: [],
        }),
        stderr: '',
      };
    };

    const result = await readCommandEveComputerUseStatus({
      userDataPath: fx.root,
      platform: 'darwin',
      runner,
      ...fixtureTrust(fx),
    });

    expect(result).toMatchObject({
      ok: true,
      ready: false,
      state: 'needs_permission',
      reason_code: 'COMPUTER_USE_NEEDS_PERMISSION',
    });
  });

  it('keeps both renderer-facing actions behind the native MAIN dialog', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'packages/desktop/src/process/bridge/commandEveBridge.ts'),
      'utf8'
    );
    const install = source.slice(
      source.indexOf("buildProvider('command-eve.computer-use-install')"),
      source.indexOf("buildProvider('command-eve.computer-use-permissions-grant')")
    );
    const grant = source.slice(
      source.indexOf("buildProvider('command-eve.computer-use-permissions-grant')"),
      source.indexOf("buildProvider('command-eve.computer-use-permissions-revoke-guide')")
    );
    expect(source).toContain('nativeDialog.showMessageBox({');
    expect(install.indexOf("confirmComputerUseNativeAction('install')")).toBeGreaterThanOrEqual(0);
    expect(install.indexOf("issueCommandEveComputerUseNativeIntent('install'")).toBeGreaterThan(
      install.indexOf("confirmComputerUseNativeAction('install')")
    );
    expect(grant.indexOf("confirmComputerUseNativeAction('grant')")).toBeGreaterThanOrEqual(0);
    expect(grant.indexOf("issueCommandEveComputerUseNativeIntent('grant'")).toBeGreaterThan(
      grant.indexOf("confirmComputerUseNativeAction('grant')")
    );
  });
});
