/**
 * HTTP/WS bridge factory — drop-in replacement for bridge.buildProvider / bridge.buildEmitter
 * that routes calls to aioncore via REST API and WebSocket.
 *
 * Exported helpers produce objects with the same shape as @office-ai/platform bridge,
 * so existing renderer code works without changes.
 */

// ---------------------------------------------------------------------------
// Base URL
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __backendPort?: number;
    __aionBackend?: {
      getPort?: () => number;
    };
  }
}

function resolveRendererBackendPort(): number | undefined {
  if (typeof window === 'undefined') return undefined;
  // LIVE port FIRST (seat-switch correctness): a seat switch STOP+RESPAWNs the
  // backend, and the respawn binds a FRESH ephemeral port (the restart hook calls
  // start() without a preferredPort). window.__backendPort is contextBridge-
  // exposed at preload time and frozen at the BOOT value — preferring it orphaned
  // every post-switch HTTP/WS call onto the dead old port (the live 1.3 bug:
  // after a switch, settings PUTs bounced and list fetches silently died).
  // __aionBackend.getPort() is a synchronous IPC to main whose handler returns
  // backendManager.port — the CURRENT port after any respawn. The frozen boot
  // value stays as a fallback for contexts without the bridge.
  const dynamicPort = (window as Window).__aionBackend?.getPort?.();
  if (typeof dynamicPort === 'number' && dynamicPort > 0) return dynamicPort;
  const exposedPort = (window as Window).__backendPort;
  if (typeof exposedPort === 'number' && exposedPort > 0) return exposedPort;
  return undefined;
}

function hasElectronBackendBridge(): boolean {
  return typeof window !== 'undefined' && typeof (window as Window).__aionBackend?.getPort === 'function';
}

/**
 * Resolve the backend port, honoring both renderer and main-process contexts.
 *
 * - Renderer (Electron): the preload bridge writes `window.__backendPort` before
 *   the first HTTP call, so reading from window is authoritative.
 * - Renderer (WebUI browser): no preload, so `window.__backendPort` is missing.
 *   Requests must go to the same origin that served the page; web-host's
 *   static-server reverse-proxies `/api/*` and upgrades `/ws` to the backend
 *   port. See getBaseUrl / getWsUrl below for the WebUI branch.
 * - Main process: `window` is undefined. `src/index.ts` writes the port to
 *   `globalThis.__backendPort` immediately after `backendManager.start()`
 *   resolves, so any main-process ipcBridge caller (e.g. the one-shot
 *   assistant migration hook) hits the correct port.
 * - Fallback `13400` only applies when neither is initialized — the request
 *   will still fail cleanly with ECONNREFUSED rather than masking the bug.
 */
function getBackendPort(): number {
  const rendererPort = resolveRendererBackendPort();
  if (rendererPort) {
    return rendererPort;
  }
  const g = globalThis as typeof globalThis & { __backendPort?: number };
  return typeof g.__backendPort === 'number' && g.__backendPort > 0 ? g.__backendPort : 13400;
}

/**
 * WebUI (browser) mode: no Electron preload, so `window.__backendPort` is not
 * injected. Use same-origin URLs; web-host's static-server handles the reverse
 * proxy / WS upgrade to the backend.
 */
function isWebUiBrowserMode(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof document !== 'undefined' &&
    !hasElectronBackendBridge() &&
    !resolveRendererBackendPort()
  );
}

export function getBaseUrl(): string {
  if (isWebUiBrowserMode()) {
    // Same-origin: calls like fetch(`${baseUrl}/api/foo`) resolve to `/api/foo`
    // on whatever host the page was served from.
    return '';
  }
  return `http://127.0.0.1:${getBackendPort()}`;
}

function getWsUrl(): string {
  if (isWebUiBrowserMode()) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/ws`;
  }
  return `ws://127.0.0.1:${getBackendPort()}/ws`;
}

// ---------------------------------------------------------------------------
// Structured backend error
// ---------------------------------------------------------------------------

