import { NextResponse } from 'next/server';

import { checkAuth } from '@/app/(backend)/middleware/auth';
import {
  getPresentationPortFactory,
  type PresentationFactoryScope,
  type PresentationPortFactory,
  presentationPortFactoryFromScopeCache,
  type PresentationPortScopeCacheBinding,
} from '@/server/runtime/presentation/factory';
import {
  handlePresentationRequest,
  matchPresentationRoute,
} from '@/server/runtime/presentation/handler';

interface PresentationAuthScope {
  readonly serverDB: unknown;
  readonly userId: string;
}

type PresentationScopedHandler = (
  request: Request,
  scope: PresentationAuthScope,
) => Promise<Response>;

type PresentationGuardedHandler = (request: Request, options?: unknown) => Promise<Response>;

export type PresentationAuthBoundary = (
  handler: PresentationScopedHandler,
) => PresentationGuardedHandler;

/**
 * Reads the authenticated session id for scoped-cache adoption. Default source
 * is the `x-session-id` header; deployments with their own session resolution
 * should override it explicitly.
 */
export type PresentationSessionIdFor = (request: Request) => string | undefined;

const defaultSessionIdFor: PresentationSessionIdFor = (request) =>
  request.headers.get('x-session-id') ?? undefined;

export interface PresentationRouteOptions {
  readonly authenticate?: PresentationAuthBoundary;
  readonly portFactory?: PresentationPortFactory;
  /**
   * C-27: explicit adoption of the C-25 scoped cache. When present, the route
   * resolves ports through it (reusing one port per authenticated
   * `{ userId, sessionId }` scope) and `portFactory` must be omitted — the
   * binding owns the underlying factory. Absent → current uncached behavior.
   */
  readonly scopeCache?: PresentationPortScopeCacheBinding;
  /** Session-id source used only while `scopeCache` is configured. */
  readonly sessionIdFor?: PresentationSessionIdFor;
}

const defaultAuthBoundary: PresentationAuthBoundary = (handler) => {
  const guarded = checkAuth(async (request, { userId, serverDB }) =>
    handler(request, { userId, serverDB }),
  );

  return (request, options) =>
    guarded(request, options as { params: Promise<{ provider?: string }> });
};

const toNextResponse = async (
  request: Request,
  scope: Omit<PresentationFactoryScope, 'request'>,
  portFactory: PresentationPortFactory,
): Promise<Response> => {
  const result = await handlePresentationRequest(
    request,
    scope,
    matchPresentationRoute(request),
    portFactory,
  );
  return NextResponse.json(result.body, {
    headers: result.headers,
    status: result.status,
  });
};

export const createPresentationRouteHandler = (
  options: PresentationRouteOptions = {},
): PresentationGuardedHandler => {
  const authenticate = options.authenticate ?? defaultAuthBoundary;
  if (options.scopeCache && options.portFactory) {
    // Contradictory wiring is a programming error: the binding owns the
    // underlying factory; a second one here would silently never run.
    throw new TypeError(
      'Provide either scopeCache or portFactory for the presentation route, not both',
    );
  }
  const portFactory = options.scopeCache
    ? presentationPortFactoryFromScopeCache(
        options.scopeCache,
        options.sessionIdFor ?? defaultSessionIdFor,
      )
    : (options.portFactory ?? getPresentationPortFactory());
  return authenticate((request, scope) => toNextResponse(request, scope, portFactory));
};

const handler = createPresentationRouteHandler();

export const GET = handler;
export const POST = handler;
