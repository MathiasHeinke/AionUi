import type { ConfigKey, ConfigKeyMap } from './configKeys';
import { LEGACY_SEAT_ID, SEAT_KEY_PREFIX, assertSeatId, isSeatScopedConfigKey, seatScopedKey } from './seatConfigKeyCore';

type Subscriber = (value: unknown) => void;
/** Fired with the NEW active seat id after the config cache re-homes (rebindSeat). */
type SeatSubscriber = (seatId: string) => void;

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
  const exposedPort = (window as Window).__backendPort;
  if (typeof exposedPort === 'number' && exposedPort > 0) return exposedPort;
  const dynamicPort = (window as Window).__aionBackend?.getPort?.();
  if (typeof dynamicPort === 'number' && dynamicPort > 0) {
    (window as Window).__backendPort = dynamicPort;
    return dynamicPort;
  }
  return undefined;
}

function getBaseUrl(): string {
  // WebUI browser mode: no preload, fetch same-origin so web-host's
  // static-server reverse-proxies /api/* to the backend.
  if (
    typeof window !== 'undefined' &&
    typeof document !== 'undefined' &&
    typeof (window as Window).__aionBackend?.getPort !== 'function' &&
    !resolveRendererBackendPort()
  ) {
    return '';
  }
  const port = resolveRendererBackendPort() ?? 13400;
  return `http://127.0.0.1:${port}`;
}

async function fetchJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = `${getBaseUrl()}${path}`;
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`ConfigService ${method} ${path} failed (${response.status}): ${errorBody}`);
  }
  const contentType = response.headers.get('Content-Type');
  if (!contentType?.includes('application/json')) {
    return undefined as T;
  }
  const json = await response.json();
  if (json && typeof json === 'object' && 'data' in json) {
    return json.data as T;
  }
  return json as T;
}

/**
 * Resolve the active seat id from the main process (Phase 4 / ISO-2). The
 * renderer's per-seat config namespace must prefix its seat-scoped keys with the
 * SAME id the main process holds (seatContextCore.getActiveSeatId). We read it
 * over the existing commandEve bridge. Lazily imported so configService stays
 * importable in non-Electron / unit-test contexts (where the bridge is mocked or
 * absent); ANY failure falls back to the legacy seat (byte-identical 1.1.3
 * behavior — no namespacing until a real seat is confirmed).
 */
async function fetchActiveSeatId(): Promise<string> {
  try {
    const { commandEve } = await import('@/common/adapter/ipcBridge');
    const response = await commandEve.activeSeat.invoke();
    const seatId = response?.data?.seat_id;
    if (response?.data?.ok && typeof seatId === 'string' && seatId.length > 0) {
      return seatId;
    }
  } catch {
    // Non-Electron / bridge unavailable / IPC error → legacy seat (no scoping).
  }
  return LEGACY_SEAT_ID;
}

class ConfigServiceImpl {
  // The cache is keyed by LOGICAL key (the public ConfigKey the renderer uses).
  // The seat namespacing happens only on the WIRE (the PUT/GET physical key), so
  // every renderer consumer keeps calling get/set with the plain key.
  private cache = new Map<string, unknown>();
  private subscribers = new Map<string, Set<Subscriber>>();
  // Seat-rebind subscribers: fired AFTER the cache re-homes to a new active seat.
  // This is the single renderer-observable "the seat changed" signal — the basis
  // for remounting per-seat hosts so every mount-once seat read re-fires (closes
  // the class of renderer hooks that hold seat-scoped state in mount-once state
  // and never re-read on a switch).
  private seatSubscribers = new Set<SeatSubscriber>();
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  // The active seat this service is currently bound to (ISO-2). Defaults to the
  // legacy seat so NOTHING changes until a seat switcher calls rebindSeat — for
  // the legacy seat every physical key equals its logical key (zero migration).
  private currentSeatId: string = LEGACY_SEAT_ID;

  /**
   * Map a LOGICAL config key to the PHYSICAL key stored in the backend bag.
   * Only the SEAT_SCOPED_CONFIG_KEYS allowlist is namespaced by the active seat;
   * install-global keys pass through unchanged. For the legacy seat even the
   * allowlisted keys pass through unchanged (byte-identical to 1.1.3).
   */
  private physicalKey(logicalKey: string): string {
    if (!isSeatScopedConfigKey(logicalKey)) return logicalKey;
    return seatScopedKey(logicalKey, this.currentSeatId);
  }