/**
 * Error thrown by `httpRequest` when the backend returns a non-2xx response.
 * Carries the structured error envelope (`success: false, error, code`) so
 * callers can branch on `code` without parsing the stringified message.
 *
 * @example
 *   try { await ipcBridge.conversation.sendMessage.invoke(...); }
 *   catch (e) {
 *     if (isBackendHttpError(e) && e.code === 'CONVERSATION_ARCHIVED') { ... }
 *   }
 */
export class BackendHttpError extends Error {
  readonly status: number;
  /** Machine-readable error code from the backend `ErrorResponse.code`, or `''` when parse failed. */
  readonly code: string;
  /** Backend-provided human message from `ErrorResponse.error`, or the raw body when parse failed. */
  readonly backendMessage: string;
  /** Structured backend metadata from `ErrorResponse.details`, when present. */
  readonly details: unknown;
  /** Raw parsed body (object on JSON response, string on text/non-JSON). */
  readonly body: unknown;

  constructor(params: { method: string; path: string; status: number; body: unknown }) {
    const { method, path, status, body } = params;
    let code = '';
    let backendMessage = '';
    let details: unknown;
    if (body && typeof body === 'object') {
      const b = body as { code?: unknown; error?: unknown; details?: unknown };
      if (typeof b.code === 'string') code = b.code;
      if (typeof b.error === 'string') backendMessage = b.error;
      details = b.details;
    } else if (typeof body === 'string') {
      backendMessage = body;
    }
    super(`Backend ${method} ${path} failed (${status}): ${JSON.stringify(body)}`);
    this.name = 'BackendHttpError';
    this.status = status;
    this.code = code;
    this.backendMessage = backendMessage;
    this.details = details;
    this.body = body;
  }
}

export function isBackendHttpError(error: unknown): error is BackendHttpError {
  // Prefer instanceof — fast path in production/bundled contexts.
  if (error instanceof BackendHttpError) return true;
  // Fallback: vite-dev HMR can split the module across chunks, breaking
  // instanceof. Detect by duck-typing on the shape produced by our
  // constructor.
  if (
    error &&
    typeof error === 'object' &&
    'name' in error &&
    (error as { name: unknown }).name === 'BackendHttpError' &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number' &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  ) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// HTTP request helper
// ---------------------------------------------------------------------------

/**
 * Per-request overrides for `httpRequest`.
 *
 * `silentStatuses` lets known-soft failures (e.g. `GET /:id/model` returning
 * 404 before the agent has attached) skip the noisy `console.error` and the
 * Sentry breadcrumb that comes with it. The error is still thrown so the
 * caller's existing try/catch keeps working.
 */
export type HttpRequestOptions = {
  silentStatuses?: number[];
  /**
   * Abort the request after this many ms (perf audit — Codex). The aioncore
   * backend is a LOCAL loopback service; a call that has not answered in seconds
   * means it is stalled (e.g. paged out under memory pressure on an 8GB Air), and
   * hanging forever makes EVE appear stuck before the first token. Callers already
   * fail-safe on a thrown error (settings resolvers fall back to safe defaults), so
   * a timeout degrades gracefully. Defaults to {@link DEFAULT_HTTP_TIMEOUT_MS};
   * hot-path reads can pass a shorter value. `0` disables the timeout.
   */
  timeoutMs?: number;
};

/**
 * Generous default so it only ever catches a genuinely stalled loopback backend,
 * never a slow-but-valid call. 15s = "the backend is wedged", not "the backend is
 * busy". Hot-path settings reads should override with ~2s.
 */
export const DEFAULT_HTTP_TIMEOUT_MS = 15000;

export async function httpRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  options?: HttpRequestOptions
): Promise<T> {
  const url = `${getBaseUrl()}${path}`;
  const headers: Record<string, string> = {};

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const serializedBody = body !== undefined ? JSON.stringify(body) : undefined;
  console.debug(`[httpBridge] ${method} ${path} body_bytes=${serializedBody?.length ?? 0}`);

  // Bound the loopback call so a stalled aioncore can never hang EVE forever
  // (perf audit). A timeout aborts → throws → the caller's existing fail-safe path.
  const timeoutMs = options?.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const controller = timeoutMs > 0 ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: serializedBody,
      signal: controller?.signal,
    });
  } catch (error) {
    if (controller?.signal.aborted) {
      throw new BackendHttpError({
        method,
        path,
        status: 0,
        body: `Local backend did not respond within ${timeoutMs}ms (stalled).`,
      });
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!response.ok) {
    // Response body can only be consumed once — read as text, then try JSON
    const rawText = await response.text().catch(() => '');
    let errorBody: unknown;
    try {
      errorBody = JSON.parse(rawText);
    } catch {
      errorBody = rawText;
    }
    if (options?.silentStatuses?.includes(response.status)) {
      console.debug(`[httpBridge] ${method} ${path} → ${response.status} (silenced)`);
    } else {
      console.error(`[httpBridge] ${method} ${path} → ${response.status}`);
    }
    throw new BackendHttpError({ method, path, status: response.status, body: errorBody });
  }

  console.debug(`[httpBridge] ${method} ${path} → ${response.status} OK`);

  const contentType = response.headers.get('Content-Type');
  if (!contentType?.includes('application/json')) {
    return undefined as T;
  }

  const json = await response.json();
  // Backend wraps in { success, data, ... } — unwrap when present
  if (json && typeof json === 'object' && 'data' in json) {
    return json.data as T;
  }
  return json as T;
}

