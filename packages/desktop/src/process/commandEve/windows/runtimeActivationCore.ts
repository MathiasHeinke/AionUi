/**
 * Decide whether a first-run Windows desktop must re-spawn AionCore after the
 * deferred runtime bootstrap installs Hermes. The web-host keeps a fixed
 * backend binding and therefore cannot use this desktop-only activation path.
 */
export function shouldRestartWindowsBackendAfterRuntimeBootstrap(input: {
  platform: NodeJS.Platform;
  surface: 'desktop' | 'webui';
  runtimeProfile: string;
  receiptStatus: string;
  hermesReadyBeforeBootstrap: boolean;
  hermesReadyAfterBootstrap: boolean;
}): boolean {
  return (
    input.platform === 'win32' &&
    input.surface === 'desktop' &&
    input.runtimeProfile === 'cloud_turn_holder_only' &&
    input.receiptStatus === 'ready' &&
    !input.hermesReadyBeforeBootstrap &&
    input.hermesReadyAfterBootstrap
  );
}
