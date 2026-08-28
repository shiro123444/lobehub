/**
 * C-28 explicit RuntimeFacade cache wiring.
 *
 * The cache is deliberately instance-owned. It has no module-level user
 * state, and a route must opt into it by supplying a binding. A cache key is
 * always derived from the authenticated user and an injected session id.
 */

import type { RuntimeFacadePort } from './adapter';
import type { RuntimeFacadeFactory, RuntimeFacadeFactoryResult } from './factory';

export type RuntimeFacadeDisposer = () => void | Promise<void>;

export interface RuntimeFacadeCacheScope {
  readonly sessionId: string;
  readonly userId: string;
}

/** The authenticated request context forwarded on a cache miss. */
export interface RuntimeFacadeCachedSession extends RuntimeFacadeCacheScope {
  readonly request: Request;
  readonly serverDB: unknown;
}

export type RuntimeFacadeCacheSession = RuntimeFacadeCachedSession;

export type RuntimeFacadeCacheLoaderResult = RuntimeFacadeFactoryResult;

export type RuntimeFacadeCacheLoader = (
  scope: RuntimeFacadeCacheScope,
  context?: unknown,
) => RuntimeFacadeCacheLoaderResult | Promise<RuntimeFacadeCacheLoaderResult>;

export type RuntimeFacadeCacheErrorCode =
  | 'RUNTIME_FACADE_CACHE_SCOPE_INVALID'
  | 'RUNTIME_FACADE_CACHE_INVALID_FACADE'
  | 'RUNTIME_FACADE_CACHE_REQUEST_INVALID'
  | 'RUNTIME_FACADE_CACHE_INVALID_BINDING';

export class RuntimeFacadeCacheError extends Error {
  constructor(
    public readonly code: RuntimeFacadeCacheErrorCode,
    message: string,
    public readonly path?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'RuntimeFacadeCacheError';
  }
}

interface CacheRecord {
  readonly dispose?: RuntimeFacadeDisposer;
  disposed?: boolean;
  readonly facade: RuntimeFacadePort;
  readonly key: string;
  readonly result: RuntimeFacadeFactoryResult;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isFacade = (value: unknown): value is RuntimeFacadePort =>
  isRecord(value) && typeof value.handle === 'function';

const requireScopeValue = (value: unknown, path: 'userId' | 'sessionId'): string => {
  if (!nonEmptyString(value)) {
    throw new RuntimeFacadeCacheError(
      'RUNTIME_FACADE_CACHE_SCOPE_INVALID',
      `${path} must be a non-empty string`,
      path,
    );
  }
  return value;
};

const defaultScopeKey = (scope: RuntimeFacadeCacheScope): string =>
  JSON.stringify([scope.userId, scope.sessionId]);

const requireRequest = (value: unknown): Request => {
  if (!(value instanceof Request)) {
    throw new RuntimeFacadeCacheError(
      'RUNTIME_FACADE_CACHE_REQUEST_INVALID',
      'An authenticated Request is required for RuntimeFacade resolution',
      'request',
    );
  }
  return value;
};

const optionalDisposerOf = (owner: unknown): RuntimeFacadeDisposer | undefined => {
  if (!isRecord(owner) && typeof owner !== 'function') {
    return undefined;
  }
  const disposer = (owner as { dispose?: unknown }).dispose;
  if (typeof disposer !== 'function') return undefined;
  return disposer.bind(owner) as RuntimeFacadeDisposer;
};

const resolveLoadedValue = (
  value: RuntimeFacadeCacheLoaderResult,
): {
  result: RuntimeFacadeFactoryResult;
  facade: RuntimeFacadePort;
  dispose?: RuntimeFacadeDisposer;
} => {
  const facade = isFacade(value) ? value : isRecord(value) ? value.facade : undefined;
  if (!isFacade(facade)) {
    throw new RuntimeFacadeCacheError(
      'RUNTIME_FACADE_CACHE_INVALID_FACADE',
      'Loader must supply a structurally valid RuntimeFacade',
    );
  }

  const dispose = optionalDisposerOf(value) ?? optionalDisposerOf(facade);
  return dispose ? { result: value, facade, dispose } : { result: value, facade };
};

export interface ScopedRuntimeFacadeCacheOptions {
  /** Injected facade source; invoked at most once per scope until reset/dispose. */
  readonly load: RuntimeFacadeCacheLoader;
  /** Optional custom key; the default is JSON of [userId, sessionId]. */
  readonly scopeKey?: (scope: RuntimeFacadeCacheScope) => string;
}

export class ScopedRuntimeFacadeCache {
  private readonly entries = new Map<string, CacheRecord>();
  private readonly tasks = new Map<string, Promise<CacheRecord>>();
  private readonly load: RuntimeFacadeCacheLoader;
  private readonly scopeKeyFor: (scope: RuntimeFacadeCacheScope) => string;

  constructor(options: ScopedRuntimeFacadeCacheOptions) {
    if (typeof options?.load !== 'function') {
      throw new RuntimeFacadeCacheError(
        'RUNTIME_FACADE_CACHE_INVALID_BINDING',
        'A RuntimeFacade cache loader is required',
        'load',
      );
    }
    this.load = options.load;
    this.scopeKeyFor = options.scopeKey ?? defaultScopeKey;
  }

  get size(): number {
    return this.entries.size;
  }

  peek(scope: RuntimeFacadeCacheScope): RuntimeFacadePort | undefined {
    return this.entries.get(this.keyOf(scope))?.facade;
  }

