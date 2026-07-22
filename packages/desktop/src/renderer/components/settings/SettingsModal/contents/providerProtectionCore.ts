import { COMMAND_EVE_LOCAL_RUNTIME_PROVIDER_ID } from '@/common/config/commandEveShell';
import type { IProvider } from '@/common/config/storage';

/** Security-owned runtime rows are reconciled by MAIN and are never BYOK UI. */
export function isUserManagedProviderId(id: string): boolean {
  return id !== COMMAND_EVE_LOCAL_RUNTIME_PROVIDER_ID;
}

export function filterUserManagedProviders(providers: IProvider[] | undefined): IProvider[] {
  return (providers ?? []).filter((provider) => isUserManagedProviderId(provider.id));
}
