import type { BrowserWindow, OnBeforeSendHeadersListenerDetails } from 'electron';
import { LOCAL_BACKEND_CAPABILITY_HEADER } from '@aionui/web-host';
import { PROJECT_RUNTIME_ATTESTATION_HEADER } from './projectRuntimeAttestationCore';

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
  details: Pick<
    OnBeforeSendHeadersListenerDetails,
    'url' | 'webContentsId' | 'webContents' | 'frame' | 'requestHeaders'
  >,
  mainWindow: BrowserWindow,
  resolver: LocalBackendCapabilityResolver
): Record<string, string> | undefined {
  const mainContents = mainWindow.webContents;
  const requestHeaders = { ...details.requestHeaders };
  let strippedReservedCapability = false;
  for (const name of Object.keys(requestHeaders)) {
    if (
      name.toLowerCase() === LOCAL_BACKEND_CAPABILITY_HEADER ||
      name.toLowerCase() === PROJECT_RUNTIME_ATTESTATION_HEADER
    ) {
      delete requestHeaders[name];
      strippedReservedCapability = true;
    }
  }

  const ownsWebContents = details.webContentsId === mainContents.id || details.webContents === mainContents;
  const ownsMainFrame = details.frame !== null && details.frame === mainContents.mainFrame;
  if (!ownsWebContents || !isCurrentLocalBackendUrl(details.url, resolver.getPort()) || !ownsMainFrame) {
    return strippedReservedCapability ? requestHeaders : undefined;
  }

  const originHeaderName = Object.keys(requestHeaders).find((name) => name.toLowerCase() === 'origin');
  if (originHeaderName && requestHeaders[originHeaderName] === 'file://') {
    requestHeaders[originHeaderName] = 'null';
  }

  const capability = resolver.getCapability();
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
    if (
      process.env.AIONUI_LOCAL_CAPABILITY_DIAGNOSTICS === '1' &&
      details.resourceType === 'webSocket' &&
      /^wss?:\/\//i.test(details.url)
    ) {
      const mainContents = mainWindow.webContents;
      const requestOrigin =
        Object.entries(details.requestHeaders).find(([name]) => name.toLowerCase() === 'origin')?.[1] ?? null;
      console.info('[local-backend-capability] websocket authorization', {
        url: details.url,
        requestOrigin,
        resourceType: details.resourceType,
        webContentsId: details.webContentsId ?? null,
        ownsWebContents:
          details.webContentsId === mainContents.id || details.webContents === mainContents,
        frame: details.frame === null ? 'null' : details.frame === undefined ? 'undefined' : 'present',
        ownsMainFrame: details.frame === mainContents.mainFrame,
        exactLiveOrigin: isCurrentLocalBackendUrl(details.url, resolver.getPort()),
        capabilityInjected: Boolean(
          requestHeaders &&
            Object.keys(requestHeaders).some((name) => name.toLowerCase() === LOCAL_BACKEND_CAPABILITY_HEADER)
        ),
      });
    }
    callback(requestHeaders ? { requestHeaders } : {});
  });
}
