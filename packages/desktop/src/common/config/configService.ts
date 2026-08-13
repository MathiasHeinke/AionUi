import type { ConfigKey, ConfigKeyMap } from './configKeys';
import {
  LEGACY_SEAT_ID,
  SEAT_KEY_PREFIX,
  assertSeatId,
  isSeatScopedConfigKey,
  seatScopedKey,
} from './seatConfigKeyCore';

type Subscriber = (value: unknown) => void;
/**
 * Fired with a key's value ONLY AFTER the durable backend write for it RESOLVED.
 *
 * WHY A SECOND CHANNEL AND NOT A REORDERED `notify`. `subscribe` is the
 * OPTIMISTIC signal: 60 `configService.set(...)` call sites across 28 files rely
 * on it landing synchronously so a toggle/field paints the instant it is pressed.
 * Deferring THAT would change the responsiveness of every settings surface in the
 * app (GitNexus rates a change to ConfigServiceImpl CRITICAL: 37 direct
 * importers, 103 impacted files), and would leave the cache holding a value no
 * subscriber had been told about whenever a PUT rejected.
 *
 * So the optimistic signal stays exactly as it was, and a SECOND, strictly
 * post-durability signal is added for the consumers whose correctness depends on
 * the write having actually landed — the MAX authority refresh above all: it
 * re-asks the MAIN process, which reads the PERSISTED state, so asking before
 * the PUT resolves is asking about the value the user just replaced.
 *
 * It cannot be bypassed by a future writer: `persist()` is the only method that
 * issues the durable PUT, and it emits this after — and only after — that PUT
 * resolves.
 */
type PersistSubscriber = (value: unknown) => void | Promise<void>;
/** Fired with the NEW active seat id after the config cache re-homes (rebindSeat). */
type SeatSubscriber = (seatId: string) => void;

export type ConfigSeatBindingSnapshot = {
  seatId: string;
  rebindEpoch: number;
  initialized: boolean;
};

/**
 * A persisted-subscriber blew up. The write ITSELF succeeded — this is a bug in
 * a LISTENER, and the two must never be confused, so it is reported here rather
 * than propagated to the writer.
 *
 * Reported, not swallowed. A silently-eaten listener error is how "the MAX
 * surface just never refreshes" becomes a defect no one can find.
 */
