import type { PresentationPort } from '../../../../packages/cordis-kernel/src/presentation';
import type { PresentationCacheScope } from './cache';
import { PresentationCacheError, ScopedPresentationPortCache } from './cache';

export interface PresentationFactoryScope {
  readonly request: Request;
  readonly serverDB: unknown;
  /**
   * Optional authenticated session id; present when a factory runs behind the
   * C-25 scoped-cache integration and omitted on legacy call paths.
   */
  readonly sessionId?: string;
  readonly userId: string;
}

export interface PresentationPortBinding {
  readonly port: PresentationPort;
}

export type PresentationPortFactoryResult = PresentationPort | PresentationPortBinding;

export type PresentationPortFactory = (
  scope: PresentationFactoryScope,
) => PresentationPortFactoryResult | Promise<PresentationPortFactoryResult>;

let configuredFactory: PresentationPortFactory | undefined;

const unavailableFactory: PresentationPortFactory = () => {
  throw Object.assign(new Error('Presentation provider is not configured'), {
    code: 'PROVIDER_UNAVAILABLE',
  });
};

export const getPresentationPortFactory = (): PresentationPortFactory =>
  configuredFactory ?? unavailableFactory;

/** Configure the factory only; every request still supplies its authenticated scope. */
export const configurePresentationPortFactory = (factory: PresentationPortFactory): void => {
  configuredFactory = factory;
};

export const resetPresentationPortFactory = (): void => {
  configuredFactory = undefined;
};

// ---------------------------------------------------------------------------
// C-25 Presentation cache factory integration
// ---------------------------------------------------------------------------

/** The authenticated session context every cached resolution must carry. */
export interface PresentationCachedSession {
  readonly request: Request;
  readonly sessionId: string;
  readonly userId: string;
}

export interface PresentationPortScopeCacheOptions {
  /** The existing (injected) PresentationPortFactory to wrap with the C-23 cache. */
  readonly factory: PresentationPortFactory;
  /** Optional custom scope key; defaults to JSON of [userId, sessionId]. */
  readonly scopeKey?: (scope: PresentationCacheScope) => string;
  /**
   * Optional injectable per-session DB handle for the wrapped factory scope;
   * without it the factory receives `serverDB: undefined`.
   */
  readonly serverDBFor?: (session: PresentationCachedSession) => unknown;
}

export interface PresentationPortScopeCacheBinding {
  /** The underlying C-23 cache, exposing `peek`, scoped `reset`/`dispose`, `size`. */
  readonly cache: ScopedPresentationPortCache;
  /** Runs disposers and evicts everything; idempotent; shutdown-safe. */
  dispose: () => Promise<void>;
  /** Evicts all ready entries without invoking disposers. */
  reset: () => number;
  /**
   * Resolves the port for an authenticated `{ userId, sessionId, request }`
   * call: reuses one instance within a scope, isolates scopes, and passes
   * request/serverDB through to the wrapped factory on cold loads only.
   */
  resolve: (session: PresentationCachedSession) => Promise<PresentationPort>;
}

const requireRequest = (value: unknown): Request => {
  if (!(value instanceof Request)) {
    throw new PresentationCacheError(
      'PRESENTATION_CACHE_REQUEST_INVALID',
      'An authenticated Request is required for presentation port resolution',
      'request',
    );
  }
  return value;
};

/**
 * Explicitly wraps an existing PresentationPortFactory with the C-23 scoped
 * cache. Nothing installs itself globally: callers decide where this binding
 * lives and wire it into route handling themselves.
 */
export const createScopedPresentationPortCache = (
  options: PresentationPortScopeCacheOptions,
): PresentationPortScopeCacheBinding => {
  const { factory, serverDBFor, scopeKey } = options;
  if (typeof factory !== 'function') {
    throw new PresentationCacheError(
      'PRESENTATION_CACHE_INVALID_PORT',
      'A PresentationPortFactory is required',
      'factory',
    );
  }

  const cache = new ScopedPresentationPortCache({
    ...(scopeKey ? { scopeKey } : {}),
    // The loader receives the full cached-session object as its opaque
    // per-resolve context and extracts the authenticated request from it.
    load: async (scope, context) => {
      const sessionContext = context as Partial<PresentationCachedSession> | undefined;
      const request = requireRequest(sessionContext?.request);
      return await factory({
        userId: scope.userId,
        sessionId: scope.sessionId,
        request,
        serverDB: serverDBFor
          ? serverDBFor({
              userId: scope.userId,
              sessionId: scope.sessionId,
              request,
            })
          : undefined,
      });
    },
  });

  return {
    cache,
    async resolve(session) {
      // Async on purpose: validation failures surface as rejections.
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

/**
 * C-27 route-wiring adapter: turns a C-25 `PresentationPortScopeCacheBinding`
 * into a plain `PresentationPortFactory` so `handlePresentationRequest` can
 * adopt scoped caching without any handler changes. Each invocation resolves
 * through the binding, which reuses one port per `{ userId, sessionId }` scope
 * and isolates scopes; the authenticated request rides along for cold loads.
 */
export const presentationPortFactoryFromScopeCache = (
  binding: PresentationPortScopeCacheBinding,
  sessionIdFor: (request: Request) => string | undefined,
): PresentationPortFactory => {
  if (!binding || typeof binding.resolve !== 'function') {
    throw new PresentationCacheError(
      'PRESENTATION_CACHE_INVALID_PORT',
      'A PresentationPortScopeCacheBinding with a resolve() is required',
      'binding',
    );
  }
  return async (factoryScope) => {
    const sessionId = sessionIdFor(factoryScope.request);
    return await binding.resolve({
      userId: factoryScope.userId,
      sessionId,
      request: factoryScope.request,
    });
  };
};
