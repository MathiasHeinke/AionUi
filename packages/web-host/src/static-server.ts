/**
 * WebUI static server.
 *
 * Serves out/renderer/ as the SPA and reverse-proxies /api/*, /ws, /login and
 * /logout to aioncore. All auth goes to backend's aionui-auth crate;
 * /login and /logout are aionui-auth's top-level paths, the rest live under
 * /api/auth/*.
 *
 * Design: Node native http + serve-handler. No Express. No business routes.
 */

import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import net, { type Socket } from 'node:net';
import serveHandler from 'serve-handler';

export type StaticServerOptions = {
  staticDir: string;
  backendPort: number;
  port?: number;
  allowRemote?: boolean;
  getBackendCapability?: () => string;
};

export type StaticServerHandle = {
  port: number;
  url: string;
  localUrl: string;
  networkUrl?: string;
  lanIP?: string;
  stop: () => Promise<void>;
};

const DEFAULT_PORT = 25808;
export const LOCAL_BACKEND_CAPABILITY_HEADER = 'x-aionui-local-capability';

export function isAllowedWebUiProxyOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) return true;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  try {
    const parsed = new URL(origin);
    return (
      parsed.protocol === 'http:' &&
      parsed.hostname === '127.0.0.1' &&
      parsed.port === String(port) &&
      parsed.pathname === '/' &&
      parsed.search === '' &&
      parsed.hash === '' &&
      parsed.username === '' &&
      parsed.password === ''
    );
  } catch {
    return false;
  }
}

function getLanIP(): string | null {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const iface of nets[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
}

function forwardToBackend(
  req: IncomingMessage,
  res: ServerResponse,
  backendPort: number,
  getBackendCapability?: () => string
): void {
  const headers: http.OutgoingHttpHeaders = { ...req.headers, host: `127.0.0.1:${backendPort}` };
  delete headers[LOCAL_BACKEND_CAPABILITY_HEADER];
  // The outer proxy validates the browser origin against its live loopback
  // port. AionCore receives no browser Origin because its per-launch allowlist
  // is fixed before this optional WebUI is started.
  delete headers.origin;
  const capability = getBackendCapability?.();
  if (capability) headers[LOCAL_BACKEND_CAPABILITY_HEADER] = capability;
  const options: http.RequestOptions = {
    hostname: '127.0.0.1',
    port: backendPort,
    path: req.url,
    method: req.method,
    headers,
  };
  const proxy = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxy.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'BACKEND_UNREACHABLE' }));
    } else {
      res.destroy();
    }
  });
  req.pipe(proxy);
}

// Max bytes we peek before forcing a routing decision. An HTTP request-line
// on its own is typically < 100 bytes; a full header block is < 2 KB. If we
// haven't seen a newline after 4 KB the client is sending something weird —
// hand it to the internal HTTP server and let it return 400.
const PEEK_LIMIT_BYTES = 4096;

/**
 * Splice `client` to a TCP endpoint on `targetPort`. Any bytes already read
 * from `client` during peek are replayed to the upstream as the first write,
 * so the endpoint sees the full HTTP request as-sent.
 */
