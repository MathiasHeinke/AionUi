import { describe, expect, it } from 'vitest';

import {
  COMMAND_EVE_TERMINAL_MAX_OUTPUT_BYTES,
  chunkCommandEveTerminalOutput,
  createCommandEveTerminalEnvironment,
  parseCommandEveTerminalResize,
  parseCommandEveTerminalStartRequest,
  parseCommandEveTerminalWrite,
  resolveCommandEveTerminalCwd,
} from '@/process/security/commandEveTerminalCore';

describe('Command EVE terminal core', () => {
  it('bounds geometry and refuses oversized input', () => {
    expect(parseCommandEveTerminalStartRequest({ cwd: '/tmp', cols: 9999, rows: 1 })).toEqual({
      cwd: '/tmp',
      cols: 400,
      rows: 5,
    });
    expect(parseCommandEveTerminalResize({ terminalId: '01234567-89ab-cdef', cols: 10, rows: 999 })).toEqual({
      terminalId: '01234567-89ab-cdef',
      cols: 20,
      rows: 200,
    });
    expect(() =>
      parseCommandEveTerminalWrite({ terminalId: '01234567-89ab-cdef', data: 'x'.repeat(70 * 1024) })
    ).toThrow('per-write limit');
  });

  it('builds a shell environment without leaking EVE or provider credentials', () => {
    const environment = createCommandEveTerminalEnvironment({
      HOME: '/Users/eve',
      PATH: '/usr/bin:/bin',
      LANG: 'de_DE.UTF-8',
      LC_ALL: 'de_DE.UTF-8',
      OPENROUTER_API_KEY: 'must-not-leak',
      SUPABASE_SERVICE_ROLE_KEY: 'must-not-leak',
      COMMAND_EVE_INTERNAL_TOKEN: 'must-not-leak',
    });

    expect(environment).toMatchObject({
      HOME: '/Users/eve',
      PATH: '/usr/bin:/bin',
      LANG: 'de_DE.UTF-8',
      LC_ALL: 'de_DE.UTF-8',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'CommandEVE',
    });
    expect(environment).not.toHaveProperty('OPENROUTER_API_KEY');
    expect(environment).not.toHaveProperty('SUPABASE_SERVICE_ROLE_KEY');
    expect(environment).not.toHaveProperty('COMMAND_EVE_INTERNAL_TOKEN');
  });

  it('chunks oversized PTY output losslessly without splitting Unicode', () => {
    const source = `${'a'.repeat(COMMAND_EVE_TERMINAL_MAX_OUTPUT_BYTES)}🙂${'ü'.repeat(100)}`;
    const chunks = chunkCommandEveTerminalOutput(source);
    expect(chunks.join('')).toBe(source);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThanOrEqual(COMMAND_EVE_TERMINAL_MAX_OUTPUT_BYTES);
      expect(chunk).not.toContain('\uFFFD');
    }
  });

  it('uses only existing directories and falls back deterministically', () => {
    const existing = new Set(['/project', '/fallback']);
    expect(resolveCommandEveTerminalCwd('/project', '/fallback', (candidate) => existing.has(candidate))).toBe(
      '/project'
    );
    expect(resolveCommandEveTerminalCwd('/missing', '/fallback', (candidate) => existing.has(candidate))).toBe(
      '/fallback'
    );
    expect(() => resolveCommandEveTerminalCwd('/missing', '/also-missing', () => false)).toThrow('working directory');
  });
});
