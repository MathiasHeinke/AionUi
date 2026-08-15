import fs from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { RegisteredAgentProcessV2 } from '@aionui/web-host';
import {
  compareCommandEveLinuxRegisteredProcessIdentity,
  compareCommandEveRegisteredProcessIdentity,
  compareCommandEveWindowsRegisteredProcessIdentity,
  createCommandEveRegisteredProcessIdentityProbe,
  createCommandEveRegisteredProcessIdentityProbeProvider,
  parseWindowsBatch,
  probeCommandEveWindowsProcessIdentities,
  probeCommandEveDarwinProcessIdentity,
  probeCommandEveLinuxProcessIdentity,
  resolveCommandEvePackagedWindowsProcessIdentityProbe,
  type LinuxProcessIdentityReader,
} from '@/process/commandEve/registeredProcessIdentityProbeCore';
import { __setVaultRecordNativeHelperForTests } from '@/process/commandEve/vaultRecordCore';

afterEach(() => {
  __setVaultRecordNativeHelperForTests(undefined);
});

function entry(overrides: Partial<RegisteredAgentProcessV2> = {}): RegisteredAgentProcessV2 {
  return {
    pid: 7021,
    process_group_id: 7021,
    conversation_id: 'conv-identity',
    agent_type: 'acp',
    registered_at_ms: 1,
    process_identity: {
      platform: 'darwin',
      start_time: { kind: 'unix_epoch_us', value: '1770000000123456' },
      parent_pid: 6001,
      executable_path: '/signed/wrapper-before-exec',
    },
    ...overrides,
  };
}