function reportPersistSubscriberError(key: string, error: unknown): void {
  console.error(`[configService] persisted-subscriber for "${key}" threw after a SUCCESSFUL write:`, error);
}

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
  // LIVE port FIRST (seat-switch correctness — mirrors httpBridge): the seat
  // switch respawns the backend on a FRESH ephemeral port, while
  // window.__backendPort is contextBridge-frozen at the BOOT value. Preferring
  // the frozen value pointed every post-switch settings GET/PUT at the dead old
  // port — the PII-toggle "bounces back to ON" live bug: the PUT died with
  // ECONNREFUSED, the .catch reverted the switch. getPort() is a synchronous IPC
  // returning backendManager.port (current after any respawn).
  const dynamicPort = (window as Window).__aionBackend?.getPort?.();
  if (typeof dynamicPort === 'number' && dynamicPort > 0) return dynamicPort;
  const exposedPort = (window as Window).__backendPort;
  if (typeof exposedPort === 'number' && exposedPort > 0) return exposedPort;
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
  // Post-durability subscribers. Fired from persist() AFTER the backend PUT
  // resolves — never before it, never on a rejected write.
  private persistSubscribers = new Map<string, Set<PersistSubscriber>>();
  // Seat-rebind subscribers: fired AFTER the cache re-homes to a new active seat.
  // This is the single renderer-observable "the seat changed" signal — the basis
  // for remounting per-seat hosts so every mount-once seat read re-fires (closes
  // the class of renderer hooks that hold seat-scoped state in mount-once state
  // and never re-read on a switch).
  private seatSubscribers = new Set<SeatSubscriber>();
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  // Monotonic renderer fence. Boot-time legacy -> authoritative-seat discovery
  // is deliberately NOT a rebind; only an explicit seat-id transition advances
  // this epoch, synchronously before rebindSeat's first await.
  private seatRebindEpoch = 0;

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
    if (sanitized !== this.currentSeatId) {
      this.seatRebindEpoch += 1;
      this.currentSeatId = sanitized;
    }
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

  /** Atomic identity used by renderer stores to distinguish boot from rebind. */
  getSeatBindingSnapshot(): ConfigSeatBindingSnapshot {
    return {
      seatId: this.currentSeatId,
      rebindEpoch: this.seatRebindEpoch,
      initialized: this.initialized,
    };
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
        // Routed through persist() like every other durable write, so this stays
        // the migration it is and never becomes a second, unsignalled PUT path.
        //
        // IT CANNOT RE-ASK ANOTHER CONSUMER MID-INIT, for two independent
        // reasons, both proven in eveMaxAuthorityRefreshOrdering.dom.test.ts
        // rather than asserted here:
        //   1. the signal is KEY-SCOPED and migrateThemeConfig writes only
        //      `theme.activeId` / `theme.userThemes` — disjoint from every key a
        //      startup-sensitive consumer subscribes to;
        //   2. this call is `void`ed, so it yields at persist()'s first await and
        //      `initialized = true` below runs BEFORE the PUT can resolve. The
        //      emit is therefore always strictly after init completes.
        void this.persist(migrated, Object.entries(migrated) as Array<[ConfigKey, unknown]>).catch(() => {});
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

  /**
   * THE ONLY PLACE A DURABLE WRITE LEAVES THIS SERVICE.
   *
   * Every persisting mutation funnels through here, which is what makes the
   * post-persistence guarantee structural rather than per-call-site: there is no
   * other route to the backend PUT, so a future writer cannot add a persisting
   * path that forgets to signal.
   *
   * ORDERING IS THE WHOLE POINT. `await` first, emit second. A rejected PUT
   * throws out of the await and the emit below is never reached — so a failed
   * persistence produces NO signal, and a consumer that re-reads main on this
   * signal can never be triggered by a write that did not land. No timer is
   * involved anywhere: the emit waits on the write, not on the clock.
   *
   * The emit CANNOT fail this call. notifyPersisted isolates every callback, so
   * the promise this returns reflects the WRITE and nothing else: a listener bug
   * never becomes a false rejected write.
   */
  private async persist(wire: Record<string, unknown>, persisted: Array<[ConfigKey, unknown]>): Promise<void> {
    await fetchJson<void>('PUT', '/api/settings/client', wire);
    for (const [key, value] of persisted) {
      this.notifyPersisted(key, value);
    }
  }

  async set<K extends ConfigKey>(key: K, value: ConfigKeyMap[K]): Promise<void> {
    // Cache + subscribers stay keyed by the LOGICAL key; only the wire uses the
    // (possibly seat-scoped) physical key (ISO-2).
    this.cache.set(key, value);
    this.notify(key, value);
    await this.persist({ [this.physicalKey(key)]: value }, [[key, value]]);
  }

  setLocal<K extends ConfigKey>(key: K, value: ConfigKeyMap[K]): void {
    this.cache.set(key, value);
    this.notify(key, value);
    // Deliberately NO persisted signal: nothing was persisted. A local-only write
    // must not be able to trigger a consumer that re-reads durable state.
  }

  async remove(key: ConfigKey): Promise<void> {
    this.cache.delete(key);
    this.notify(key, undefined);
    await this.persist({ [this.physicalKey(key)]: null }, [[key, undefined]]);
  }

  async setBatch(entries: Partial<{ [K in ConfigKey]: ConfigKeyMap[K] }>): Promise<void> {
    const wire: Record<string, unknown> = {};
    const persisted: Array<[ConfigKey, unknown]> = [];
    for (const [key, value] of Object.entries(entries)) {
      this.cache.set(key, value);
      this.notify(key as ConfigKey, value);
      wire[this.physicalKey(key)] = value;
      persisted.push([key as ConfigKey, value]);
    }
    await this.persist(wire, persisted);
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
   * Subscribe to DURABLE PERSISTENCE of a key.
   *
   * Use this instead of `subscribe` when the callback's correctness depends on
   * the backend actually holding the new value — most importantly when it goes
   * on to ASK ANOTHER PROCESS a question whose answer is computed from persisted
   * state. `subscribe` fires optimistically, before the PUT is even in flight;
   * a re-read triggered from there races the write and can answer for the value
   * the user just replaced.
   *
   * Guarantees:
   *   - fires only after the PUT for that key RESOLVED;
   *   - never fires for a REJECTED PUT;
   *   - never fires for `setLocal` (nothing was persisted);
   *   - is KEY-SCOPED: a write to any other key never reaches this callback.
   *     That is what keeps the startup theme migration — which persists
   *     `theme.*` — from re-asking an unrelated consumer mid-init;
   *   - throwing (or returning a rejecting promise) is contained: it is reported
   *     and neither fails the writer's promise nor starves later subscribers.
   */
  subscribePersisted(key: ConfigKey, callback: PersistSubscriber): () => void {
    if (!this.persistSubscribers.has(key)) {
      this.persistSubscribers.set(key, new Set());
    }
    this.persistSubscribers.get(key)!.add(callback);
    return () => {
      this.persistSubscribers.get(key)?.delete(callback);
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
    this.persistSubscribers.clear();
    this.seatSubscribers.clear();
    this.initialized = false;
    this.initPromise = null;
    this.seatRebindEpoch += 1;
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

  /**
   * Reachable ONLY from persist(), i.e. only after a resolved durable write.
   *
   * EVERY CALLBACK IS ISOLATED, and that is a correctness requirement, not
   * politeness. By the time this runs the durable write has ALREADY succeeded,
   * so:
   *
   *   (a) a listener's exception must NOT surface as a rejected `set`/`remove`/
   *       `setBatch`. Reporting a listener bug as a persistence failure would
   *       make callers roll back or retry a write that actually landed;
   *   (b) one bad listener must NOT starve the ones registered after it. An
   *       unrelated subscriber throwing first would otherwise mean the MAX
   *       authority silently never refreshes — the exact stale-surface defect,
   *       relocated once more.
   *
   * Async listeners are covered too: a returned promise is adopted so a REJECTED
   * one is reported rather than left as an unhandled rejection.
   *
   * Iterates the Set directly, exactly as `notify` does, so the two channels
   * behave identically for a callback that subscribes/unsubscribes during
   * dispatch. Deliberately NOT a copy: diverging here would make the persisted
   * channel subtly different from the optimistic one for no stated reason.
   */
  private notifyPersisted(key: ConfigKey, value: unknown): void {
    const subs = this.persistSubscribers.get(key);
    if (!subs) return;
    for (const cb of subs) {
      try {
        const result: unknown = cb(value);
        if (typeof (result as PromiseLike<unknown> | undefined)?.then === 'function') {
          void Promise.resolve(result).catch((error: unknown) => reportPersistSubscriberError(key, error));
        }
      } catch (error) {
        reportPersistSubscriberError(key, error);
      }
    }
  }
}

export const configService = new ConfigServiceImpl();
