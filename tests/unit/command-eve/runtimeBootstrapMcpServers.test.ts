import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildCommandEveManagedImageHermesMcpServer,
  renderHermesMcpServersYaml,
  resolveCommandEveManagedNodeResourceRoot,
  resolveCommandEveManagedNodeExecutable,
} from '@/process/commandEve/runtimeBootstrapCore';
import { deriveCommandEveManagedImageRequestId } from '@/process/resources/builtinMcp/managedImageRequestIdentityCore';

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
      '      "PYTHONDONTWRITEBYTECODE": "1"',
    ]);
  });

  it('guards the signed app bundle for a connector without args or caller-supplied env', () => {
    const lines = renderHermesMcpServersYaml([{ id: 'bare', command: 'run-bare' }]);
    expect(lines).toEqual([
      'mcp_servers:',
      '  "bare":',
      '    command: "run-bare"',
      '    args: []',
      '    env:',
      '      "PYTHONDONTWRITEBYTECODE": "1"',
    ]);
  });

  it('fails closed when a connector attempts to re-enable Python bytecode writes', () => {
    const lines = renderHermesMcpServersYaml([
      { id: 'unsafe-python', command: 'python', env: { PYTHONDONTWRITEBYTECODE: '0' } },
    ]);

    expect(lines.filter((line) => line.includes('PYTHONDONTWRITEBYTECODE'))).toEqual([
      '      "PYTHONDONTWRITEBYTECODE": "1"',
    ]);
  });

  it('renders multiple connectors in order', () => {
    const lines = renderHermesMcpServersYaml([
      { id: 'a', command: 'cmd-a' },
      { id: 'b', command: 'cmd-b' },
    ]);
    expect(lines.filter((line) => /^  ".*":$/.test(line))).toEqual(['  "a":', '  "b":']);
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

  it('selects the checkout resource root in dev without weakening packaged fail-closed behavior', () => {
    const checkout = makeResourcesRoot();
    const checkoutResources = path.join(checkout, 'resources');
    const executable = writeManagedNode(checkoutResources);
    const electronResources = '/Applications/Electron.app/Contents/Resources';

    const devRoot = resolveCommandEveManagedNodeResourceRoot(electronResources, {
      devSourceRun: true,
      cwd: checkout,
    });
    expect(devRoot).toBe(checkoutResources);
    expect(resolveCommandEveManagedNodeExecutable(devRoot, 'darwin', 'arm64')).toBe(executable);

    const packagedRoot = resolveCommandEveManagedNodeResourceRoot(electronResources, {
      devSourceRun: false,
      cwd: checkout,
    });
    expect(packagedRoot).toBe(electronResources);
    expect(resolveCommandEveManagedNodeExecutable(packagedRoot, 'darwin', 'arm64')).toBe('');
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
      userDataPath: '/private/seat-user-data',
    });

    expect(server?.command).toBe('/signed/managed/node');
    expect(server?.env?.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(server?.env?.AIONUI_IMG_API_KEY_FILE).toBe('/private/runtime-security/shim-auth-token');
    expect(server?.env?.DATA_DIR).toBe('/private/seat-user-data');
  });

  it('fails closed instead of sending a standalone MCP child to a fallback data root', () => {
    const server = buildCommandEveManagedImageHermesMcpServer({
      nodeExecutable: '/signed/managed/node',
      scriptPath: '/signed/app.asar.unpacked/out/main/builtin-mcp-image-gen.js',
      shimBaseUrl: 'http://127.0.0.1:25811',
      authTokenFile: '/private/runtime-security/shim-auth-token',
      userDataPath: 'relative-seat-user-data',
    });

    expect(server).toBeUndefined();
  });

  it('starts under external Node and persists the shadow receipt inside DATA_DIR', async () => {
    const root = makeResourcesRoot();
    const dataDir = path.join(root, 'seat-user-data');
    const tokenFile = path.join(root, 'shim-auth-token');
    const permit = `evespend_${'c'.repeat(64)}`;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(tokenFile, 'node-smoke-token', { mode: 0o600 });

    const shimRequests: Array<{ url: string; authorization: string; body: Record<string, unknown> }> = [];
    const localShim = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        shimRequests.push({
          url: request.url || '',
          authorization: request.headers.authorization || '',
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
        });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            data: [
              {
                artifact_handle: `img_h_${'a'.repeat(64)}`,
                media_type: 'image/png',
                sha256: 'b'.repeat(64),
                bytes_count: 42,
              },
            ],
            usage: { model: 'node-smoke-model', cost: 0 },
          })
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      localShim.once('error', reject);
      localShim.listen(0, '127.0.0.1', resolve);
    });
    const address = localShim.address();
    if (!address || typeof address === 'string') throw new Error('Local image shim did not bind a TCP port.');

    const child = spawn(
      'node',
      [
        '--import',
        'tsx',
        path.join(process.cwd(), 'packages/desktop/src/process/resources/builtinMcp/imageGenServer.ts'),
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATA_DIR: dataDir,
          AIONUI_IMG_PLATFORM: 'command-eve-managed-image',
          AIONUI_IMG_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
          AIONUI_IMG_MODEL: 'command-eve-visual-direction-v1',
          AIONUI_IMG_API_KEY_FILE: tokenFile,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const lines = readline.createInterface({ input: child.stdout });
    const pending = new Map<number, (message: Record<string, unknown>) => void>();
    lines.on('line', (line) => {
      try {
        const message = JSON.parse(line) as Record<string, unknown>;
        const id = typeof message.id === 'number' ? message.id : undefined;
        if (id !== undefined) pending.get(id)?.(message);
      } catch {
        // The MCP protocol is JSONL. Non-JSON diagnostics belong on stderr
        // and are ignored here so they cannot masquerade as a response.
      }
    });
    const nextResponse = (id: number) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`MCP child response timed out for id=${id}; stderr=${stderr}`)),
          10_000
        );
        pending.set(id, (message) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(message);
        });
      });
    const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(message)}\n`);

    try {
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'command-eve-node-smoke', version: '1.0.0' },
        },
      });
      await nextResponse(1);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const managedRequestId = deriveCommandEveManagedImageRequestId();
      const hermesMeta = { hermes: { logicalCallId: managedRequestId } };
      send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'aionui_image_generation',
          arguments: {
            prompt: 'Generate image: local node smoke',
            permit,
            aspect_ratio: '1:1',
            resolution: '1K',
          },
          _meta: hermesMeta,
        },
      });
      const response = await nextResponse(2);
      expect(response.error).toBeUndefined();
      expect(JSON.stringify(response.result)).toContain(`img_h_${'a'.repeat(64)}`);
      expect(stderr).not.toContain('Services not registered');
      expect(shimRequests).toEqual([
        {
          url: '/v1/images',
          authorization: 'Bearer node-smoke-token',
          body: expect.objectContaining({
            requestId: deriveCommandEveManagedImageRequestId(hermesMeta),
          }),
        },
      ]);

      const receiptDir = path.join(dataDir, 'command-eve-runtime', 'route-receipts');
      const receipts = fs.readdirSync(receiptDir);
      expect(receipts).toHaveLength(1);
      const receipt = fs.readFileSync(path.join(receiptDir, receipts[0]), 'utf8');
      expect(receipt).toContain('"raw_text_stored": false');
      expect(receipt).not.toContain('local node smoke');
    } finally {
      child.kill();
      lines.close();
      await new Promise<void>((resolve) => localShim.close(() => resolve()));
    }
  }, 20_000);
});
