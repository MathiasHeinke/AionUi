import type { ElectronDesktopShellAPI } from '../types/platform/electron';

type ProviderLike<Data, Params> = {
  provider: (handler: (params: Params) => Promise<Data>) => void;
  invoke: (params: Params) => Promise<Data>;
};

type DesktopShellMethod = keyof ElectronDesktopShellAPI;

export function preferElectronDesktopShell(
  method: DesktopShellMethod,
  fallback: ProviderLike<void, string>
): ProviderLike<void, string> {
  return {
    provider: fallback.provider,
    invoke: async (value) => {
      const desktopShell = typeof window === 'undefined' ? undefined : window.electronAPI?.desktopShell;
      const invoke = desktopShell?.[method];
      if (invoke) {
        await invoke(value);
        return;
      }
      await fallback.invoke(value);
    },
  };
}
