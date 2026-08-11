/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { parseTypedUIEnvelope, validateTypedUIEnvelope } from '@/common/typedUI';
import { describe, expect, it } from 'vitest';
import { cloneFixture, typedUIFixture } from './fixtures';

function issuesOf(value: unknown): string[] {
  const result = validateTypedUIEnvelope(value);
  return 'issues' in result ? result.issues.map((issue) => issue.code) : [];
}

describe('Typed UI schema and graph properties', () => {
  it('accepts the canonical fixture and round-trips JSON', () => {
    expect(validateTypedUIEnvelope(typedUIFixture())).toEqual({ ok: true, value: typedUIFixture() });
    expect(parseTypedUIEnvelope(JSON.stringify(typedUIFixture()))).toEqual({ ok: true, value: typedUIFixture() });
  });

  it.each(['setState', 'shell', 'ipc', 'fetch', 'goal_control', 'worker_control', 'javascript'])(
    'rejects non-allowlisted action %s',
    (type) => {
      const candidate = cloneFixture();
      const actions = candidate.actions as Record<string, Record<string, unknown>>;
      actions.replyState.type = type;
      expect(issuesOf(candidate)).toContain('action.not_allowed');
    }
  );

  it.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'ftp://example.com/file',
    'https://user:pass@example.com/private',
    '//example.com/path',
  ])('rejects unsafe URL property %s', (url) => {
    const candidate = cloneFixture();
    const actions = candidate.actions as Record<string, Record<string, unknown>>;
    actions.replyState = { type: 'open_url', params: { url } };
    expect(issuesOf(candidate)).toContain('action.invalid_params');
  });

  it.each(['style', 'className', 'dangerouslySetInnerHTML', 'href', 'src', 'onClick'])(
    'rejects renderer-owned prop escape hatch %s',
    (prop) => {
      const candidate = cloneFixture();
      const elements = candidate.elements as Record<string, Record<string, unknown>>;
      (elements.heading.props as Record<string, unknown>)[prop] = 'owned-by-model';
      expect(issuesOf(candidate)).toContain('element.invalid_props');
    }
  );

  it('rejects missing children, cycles and unreachable hidden payloads', () => {
    const missing = cloneFixture();
    ((missing.elements as Record<string, Record<string, unknown>>).root.children as string[]).push('missing');
    expect(issuesOf(missing)).toContain('tree.child_missing');

    const cycle = cloneFixture();
    const cycleElements = cycle.elements as Record<string, Record<string, unknown>>;
    cycleElements.goal.children = ['root'];
    expect(issuesOf(cycle)).toContain('tree.cycle');

    const unreachable = cloneFixture();
    (unreachable.elements as Record<string, unknown>).hidden = {
      type: 'Text',
      props: { text: 'hidden payload' },
      children: [],
    };
    expect(issuesOf(unreachable)).toContain('tree.unreachable');
  });

  it('rejects prototype-pollution keys parsed from JSON', () => {
    const serialized = JSON.stringify(typedUIFixture()).replace(
      '"state":{"decision":null,"note":"Ready"}',
      '"state":{"decision":null,"note":"Ready","__proto__":{"polluted":true}}'
    );
    const result = parseTypedUIEnvelope(serialized);
    expect('issues' in result && result.issues.map((issue) => issue.code)).toContain('envelope.invalid_state');
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it.each(['/__proto__/polluted', '/constructor/value', '/prototype/value', '/a/4294967294'])(
    'rejects unsafe or allocation-amplifying state path %s',
    (statePath) => {
      const candidate = cloneFixture();
      const actions = candidate.actions as Record<string, { params: Record<string, unknown> }>;
      actions.selectDecision.params.state_path = statePath;
      expect(issuesOf(candidate)).toContain('action.invalid_params');
    }
  );

  it('requires every state path to exist before rendering', () => {
    const candidate = cloneFixture();
    const actions = candidate.actions as Record<string, { params: Record<string, unknown> }>;
    actions.selectDecision.params.state_path = '/missing';
    expect(issuesOf(candidate)).toContain('tree.state_path_missing');
  });

  it('prevents implicit navigation and approval from passive events', () => {
    const passive = cloneFixture();
    const elements = passive.elements as Record<
      string,
      { type: string; props: Record<string, unknown>; children: string[]; on?: Record<string, string> }
    >;
    elements.heading = {
      type: 'Input',
      props: { label: 'Name', statePath: '/note' },
      children: [],
      on: { change: 'replyState' },
    };
    expect(issuesOf(passive)).toContain('element.invalid_events');

    const incompatible = cloneFixture();
    const actions = incompatible.actions as Record<string, Record<string, unknown>>;
    actions.openRun = { type: 'open_url', params: { url: 'https://example.com' } };
    expect(issuesOf(incompatible)).toContain('tree.action_incompatible');
  });

  it('binds each option event to the same option id, value and state path', () => {
    const candidate = cloneFixture();
    const actions = candidate.actions as Record<string, { params: Record<string, unknown> }>;
    actions.selectDecision.params.option_id = 'later';
    actions.selectDecision.params.value = 'later';
    expect(issuesOf(candidate)).toContain('tree.action_incompatible');
  });

  it('fails closed for malformed, partial and oversized JSON', () => {
    expect(parseTypedUIEnvelope('{"schema_version":')).toMatchObject({ ok: false });
    expect(parseTypedUIEnvelope('x'.repeat(512 * 1024 + 1))).toMatchObject({
      ok: false,
      issues: [{ code: 'envelope.too_large' }],
    });
  });
});