// ---------------------------------------------------------------------------
// Provider factories (same shape as bridge.buildProvider)
// ---------------------------------------------------------------------------

type ProviderLike<Data, Params> = {
  provider: (handler: (params: Params) => Promise<Data>) => void;
  invoke: Params extends undefined ? () => Promise<Data> : (params: Params) => Promise<Data>;
};

export function withResponseMap<Raw, Mapped, Params>(
  inner: ProviderLike<Raw, Params>,
  map: (data: Raw) => Mapped
): ProviderLike<Mapped, Params> {
  return {
    provider: () => {},
    invoke: (async (params?: Params) => {
      const raw = await (inner.invoke as (p?: Params) => Promise<Raw>)(params);
      return map(raw);
    }) as ProviderLike<Mapped, Params>['invoke'],
  };
}

export function httpGet<Data, Params = undefined>(
  path: string | ((params: Params) => string),
  options?: HttpRequestOptions
): ProviderLike<Data, Params> {
  return {
    provider: () => {},
    invoke: (async (params?: Params) => {
      const resolvedPath = typeof path === 'function' ? path(params!) : path;
      return httpRequest<Data>('GET', resolvedPath, undefined, options);
    }) as ProviderLike<Data, Params>['invoke'],
  };
}

export function httpPost<Data, Params = undefined>(
  path: string | ((params: Params) => string),
  mapBody?: (params: Params) => unknown
): ProviderLike<Data, Params> {
  return {
    provider: () => {},
    invoke: (async (params?: Params) => {
      const resolvedPath = typeof path === 'function' ? path(params!) : path;
      const body = mapBody ? mapBody(params!) : params;
      return httpRequest<Data>('POST', resolvedPath, body);
    }) as ProviderLike<Data, Params>['invoke'],
  };
}

export function httpPut<Data, Params = undefined>(
  path: string | ((params: Params) => string),
  mapBody?: (params: Params) => unknown
): ProviderLike<Data, Params> {
  return {
    provider: () => {},
    invoke: (async (params?: Params) => {
      const resolvedPath = typeof path === 'function' ? path(params!) : path;
      const body = mapBody ? mapBody(params!) : params;
      return httpRequest<Data>('PUT', resolvedPath, body);
    }) as ProviderLike<Data, Params>['invoke'],
  };
}

