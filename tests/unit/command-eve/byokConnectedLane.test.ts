/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CEVE-1821 — BYOK Bausteine 1 and 3: the connected lane can be NAMED and
 * RESOLVED. It cannot yet be SENT, and that gap is asserted here rather than
 * left to be discovered.
 *
 * WHAT WAS BROKEN. `connectedSelectionValue()` / `isConnectedSelection()` existed
 * and `repairInferenceSelection` already refused to convert a BYOK value onto the
 * metered lane. But nothing could read the provider and model back out of the
 * value, `CommandEveActiveLane` had only `eve` and `local`, and the send path had
 * exactly two branches. So a connected selection was answered as the local
 * default tier: the composer painted Gemma, the send path warmed Gemma, and the
 * operator's choice evaporated in silence.
 *
 * WHAT IS STILL MISSING, ON PURPOSE. The wire. The Command EVE shim reaches three
 * upstreams — EVE's metered Edge Function, a strict-IPv4-loopback OpenAI server,
 * and loopback Ollama — and `handleLocalOpenAiCompletions` answers 503 for any
 * non-loopback base URL. A fourth lane to an operator-named third-party host is a
 * NETWORK BOUNDARY decision and is being put to the founder separately. Until it
 * lands the row must not be OFFERED, because an entry that cannot carry a turn is
 * the same lie in a new place.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildEvePickerGroups,
  BYOK_PICKER_VISIBLE,
  connectedProviderSelectionValue,
  connectedSelectionValue,
  describeCommandEveActiveLane,
  EVE_DEFAULT_INFERENCE_SELECTION,
  isConnectedSelection,
  localTierValue,
  parseConnectedSelection,
  repairInferenceSelection,
  resolveCommandEveActiveLane,
} from '@/common/config/eveInferenceCore';
import {
  APP_OWNED_PROVIDER_IDS,
  buildConnectedProviderGroups,
  resolveConnectedProviderRoute,
  type ConnectedProviderRow,
} from '@/common/config/eveConnectedProviderCore';

const read = (relative: string): string => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

const row = (over: Partial<ConnectedProviderRow> = {}): ConnectedProviderRow => ({
  id: 'p1',
  name: 'My OpenRouter',
  platform: 'openrouter',
  base_url: 'https://openrouter.ai/api/v1',
  api_key: 'sk-operator-owned',
  models: ['gpt-5.2', 'qwen/qwen3:8b'],
  enabled: true,
  ...over,
});

describe('Baustein 1 — the selection can be read back', () => {
  it('round-trips a provider and model', () => {
    const value = connectedProviderSelectionValue('p1', 'gpt-5.2');
    expect(isConnectedSelection(value)).toBe(true);
    expect(parseConnectedSelection(value)).toEqual({ providerId: 'p1', model: 'gpt-5.2' });
  });

  it('splits on the FIRST colon — a model name may contain one, a row id may not', () => {
    // Splitting from the right would hand back `qwen/qwen3` and route a different
    // model than the operator chose.
    const value = connectedProviderSelectionValue('p1', 'qwen/qwen3:8b');
    expect(parseConnectedSelection(value)).toEqual({ providerId: 'p1', model: 'qwen/qwen3:8b' });
  });

  it('an unusable value is nameable as unusable, never guessed into a working one', () => {
    for (const broken of [
      connectedSelectionValue(''),
      connectedSelectionValue('no-colon-here'),
      connectedSelectionValue(':leading'),
      connectedSelectionValue('trailing:'),
      localTierValue('local-high'),
      EVE_DEFAULT_INFERENCE_SELECTION,
      '',
      null,
      undefined,
    ]) {
      expect(parseConnectedSelection(broken)).toBeNull();
    }
  });
});

