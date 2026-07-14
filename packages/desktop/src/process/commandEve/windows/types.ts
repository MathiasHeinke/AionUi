/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

export const WINDOWS_GATE_SCHEMA_VERSION = 'command-eve-windows-gate/v1' as const;

export const WINDOWS_GATE_IDS = [
  'WIN-G00',
  'WIN-G01',
  'WIN-G02',
  'WIN-G03',
  'WIN-G04',
  'WIN-G05',
  'WIN-G06',
  'WIN-G06T',
  'WIN-G07',
  'WIN-G08',
  'WIN-G09',
  'WIN-G10',
  'WIN-G11',
  'WIN-G12',
  'WIN-G13',
  'WIN-G14',
  'WIN-G15',
  'WIN-G16',
  'WIN-G17',
  'WIN-G18',
  'WIN-G19',
  'WIN-G20',
  'WIN-G21',
  'WIN-G22',
  'WIN-G23',
  'WIN-G24',
] as const;

export type WindowsGateId = (typeof WINDOWS_GATE_IDS)[number];

export type WindowsGateStatus =
  | 'PASS'
  | 'REJECT'
  | 'BLOCKED_AUTH'
  | 'BLOCKED_ARTIFACT'
  | 'BLOCKED_ENVIRONMENT'
  | 'BLOCKED_EXTERNAL_APPROVAL';

export type WindowsRuntimeTarget =
  | 'local_windows_desktop'
  | 'local_mac_desktop'
  | 'cloud_runtime'
  | 'desktop_companion';

export type WindowsRuntimeProfile = 'default' | 'cloud_turn_holder_only';

export type WindowsGateCommandReceipt = {
  command: string;
  exit_code: number;
  duration_ms?: number;
};

export type WindowsGateAssertionReceipt = {
  id: string;
  status: 'PASS' | 'REJECT';
  detail: string;
};

export type WindowsDeliveryArtifactReceipt = {
  name: string;
  sha256: string;
  signed: boolean;
  signature_subject: string | null;
};

export type WindowsProcessTerminationReceipt = {
  platform: 'win32' | 'darwin' | 'linux';
  root_pid: number;
  requested_signal: string;
  forced: boolean;
  duration_ms: number;
  surviving_owned_pids: number[];
  status: 'PASS' | 'REJECT';
};

export type WindowsLauncherConformanceReceipt = {
  schema_version: 'command-eve-launcher-conformance/v1';
  platform: 'win32' | 'darwin';
  cases: Array<{
    id: 'pause-gate' | 'token-file' | 'secret-scrub' | 'raw-stdio' | 'exit-code' | 'tree-cancel';
    status: 'PASS' | 'REJECT';
    evidence_path: string;
  }>;
  completion_sentinel: 'WIN_LAUNCHER_CONFORMANCE_COMPLETE';
};

export type PlatformRuntimeAdapter = {
  platform: 'win32' | 'darwin' | 'linux';
  resolveExecutable: (name: string, env: NodeJS.ProcessEnv) => Promise<string | null>;
  pythonInVenv: (venvRoot: string) => string;
  hermesInVenv: (venvRoot: string) => string;
  terminateTree: (pid: number, signal: string) => Promise<WindowsProcessTerminationReceipt>;
  normalizeUserPath: (input: string) => string;
};

export type WindowsGateReceiptV1 = {
  schema_version: typeof WINDOWS_GATE_SCHEMA_VERSION;
  gate_id: WindowsGateId;
  status: WindowsGateStatus;
  reject_code: string | null;
  source: {
    repository: string;
    commit: string;
    tree_clean: boolean;
  };
  artifact: WindowsDeliveryArtifactReceipt | null;
  environment: {
    os: string;
    os_build: string;
    arch: 'x64';
    ram_bytes: number;
    cpu_count: number;
    test_mode: string;
  };
  commands: WindowsGateCommandReceipt[];
  assertions: WindowsGateAssertionReceipt[];
  metrics: Record<string, string | number | boolean | null>;
  evidence_paths: string[];
  started_at: string;
  completed_at: string;
  worker: string;
  reviewer: string;
  completion_sentinel: 'WIN_GATE_COMPLETE';
};
