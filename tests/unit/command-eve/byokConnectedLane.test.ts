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
import { classifyConnectedProviderHost } from '@/process/commandEve/ollamaOpenAiShim';
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

describe('THE CONDITION, ONE COMMIT LATER: the wire exists, so the row is offered', () => {
  /**
   * REWRITTEN VISIBLY, NOT DELETED. This block pinned `BYOK_PICKER_VISIBLE ===
   * false`, and that was right: there was no lane to a third-party host, so an
   * offered row could not have carried a turn, and a picker entry that cannot be
   * taken is the same falsehood in a new place.
   *
   * `handleConnectedProviderCompletions` is that lane. The constant flips with
   * it — which is what the previous assertion was protecting: not the `false`,
   * but the rule that the two move together.
   *
   * What did NOT move: https to a public host, the loopback refusal, the
   * no-redirect policy, the egress boundary and its receipt, and named refusals
   * instead of silent reroutes. None of those protect a hypothetical future
   * stranger; they protect this install, today. They are asserted below.
   */
  it('the gate is OPEN, and it moved together with the lane', () => {
    expect(BYOK_PICKER_VISIBLE).toBe(true);
    const shim = read('packages/desktop/src/process/commandEve/ollamaOpenAiShim.ts');
    expect(shim, 'the gate opened without the lane it depends on').toContain(
      'async function handleConnectedProviderCompletions('
    );
  });

  it('the justification no longer claims the wire is missing', () => {
    const core = read('packages/desktop/src/common/config/eveInferenceCore.ts');
    const doc = core
      .slice(core.indexOf('MAY A BYOK ROW BE OFFERED'), core.indexOf('export const BYOK_PICKER_VISIBLE'))
      .replace(/[\s*]+/g, ' ');
    expect(doc).not.toContain('What does NOT exist is the wire');
    expect(doc).toContain('handleConnectedProviderCompletions');
  });

  it('an operator with a provider actually gets the group', () => {
    const groups = buildEvePickerGroups(null, buildConnectedProviderGroups([row()]));
    expect(groups.map((g) => g.kind)).toEqual(['local', 'eve', 'connected']);
  });

  it('the hook still reads the gate, so one line can close it again', () => {
    const hook = read('packages/desktop/src/renderer/hooks/agent/useEveInferenceSelection.ts');
    expect(hook).toContain('BYOK_PICKER_VISIBLE ? buildConnectedProviderGroups(connectedRows) : []');
  });
});

describe('the host rule — three different reasons, three different checks', () => {
  it('LOOPBACK IS REFUSED: the shim listens there and the lane would loop', () => {
    for (const base of [
      'http://127.0.0.1:11434/v1',
      'http://127.0.0.2:8080/v1',
      'https://localhost:8443/v1',
      'http://[::1]:9000/v1',
      'http://0.0.0.0:25811/v1',
      'https://api.localhost/v1',
    ]) {
      const verdict = classifyConnectedProviderHost(base);
      expect(verdict.ok, `${base} was accepted — loopback risk`).toBe(false);
      expect(verdict.ok === false && verdict.reason).toBe('CONNECTED_HOST_LOOPBACK');
    }
  });

  it('A PUBLIC HOST MUST BE https — cleartext there is OUR data loss', () => {
    expect(classifyConnectedProviderHost('https://api.openai.com/v1')).toEqual({ ok: true, transport: 'https' });
    expect(classifyConnectedProviderHost('https://openrouter.ai/api/v1')).toEqual({ ok: true, transport: 'https' });
    for (const base of ['http://api.openai.com/v1', 'http://8.8.8.8/v1', 'http://models.example.com:8080/v1']) {
      const verdict = classifyConnectedProviderHost(base);
      expect(verdict.ok, `${base} was accepted in cleartext`).toBe(false);
      expect(verdict.ok === false && verdict.reason).toBe('CONNECTED_HOST_INSECURE_PUBLIC');
    }
  });

  it('A PRIVATE NETWORK MAY USE http, and the receipt records that it was cleartext', () => {
    for (const base of ['http://192.168.1.50:8000/v1', 'http://10.0.0.7/v1', 'http://172.16.4.4:1234/v1']) {
      expect(classifyConnectedProviderHost(base), base).toEqual({ ok: true, transport: 'http_private_network' });
    }
    // 172.32 is NOT RFC1918 — the range check has to be a range, not a prefix.
    expect(classifyConnectedProviderHost('http://172.32.0.1/v1').ok).toBe(false);
    const shim = read('packages/desktop/src/process/commandEve/ollamaOpenAiShim.ts');
    expect(shim, 'the cleartext evidence is not written to the receipt').toContain(
      'const egressReceipt = { ...egressBoundary.receipt, transport: host.transport };'
    );
  });

  it('an unparseable base URL is named, not guessed', () => {
    const verdict = classifyConnectedProviderHost('not a url');
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe('CONNECTED_HOST_UNPARSEABLE');
  });
});