function spliceToTcpEndpoint(client: Socket, targetPort: number, initialBytes: Buffer): void {
  client.setNoDelay(true);
  client.setKeepAlive(true);
  client.setTimeout(0);
  const upstream = net.connect({ host: '127.0.0.1', port: targetPort });
  upstream.setNoDelay(true);
  upstream.setKeepAlive(true);
  upstream.once('connect', () => {
    if (initialBytes.length > 0) upstream.write(initialBytes);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  const tearDown = (): void => {
    client.destroy();
    upstream.destroy();
  };
  upstream.on('error', tearDown);
  client.on('error', tearDown);
  upstream.on('close', tearDown);
  client.on('close', tearDown);
}

/**
 * Decide routing from the first chunk of an incoming HTTP connection:
 *  - `true`  → `GET /ws[...] HTTP/1.x` (WebSocket upgrade), splice to backend
 *  - `false` → any other HTTP method / path, hand to internal HTTP server
 *  - `null`  → need more bytes (no CRLF yet)
 *
 * We only check the request-line; `Upgrade: websocket` is not strictly
 * required — the backend will reject a non-upgrade `GET /ws` on its own.
 * Keeping the rule simple means we can decide after the first ~50 bytes
 * instead of waiting for the full header block.
 */
function peekWsRoute(buf: Buffer): boolean | null {
  const newlineIdx = buf.indexOf(0x0a); // \n
  if (newlineIdx < 0) return null;
  const firstLine = buf.slice(0, newlineIdx).toString('ascii');
  return /^GET\s+\/ws(?:\?[^\s]*)?\s+HTTP\/1\.[01]\r?$/.test(firstLine);
}

function websocketHeaderEnd(buf: Buffer): number {
  const crlf = buf.indexOf('\r\n\r\n');
  if (crlf >= 0) return crlf + 4;
  const lf = buf.indexOf('\n\n');
  return lf >= 0 ? lf + 2 : -1;
}

function websocketHeaderValue(request: Buffer, name: string): string | undefined {
  const headerEnd = websocketHeaderEnd(request);
  if (headerEnd < 0) return undefined;
  const prefix = `${name.toLowerCase()}:`;
  for (const line of request.subarray(0, headerEnd).toString('latin1').split(/\r?\n/).slice(1)) {
    if (line.toLowerCase().startsWith(prefix)) return line.slice(line.indexOf(':') + 1).trim();
  }
  return undefined;
}

function rejectRawHttpRequest(client: Socket, status: 403 | 401, code: string): void {
  const body = JSON.stringify({ error: code });
  client.end(
    `HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Unauthorized'}\r\n` +
      'Content-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'Connection: close\r\n\r\n' +
      body
  );
}

export function injectWebSocketCapabilityHeaders(request: Buffer, capability: string): Buffer {
  const headerEnd = websocketHeaderEnd(request);
  if (headerEnd < 0) return request;

  const headerBlock = request.subarray(0, headerEnd).toString('latin1');
  const newline = headerBlock.includes('\r\n') ? '\r\n' : '\n';
  const lines = headerBlock
    .split(/\r?\n/)
    .filter(
      (line, index) =>
        index === 0 ||
        (!/^origin\s*:/i.test(line) && !new RegExp(`^${LOCAL_BACKEND_CAPABILITY_HEADER}\\s*:`, 'i').test(line))
    )
    .filter((line) => line.length > 0);
  const capabilityHeaders = capability ? [`${LOCAL_BACKEND_CAPABILITY_HEADER}: ${capability}`] : [];
  const rewritten = Buffer.from([lines[0], ...capabilityHeaders, ...lines.slice(1), '', ''].join(newline), 'latin1');
  return Buffer.concat([rewritten, request.subarray(headerEnd)]);
}

export async function startStaticServer(opts: StaticServerOptions): Promise<StaticServerHandle> {
  const port = opts.port ?? DEFAULT_PORT;
  if (opts.allowRemote === true) {
    throw new Error(
      'REMOTE_WEBUI_DISABLED: remote WebUI is unavailable until the proxy enforces authentication before forwarding to aioncore'
    );
  }
  const allowRemote = false;
  const host = '127.0.0.1';
  let publicPort = port;

  // The HTTP server listens only on loopback — user traffic hits the outer
  // net.Server first. We route to this server for everything except WS
  // upgrades, which go straight to the backend via a raw TCP splice.
  //
  // Why two listeners instead of using `http.Server`'s native `upgrade` event:
  // bun 1.3's http-compat layer does not faithfully forward writes on the
  // socket delivered to the `upgrade` handler, so the backend's 101 response
  // never reaches the browser (see #2824). Making the outer listener pure
  // TCP avoids touching that code path on both bun and node.
  const http_server: Server = http.createServer(async (req, res) => {
    try {
      if (!req.url || !req.method) {
        res.writeHead(400).end();
        return;
      }

      // /api/* — reverse proxy to backend (includes /api/auth/*).
      // /login and /logout are aionui-auth's top-level auth endpoints: proxy them too
      // so WebUI browser clients reach the backend without a path-rewrite.
      if (req.url.startsWith('/api/') || req.url.startsWith('/api?') || req.url === '/login' || req.url === '/logout') {
        if (!isAllowedWebUiProxyOrigin(req.headers.origin, publicPort)) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'ORIGIN_NOT_ALLOWED' }));
          return;
        }
        forwardToBackend(req, res, opts.backendPort, opts.getBackendCapability);
        return;
      }

      // static files + SPA fallback
      await serveHandler(req, res, {
        public: opts.staticDir,
        rewrites: [{ source: '**', destination: '/index.html' }],
      });
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'INTERNAL_ERROR' }));
      } else {
        res.destroy();
      }
    }
  });

  // Internal HTTP server — 127.0.0.1 ephemeral port, never visible to the user.
  await new Promise<void>((resolve, reject) => {
    http_server.once('error', reject);
    http_server.listen(0, '127.0.0.1', () => {
      http_server.off('error', reject);
      resolve();
    });
  });
  const internalPort = (http_server.address() as { port: number } | null)?.port;
  if (!internalPort) {
    throw new Error('internal HTTP server failed to bind to a port');
  }

  // User-facing listener: inspect the first line of every TCP connection and
  // route to either the backend (for /ws upgrades) or the internal HTTP
  // server (everything else). Both routes use raw TCP splice — no reliance
  // on http.Server's upgrade event.
  const tcp_server = net.createServer((client: Socket) => {
    let peeked = Buffer.alloc(0);
    let settled = false;
    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      client.removeListener('data', onData);
      client.removeListener('error', onEarlyError);
      client.removeListener('end', onEarlyEnd);
    };
    const onData = (chunk: Buffer): void => {
      peeked = Buffer.concat([peeked, chunk]);
      const decision = peekWsRoute(peeked);
      if (decision === null && peeked.length < PEEK_LIMIT_BYTES) return;
      if (decision === true && websocketHeaderEnd(peeked) < 0 && peeked.length < PEEK_LIMIT_BYTES) return;
      if (decision === true && websocketHeaderEnd(peeked) < 0) {
        cleanup();
        client.destroy();
        return;
      }
      if (decision === true && !isAllowedWebUiProxyOrigin(websocketHeaderValue(peeked, 'origin'), publicPort)) {
        cleanup();
        rejectRawHttpRequest(client, 403, 'ORIGIN_NOT_ALLOWED');
        return;
      }
      cleanup();
      const target = decision === true ? opts.backendPort : internalPort;
      const capability = decision === true ? (opts.getBackendCapability?.() ?? '') : '';
      const initialBytes = decision === true ? injectWebSocketCapabilityHeaders(peeked, capability) : peeked;
      spliceToTcpEndpoint(client, target, initialBytes);
    };
    const onEarlyError = (): void => {
      cleanup();
      client.destroy();
    };
    const onEarlyEnd = (): void => {
      // Client closed before we saw a request line — nothing to route.
      cleanup();
      client.destroy();
    };
    client.on('data', onData);
    client.on('error', onEarlyError);
    client.on('end', onEarlyEnd);
  });

  await new Promise<void>((resolve, reject) => {
    tcp_server.once('error', reject);
    tcp_server.listen(port, host, () => {
      tcp_server.off('error', reject);
      resolve();
    });
  });

  const actualPort = (tcp_server.address() as { port: number } | null)?.port ?? port;
  publicPort = actualPort;
  const lanIP = allowRemote ? (getLanIP() ?? undefined) : undefined;
  const localUrl = `http://127.0.0.1:${actualPort}`;
  const networkUrl = lanIP ? `http://${lanIP}:${actualPort}` : undefined;

  return {
    port: actualPort,
    url: networkUrl ?? localUrl,
    localUrl,
    networkUrl,
    lanIP,
    stop: () =>
      new Promise<void>((resolve) => {
        tcp_server.close(() => {
          http_server.close(() => resolve());
        });
      }),
  };
}

export async function stopStaticServer(handle: StaticServerHandle): Promise<void> {
  await handle.stop();
}