  /**
   * Inverse of physicalKey for the CURRENTLY-bound seat: given a physical key
   * read from the backend bag, return the logical key IF it belongs to the
   * active seat, else `null` (it belongs to another seat or is a stray prefix and
   * must NOT leak into this seat's cache). Install-global (un-prefixed,
   * non-allowlisted) keys map to themselves. Allowlisted keys are accepted only
   * when their physical form matches THIS seat's namespacing.
   */
  private logicalKeyForCurrentSeat(physicalKey: string): string | null {
    // A namespaced key (`seat:<id>:<rest>`) belongs to the active seat ONLY when
    // it equals the physical form THIS seat would produce for the inner key.
    if (physicalKey.startsWith(SEAT_KEY_PREFIX)) {
      const rest = physicalKey.slice(SEAT_KEY_PREFIX.length);
      const sep = rest.indexOf(':');
      if (sep <= 0) return null;
      const innerKey = rest.slice(sep + 1);
      // Reconstruct what THIS seat would write for innerKey; accept only on match.
      if (isSeatScopedConfigKey(innerKey) && this.physicalKey(innerKey) === physicalKey) {
        return innerKey;
      }
      return null;
    }
    // Un-prefixed key. For an allowlisted (seat-scoped) key, the un-prefixed form
    // belongs to the LEGACY seat only — so it must NOT leak into a real seat's
    // cache. Install-global keys always map to themselves.
    if (isSeatScopedConfigKey(physicalKey)) {
      return this.currentSeatId === LEGACY_SEAT_ID ? physicalKey : null;
    }
    return physicalKey;
  }

  /**
   * Rebind the service to a different active seat (ISO-2). Called by the seat
   * switcher (Task #2) AFTER setActiveSeatId on the main side. Sanitizes the id
   * (throws on an unsafe id so a crafted id can never become a key prefix),
   * invalidates the in-memory cache, and re-initializes so subsequent reads
   * re-resolve under the new seat's namespace. Notifies subscribers of every
   * seat-scoped key that changed value across the switch.
   */
  async rebindSeat(seatId?: string | null): Promise<void> {
    const sanitized = assertSeatId(seatId);
    if (sanitized === this.currentSeatId && this.initialized) return;
    // Snapshot the pre-switch seat-scoped values so we can fire change events for
    // any whose value differs under the new seat.
    const previous = new Map<string, unknown>();
    for (const key of this.cache.keys()) {
      if (isSeatScopedConfigKey(key)) previous.set(key, this.cache.get(key));
    }
    this.currentSeatId = sanitized;
    this.cache.clear();
    this.initialized = false;
    this.initPromise = null;
    await this.initialize();
    // Re-notify seat-scoped keys whose value changed (or cleared) on the switch.
    const seen = new Set<string>(previous.keys());
    for (const key of this.cache.keys()) {
      if (isSeatScopedConfigKey(key)) seen.add(key);
    }
    for (const key of seen) {
      const before = previous.get(key);
      const after = this.cache.get(key);
      if (before !== after) this.notify(key as ConfigKey, after);
    }
    // Fire the seat-rebind signal LAST, after the cache has fully re-homed, so a
    // subscriber that re-reads (or remounts) observes the NEW seat's namespace.
    // Only reached when the seat actually changed (the early-return above guards
    // the no-op / legacy-stable case), so single-seat installs never fire it.
    for (const cb of this.seatSubscribers) cb(this.currentSeatId);
  }

  /** The active seat id this service is currently bound to (ISO-2). */
  getCurrentSeatId(): string {
    return this.currentSeatId;
  }

