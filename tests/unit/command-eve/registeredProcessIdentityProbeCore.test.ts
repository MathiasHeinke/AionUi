import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import type { RegisteredAgentProcessV2 } from '@aionui/web-host';
import {
  compareCommandEveLinuxRegisteredProcessIdentity,
  compareCommandEveRegisteredProcessIdentity,
  createCommandEveRegisteredProcessIdentityProbe,
  probeCommandEveDarwinProcessIdentity,
  probeCommandEveLinuxProcessIdentity,
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
