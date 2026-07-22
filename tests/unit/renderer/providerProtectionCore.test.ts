import { describe, expect, it } from 'vitest';
import { COMMAND_EVE_LOCAL_RUNTIME_PROVIDER_ID } from '@/common/config/commandEveShell';
import type { IProvider } from '@/common/config/storage';
import {
  filterUserManagedProviders,
  isUserManagedProviderId,
} from '@/renderer/components/settings/SettingsModal/contents/providerProtectionCore';

describe('Command EVE provider settings protection', () => {
  it('keeps the security-owned local runtime row outside generic BYOK settings', () => {
    expect(isUserManagedProviderId(COMMAND_EVE_LOCAL_RUNTIME_PROVIDER_ID)).toBe(false);
    expect(isUserManagedProviderId('operator-byok')).toBe(true);

    const visible = filterUserManagedProviders([
      { id: COMMAND_EVE_LOCAL_RUNTIME_PROVIDER_ID, name: 'Command EVE Local Runtime' },
      { id: 'operator-byok', name: 'Operator BYOK' },
    ] as unknown as IProvider[]);
    expect(visible.map((provider) => provider.id)).toEqual(['operator-byok']);
  });
});
