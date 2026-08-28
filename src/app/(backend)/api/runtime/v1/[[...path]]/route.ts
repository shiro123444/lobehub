import { NextResponse } from 'next/server';

import { checkAuth } from '@/app/(backend)/middleware/auth';
import {
  runtimeFacadeFactoryFromScopeCache,
  type RuntimeFacadeScopeCacheBinding,
  type RuntimeSessionIdFor,
} from '@/server/runtime/facade-cache';
import { getRuntimeFacadeFactory, type RuntimeFacadeFactory } from '@/server/runtime/factory';
import { handleRuntimeRequest } from '@/server/runtime/route-handler';
import {
  handleRuntimeSseRequest,
  isRuntimeEventsRequest,
  isRuntimeSseStreamResponse,
  type RuntimeSseOptions,
} from '@/server/runtime/sse';

interface RuntimeAuthScope {
  readonly serverDB: unknown;
  readonly userId: string;
}

type RuntimeScopedHandler = (request: Request, scope: RuntimeAuthScope) => Promise<Response>;

type RuntimeGuardedHandler = (request: Request, options?: unknown) => Promise<Response>;

export type RuntimeAuthBoundary = (handler: RuntimeScopedHandler) => RuntimeGuardedHandler;

export interface RuntimeRouteOptions {
  readonly authenticate?: RuntimeAuthBoundary;
  readonly facadeFactory?: RuntimeFacadeFactory;
  /**
   * Explicit C-28 cache adoption. The binding owns the underlying factory;
   * `facadeFactory` must therefore be omitted when this option is present.
   */
  readonly scopeCache?: RuntimeFacadeScopeCacheBinding;
  /** Session-id source used only while `scopeCache` is configured. */
  readonly sessionIdFor?: RuntimeSessionIdFor;
  readonly sse?: RuntimeSseOptions;
}

const defaultSessionIdFor: RuntimeSessionIdFor = (request) =>
  request.headers.get('x-session-id') ?? undefined;

const defaultAuthBoundary: RuntimeAuthBoundary = (handler) => {
  const guarded = checkAuth(async (request, { userId, serverDB }) =>
    handler(request, { userId, serverDB }),
  );

  return (request, options) =>
    guarded(request, options as { params: Promise<{ provider?: string }> });
};

const toNextResponse = async (
  request: Request,
  scope: RuntimeAuthScope,
  factory: RuntimeFacadeFactory,
  sseOptions: RuntimeSseOptions,
) => {
  const result = isRuntimeEventsRequest(request)
    ? await handleRuntimeSseRequest(request, scope, factory, sseOptions)
    : await handleRuntimeRequest(request, scope, factory);
  if (isRuntimeSseStreamResponse(result)) {
    return new Response(result.body, {
      headers: result.headers,
      status: result.status,
    });
  }
  return NextResponse.json(result.body, {
    headers: result.headers,
    status: result.status,
  });
};

export const createRuntimeRouteHandler = (
  options: RuntimeRouteOptions = {},
): RuntimeGuardedHandler => {
  const authenticate = options.authenticate ?? defaultAuthBoundary;
  if (options.scopeCache && options.facadeFactory) {
    throw new TypeError(
      'Provide either scopeCache or facadeFactory for the runtime route, not both',
    );
  }
  const facadeFactory = options.scopeCache
    ? runtimeFacadeFactoryFromScopeCache(
        options.scopeCache,
        options.sessionIdFor ?? defaultSessionIdFor,
      )
    : (options.facadeFactory ?? getRuntimeFacadeFactory());
  return authenticate((request, scope) =>
    toNextResponse(request, scope, facadeFactory, options.sse ?? {}),
  );
};

const handler = createRuntimeRouteHandler();

export const GET = handler;
export const POST = handler;
