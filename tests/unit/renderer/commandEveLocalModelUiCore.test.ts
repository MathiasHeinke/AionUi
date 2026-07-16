import { describe, expect, it } from 'vitest';

import { commandEveLocalPullMatchesTier } from '@/renderer/components/settings/SettingsModal/contents/commandEveLocalModelUiCore';

describe('Command EVE local model UI progress', () => {
  it('shows progress only on the tier whose base or runtime model is being prepared', () => {
    const pull = { model: 'command-eve-colibri-glm-5-2-64k', percent: 42, status: 'pulling' };
    expect(
      commandEveLocalPullMatchesTier(pull, {
        runtime_model_ref: 'command-eve-colibri-glm-5-2-64k',
        model_ref: 'colibri:glm-5.2-fp8-uncensored-int4',
      })
    ).toBe(true);
    expect(
      commandEveLocalPullMatchesTier(pull, {
        runtime_model_ref: 'command-eve-gemma4-e4b-64k',
        model_ref: 'tripolskypetr/Gemma-4-Uncensored-Aggressive-GGUF:Q5_K_M',
      })
    ).toBe(false);
    expect(commandEveLocalPullMatchesTier(null, undefined)).toBe(false);
  });
});
