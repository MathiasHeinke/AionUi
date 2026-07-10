export type CdpStartupPolicyInput = {
  isPackaged: boolean;
  envPort?: string;
  configEnabled?: boolean;
};

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
