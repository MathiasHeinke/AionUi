/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1747, trap #6 — the reconciliation receipt must report the MCP servers the
 * config actually emitted.
 *
 * `hermes_config.mcp_servers` was a hardcoded `[]` and had been under-reporting
 * since the managed image server landed: the receipt named an empty list while
 * the emitted config.yaml named a server. A receipt that is always wrong in the
 * same direction is worse than no receipt, because it is believed.
 *
 * This could not be tested before, and that is part of the story: the only way
 * to reach the builder was a full runtime render, which in a test emits no
 * servers at all — so the wrong constant looked correct. The builder is now
 * reachable directly, which is why the non-empty case below exists.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildCommandEveRuntimeReconciliation,
  loadCommandEveCapabilityPack,
  resolveCommandEveRuntimeBootstrapPaths,
} from '@/process/commandEve/runtimeBootstrapCore';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-reconciliation-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function reconcile(ids?: readonly string[]) {
  const paths = resolveCommandEveRuntimeBootstrapPaths(tmpRoot);
  const pack = loadCommandEveCapabilityPack('');
  return ids === undefined
    ? buildCommandEveRuntimeReconciliation(paths, pack, [])
    : buildCommandEveRuntimeReconciliation(paths, pack, [], ids);
}

describe('hermes_config.mcp_servers reflects what was emitted', () => {
  it('reports every emitted server id', () => {
    // The case the old hardcoded `[]` got wrong. A seat running the image
    // generator, the artifact capability and Honcho reported none of them.
    expect(
      reconcile(['aionui-image-generation', 'aionui-eve-artifacts', 'honcho-seat-1']).hermes_config.mcp_servers
    ).toEqual(['aionui-image-generation', 'aionui-eve-artifacts', 'honcho-seat-1']);
  });

  it('still reports an empty list when nothing was emitted', () => {
    // The NEGATIVE control: the fix must not turn "no servers" into a false
    // positive either. A seat with no managed node emits nothing and says so.
    expect(reconcile([]).hermes_config.mcp_servers).toEqual([]);
  });

  it('defaults to empty for the skills-only reconciler, which computes no servers', () => {
    // `ensureCommandEveManagedSkillsReconciliation` reconciles skills and never
    // renders a config. Defaulting keeps its existing meaning instead of having
    // it claim a server set it did not compute.
    expect(reconcile().hermes_config.mcp_servers).toEqual([]);
  });

  it('does not alias the caller’s array', () => {
    const ids = ['aionui-eve-artifacts'];
    const reconciliation = reconcile(ids);
    ids.push('smuggled-in-later');
    expect(reconciliation.hermes_config.mcp_servers).toEqual(['aionui-eve-artifacts']);
  });
});