export function httpPatch<Data, Params = undefined>(
  path: string | ((params: Params) => string),
  mapBody?: (params: Params) => unknown
): ProviderLike<Data, Params> {
  return {
    provider: () => {},
    invoke: (async (params?: Params) => {
      const resolvedPath = typeof path === 'function' ? path(params!) : path;
      const body = mapBody ? mapBody(params!) : params;
      return httpRequest<Data>('PATCH', resolvedPath, body);
    }) as ProviderLike<Data, Params>['invoke'],
  };
}

export function httpDelete<Data, Params = undefined>(
  path: string | ((params: Params) => string)
): ProviderLike<Data, Params> {
  return {
    provider: () => {},
    invoke: (async (params?: Params) => {
      const resolvedPath = typeof path === 'function' ? path(params!) : path;
      return httpRequest<Data>('DELETE', resolvedPath);
    }) as ProviderLike<Data, Params>['invoke'],
  };
}

/**
 * Stub provider for features not yet implemented in the backend.
 * Returns a sensible default value and logs a warning.
 */
export function stubProvider<Data, Params = undefined>(name: string, defaultValue: Data): ProviderLike<Data, Params> {
  return {
    provider: () => {},
    invoke: (async (_params?: Params) => {
      console.warn(`[httpBridge] stub: ${name} not yet implemented in backend`);
      return defaultValue;
    }) as ProviderLike<Data, Params>['invoke'],
  };
}

// ---------------------------------------------------------------------------
// WebSocket singleton
// ---------------------------------------------------------------------------

type WsCallback = (data: unknown) => void;
const wsListeners = new Map<string, Set<WsCallback>>();
let ws: WebSocket | null = null;
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wsReconnectAttempt = 0;
let wsTransportGeneration = 0;
let wsSeatTransitionPending = false;

function dispatchWsEvent(eventName: string, payload: unknown): void {
  const handlers = wsListeners.get(eventName);
  if (!handlers) return;
  for (const handler of handlers) {
    try {
      handler(payload);
    } catch {
      // One renderer listener must never break the shared realtime transport.
    }
  }
}

function ensureWs(): void {
  // MAIN publishes the target backend port before a seat-switch IPC is
  // terminal. During that interval the renderer must not reconnect through the
  // dynamic port: doing so would attach old-seat listeners to the target seat.
  if (wsSeatTransitionPending) return;
  if (typeof window === 'undefined') {
    console.debug('[ensureWs] skipped: no window');
    return;
  }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    console.debug('[ensureWs] skipped: already open/connecting, readyState=', ws.readyState);
    return;
  }

  const url = getWsUrl();
  const transportGeneration = wsTransportGeneration;
  console.debug('[ensureWs] connecting to', url);
  try {
    ws = new WebSocket(url);
  } catch (e) {
    console.error('[ensureWs] WebSocket constructor threw:', e);
    scheduleWsReconnect();
    return;
  }

  const current = ws;
  const isCurrentTransport = () => ws === current && transportGeneration === wsTransportGeneration;

  current.addEventListener('open', () => {
    if (!isCurrentTransport()) return;
    console.debug('[ensureWs] CONNECTED');
    const reconnected = wsReconnectAttempt > 0;
    wsReconnectAttempt = 0;
    dispatchWsEvent('realtime.connected', { reconnected });
  });

  current.addEventListener('close', (e) => {
    if (!isCurrentTransport()) return;
    console.debug('[ensureWs] CLOSED code=' + e.code + ' reason=' + e.reason);
    ws = null;
    scheduleWsReconnect();
  });

  current.addEventListener('error', (e) => {
    if (!isCurrentTransport()) return;
    console.error('[ensureWs] ERROR', e);
    current.close();
  });

  current.addEventListener('message', (event: MessageEvent) => {
    // A confirmed seat switch rotates the singleton before the new seat is
    // exposed to renderer stores. Browser event queues may still contain a
    // message from the closed socket; identity, not arrival time, decides
    // whether that frame belongs to the current transport.
    if (!isCurrentTransport()) return;
    try {
      const msg = JSON.parse(event.data as string) as {
        name?: string;
        event?: string;
        data?: unknown;
        payload?: unknown;
      };
      const eventName = msg.name ?? msg.event;
      const payload = msg.data ?? msg.payload;
      console.debug('[WS:msg]', eventName, payload === undefined ? 'no-payload' : 'payload-present');
      if (eventName === 'ping') {
        // AionCore drops clients that do not answer its application-level
        // heartbeat. A half-open renderer socket otherwise keeps HTTP working
        // while silently losing live message.stream events until a route
        // remount reloads the persisted transcript.
        if (current.readyState === WebSocket.OPEN) {
          current.send(JSON.stringify({ name: 'pong', data: payload ?? {} }));
        }
        return;
      }
      if (eventName) {
        dispatchWsEvent(eventName, payload);
      }
    } catch {
      // ignore non-JSON
    }
  });
}

