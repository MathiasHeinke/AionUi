export type CdpStartupPolicyInput = {
  isPackaged: boolean;
  envPort?: string;
  configEnabled?: boolean;
};

const PACKAGED_CDP_SWITCHES = [
  'remote-debugging-port',
  'remote-debugging-address',
  'remote-debugging-pipe',
  'inspect',
  'inspect-brk',
] as const;

type PackagedCdpCommandLineInput = {
  isPackaged: boolean;
  argv: string[];
  removeSwitch: (name: string) => void;
};

export function hardenPackagedCdpCommandLine(input: PackagedCdpCommandLineInput): string[] {
  if (!input.isPackaged) return [];

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
  return [...stripped].sort();
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