  async resolve(
    scope: RuntimeFacadeCacheScope,
    context?: RuntimeFacadeCachedSession,
  ): Promise<RuntimeFacadeFactoryResult> {
    const normalized = this.normalize(scope);
    const key = this.keyOf(normalized);
    const ready = this.entries.get(key);
    if (ready) return ready.result;

    const task = this.taskFor(normalized, key, context);
    return (await task).result;
  }

  /** Evicts ready entries without invoking their disposers. */
  reset(scope?: RuntimeFacadeCacheScope): number {
    if (scope === undefined) {
      const removed = this.entries.size;
      this.entries.clear();
      return removed;
    }
    return this.entries.delete(this.keyOf(scope)) ? 1 : 0;
  }

  /** Disposes selected entries and evicts them. Repeated calls are harmless. */
  async dispose(scope?: RuntimeFacadeCacheScope): Promise<void> {
    const keys =
      scope === undefined
        ? new Set<string>([...this.entries.keys(), ...this.tasks.keys()])
        : new Set([this.keyOf(scope)]);

    const inFlight: Array<Promise<unknown>> = [];
    for (const key of keys) {
      const task = this.tasks.get(key);
      if (task) inFlight.push(task.catch(() => undefined));
    }
    if (inFlight.length > 0) await Promise.all(inFlight);

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

  private taskFor(
    scope: RuntimeFacadeCacheScope,
    key: string,
    context?: RuntimeFacadeCachedSession,
  ): Promise<CacheRecord> {
    const existing = this.tasks.get(key);
    if (existing) return existing;

    const task: Promise<CacheRecord> = (async () => {
      const resolved = resolveLoadedValue(await this.load(scope, context));
      const record: CacheRecord = {
        key,
        result: resolved.result,
        facade: resolved.facade,
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

  private normalize(scope: RuntimeFacadeCacheScope): RuntimeFacadeCacheScope {
    return {
      userId: requireScopeValue(scope?.userId, 'userId'),
      sessionId: requireScopeValue(scope?.sessionId, 'sessionId'),
    };
  }

  private keyOf(scope: RuntimeFacadeCacheScope): string {
    return this.scopeKeyFor(this.normalize(scope));
  }
}

export interface RuntimeFacadeScopeCacheBinding {
  readonly cache: ScopedRuntimeFacadeCache;
  dispose: () => Promise<void>;
  reset: () => number;
  resolve: (session: RuntimeFacadeCachedSession) => Promise<RuntimeFacadeFactoryResult>;
}

export type RuntimeFacadeCacheBinding = RuntimeFacadeScopeCacheBinding;

/**
 * Builds a cache binding around an existing factory. The factory is called
 * only on a cold `{ userId, sessionId }` scope and receives the real request
 * and serverDB for that first request.
 */
export const createScopedRuntimeFacadeCache = (options: {
  readonly factory: RuntimeFacadeFactory;
  readonly scopeKey?: (scope: RuntimeFacadeCacheScope) => string;
}): RuntimeFacadeScopeCacheBinding => {
  if (typeof options?.factory !== 'function') {
    throw new RuntimeFacadeCacheError(
      'RUNTIME_FACADE_CACHE_INVALID_BINDING',
      'A RuntimeFacadeFactory is required',
      'factory',
    );
  }

  const cache = new ScopedRuntimeFacadeCache({
    ...(options.scopeKey ? { scopeKey: options.scopeKey } : {}),
    load: async (scope, context) => {
      const session = context as Partial<RuntimeFacadeCachedSession> | undefined;
      const request = requireRequest(session?.request);
      return await options.factory({
        userId: scope.userId,
        sessionId: scope.sessionId,
        serverDB: session?.serverDB,
        request,
      });
    },
  });

  return {
    cache,
    async resolve(session) {
      const request = requireRequest(session?.request);
      return await cache.resolve(
        { userId: session.userId, sessionId: session.sessionId },
        { ...session, request },
      );
    },
    reset: () => cache.reset(),
    dispose: () => cache.dispose(),
  };
};

export type RuntimeSessionIdFor = (request: Request) => string | undefined;

/**
 * Adapts the binding to the existing per-request RuntimeFacadeFactory seam.
 * The route supplies the session-id resolver so this helper never invents or
 * trusts a fixed session identifier.
 */
export const runtimeFacadeFactoryFromScopeCache = (
  binding: RuntimeFacadeScopeCacheBinding,
  sessionIdFor: RuntimeSessionIdFor,
): RuntimeFacadeFactory => {
  if (!binding || typeof binding.resolve !== 'function') {
    throw new RuntimeFacadeCacheError(
      'RUNTIME_FACADE_CACHE_INVALID_BINDING',
      'A RuntimeFacadeScopeCacheBinding with a resolve() is required',
      'binding',
    );
  }
  if (typeof sessionIdFor !== 'function') {
    throw new RuntimeFacadeCacheError(
      'RUNTIME_FACADE_CACHE_INVALID_BINDING',
      'A sessionIdFor resolver is required for RuntimeFacade scope caching',
      'sessionIdFor',
    );
  }

  return async (factoryScope) => {
    const sessionId = sessionIdFor(factoryScope.request);
    return await binding.resolve({
      userId: factoryScope.userId,
      sessionId: sessionId as string,
      serverDB: factoryScope.serverDB,
      request: factoryScope.request,
    });
  };
};
