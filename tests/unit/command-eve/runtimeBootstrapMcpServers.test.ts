import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildCommandEveManagedImageHermesMcpServer,
  renderHermesMcpServersYaml,
  resolveCommandEveManagedNodeExecutable,
} from '@/process/commandEve/runtimeBootstrapCore';

const tempRoots: string[] = [];

function makeResourcesRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-managed-node-'));
  tempRoots.push(root);
  return root;
}

function writeManagedNode(resourcesRoot: string, version = 'node-v24.11.0'): string {
  const executable = path.join(
    resourcesRoot,
    'bundled-aioncore',
    'darwin-arm64',
    'managed-resources',
    'node',
    version,
    'bin',
    'node'
  );
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, 'managed-node');
  return executable;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('renderHermesMcpServersYaml', () => {
  it('renders the inline empty map for no vetted connectors (identical to the prior literal)', () => {
    expect(renderHermesMcpServersYaml([])).toEqual(['mcp_servers: {}']);
  });

  it('renders a stdio connector with args and env, all values quoted', () => {
    const lines = renderHermesMcpServersYaml([
      { id: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp'], env: { LOG_LEVEL: 'info' } },
    ]);
    expect(lines).toEqual([
      'mcp_servers:',
      '  "context7":',
      '    command: "npx"',
      '    args:',
      '      - "-y"',
      '      - "@upstash/context7-mcp"',
      '    env:',
      '      "LOG_LEVEL": "info"',
    ]);
  });

  it('emits empty inline collections for a connector without args or env', () => {
    const lines = renderHermesMcpServersYaml([{ id: 'bare', command: 'run-bare' }]);
    expect(lines).toEqual(['mcp_servers:', '  "bare":', '    command: "run-bare"', '    args: []', '    env: {}']);
  });

  it('renders multiple connectors in order', () => {
    const lines = renderHermesMcpServersYaml([
      { id: 'a', command: 'cmd-a' },
      { id: 'b', command: 'cmd-b' },
    ]);
    expect(lines.filter((line) => line.endsWith(':') && line.startsWith('  '))).toEqual(['  "a":', '  "b":']);
  });

  it('quote-escapes ids and values that contain special characters (no YAML injection)', () => {
    const lines = renderHermesMcpServersYaml([{ id: 'evil: key', command: 'cmd', env: { 'A B': 'x: y # z' } }]);
    expect(lines).toContain('  "evil: key":');
    expect(lines).toContain('      "A B": "x: y # z"');
  });

  it('resolves the single signed managed Node executable for the packaged runtime key', () => {
    const resourcesRoot = makeResourcesRoot();
    const executable = writeManagedNode(resourcesRoot);

    expect(resolveCommandEveManagedNodeExecutable(resourcesRoot, 'darwin', 'arm64')).toBe(executable);
  });

  it('fails closed when the managed Node layout is ambiguous or symlinked', () => {
    const ambiguousRoot = makeResourcesRoot();
    writeManagedNode(ambiguousRoot, 'node-v24.11.0');
    writeManagedNode(ambiguousRoot, 'node-v25.0.0');
    expect(resolveCommandEveManagedNodeExecutable(ambiguousRoot, 'darwin', 'arm64')).toBe('');

    const symlinkRoot = makeResourcesRoot();
    const outsideNode = path.join(makeResourcesRoot(), 'node');
    fs.writeFileSync(outsideNode, 'outside-node');
    const versionDir = path.join(
      symlinkRoot,
      'bundled-aioncore',
      'darwin-arm64',
      'managed-resources',
      'node',
      'node-v24.11.0',
      'bin'
    );
    fs.mkdirSync(versionDir, { recursive: true });
    fs.symlinkSync(outsideNode, path.join(versionDir, 'node'));
    expect(resolveCommandEveManagedNodeExecutable(symlinkRoot, 'darwin', 'arm64')).toBe('');
  });

  it('builds the managed image MCP on Node without weakening the Electron RunAsNode fuse', () => {
    const server = buildCommandEveManagedImageHermesMcpServer({
      nodeExecutable: '/signed/managed/node',
      scriptPath: '/signed/app.asar.unpacked/out/main/builtin-mcp-image-gen.js',
      shimBaseUrl: 'http://127.0.0.1:25811',
      authTokenFile: '/private/runtime-security/shim-auth-token',
    });

    expect(server?.command).toBe('/signed/managed/node');
    expect(server?.env?.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(server?.env?.AIONUI_IMG_API_KEY_FILE).toBe('/private/runtime-security/shim-auth-token');
  });
});
