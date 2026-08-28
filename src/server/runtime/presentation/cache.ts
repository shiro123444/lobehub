/**
 * C-23 Scoped PresentationPort cache.
 *
 * An injectable wrapper that caches one PresentationPort per authenticated
 * `{ userId, sessionId }` scope and reuses it across requests in the same
 * scope. Different scopes never share cached ports. The wrapper itself never
 * executes a provider — it only forwards to the injected loader and hands back
 * the returned port — and it holds no module-global state: every instance owns
 * its own Maps, so tests can construct fully isolated caches.
 *
 * Lifecycle:
 * - `resolve()` loads through the injected loader exactly once per scope and
 *   coalesces concurrent calls onto that single load. Failed loads are never
 *   cached; the next resolve retries.
 * - `dispose()` invokes any disposer attached to the loaded port/binding,
 *   including for loads still in flight, then evicts. It is idempotent; a
 *   disposer failure surfaces only after every other disposer has run.
 * - `reset()` evicts ready entries without invoking disposers (test-friendly).
 * - `bindPresentationCacheShutdown()` offers an explicit opt-in shutdown hook
 *   against a caller-provided `{ on, off }` target — no implicit globals.
 */

import type { PresentationPort } from '../../../../packages/cordis-kernel/src/presentation';
import type { PresentationPortBinding } from './factory';

export type PresentationDisposer = () => void | Promise<void>;

/** The authenticated scope shape; mirrors the C-20 `RuntimeScope`. */
export interface PresentationCacheScope {
  readonly sessionId: string;
  readonly userId: string;
}

export type PresentationCacheLoaderResult =
  | PresentationPort
  | (PresentationPortBinding & { readonly dispose?: PresentationDisposer });

/**
 * Opaque per-resolve extras (e.g. the authenticated `request`) handed to the
 * loader on cache misses. Cache hits never invoke the loader, so hits do not
 * need a context; concurrent coalesced resolves follow first-writer-wins.
 */
export type PresentationCacheRequestContext = unknown;

export type PresentationCacheLoader<TContext = PresentationCacheRequestContext> = (
  scope: PresentationCacheScope,
  context?: TContext,
) => PresentationCacheLoaderResult | Promise<PresentationCacheLoaderResult>;

export type PresentationCacheErrorCode =
  | 'PRESENTATION_CACHE_SCOPE_INVALID'
  | 'PRESENTATION_CACHE_INVALID_PORT'
  | 'PRESENTATION_CACHE_REQUEST_INVALID';

export class PresentationCacheError extends Error {
  constructor(
    public readonly code: PresentationCacheErrorCode,
    message: string,
    public readonly path?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'PresentationCacheError';
  }
}

interface CacheRecord {
  readonly dispose?: PresentationDisposer;
  /** Set once `dispose()` has invoked (or skipped invoking) the disposer. */
  disposed?: boolean;
  readonly key: string;
  readonly port: PresentationPort;
  readonly scope: PresentationCacheScope;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isPresentationPort = (value: unknown): value is PresentationPort =>
  isRecord(value) &&
  typeof value.createJob === 'function' &&
  typeof value.getJob === 'function' &&
  typeof value.cancelJob === 'function' &&
  typeof value.retryJob === 'function' &&
  typeof value.getArtifact === 'function' &&
  typeof value.exportArtifact === 'function';

const requireScopeValue = (value: unknown, path: 'userId' | 'sessionId'): string => {
  if (!nonEmptyString(value)) {
    throw new PresentationCacheError(
      'PRESENTATION_CACHE_SCOPE_INVALID',
      `${path} must be a non-empty string`,
      path,
    );
  }
  return value;
};

const defaultScopeKey = (scope: PresentationCacheScope): string =>
  JSON.stringify([scope.userId, scope.sessionId]);

const optionalDisposerOf = (owner: unknown): PresentationDisposer | undefined => {
  const maybe = (owner as { dispose?: unknown }).dispose;
  if (typeof maybe !== 'function') return undefined;
  return (maybe as (...args: unknown[]) => unknown).bind(owner) as PresentationDisposer;
};

const resolveLoadedValue = (
  value: PresentationCacheLoaderResult,
): { port: PresentationPort; dispose?: PresentationDisposer } => {
  if (isPresentationPort(value)) {
    const portDispose = optionalDisposerOf(value);
    return portDispose ? { port: value, dispose: portDispose } : { port: value };
  }
  if (isRecord(value) && isPresentationPort(value.port)) {
    const dispose =
      typeof value.dispose === 'function'
        ? (value.dispose as PresentationDisposer)
        : optionalDisposerOf(value.port);
    return dispose ? { port: value.port, dispose } : { port: value.port };
  }
  throw new PresentationCacheError(
    'PRESENTATION_CACHE_INVALID_PORT',
    'Loader must supply a structurally valid PresentationPort',
  );
};

export interface ScopedPresentationPortCacheOptions {
  /** Injected port source; invoked at most once per scope until reset/disposed. */
  readonly load: PresentationCacheLoader;
  /** Optional custom key function; defaults to JSON of [userId, sessionId]. */
  readonly scopeKey?: (scope: PresentationCacheScope) => string;
}

/**
 * Event-target shape compatible with Node's EventEmitter (`process`) so the
 * shutdown hook stays opt-in and testable without hidden global wiring.
 */
export interface PresentationCacheShutdownTarget {
  off: (event: string, listener: (...args: unknown[]) => unknown) => unknown;
  on: (event: string, listener: (...args: unknown[]) => unknown) => unknown;
}

export interface PresentationCacheShutdownBinding {
  readonly events: readonly string[];
  unbind: () => void;
}

export class ScopedPresentationPortCache {
  private readonly entries = new Map<string, CacheRecord>();
  private readonly tasks = new Map<string, Promise<CacheRecord>>();
  private readonly load: PresentationCacheLoader;
  private readonly scopeKeyFor: (scope: PresentationCacheScope) => string;
  constructor(options: ScopedPresentationPortCacheOptions) {
    this.load = options.load;
    this.scopeKeyFor = options.scopeKey ?? defaultScopeKey;
  }