describe('the lane itself — what must never be softened', () => {
  const shim = read('packages/desktop/src/process/commandEve/ollamaOpenAiShim.ts');
  const lane = shim.slice(
    shim.indexOf('async function handleConnectedProviderCompletions('),
    shim.indexOf('async function handleChatCompletions(')
  );

  it('a 30x must not re-POST the body and the key to a host nobody named', () => {
    expect(lane.length).toBeGreaterThan(0);
    expect(lane).toContain("redirect: 'error'");
    expect(lane, 'redirect following would leak the turn to an unnamed host').not.toContain("redirect: 'follow'");
  });

  it('the egress boundary runs BEFORE the fetch, not after', () => {
    const boundaryAt = lane.indexOf('evaluateCommandEveEgressBoundary');
    const fetchAt = lane.indexOf('await fetch(');
    expect(boundaryAt, 'the egress boundary was skipped').toBeGreaterThan(-1);
    expect(boundaryAt, 'bytes would leave before the boundary decided').toBeLessThan(fetchAt);
    expect(lane).toContain('writeCommandEveEgressBoundaryReceipt');
    expect(lane, 'a blocked turn must not be sent anyway').toContain("egressBoundary.decision === 'block'");
    expect(lane, 'a redact decision must actually redact the outbound messages').toContain(
      "egressBoundary.decision === 'redact'"
    );
  });

  it('it is classified as a CLOUD egress, because that is what it is', () => {
    expect(lane).toContain("kind: 'cloud'");
    expect(lane, 'a third-party turn recorded as local would be a receipt that lies').not.toContain("kind: 'local'");
  });

  it('the key rides in the authorization header and nowhere else', () => {
    expect(lane).toContain('authorization: `Bearer ${apiKey}`');
    // Exactly once, and only there.
    expect([...lane.matchAll(/\$\{apiKey\}/g)]).toHaveLength(1);
    // Not in the outbound body.
    const bodyLine = lane.slice(lane.indexOf('body: JSON.stringify('), lane.indexOf('signal: upstreamScope.signal'));
    expect(bodyLine, 'the key was serialised into the request body').not.toContain('apiKey');
    // Not in a query string, and never interpolated into anything user-visible.
    expect(lane).not.toMatch(/[?&][a-z_]*key=/i);
    expect(lane, 'the key must never reach a message or a log').not.toMatch(
      /(message|console\.(warn|info|error))[^\n]*apiKey/
    );
  });

  it('every refusal is a NAMED reason, and none of them reroutes', () => {
    for (const code of [
      'CONNECTED_PROVIDER_INCOMPLETE',
      'CONNECTED_HOST_LOOPBACK',
      'CONNECTED_HOST_INSECURE_PUBLIC',
      'CONNECTED_EGRESS_BLOCKED',
      'CONNECTED_PROVIDER_UNREACHABLE',
    ]) {
      expect(lane, `refusal ${code} is missing`).toContain(code);
    }
    // The whole point: a failure here ends the turn. It never warms a local model
    // and never falls back to the metered cloud lane.
    expect(lane).not.toContain('warmLocalModel');
    expect(lane).not.toContain('handleEveCloudCompletions');
    expect(lane).not.toContain('handleLocalOpenAiCompletions');
    expect(lane).not.toContain('fetchOllama');
  });

  it('it marks a non-OK upstream and disposes its scope (F-14, same as its template)', () => {
    expect(lane).toContain('upstreamScope.markUpstreamError()');
    expect(lane).toContain('upstreamScope.dispose()');
  });
});

describe('the dispatch — a BYOK turn never gets classified as local first', () => {
  const shim = read('packages/desktop/src/process/commandEve/ollamaOpenAiShim.ts');
  const dispatch = shim.slice(shim.indexOf('async function handleChatCompletions('));

  it('the connected route is resolved BEFORE the local egress block', () => {
    const connectedAt = dispatch.indexOf('await options.connectedProviderRouting()');
    const localEgressAt = dispatch.indexOf("kind: 'local',");
    expect(connectedAt, 'the connected lane is never dispatched').toBeGreaterThan(-1);
    expect(connectedAt, 'a third-party turn would be receipted as a local one').toBeLessThan(localEgressAt);
  });

  it('a resolver failure refuses instead of falling through to a local turn', () => {
    const block = dispatch.slice(
      dispatch.indexOf('await options.connectedProviderRouting()') - 400,
      dispatch.indexOf('let localOpenAiRoute')
    );
    expect(block).toContain('CONNECTED_PROVIDER_UNRESOLVED');
    expect(block).toContain('return;');
  });

  it('the shim default is INERT, so an un-wired shim behaves exactly as before', () => {
    expect(shim).toContain(
      'shimOptions.connectedProviderRouting || ((): CommandEveConnectedProviderRoute => ({ active: false }))'
    );
  });

  it('main injects the resolver at every shim start site, and keeps the key', () => {
    const main = read('packages/desktop/src/index.ts');
    const starts = [...main.matchAll(/kanbanAcpRead: readKanbanAcpBoard,/g)].length;
    const injected = [...main.matchAll(/connectedProviderRouting: buildCommandEveShimConnectedProviderResolver\(\),/g)]
      .length;
    expect(starts).toBeGreaterThan(0);
    expect(injected, 'a shim start site would silently have no BYOK lane').toBe(starts);
    const resolver = main.slice(
      main.indexOf('function buildCommandEveShimConnectedProviderResolver'),
      main.indexOf('function buildCommandEveShimApprovalResolver')
    );
    expect(resolver).toContain("httpRequest<IProvider[]>('GET', '/api/providers')");
    expect(resolver, 'an unreadable store must mean "not this lane", never "run it elsewhere"').toContain(
      'return { active: false }'
    );
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

  it('it answers with its own reason code when the row cannot be used', () => {
    expect(bridge).toContain('CONNECTED_PROVIDER_UNAVAILABLE');
  });

  it('and it now RESOLVES: the shim provider with the BYOK model name on it', () => {
    // The agent only ever addresses the loopback shim; the shim's fourth lane
    // carries the turn onward. So the resolved provider is the shim row, and the
    // model name travels so the conversation record is honest about what ran.
    const branch = bridge.slice(
      bridge.indexOf('if (isConnectedSelection(selection)) {'),
      bridge.indexOf('// Privat (lokal) lane')
    );
    expect(branch).toContain("lane: 'connected' as const");
    expect(branch).toContain('use_model: route.model');
    expect(branch, 'the wire-missing refusal outlived the wire').not.toContain('CONNECTED_PROVIDER_NO_WIRE');
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