function invalidateRealtimeTransport(): void {
  wsTransportGeneration += 1;
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  const stale = ws;
  ws = null;
  wsReconnectAttempt = 0;
  try {
    stale?.close();
  } catch {
    // Generation identity already invalidated the socket. A platform-specific
    // close() failure cannot be allowed to strand the seat-transition fence.
  }
}

/**
 * Synchronously close and fence the old transport before MAIN begins a seat
 * switch. `ensureWs` remains disabled until the IPC terminally resolves, even
 * if MAIN has already published a target backend port in the meantime.
 */
export function beginRealtimeTransportSeatTransition(): void {
  wsSeatTransitionPending = true;
  invalidateRealtimeTransport();
}

/** Bind listeners to MAIN's authoritative terminal backend generation. */
export function completeRealtimeTransportSeatTransition(): void {
  // Advance again so even a constructor/listener queued around completion can
  // never share identity with the pre-terminal transition generation.
  invalidateRealtimeTransport();
  wsSeatTransitionPending = false;
  ensureWs();
}

/** Immediate rotation for non-transactional callers and legacy tests. */
export function rotateRealtimeTransportForSeatRebind(): void {
  beginRealtimeTransportSeatTransition();
  completeRealtimeTransportSeatTransition();
}

function scheduleWsReconnect(): void {
  if (wsReconnectTimer) return;
  const delay = Math.min(1000 * Math.pow(2, wsReconnectAttempt), 30000);
  wsReconnectAttempt++;
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    ensureWs();
  }, delay);
}

// ---------------------------------------------------------------------------
// Emitter factory (same shape as bridge.buildEmitter)
// ---------------------------------------------------------------------------

type EmitterLike<Params> = {
  on: (callback: Params extends undefined ? () => void : (params: Params) => void) => () => void;
  emit: Params extends undefined ? () => void : (params: Params) => void;
};

export function wsEmitter<Params = undefined>(eventName: string): EmitterLike<Params> {
  return {
    on: (callback: (params: Params) => void) => {
      ensureWs();
      if (!wsListeners.has(eventName)) {
        wsListeners.set(eventName, new Set());
      }
      const cb = callback as WsCallback;
      wsListeners.get(eventName)!.add(cb);
      return () => {
        wsListeners.get(eventName)?.delete(cb);
      };
    },
    emit: (() => {}) as EmitterLike<Params>['emit'],
  };
}

export function wsMappedEmitter<Params = undefined>(
  eventName: string,
  transform: (raw: unknown) => Params
): EmitterLike<Params> {
  const inner = wsEmitter<unknown>(eventName);
  return {
    on: (callback: (params: Params) => void) => {
      return inner.on((raw) => {
        callback(transform(raw));
      });
    },
    emit: (() => {}) as EmitterLike<Params>['emit'],
  };
}

/**
 * Stub emitter for events not yet implemented in the backend.
 */
export function stubEmitter<Params = undefined>(_name: string): EmitterLike<Params> {
  return {
    on: () => () => {},
    emit: (() => {}) as EmitterLike<Params>['emit'],
  };
}
