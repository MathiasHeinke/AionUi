export type CdpStartupPolicyInput = {
  isPackaged: boolean;
  envPort?: string;
  configEnabled?: boolean;
};

// Canonical definition lives in the common layer (userDataPath.ts) so the
// platform services can detect e2e-packaged builds without importing @process.
export { COMMAND_EVE_E2E_PACKAGED_ATTACHMENT_MARKER } from '@/common/platform/userDataPath';

/**
 * Internal proof recomputed during the earliest main-process bootstrap. It is
 * deliberately distinct from the operator-controlled attachment request: an
 * inherited value is deleted before the four packaged-QA gates are evaluated.
 */
export const COMMAND_EVE_E2E_PACKAGED_ATTACHMENT_VERIFIED_ENV = 'COMMAND_EVE_E2E_PACKAGED_ATTACHMENT_VERIFIED';

type PackagedE2EAttachmentPolicyInput = {
  isPackaged: boolean;
  e2eTest: boolean;
  attachmentRequested: boolean;
  packageMarkerPresent: boolean;
};

export function shouldAllowNonDistributableE2EAttachment(input: PackagedE2EAttachmentPolicyInput): boolean {
  return input.isPackaged && input.e2eTest && input.attachmentRequested && input.packageMarkerPresent;
}

export function synchronizeNonDistributableE2EAttachmentProof(
  env: NodeJS.ProcessEnv,
  allowNonDistributableE2EAttachment: boolean
): void {
  delete env[COMMAND_EVE_E2E_PACKAGED_ATTACHMENT_VERIFIED_ENV];
  if (allowNonDistributableE2EAttachment) {
    env[COMMAND_EVE_E2E_PACKAGED_ATTACHMENT_VERIFIED_ENV] = '1';
  }
}

const PACKAGED_CDP_SWITCHES = [
  'remote-debugging-port',
  'remote-debugging-address',
  'remote-debugging-pipe',
  'inspect',
  'inspect-brk',
] as const;

type PackagedCdpCommandLineInput = {
  isPackaged: boolean;
  allowNonDistributableE2EAttachment?: boolean;
  argv: string[];
  removeSwitch: (name: string) => void;
};

export function hardenPackagedCdpCommandLine(input: PackagedCdpCommandLineInput): string[] {
  if (!input.isPackaged || input.allowNonDistributableE2EAttachment === true) return [];

  const stripped = new Set<string>();
  for (const switchName of PACKAGED_CDP_SWITCHES) {
    input.removeSwitch(switchName);
  }
  for (let index = input.argv.length - 1; index >= 0; index -= 1) {
    const arg = input.argv[index];
    const switchName = PACKAGED_CDP_SWITCHES.find(
      (candidate) => arg === `--${candidate}` || arg.startsWith(`--${candidate}=`)
    );
    if (!switchName) continue;
    stripped.add(switchName);
    input.argv.splice(index, 1);
  }
  return [...stripped].toSorted();
}

export function shouldEnableCdpAtStartup(input: CdpStartupPolicyInput): boolean {
  // Chromium's remote-debugging endpoint has no application-level auth. A
  // packaged client must never expose it because an attached client can read
  // and control every renderer in the app.
  if (input.isPackaged) return false;
  if (input.envPort === '0' || input.envPort === 'false') return false;
  if (input.envPort) return true;
  if (input.configEnabled !== undefined) return input.configEnabled;
  return true;
}
