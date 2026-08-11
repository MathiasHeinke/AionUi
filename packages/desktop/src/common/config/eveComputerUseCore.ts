/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/** Renderer-safe contract over Hermes 0.20 + cua-driver readiness. */

export const COMMAND_EVE_COMPUTER_USE_VERSION = 'command-eve-computer-use/v1' as const;

export type CommandEveComputerUseCheck = {
  label: string;
  status: string;
  message: string;
};

export type CommandEveComputerUseStatus = {
  version: typeof COMMAND_EVE_COMPUTER_USE_VERSION;
  ok: boolean;
  state: 'ready' | 'needs_install' | 'needs_permission' | 'needs_user' | 'blocked' | 'failed';
  platform: string;
  platform_supported: boolean;
  installed: boolean;
  ready: boolean | null;
  can_install: boolean;
  can_grant: boolean;
  can_revoke_automatically: false;
  accessibility: boolean | null;
  screen_recording: boolean | null;
  screen_recording_capturable: boolean | null;
  checks: CommandEveComputerUseCheck[];
  provenance: {
    resolution: 'HERMES_CUA_DRIVER_CMD' | 'PATH_OR_CANONICAL_LOCATION' | 'missing' | 'unknown';
    executable_name: string | null;
    executable_sha256: string | null;
    expected_executable_sha256: string | null;
    checksum_verified: boolean;
    driver_version: string | null;
    expected_version: string;
    release_tag: string;
    expected_identity: string | null;
    expected_team_identifier: string | null;
    installer_source: 'hermes-0.20-upstream-pinned';
    identity: string | null;
    team_identifier: string | null;
    signature_valid: boolean | null;
  };
  reason_code?: string;
  message?: string;
};

export type CommandEveComputerUseActionResult = {
  version: typeof COMMAND_EVE_COMPUTER_USE_VERSION;
  ok: boolean;
  state: 'ready' | 'needs_user' | 'blocked' | 'failed';
  reason_code?: string;
  message?: string;
};
