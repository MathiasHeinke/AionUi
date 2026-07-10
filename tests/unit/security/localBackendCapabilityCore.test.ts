import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_BACKEND_CAPABILITY_HEADER } from '@aionui/web-host';
import {
  authorizeRendererBackendRequest,
  configureMainRendererBackendCapability,
  installMainProcessLocalBackendCapability,
  isCurrentLocalBackendUrl,
} from '@/process/security/localBackendCapabilityCore';

const resolver = {
  getPort: () => 43123,
  getCapability: () => 'capability-secret',
};

let restoreFetch: (() => void) | undefined;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
  vi.restoreAllMocks();
});

describe('local backend capability transport', () => {
  it('matches only the exact current aioncore loopback origin', () => {
    expect(isCurrentLocalBackendUrl('http://127.0.0.1:43123/api/settings', 43123)).toBe(true);
    expect(isCurrentLocalBackendUrl('ws://127.0.0.1:43123/ws', 43123)).toBe(true);
    expect(isCurrentLocalBackendUrl('http://localhost:43123/api/settings', 43123)).toBe(false);
    expect(isCurrentLocalBackendUrl('http://127.0.0.1:43124/api/settings', 43123)).toBe(false);
    expect(isCurrentLocalBackendUrl('https://example.com:43123/api/settings', 43123)).toBe(false);
  });

  it('authorizes only requests owned by the main renderer webContents', () => {
    const mainContents = { id: 7 };
    const mainWindow = { webContents: mainContents } as never;
    const authorized = authorizeRendererBackendRequest(
      {
        url: 'http://127.0.0.1:43123/api/settings',
        webContentsId: 7,
        requestHeaders: { Accept: 'application/json', 'X-AionUI-Local-Capability': 'forged' },
      },
      mainWindow,
      resolver
    );

    expect(authorized).toEqual({
      Accept: 'application/json',
      [LOCAL_BACKEND_CAPABILITY_HEADER]: 'capability-secret',
    });
    expect(
      authorizeRendererBackendRequest(
        {
          url: 'http://127.0.0.1:43123/api/settings',
          webContentsId: 8,
          requestHeaders: {},
        },
        mainWindow,
        resolver
      )
    ).toBeUndefined();
  });

  it('strips a forged renderer capability even while the server capability is unavailable', () => {
    const mainWindow = { webContents: { id: 7 } } as never;

    expect(
      authorizeRendererBackendRequest(
        {
          url: 'http://127.0.0.1:43123/api/settings',
          webContentsId: 7,
          requestHeaders: { Accept: 'application/json', 'X-AionUI-Local-Capability': 'forged' },
        },
        mainWindow,
        { ...resolver, getCapability: () => '' }
      )
    ).toEqual({ Accept: 'application/json' });
  });

  it('registers one Electron webRequest gate and leaves unrelated requests untouched', () => {
    let listener: ((details: never, callback: (result: unknown) => void) => void) | undefined;
    const mainContents = {
      id: 7,
      session: {
        webRequest: {
          onBeforeSendHeaders: (_filter: unknown, next: typeof listener) => {
            listener = next;
          },
        },
      },
    };
    configureMainRendererBackendCapability({ webContents: mainContents } as never, resolver);

    const callback = vi.fn();
    listener?.(
      {
        url: 'https://example.com/',
        webContentsId: 7,
        requestHeaders: {},
      } as never,
      callback
    );
    expect(callback).toHaveBeenCalledWith({});
  });

  it('adds the capability to exact main-process backend fetches only', async () => {
    const originalFetch = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', originalFetch);
    restoreFetch = installMainProcessLocalBackendCapability(resolver);

    await fetch('http://127.0.0.1:43123/api/settings', { headers: { Accept: 'application/json' } });
    await fetch('http://127.0.0.1:11434/api/tags');
    await fetch('https://example.com/api');

    const backendInit = originalFetch.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(backendInit.headers).get(LOCAL_BACKEND_CAPABILITY_HEADER)).toBe('capability-secret');
    expect((originalFetch.mock.calls[1]?.[1] as RequestInit | undefined)?.headers).toBeUndefined();
    expect((originalFetch.mock.calls[2]?.[1] as RequestInit | undefined)?.headers).toBeUndefined();
  });

  it('strips a forged main-process capability while the server capability is unavailable', async () => {
    const originalFetch = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', originalFetch);
    restoreFetch = installMainProcessLocalBackendCapability({ ...resolver, getCapability: () => '' });

    await fetch('http://127.0.0.1:43123/api/settings', {
      headers: { Accept: 'application/json', 'X-AionUI-Local-Capability': 'forged' },
    });

    const backendInit = originalFetch.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(backendInit.headers).get(LOCAL_BACKEND_CAPABILITY_HEADER)).toBeNull();
    expect(new Headers(backendInit.headers).get('accept')).toBe('application/json');
  });
});