describe('Baustein 1 — the lane has its own kind, so it stops being answered as local', () => {
  const selection = connectedProviderSelectionValue('p1', 'gpt-5.2');

  it('resolves to a connected lane carrying the provider and model', () => {
    expect(resolveCommandEveActiveLane(selection)).toEqual({
      kind: 'connected',
      providerId: 'p1',
      model: 'gpt-5.2',
    });
  });

  it('THE REGRESSION: it is no longer reported as the local default tier', () => {
    // This is the defect in one assertion. Before Baustein 1 the value fell
    // through the "unknown non-EVE value" branch and came back as
    // `{ kind: 'local', tierId: EVE_LOCAL_PICKER_TIERS[0].id }`.
    const lane = resolveCommandEveActiveLane(selection);
    expect(lane.kind).not.toBe('local');
    expect(lane.kind).not.toBe('eve');
  });

  it('a genuinely unknown value still falls back to local — that branch was correct', () => {
    expect(resolveCommandEveActiveLane('something-nobody-wrote').kind).toBe('local');
  });

  it('the self-description says whose key pays, in both locales', () => {
    expect(describeCommandEveActiveLane(selection, 'de-DE')).toContain('Eigener Anbieter');
    expect(describeCommandEveActiveLane(selection, 'de-DE')).toContain('keine EVE-Credits');
    expect(describeCommandEveActiveLane(selection, 'en-US')).toContain('no EVE credits');
  });

  it('and it survives a restart: never repaired onto the metered lane', () => {
    const repaired = repairInferenceSelection(selection);
    expect(repaired).toEqual({ selection, repaired: false });
    expect(repaired.selection).not.toBe(EVE_DEFAULT_INFERENCE_SELECTION);
  });
});

describe('Baustein 3 — the operator rows become groups, and the key stays behind', () => {
  it('one group per row, one item per model, values that parse back', () => {
    const groups = buildConnectedProviderGroups([row()]);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('connected');
    expect(groups[0].title).toBe('My OpenRouter');
    expect(groups[0].items.map((item) => item.label)).toEqual(['gpt-5.2', 'qwen/qwen3:8b']);
    for (const item of groups[0].items) {
      expect(parseConnectedSelection(item.value)?.providerId).toBe('p1');
    }
  });

  it('NO CREDENTIAL is anywhere in the renderer-facing shape', () => {
    // The whole reason the group builder and the route resolver are separate
    // functions rather than one with a flag.
    const serialised = JSON.stringify(buildConnectedProviderGroups([row()]));
    expect(serialised).not.toContain('sk-operator-owned');
    expect(serialised).not.toContain('api_key');
  });

  it('a row that could not carry a turn produces NO entry, not a disabled one', () => {
    const unusable: Array<[string, ConnectedProviderRow]> = [
      ['no key', row({ api_key: '' })],
      ['no base url', row({ base_url: '' })],
      ['no models', row({ models: [] })],
      ['disabled', row({ enabled: false })],
      ['every model disabled', row({ model_enabled: { 'gpt-5.2': false, 'qwen/qwen3:8b': false } })],
    ];
    for (const [why, candidate] of unusable) {
      expect(buildConnectedProviderGroups([candidate]), why).toEqual([]);
    }
  });

  it('the app writes two provider rows itself, and neither is the operator bringing a key', () => {
    // command-eve-local-runtime IS the loopback shim — offering it would point
    // the shim at itself; command-eve-managed-image is an image lane, not chat.
    expect([...APP_OWNED_PROVIDER_IDS].toSorted()).toEqual(['command-eve-local-runtime', 'command-eve-managed-image']);
    for (const id of APP_OWNED_PROVIDER_IDS) {
      expect(buildConnectedProviderGroups([row({ id })])).toEqual([]);
    }
  });

  it('no configured provider means no group at all — no heading, no placeholder', () => {
    expect(buildConnectedProviderGroups([])).toEqual([]);
    expect(buildConnectedProviderGroups(null)).toEqual([]);
    expect(buildEvePickerGroups(null, buildConnectedProviderGroups([])).some((g) => g.kind === 'connected')).toBe(
      false
    );
  });
});

describe('Baustein 3 — resolving one selection against the rows', () => {
  const rows = [row()];

  it('returns the route the main process needs, key included', () => {
    const route = resolveConnectedProviderRoute({ providerId: 'p1', model: 'gpt-5.2' }, rows);
    expect(route).toEqual({
      providerId: 'p1',
      providerName: 'My OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'gpt-5.2',
      apiKey: 'sk-operator-owned',
    });
  });

  it('a model that disappeared resolves to null, NOT to the row first model', () => {
    // Substituting silently would be a different turn at a different price.
    expect(resolveConnectedProviderRoute({ providerId: 'p1', model: 'gpt-4o' }, rows)).toBeNull();
    expect(resolveConnectedProviderRoute({ providerId: 'p1', model: 'gpt-5.2' }, [row({ enabled: false })])).toBeNull();
    expect(
      resolveConnectedProviderRoute({ providerId: 'p1', model: 'gpt-5.2' }, [
        row({ model_enabled: { 'gpt-5.2': false } }),
      ])
    ).toBeNull();
  });

  it('a deleted row, a null parse and an unreadable list all resolve to null', () => {
    expect(resolveConnectedProviderRoute({ providerId: 'gone', model: 'gpt-5.2' }, rows)).toBeNull();
    expect(resolveConnectedProviderRoute(null, rows)).toBeNull();
    expect(resolveConnectedProviderRoute({ providerId: 'p1', model: 'gpt-5.2' }, null)).toBeNull();
  });
});

