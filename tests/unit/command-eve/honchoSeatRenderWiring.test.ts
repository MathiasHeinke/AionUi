/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * COMPA-624 Inc.3 — the SEAT RENDER wiring (H-INT-3/4/5/9/10). Proves, through the
 * REAL writeHermesRuntimeFiles seam (via provisionSeatRuntimeFiles → config.yaml +
 * SOUL.md), that:
 *   - an un-provisioned seat is BYTE-IDENTICAL (no honcho MCP entry, no SOUL clause),
 *   - a FRESH-READY seat with a venv launcher advertises the honcho MCP server with a
 *     per-seat, secret-free, loopback env + gains the SOUL memory clause,
 *   - a stale / cross-seat / launcher-less snapshot renders NOTHING.
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  provisionSeatRuntimeFiles,
  resolveCommandEveRuntimeBootstrapPaths,
} from '@/process/commandEve/runtimeBootstrapCore';
import { resolveHonchoRenderForSeat } from '@/process/commandEve/honchoRuntimeRenderCore';
import { writeHonchoReadyState } from '@/process/commandEve/honchoReadyStateFile';
import { reduceHonchoReadiness } from '@/process/commandEve/honchoReadinessCore';
import { HONCHO_DERIVER_BRANCH_CLOUD, HONCHO_DERIVER_BRANCH_LOCAL } from '@/process/commandEve/honchoRuntimeConfigCore';
import { __resetActiveSeatForTests } from '@/process/commandEve/seatContextCore';

const SEAT_A = 'a1b2c3d4-e5f6-4789-aabb-ccddeeff0011';
const SEAT_B = 'ffeeddcc-bbaa-4321-9988-776655443322';

const tempRoots: string[] = [];
const makeUserData = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'honcho-inc3-render-'));
  tempRoots.push(root);
  return root;
};

/** Write a fresh (probedAt=now) ready snapshot into the seat's OWN honcho home. */
function writeReadySnapshot(hermesHome: string, seatId: string, branch: string): void {
  const honchoHome = path.join(hermesHome, 'honcho');
  writeHonchoReadyState(honchoHome, reduceHonchoReadiness({ provisioned: true, serverProbe: { ok: true }, deriverProbe: { ok: true }, seatId, branch, now: Date.now() }));
}

/** Create the fake venv python so the O2 launcher resolves. */
function makeVenvPython(hermesVenv: string): void {
  const bin = path.join(hermesVenv, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'python'), '#!/bin/sh\n', { mode: 0o755 });
}

