/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// Regression: EVE Cloud must show the universal 256K operating window, NOT the
// local 64K hardware cap and NOT a provider-advertised 1M window. The bug was
// that the runtime
// `request_trace.model_id` on a cloud turn carries Hermes' LOCAL config model
// (one managed Ollama config), so the resolver saw a local-looking id and let
// the 64k live `acp_context_usage.size` win → the founder's "55.3K / 65.5K".
// AcpSendBox now feeds the cloud SELECTION id to the indicator, which the
// resolver detects as the cloud lane and applies the 256K policy.

import { describe, expect, it } from 'vitest';
import {
  resolveEffectiveContextLimit,
  isEveCloudModelId,
  EVE_CLOUD_CONTEXT_LIMIT,
} from '@/renderer/utils/model/modelContextLimits';

const CLOUD_MAX_SELECTION = 'command-eve-inference:eve-max';
const LOCAL_RUNTIME_MODEL_ID = 'custom:command-eve-gemma4-e4b-64k:latest';
const LIVE_64K = 65_536;

describe('EVE cloud context window resolution', () => {
  it('detects the EVE cloud selection id (prefixed and bare tier forms)', () => {
    expect(isEveCloudModelId(CLOUD_MAX_SELECTION)).toBe(true);
    expect(isEveCloudModelId('command-eve-inference:eve-high')).toBe(true);
    expect(isEveCloudModelId('command-eve-inference:eve-standard')).toBe(true);
    expect(isEveCloudModelId('command-eve-inference:eve-ultra')).toBe(true);
    expect(isEveCloudModelId('eve-max')).toBe(true);
    expect(isEveCloudModelId('eve-high')).toBe(true);
    expect(isEveCloudModelId('eve-standard')).toBe(true);
    expect(isEveCloudModelId('eve-ultra')).toBe(true);
    expect(isEveCloudModelId('moonshotai/kimi-k2.6')).toBe(true);
    expect(isEveCloudModelId('moonshotai/kimi-k3')).toBe(true);
  });

  it('does NOT treat the local Hermes runtime model as cloud', () => {
    expect(isEveCloudModelId(LOCAL_RUNTIME_MODEL_ID)).toBe(false);
    expect(isEveCloudModelId('gemma-4')).toBe(false);
  });

  it('cloud Max resolves to 256K even when Hermes still reports the local 64K cap', () => {
    expect(resolveEffectiveContextLimit(CLOUD_MAX_SELECTION, LIVE_64K)).toBe(EVE_CLOUD_CONTEXT_LIMIT);
    expect(EVE_CLOUD_CONTEXT_LIMIT).toBe(262_144);
  });

  it('caps every large remote model at 256K regardless of its advertised window', () => {
    expect(resolveEffectiveContextLimit('claude-opus-4.8')).toBe(262_144);
    expect(resolveEffectiveContextLimit('fable-5')).toBe(262_144);
    expect(resolveEffectiveContextLimit('z-ai/glm-5.2')).toBe(262_144);
    expect(resolveEffectiveContextLimit('gpt-5.6')).toBe(262_144);
    expect(resolveEffectiveContextLimit('moonshotai/kimi-k2.6')).toBe(262_144);
    expect(resolveEffectiveContextLimit('moonshotai/kimi-k3')).toBe(262_144);
  });

  it('keeps genuinely smaller provider windows smaller', () => {
    expect(resolveEffectiveContextLimit('gpt-4')).toBe(8_192);
  });

  it('local lane keeps its real 64k window from the live size', () => {
    expect(resolveEffectiveContextLimit(LOCAL_RUNTIME_MODEL_ID, LIVE_64K)).toBe(LIVE_64K);
  });

  it('the OLD path (local-looking runtime id on a cloud turn) would have pinned 64k', () => {
    // Documents the pre-fix failure mode the AcpSendBox change avoids by passing
    // the cloud selection id to the indicator instead of the runtime model id.
    expect(resolveEffectiveContextLimit(LOCAL_RUNTIME_MODEL_ID, LIVE_64K)).toBe(LIVE_64K);
  });
});