  get size(): number {
    return this.entries.size;
  }

  peek(scope: PresentationCacheScope): PresentationPort | undefined {
    return this.entries.get(this.keyOf(scope))?.port;
  }

  /**
   * Returns the cached port for the scope, loading it through the injected
   * loader exactly once per scope. Concurrent resolves for the same scope ride
   * on the single in-flight load; rejections are never cached. The optional
   * `context` (e.g. the authenticated request) is forwarded verbatim to the
   * loader on misses only — cache hits never need it.
   */
  async resolve(
    scope: PresentationCacheScope,
    context?: PresentationCacheRequestContext,
  ): Promise<PresentationPort> {
    const normalized = this.normalize(scope);
    const key = this.keyOf(normalized);

    const ready = this.entries.get(key);
    if (ready) return ready.port;

    const task = this.taskFor(normalized, key, context);
    const record = await task;
    return record.port;
  }

  /** Evicts ready entries without invoking disposers; returns count dropped. */
  reset(scope?: PresentationCacheScope): number {
    if (scope === undefined) {
      const removed = this.entries.size;
      this.entries.clear();
      return removed;
    }
    return this.entries.delete(this.keyOf(scope)) ? 1 : 0;
  }

  /**
   * Invokes any disposer on the selected ports (one scope or all), awaits
   * in-flight loads for the selected scopes first, then evicts. Idempotent:
   * records already disposed are skipped and disposing an empty cache resolves
   * immediately. Disposer failures never stop other disposers; the first
   * failure is rethrown once cleanup finished everywhere.
   */
  async dispose(scope?: PresentationCacheScope): Promise<void> {
    const keys =
      scope === undefined
        ? new Set<string>([...this.entries.keys(), ...this.tasks.keys()])
        : new Set([this.keyOf(scope)]);

    const inflight: Array<Promise<unknown>> = [];
    for (const key of keys) {
      const task = this.tasks.get(key);
      if (task) inflight.push(task.catch(() => null));
    }
    if (inflight.length > 0) await Promise.all(inflight);

    let firstError: unknown;
    for (const key of keys) {
      const record = this.entries.get(key);
      if (!record) continue;
      this.entries.delete(key);
      if (record.disposed) continue;
      record.disposed = true;
      try {
        await record.dispose?.();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  /**
   * Single lazy-load task per scope. The record is written into `entries`
   * inside the task body, so by the time any awaiter observes settlement the
   * cache state is consistent; `tasks` cleanup then frees the slot either way.
   */
  private taskFor(
    scope: PresentationCacheScope,
    key: string,
    context?: PresentationCacheRequestContext,
  ): Promise<CacheRecord> {
    const existing = this.tasks.get(key);
    if (existing) return existing;

    const task: Promise<CacheRecord> = (async () => {
      const resolved = resolveLoadedValue(await this.load(scope, context));
      const record: CacheRecord = {
        key,
        scope,
        port: resolved.port,
        ...(resolved.dispose ? { dispose: resolved.dispose } : {}),
      };
      this.entries.set(key, record);
      return record;
    })();

    this.tasks.set(key, task);
    const releaseSlot = (): void => {
      if (this.tasks.get(key) === task) this.tasks.delete(key);
    };
    void task.then(releaseSlot, releaseSlot);
    return task;
  }

  private normalize(scope: PresentationCacheScope): PresentationCacheScope {
    return {
      userId: requireScopeValue(scope?.userId, 'userId'),
      sessionId: requireScopeValue(scope?.sessionId, 'sessionId'),
    };
  }

  private keyOf(scope: PresentationCacheScope): string {
    return this.scopeKeyFor(this.normalize(scope));
  }
}

/**
 * Opt-in shutdown hook: binds cache disposal to caller-chosen events on an
 * explicitly provided `{ on, off }` target. Returns the bound event names plus
 * an `unbind()` that removes exactly what was installed (safe repeatedly).
 */
export const bindPresentationCacheShutdown = (
  cache: ScopedPresentationPortCache,
  events: readonly string[],
  target: PresentationCacheShutdownTarget,
): PresentationCacheShutdownBinding => {
  const listener = (): void => {
    void cache.dispose().catch(() => undefined);
  };
  for (const event of events) target.on(event, listener);
  return {
    events: [...events],
    unbind(): void {
      for (const event of events) target.off(event, listener);
    },
  };
};