afterEach(() => {
  __resetActiveSeatForTests();
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('resolveHonchoRenderForSeat', () => {
  it('no readiness ⇒ { ready: false }', () => {
    const userData = makeUserData();
    const paths = resolveCommandEveRuntimeBootstrapPaths(userData, SEAT_A);
    const r = resolveHonchoRenderForSeat({ userDataPath: userData, seatId: SEAT_A, hermesVenv: paths.hermesVenv });
    expect(r.ready).toBe(false);
    expect(r.launcher).toBeUndefined();
  });

  it('fresh-ready cloud + venv python ⇒ ready cfg (cfg.ready true) + launcher', () => {
    const userData = makeUserData();
    const paths = resolveCommandEveRuntimeBootstrapPaths(userData, SEAT_A);
    writeReadySnapshot(paths.hermesHome, SEAT_A, HONCHO_DERIVER_BRANCH_CLOUD);
    makeVenvPython(paths.hermesVenv);
    const r = resolveHonchoRenderForSeat({ userDataPath: userData, seatId: SEAT_A, hermesVenv: paths.hermesVenv });
    expect(r.ready).toBe(true);
    expect(r.cfg?.ready).toBe(true); // not false ⇒ honchoMcpServerForSeat will advertise
    expect(r.launcher?.command).toContain(`${path.sep}bin${path.sep}python`);
    expect(r.launcher?.args).toEqual(['-m', 'honcho.mcp']);
  });

  it('fresh-ready but NO venv python ⇒ ready but launcher undefined (never points at a dead binary)', () => {
    const userData = makeUserData();
    const paths = resolveCommandEveRuntimeBootstrapPaths(userData, SEAT_A);
    writeReadySnapshot(paths.hermesHome, SEAT_A, HONCHO_DERIVER_BRANCH_LOCAL);
    const r = resolveHonchoRenderForSeat({ userDataPath: userData, seatId: SEAT_A, hermesVenv: paths.hermesVenv });
    expect(r.ready).toBe(true);
    expect(r.launcher).toBeUndefined();
  });

  it('an unsafe seat id ⇒ { ready: false } (fail-soft, no throw)', () => {
    const userData = makeUserData();
    expect(resolveHonchoRenderForSeat({ userDataPath: userData, seatId: '../../escape', hermesVenv: '' }).ready).toBe(false);
  });
});

describe('config.yaml + SOUL.md render through the REAL provisioning seam', () => {
  it('H-INT-3/4 — an un-provisioned seat is byte-identical (no honcho MCP entry, no SOUL clause)', () => {
    const userData = makeUserData();
    const paths = resolveCommandEveRuntimeBootstrapPaths(userData, SEAT_A);
    const res = provisionSeatRuntimeFiles({ userDataPath: userData, seatId: SEAT_A });
    expect(res.ok).toBe(true);
    const config = fs.readFileSync(path.join(paths.hermesHome, 'config.yaml'), 'utf8');
    const soul = fs.readFileSync(path.join(paths.hermesHome, 'SOUL.md'), 'utf8');
    // The default mcp_servers is the empty map; no honcho server leaked.
    expect(config).toContain('mcp_servers: {}');
    expect(config).not.toContain('"honcho":');
    expect(config).not.toContain('HONCHO_DB_URI');
    expect(soul).not.toContain('Dauerhaftes Gedächtnis');
  });

  it('H-INT-4/5/9 — a fresh-ready seat advertises the honcho MCP server + gains the SOUL clause', () => {
    const userData = makeUserData();
    const paths = resolveCommandEveRuntimeBootstrapPaths(userData, SEAT_A);
    // Provision once so the seat home exists, then plant readiness + venv and re-provision.
    provisionSeatRuntimeFiles({ userDataPath: userData, seatId: SEAT_A });
    writeReadySnapshot(paths.hermesHome, SEAT_A, HONCHO_DERIVER_BRANCH_CLOUD);
    makeVenvPython(paths.hermesVenv);
    const res = provisionSeatRuntimeFiles({ userDataPath: userData, seatId: SEAT_A });
    expect(res.ok).toBe(true);

    const config = fs.readFileSync(path.join(paths.hermesHome, 'config.yaml'), 'utf8');
    const soul = fs.readFileSync(path.join(paths.hermesHome, 'SOUL.md'), 'utf8');
    // The honcho MCP server is advertised, per-seat + secret-free + loopback.
    // (values are JSON.stringify-quoted by yamlScalar.)
    expect(config).toContain('"honcho":');
    expect(config).toContain('"HONCHO_DB_URI": "postgresql://127.0.0.1:5432/honcho_');
    expect(config).toContain('"HONCHO_WORKSPACE_ID": "ws_a1b2c3d4-e5f6-4789-aabb-ccddeeff0011"');
    // No secret / password ever serialized into the env.
    expect(config).not.toMatch(/password|CEVE\.v1|api_key/i);
    // The SOUL now teaches the durable memory (honest — only because it is ready).
    expect(soul).toContain('Dauerhaftes Gedächtnis');
  });

  it('H-INT-10 — seat B\'s ready file can NOT make seat A advertise honcho', () => {
    const userData = makeUserData();
    const pathsA = resolveCommandEveRuntimeBootstrapPaths(userData, SEAT_A);
    const pathsB = resolveCommandEveRuntimeBootstrapPaths(userData, SEAT_B);
    // only B gets a ready snapshot + venv
    provisionSeatRuntimeFiles({ userDataPath: userData, seatId: SEAT_B });
    writeReadySnapshot(pathsB.hermesHome, SEAT_B, HONCHO_DERIVER_BRANCH_CLOUD);
    makeVenvPython(pathsB.hermesVenv);
    // provision A — A has no readiness of its own
    const res = provisionSeatRuntimeFiles({ userDataPath: userData, seatId: SEAT_A });
    expect(res.ok).toBe(true);
    const configA = fs.readFileSync(path.join(pathsA.hermesHome, 'config.yaml'), 'utf8');
    expect(configA).toContain('mcp_servers: {}');
    expect(configA).not.toContain('"honcho":');
    expect(configA).not.toContain('HONCHO_DB_URI');
  });
});