describe('registeredProcessIdentityProbeCore', () => {
  it('accepts exact birth and PGID after legitimate exec and reparent changes', () => {
    expect(
      compareCommandEveRegisteredProcessIdentity(entry(), {
        pid: 7021,
        process_group_id: 7021,
        start_time_value: '1770000000123456',
        parent_pid: 1,
        executable_path: '/signed/hermes-after-exec',
      })
    ).toBe('match');
  });

  it('rejects a recycled PID with a different exact birth before signaling', () => {
    expect(
      compareCommandEveRegisteredProcessIdentity(entry(), {
        pid: 7021,
        process_group_id: 7021,
        start_time_value: '1770000000123457',
        parent_pid: 1,
        executable_path: '/unrelated/process',
      })
    ).toBe('mismatch');
  });

  it('rejects a birth-correct process that is no longer in the registered group', () => {
    expect(
      compareCommandEveRegisteredProcessIdentity(entry(), {
        pid: 7021,
        process_group_id: 9001,
        start_time_value: '1770000000123456',
        parent_pid: 1,
        executable_path: '/signed/hermes-after-exec',
      })
    ).toBe('mismatch');
  });

  it('refuses authority when the registry did not bind a positive PGID', () => {
    expect(
      compareCommandEveRegisteredProcessIdentity(entry({ process_group_id: undefined }), {
        pid: 7021,
        process_group_id: 7021,
        start_time_value: '1770000000123456',
        parent_pid: 1,
        executable_path: '/signed/hermes-after-exec',
      })
    ).toBe('unknown');
  });

  it('validates the exact Linux boot-id, start ticks, PID and PGID', async () => {
    const bootId = '11111111-2222-3333-4444-555555555555';
    const fields = ['S', '6001', '7021', ...Array.from({ length: 16 }, () => '0'), '123456', '0'];
    const reader: LinuxProcessIdentityReader = {
      readText: async (filePath) =>
        filePath.endsWith('/stat') ? '7021 (hermes agent) ' + fields.join(' ') : bootId + '\n',
      readLink: async () => '/signed/hermes-after-exec',
    };
    const observed = await probeCommandEveLinuxProcessIdentity(7021, reader);
    expect(observed).toEqual({
      state: 'observed',
      observed: {
        pid: 7021,
        process_group_id: 7021,
        start_time_value: bootId + ':123456',
        parent_pid: 6001,
        executable_path: '/signed/hermes-after-exec',
      },
    });
    if (observed.state !== 'observed') return;
    const linuxEntry = entry({
      process_identity: {
        platform: 'linux',
        start_time: { kind: 'linux_boot_ticks', value: bootId + ':123456' },
        parent_pid: 6001,
        executable_path: '/signed/wrapper-before-exec',
      },
    });
    expect(compareCommandEveLinuxRegisteredProcessIdentity(linuxEntry, observed.observed)).toBe('match');
    expect(
      compareCommandEveLinuxRegisteredProcessIdentity(
        {
          ...linuxEntry,
          process_identity: {
            ...linuxEntry.process_identity,
            start_time: { kind: 'linux_boot_ticks', value: bootId + ':123457' },
          },
        },
        observed.observed
      )
    ).toBe('mismatch');
  });

  it('classifies an absent Linux proc identity without signal authority', async () => {
    const missing = Object.assign(new Error('gone'), { code: 'ENOENT' });
    const reader: LinuxProcessIdentityReader = {
      readText: async () => {
        throw missing;
      },
      readLink: async () => {
        throw missing;
      },
    };
    await expect(probeCommandEveLinuxProcessIdentity(7021, reader)).resolves.toEqual({ state: 'absent' });
  });

  it('accepts only the exact Windows FILETIME birth identity', () => {
    const windowsEntry = entry({
      process_group_id: undefined,
      process_identity: {
        platform: 'win32',
        start_time: { kind: 'windows_filetime_100ns', value: '133999999999999999' },
        parent_pid: 6001,
        executable_path: 'C:\\Program Files\\Command EVE\\hermes-command-eve.exe',
      },
    });
    expect(
      compareCommandEveWindowsRegisteredProcessIdentity(windowsEntry, {
        pid: 7021,
        start_time_value: '133999999999999999',
        executable_path: 'C:\\Program Files\\Command EVE\\hermes-command-eve.exe',
      })
    ).toBe('match');
    expect(
      compareCommandEveWindowsRegisteredProcessIdentity(windowsEntry, {
        pid: 7021,
        start_time_value: '133999999999999998',
        executable_path: 'C:\\Windows\\System32\\cmd.exe',
      })
    ).toBe('mismatch');
  });

  it('parses only a closed Windows native probe result', () => {
    expect(
      parseWindowsBatch(
        JSON.stringify({
          sentinel: 'COMMAND_EVE_WINDOWS_PROCESS_IDENTITY_V1',
          results: [
            {
              state: 'observed',
              pid: 7021,
              start_time_value: '133999999999999999',
              executable_path: 'C:\\Program Files\\Command EVE\\hermes-command-eve.exe',
            },
          ],
        }),
        1
      )
    ).toEqual([
      {
        state: 'observed',
        observed: {
          pid: 7021,
          start_time_value: '133999999999999999',
          executable_path: 'C:\\Program Files\\Command EVE\\hermes-command-eve.exe',
        },
      },
    ]);
    expect(
      parseWindowsBatch(
        JSON.stringify({
          sentinel: 'COMMAND_EVE_WINDOWS_PROCESS_IDENTITY_V1',
          results: [{ state: 'observed', pid: 7021, start_time_value: '1', executable_path: 'relative.exe' }],
        }),
        1
      )
    ).toBeUndefined();
  });

  it('runs the resolved native AionCore probe instead of an inherited system interpreter', async () => {
    if (process.platform === 'win32') return;
    const directory = await mkdtemp(path.join(os.tmpdir(), 'command-eve-native-process-probe-'));
    const helper = path.join(directory, 'aioncore-fixture');
    await writeFile(
      helper,
      `#!/bin/sh
test "$1" = "process-identity-probe" || exit 2
cat >/dev/null
printf '%s' '{"sentinel":"COMMAND_EVE_WINDOWS_PROCESS_IDENTITY_V1","results":[{"state":"observed","pid":7021,"start_time_value":"133999999999999999","executable_path":"C:\\\\Program Files\\\\Command EVE\\\\aioncore.exe"}]}'
`
    );
    await chmod(helper, 0o700);

    try {
      await expect(probeCommandEveWindowsProcessIdentities([7021], helper)).resolves.toEqual([
        {
          state: 'observed',
          observed: {
            pid: 7021,
            start_time_value: '133999999999999999',
            executable_path: 'C:\\Program Files\\Command EVE\\aioncore.exe',
          },
        },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('resolves only the exact real bundled Windows AionCore endpoint for packaged signal authority', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'command-eve-packaged-windows-probe-'));
    const runtimeRoot = path.join(directory, 'bundled-aioncore', 'win32-x64');
    const binary = path.join(runtimeRoot, 'aioncore.exe');
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(path.join(runtimeRoot, 'manifest.json'), '{}');
    await writeFile(binary, '#!/bin/sh\nexit 0\n');
    await chmod(binary, 0o700);
    const canonicalResources = fs.realpathSync.native(directory);

    try {
      expect(
        resolveCommandEvePackagedWindowsProcessIdentityProbe({
          isPackaged: true,
          resourcesPath: canonicalResources,
          platform: 'win32',
          arch: 'x64',
        })
      ).toBe(fs.realpathSync.native(binary));
      expect(
        resolveCommandEvePackagedWindowsProcessIdentityProbe({
          isPackaged: false,
          resourcesPath: canonicalResources,
          platform: 'win32',
          arch: 'x64',
        })
      ).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('ignores malicious Windows env PATH and CWD probes when the exact packaged endpoint is absent', async () => {
    const resources = await mkdtemp(path.join(os.tmpdir(), 'command-eve-missing-packaged-probe-'));
    const malicious = await mkdtemp(path.join(os.tmpdir(), 'command-eve-malicious-probe-'));
    const marker = path.join(malicious, 'executed');
    const maliciousBinary = path.join(malicious, 'aioncore');
    await writeFile(maliciousBinary, `#!/bin/sh\nprintf x > "${marker}"\nexit 0\n`);
    await chmod(maliciousBinary, 0o700);
    const oldPath = process.env.PATH;
    const oldOverride = process.env.AIONUI_BACKEND_BINARY;
    const oldCwd = process.cwd();
    process.env.PATH = `${malicious}${path.delimiter}${oldPath ?? ''}`;
    process.env.AIONUI_BACKEND_BINARY = maliciousBinary;
    process.chdir(malicious);

    try {
      const provider = createCommandEveRegisteredProcessIdentityProbeProvider({
        isPackaged: true,
        resourcesPath: resources,
        platform: 'win32',
        arch: 'x64',
      });
      const session = await provider.open();
      const windowsEntry = entry({
        process_group_id: undefined,
        process_identity: {
          platform: 'win32',
          start_time: { kind: 'windows_filetime_100ns', value: '133999999999999999' },
          parent_pid: 6001,
          executable_path: 'C:\\Program Files\\Command EVE\\hermes-command-eve.exe',
        },
      });
      await expect(session.probeMany([windowsEntry])).resolves.toEqual(['unknown']);
      await session.close();
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      process.chdir(oldCwd);
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldOverride === undefined) delete process.env.AIONUI_BACKEND_BINARY;
      else process.env.AIONUI_BACKEND_BINARY = oldOverride;
      await rm(resources, { recursive: true, force: true });
      await rm(malicious, { recursive: true, force: true });
    }
  });

  it('round-trips the live Darwin birth and PGID through the verified packaged interpreter helper', async () => {
    const python = '/Applications/Command EVE.app/Contents/Resources/python/bin/python3.12';
    if (process.platform !== 'darwin' || !fs.existsSync(python)) return;
    __setVaultRecordNativeHelperForTests({ pythonExecutable: python });
    const captured = probeCommandEveDarwinProcessIdentity(process.pid);
    expect(captured?.state).toBe('observed');
    if (!captured || captured.state !== 'observed') return;
    const current = entry({
      pid: process.pid,
      process_group_id: captured.observed.process_group_id,
      process_identity: {
        platform: 'darwin',
        start_time: { kind: 'unix_epoch_us', value: captured.observed.start_time_value },
        parent_pid: captured.observed.parent_pid,
        executable_path: captured.observed.executable_path,
      },
    });

    await expect(createCommandEveRegisteredProcessIdentityProbe()(current)).resolves.toBe('match');
    await expect(
      createCommandEveRegisteredProcessIdentityProbe()({
        ...current,
        process_identity: {
          ...current.process_identity,
          start_time: {
            kind: 'unix_epoch_us',
            value: `${BigInt(current.process_identity.start_time.value) + 1n}`,
          },
        },
      })
    ).resolves.toBe('mismatch');
  });
});