describe('THE CONDITION: no offer without a wire', () => {
  it('BYOK_PICKER_VISIBLE is OFF, and that is a decision with a reason next to it', () => {
    expect(BYOK_PICKER_VISIBLE).toBe(false);
    const core = read('packages/desktop/src/common/config/eveInferenceCore.ts');
    // Normalise the JSDoc frame away: the phrases are load-bearing, the line
    // breaks and leading asterisks the formatter inserts are not.
    const doc = core
      .slice(core.indexOf('MAY A BYOK ROW BE OFFERED'), core.indexOf('export const BYOK_PICKER_VISIBLE'))
      .replace(/[\s*]+/g, ' ');
    expect(doc).toContain('NETWORK BOUNDARY');
    expect(doc).toContain('handleLocalOpenAiCompletions');
  });

  it('the gate is the ONLY thing off — the wire underneath it works', () => {
    // Proven by handing the groups straight to the picker builder: it appends
    // them. So when the shim lane lands, one constant flips and nothing else has
    // to be re-derived.
    const groups = buildEvePickerGroups(null, buildConnectedProviderGroups([row()]));
    expect(groups.map((g) => g.kind)).toEqual(['local', 'eve', 'connected']);
  });

  it('the hook applies the gate at the one place the groups reach the picker', () => {
    const hook = read('packages/desktop/src/renderer/hooks/agent/useEveInferenceSelection.ts');
    expect(hook).toContain('BYOK_PICKER_VISIBLE ? buildConnectedProviderGroups(connectedRows) : []');
    expect(hook).toContain('buildEvePickerGroups(pickerEntitlement, connectedProviderGroups)');
  });
});

describe('the send path stops warming Gemma for a BYOK selection', () => {
  const send = read('packages/desktop/src/renderer/pages/guid/hooks/useGuidSend.ts');

  it('the connected branch sits BEFORE the local warmup', () => {
    const connectedAt = send.indexOf('const useConnected =');
    const warmupAt = send.indexOf("configService.get('commandEve.localModelTierId')");
    expect(connectedAt, 'the connected branch is missing').toBeGreaterThan(-1);
    expect(warmupAt).toBeGreaterThan(-1);
    expect(connectedAt, 'the warmup would run first and the operator would get Gemma').toBeLessThan(warmupAt);
  });

  it('the local branch can no longer be entered by a connected selection', () => {
    expect(send).toContain('if (!useEveCloud && !useConnected) {');
  });

  it('it refuses out loud rather than routing somewhere else', () => {
    expect(send).toContain('connectedNotRoutable');
    const branch = send.slice(send.indexOf('const useConnected ='), send.indexOf('if (!useEveCloud && !useConnected)'));
    expect(branch).toContain('return false;');
    expect(branch, 'a BYOK selection must not reach the warmup call').not.toContain('warmLocalModel');
  });
});

describe('the main process resolves it, and keeps the key', () => {
  const bridge = read('packages/desktop/src/process/bridge/commandEveBridge.ts');

  it('the resolver has a connected branch that reads the operator rows', () => {
    expect(bridge).toContain('if (isConnectedSelection(selection)) {');
    expect(bridge).toContain("httpRequest<IProvider[]>('GET', '/api/providers')");
    expect(bridge).toContain('resolveConnectedProviderRoute(parseConnectedSelection(selection), rows)');
  });

  it('it answers with its own reason codes instead of a generic failure', () => {
    expect(bridge).toContain('CONNECTED_PROVIDER_UNAVAILABLE');
    expect(bridge).toContain('CONNECTED_PROVIDER_NO_WIRE');
  });

  it('the resolved route never crosses the bridge', () => {
    // The branch returns `data: undefined` in both directions today; when the
    // wire lands it must still strip the key, exactly like the EVE wire above.
    const branch = bridge.slice(
      bridge.indexOf('if (isConnectedSelection(selection)) {'),
      bridge.indexOf('// Privat (lokal) lane')
    );
    expect(branch).not.toContain('apiKey');
    expect(branch).not.toContain('route.apiKey');
  });
});