  // Idempotent: concurrent callers share the same in-flight promise, and a
  // resolved init returns immediately. Modules that need persisted settings on
  // module load (theme/colorScheme/language) await whenReady() before reading.
  initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      // Resolve the active seat from main BEFORE mapping the bag, so seat-scoped
      // physical keys are demultiplexed for the correct seat. Skips the IPC for
      // the legacy default unless a rebind already moved us off it (a switcher
      // sets currentSeatId via rebindSeat, which re-enters initialize()).
      if (this.currentSeatId === LEGACY_SEAT_ID) {
        this.currentSeatId = await fetchActiveSeatId();
      }
      const data = await fetchJson<Record<string, unknown>>('GET', '/api/settings/client');
      this.cache.clear();
      if (data) {
        for (const [physKey, value] of Object.entries(data)) {
          const logical = this.logicalKeyForCurrentSeat(physKey);
          if (logical !== null) this.cache.set(logical, value);
        }
      }
      // One-time theme migration: only when new keys are absent (idempotent).
      if (!this.cache.has('theme.activeId')) {
        const { migrateThemeConfig } = await import('@/common/theme/migrateThemeConfig');
        const migrated = migrateThemeConfig({
          theme: this.cache.get('theme') as string | undefined,
          'css.activeThemeId': this.cache.get('css.activeThemeId') as string | undefined,
          'css.themes': this.cache.get('css.themes') as never,
          customCss: this.cache.get('customCss') as string | undefined,
        });
        this.cache.set('theme.activeId', migrated['theme.activeId']);
        this.cache.set('theme.userThemes', migrated['theme.userThemes']);
        // Persist asynchronously; ignore failure (will re-run next launch).
        void fetchJson<void>('PUT', '/api/settings/client', migrated).catch(() => {});
      }
      this.initialized = true;
    })();
    this.initPromise.catch(() => {
      // Allow a future caller to retry after a transient failure
      this.initPromise = null;
    });
    return this.initPromise;
  }

  whenReady(): Promise<void> {
    return this.initialize();
  }

  get<K extends ConfigKey>(key: K): ConfigKeyMap[K] | undefined {
    return this.cache.get(key) as ConfigKeyMap[K] | undefined;
  }

  async set<K extends ConfigKey>(key: K, value: ConfigKeyMap[K]): Promise<void> {
    // Cache + subscribers stay keyed by the LOGICAL key; only the wire uses the
    // (possibly seat-scoped) physical key (ISO-2).
    this.cache.set(key, value);
    this.notify(key, value);
    await fetchJson<void>('PUT', '/api/settings/client', { [this.physicalKey(key)]: value });
  }

  setLocal<K extends ConfigKey>(key: K, value: ConfigKeyMap[K]): void {
    this.cache.set(key, value);
    this.notify(key, value);
  }

  async remove(key: ConfigKey): Promise<void> {
    this.cache.delete(key);
    this.notify(key, undefined);
    await fetchJson<void>('PUT', '/api/settings/client', { [this.physicalKey(key)]: null });
  }

  async setBatch(entries: Partial<{ [K in ConfigKey]: ConfigKeyMap[K] }>): Promise<void> {
    const wire: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entries)) {
      this.cache.set(key, value);
      this.notify(key as ConfigKey, value);
      wire[this.physicalKey(key)] = value;
    }
    await fetchJson<void>('PUT', '/api/settings/client', wire);
  }

  subscribe(key: ConfigKey, callback: Subscriber): () => void {
    if (!this.subscribers.has(key)) {
      this.subscribers.set(key, new Set());
    }
    this.subscribers.get(key)!.add(callback);
    return () => {
      this.subscribers.get(key)?.delete(callback);
    };
  }

  /**
   * Subscribe to active-seat changes. The callback fires AFTER the config cache
   * has re-homed to the new seat (i.e. subsequent get() reads see the new seat's
   * namespace). Returns an unsubscribe fn. Used by useActiveSeatId to drive a
   * remount key for per-seat hosts.
   */
  onSeatRebind(callback: SeatSubscriber): () => void {
    this.seatSubscribers.add(callback);
    return () => {
      this.seatSubscribers.delete(callback);
    };
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  reset(): void {
    this.cache.clear();
    this.subscribers.clear();
    this.seatSubscribers.clear();
    this.initialized = false;
    this.initPromise = null;
    // Clean-reset returns to the legacy seat so a fresh initialize() re-resolves
    // the active seat from main (ISO-2).
    this.currentSeatId = LEGACY_SEAT_ID;
  }

  private notify(key: ConfigKey, value: unknown): void {
    const subs = this.subscribers.get(key);
    if (subs) {
      for (const cb of subs) {
        cb(value);
      }
    }
  }
}

export const configService = new ConfigServiceImpl();
