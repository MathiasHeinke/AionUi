/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  evaluatePhaseBMachineReadiness,
  type PhaseBMachineFactsV1,
} from '@/process/commandEve/windows/phaseBMachineReceiptCore';

const NOW_MS = Date.parse('2026-07-15T16:05:00.000Z');

function facts(overrides: Partial<PhaseBMachineFactsV1> = {}): PhaseBMachineFactsV1 {
  return {
    schema_version: 'command-eve-windows-phase-b-machine-facts/v1',
    collected_at: '2026-07-15T16:00:00.000Z',
    collection_errors: [],
    host: {
      os_caption: 'Microsoft Windows 11 Enterprise',
      os_version: '10.0.26100',
      os_build: '26100',
      product_type: 1,
      native_architecture: 'AMD64',
      process_architecture: 'X64',
      processor_architecture_codes: [9, 9, 9, 9],
      ram_bytes: 8 * 1024 ** 3,
      logical_cpu_count: 2,
    },
    user: {
      is_local_administrator: false,
      token_is_elevated: false,
      uac_enabled: true,
      secure_desktop_enabled: true,
    },
    security: {
      defender_service_running: true,
      defender_antivirus_enabled: true,
      defender_real_time_protection_enabled: true,
      defender_behavior_monitor_enabled: true,
      defender_ioav_protection_enabled: true,
      defender_tamper_protected: true,
      smart_screen_policy_enabled: true,
      smart_screen_shell_mode: 'Warn',
      smart_screen_app_reputation_enabled: true,
      process_creation_command_line_audit_enabled: null,
      firewall_domain_enabled: true,
      firewall_private_enabled: true,
      firewall_public_enabled: true,
    },
    ...overrides,
  };
}

function readiness(input: unknown, memoryClass: 'lowmem-8gb' | 'normal-16gb' = 'lowmem-8gb') {
  return evaluatePhaseBMachineReadiness(input, memoryClass, NOW_MS);
}

describe('Windows Phase B machine readiness', () => {
  it('accepts a hardened Windows 11 x64 standard-user 8 GB machine', () => {
    const result = readiness(facts());

    expect(result.status).toBe('PASS');
    expect(result.reject_codes).toEqual([]);
    expect(result.completion_sentinel).toBe('WIN_PHASE_B_MACHINE_READINESS_COMPLETE');
  });

  it('accepts the separate 16 GB normal-memory class', () => {
    const input = facts({
      host: {
        ...facts().host,
        ram_bytes: 16 * 1024 ** 3,
        logical_cpu_count: 4,
      },
    });

    expect(readiness(input, 'normal-16gb').status).toBe('PASS');
  });

  it('rejects Windows Server, non-workstation images, and ARM64 hosts', () => {
    const input = facts({
      host: {
        ...facts().host,
        os_caption: 'Microsoft Windows Server 2022 Datacenter',
        product_type: 3,
        native_architecture: 'ARM64',
        process_architecture: 'ARM64',
        processor_architecture_codes: [12],
      },
    });
    const result = readiness(input);

    expect(result.reject_codes).toEqual(
      expect.arrayContaining(['WIN_B_OS_NOT_WINDOWS_11', 'WIN_B_OS_NOT_WORKSTATION', 'WIN_B_ARCH_NOT_X64'])
    );
  });

  it('rejects machines outside the selected memory and CPU class', () => {
    const result = readiness(
      facts({ host: { ...facts().host, ram_bytes: 12 * 1024 ** 3, logical_cpu_count: 1 } }),
      'normal-16gb'
    );

    expect(result.reject_codes).toEqual(
      expect.arrayContaining(['WIN_B_MEMORY_CLASS_MISMATCH', 'WIN_B_CPU_BELOW_PROFILE_MINIMUM'])
    );
  });

  it('rejects an administrator account even when its token is not elevated', () => {
    const result = readiness(facts({ user: { ...facts().user, is_local_administrator: true } }));

    expect(result.reject_codes).toContain('WIN_B_USER_IS_ADMIN');
  });

  it('fails closed when Defender, tamper protection, SmartScreen, or a firewall profile is unavailable', () => {
    const result = readiness(
      facts({
        security: {
          ...facts().security,
          defender_real_time_protection_enabled: false,
          defender_tamper_protected: null,
          smart_screen_policy_enabled: null,
          smart_screen_shell_mode: null,
          firewall_public_enabled: false,
        },
      })
    );

    expect(result.reject_codes).toEqual(
      expect.arrayContaining([
        'WIN_B_DEFENDER_PROTECTION_INCOMPLETE',
        'WIN_B_DEFENDER_TAMPER_NOT_PROVEN',
        'WIN_B_SMARTSCREEN_NOT_PROVEN',
        'WIN_B_FIREWALL_INCOMPLETE',
      ])
    );
  });

  it('does not turn malformed or partially collected facts into a pass', () => {
    expect(readiness('not-json').reject_codes).toContain('WIN_B_MACHINE_SCHEMA_INVALID');
    expect(readiness(facts({ collection_errors: ['Get-MpComputerStatus failed'] })).reject_codes).toContain(
      'WIN_B_MACHINE_COLLECTION_INCOMPLETE'
    );
  });

  it('accepts default-on SmartScreen registry absence but rejects explicit disablement', () => {
    const defaultOn = readiness(
      facts({
        security: {
          ...facts().security,
          smart_screen_policy_enabled: null,
          smart_screen_app_reputation_enabled: null,
        },
      })
    );
    const explicitlyDisabled = readiness(
      facts({
        security: {
          ...facts().security,
          smart_screen_policy_enabled: false,
        },
      })
    );

    expect(defaultOn.status).toBe('PASS');
    expect(explicitlyDisabled.reject_codes).toContain('WIN_B_SMARTSCREEN_NOT_PROVEN');
  });

  it('rejects process-command-line auditing because the one-use JIT value is a runner argument', () => {
    const result = readiness(
      facts({
        security: {
          ...facts().security,
          process_creation_command_line_audit_enabled: true,
        },
      })
    );

    expect(result.reject_codes).toContain('WIN_B_PROCESS_COMMAND_LINE_AUDIT_ENABLED');
  });

  it('rejects stale receipts, future clocks, and pre-Windows-11 build numbers', () => {
    expect(readiness(facts({ collected_at: '2026-07-15T15:30:00.000Z' })).reject_codes).toContain(
      'WIN_B_MACHINE_FACTS_STALE'
    );
    expect(readiness(facts({ collected_at: '2026-07-15T16:10:00.000Z' })).reject_codes).toContain(
      'WIN_B_MACHINE_FACTS_STALE'
    );
    expect(readiness(facts({ host: { ...facts().host, os_build: '19045' } })).reject_codes).toContain(
      'WIN_B_OS_BUILD_INVALID'
    );
    expect(readiness(facts({ host: { ...facts().host, os_build: '26100-preview' } })).reject_codes).toContain(
      'WIN_B_OS_BUILD_INVALID'
    );
  });
});
