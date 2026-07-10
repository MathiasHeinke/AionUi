import type { BrowserWindow, OnBeforeSendHeadersListenerDetails } from 'electron';
import { LOCAL_BACKEND_CAPABILITY_HEADER } from '@aionui/web-host';

export type LocalBackendCapabilityResolver = {
  getPort: () => number;
  getCapability: () => string;
};

let originalMainFetch: typeof globalThis.fetch | undefined;
let activeMainResolver: LocalBackendCapabilityResolver | undefined;

export function getMainProcessLocalBackendCapability(): string {
  return activeMainResolver?.getCapability() ?? '';
}

export function isCurrentLocalBackendUrl(url: string, port: number): boolean {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'ws:') &&
      parsed.hostname === '127.0.0.1' &&
      parsed.port === String(port)
    );
  } catch {
    return false;
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function capabilityHeaders(input: RequestInfo | URL, init: RequestInit | undefined, capability: string): Headers {
  const headers = new Headers(typeof input === 'object' && 'headers' in input ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  headers.delete(LOCAL_BACKEND_CAPABILITY_HEADER);
  if (capability) headers.set(LOCAL_BACKEND_CAPABILITY_HEADER, capability);
  return headers;
}

/**
 * Install one main-process fetch boundary. It adds the per-launch capability
 * only for the exact live aioncore loopback port and leaves every other local
 * or remote request byte-for-byte on its existing auth path.
 */
export function installMainProcessLocalBackendCapability(resolver: LocalBackendCapabilityResolver): () => void {
  activeMainResolver = resolver;
  if (!originalMainFetch) {
    originalMainFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const currentResolver = activeMainResolver;
      const original = originalMainFetch;
      if (!currentResolver || !original) {
        throw new Error('main-process fetch boundary is not initialized');
      }

      const port = currentResolver.getPort();
      const capability = currentResolver.getCapability();
      if (!isCurrentLocalBackendUrl(requestUrl(input), port)) {
        return original(input, init);
      }
      return original(input, {
        ...init,
        headers: capabilityHeaders(input, init, capability),
      });
    }) as typeof globalThis.fetch;
  }

  return () => {
    if (activeMainResolver !== resolver) return;
    activeMainResolver = undefined;
    if (originalMainFetch) {
      globalThis.fetch = originalMainFetch;
      originalMainFetch = undefined;
    }
  };
}

export function authorizeRendererBackendRequest(
  details: Pick<OnBeforeSendHeadersListenerDetails, 'url' | 'webContentsId' | 'webContents' | 'requestHeaders'>,
  mainWindow: BrowserWindow,
  resolver: LocalBackendCapabilityResolver
): Record<string, string> | undefined {
  const mainContents = mainWindow.webContents;
  if (details.webContentsId !== mainContents.id && details.webContents !== mainContents) return undefined;
  if (!isCurrentLocalBackendUrl(details.url, resolver.getPort())) return undefined;
  const capability = resolver.getCapability();

  const requestHeaders = { ...details.requestHeaders };
  for (const name of Object.keys(requestHeaders)) {
    if (name.toLowerCase() === LOCAL_BACKEND_CAPABILITY_HEADER) delete requestHeaders[name];
  }
  if (capability) requestHeaders[LOCAL_BACKEND_CAPABILITY_HEADER] = capability;
  return requestHeaders;
}

/** Keep the capability in Electron main while authorizing only the owning UI. */
export function configureMainRendererBackendCapability(
  mainWindow: BrowserWindow,
  resolver: LocalBackendCapabilityResolver
): void {
  mainWindow.webContents.session.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
    const requestHeaders = authorizeRendererBackendRequest(details, mainWindow, resolver);
    callback(requestHeaders ? { requestHeaders } : {});
  });
}
