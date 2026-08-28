// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import type { RuntimeEventListener } from '@/server/runtime/adapter';
import { createScopedRuntimeFacadeCache } from '@/server/runtime/facade-cache';
import type { RuntimeFacadeFactory } from '@/server/runtime/factory';

import { createRuntimeRouteHandler } from './route';

vi.mock('@/app/(backend)/middleware/auth', () => ({
  checkAuth:
    (
      handler: (
        request: Request,
        scope: { userId: string; serverDB: unknown },
      ) => Promise<Response>,
    ) =>
    async (request: Request) =>
      handler(request, { userId: 'auth-boundary-user', serverDB: 'auth-db' }),
}));

const request = (url: string, init: RequestInit = {}): Request =>
  new Request(`https://example.test${url}`, init);

const authenticated =
  (userId: string, serverDB: unknown) =>
  (
    handler: (request: Request, scope: { userId: string; serverDB: unknown }) => Promise<Response>,
  ) =>
  async (request: Request) =>
    handler(request, { userId, serverDB });

describe('Next runtime route wiring', () => {
  it('uses the existing checkAuth boundary by default', async () => {
    const facade = { handle: vi.fn(async () => ({ ok: true })) };
    const factory = vi.fn<RuntimeFacadeFactory>(async ({ userId, serverDB }) => {
      expect(userId).toBe('auth-boundary-user');
      expect(serverDB).toBe('auth-db');
      return facade;
    });
    const handler = createRuntimeRouteHandler({ facadeFactory: factory });

    const response = await handler(request('/api/runtime/v1/plugins?request_id=auth-boundary-0'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('uses the injected auth boundary and returns a JSON run snapshot', async () => {
    const facade = {
      handle: vi.fn(async () => ({ runId: 'run-route-1', state: 'running' })),
    };
    const factory = vi.fn<RuntimeFacadeFactory>(async ({ userId, serverDB }) => {
      expect(userId).toBe('user-route-1');
      expect(serverDB).toEqual({ requestScope: 'db-1' });
      return facade;
    });
    const handler = createRuntimeRouteHandler({
      authenticate: authenticated('user-route-1', { requestScope: 'db-1' }),
      facadeFactory: factory,
    });

    const response = await handler(
      request('/api/runtime/v1/runs', {
        method: 'POST',
        headers: { 'x-request-id': 'route-start-1' },
        body: JSON.stringify({ runId: 'run-route-1', userMessage: 'hello' }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ runId: 'run-route-1', state: 'running' });
    expect(facade.handle).toHaveBeenCalledWith({
      protocol_version: 'runtime.v1',
      request_id: 'route-start-1',
      command: 'run.start',
      payload: { runId: 'run-route-1', userMessage: 'hello' },
    });
  });

  it('wires GET event replay through Next Response as SSE with after_seq', async () => {
    const abort = new AbortController();
    const events = [
      { protocol_version: 'runtime.v1', run_id: 'run-route-2', seq: 4, type: 'state', data: {} },
    ];
    const facade = { handle: vi.fn(async () => events) };
    const factory = vi.fn<RuntimeFacadeFactory>(async () => facade);
    const handler = createRuntimeRouteHandler({
      authenticate: authenticated('user-route-2', 'db-2'),
      facadeFactory: factory,
      sse: { heartbeatIntervalMs: 1000 },
    });

    const response = await handler(
      request('/api/runtime/v1/runs/run-route-2/events?after_seq=3&request_id=route-events-2', {
        signal: abort.signal,
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const chunk = await reader.read();
    expect(new TextDecoder().decode(chunk.value)).toContain('id: 4\n');
    abort.abort();
    await expect(reader.read()).resolves.toMatchObject({ done: true });
    expect(facade.handle).toHaveBeenCalledWith({
      protocol_version: 'runtime.v1',
      request_id: 'route-events-2',
      command: 'run.events',
      payload: { runId: 'run-route-2', after_seq: 3 },
    });
  });

  it('wires facade live events through the Next SSE response', async () => {
    const abort = new AbortController();
    let listener: RuntimeEventListener | undefined;
    const unsubscribe = vi.fn();
    const facade = {
      handle: vi.fn(async () => [
        {
          protocol_version: 'runtime.v1' as const,
          session_id: 'session-route-2-live',
          run_id: 'run-route-2-live',
          seq: 1,
          type: 'state',
          data: { state: 'running' },
        },
      ]),
      subscribe: vi.fn((_runId: string, next: RuntimeEventListener) => {
        listener = next;
        return unsubscribe;
      }),
    };
    const factory = vi.fn<RuntimeFacadeFactory>(async () => facade);
    const handler = createRuntimeRouteHandler({
      authenticate: authenticated('user-route-2-live', 'db-2-live'),
      facadeFactory: factory,
      sse: { heartbeatIntervalMs: 1000 },
    });

    const response = await handler(
      request('/api/runtime/v1/runs/run-route-2-live/events?request_id=route-live-2', {
        signal: abort.signal,
      }),
    );
    const reader = response.body!.getReader();

    expect(await reader.read()).toMatchObject({ done: false });
    listener?.({
      protocol_version: 'runtime.v1',
      session_id: 'session-route-2-live',
      run_id: 'run-route-2-live',
      seq: 2,
      type: 'state',
      data: { state: 'completed' },
    });
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('id: 2\n');
    abort.abort();
    await expect(reader.read()).resolves.toMatchObject({ done: true });
    expect(facade.subscribe).toHaveBeenCalledWith('run-route-2-live', expect.any(Function));
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('keeps protocol errors as stable JSON responses', async () => {
    const facade = { handle: vi.fn(async () => null) };
    const factory = vi.fn<RuntimeFacadeFactory>(async () => facade);
    const handler = createRuntimeRouteHandler({
      authenticate: authenticated('user-route-3', 'db-3'),
      facadeFactory: factory,
    });

    const response = await handler(
      request('/api/runtime/v1/runs', {
        method: 'POST',
        body: JSON.stringify({
          protocol_version: 'runtime.v0',
          request_id: 'route-invalid-3',
          command: 'run.start',
          payload: {},
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PROTOCOL_INVALID', path: 'protocol_version' },
    });
    expect(facade.handle).not.toHaveBeenCalled();
  });

  it('keeps facade failures visible through the route status and code', async () => {
    const facade = {
      handle: vi.fn(async () => {
        throw Object.assign(new Error('run missing'), { code: 'RUN_NOT_FOUND' });
      }),
    };
    const handler = createRuntimeRouteHandler({
      authenticate: authenticated('user-route-4', 'db-4'),
      facadeFactory: async () => facade,
    });

    const response = await handler(
      request('/api/runtime/v1/runs/missing', { headers: { 'x-request-id': 'route-missing-4' } }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'RUN_NOT_FOUND', message: 'run missing' },
    });
  });
});

describe('C-28 runtime route scoped-cache adoption', () => {
  const authenticatedByHeaders =
    (
      handler: (
        request: Request,
        scope: { userId: string; serverDB: unknown },
      ) => Promise<Response>,
    ) =>
    async (request: Request) =>
      handler(request, {
        userId: request.headers.get('x-user-id') ?? 'route-user',
        serverDB: request.headers.get('x-db') ?? 'route-db',
      });

  it('reuses one facade for repeated requests in the same user/session scope', async () => {
    const facades = new Map<string, { handle: ReturnType<typeof vi.fn> }>();
    const factory = vi.fn<RuntimeFacadeFactory>(async ({ userId, sessionId }) => {
      const facade = { handle: vi.fn(async () => ({ userId, sessionId })) };
      facades.set(`${userId}:${sessionId}`, facade);
      return facade;
    });
    const handler = createRuntimeRouteHandler({
      authenticate: authenticatedByHeaders,
      scopeCache: createScopedRuntimeFacadeCache({ factory }),
    });
    const init = { headers: { 'x-user-id': 'route-user-1', 'x-session-id': 'route-session-1' } };

    const first = await handler(request('/api/runtime/v1/plugins', init));
    const second = await handler(request('/api/runtime/v1/plugins', init));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(factory).toHaveBeenCalledOnce();
    expect(facades.get('route-user-1:route-session-1')?.handle).toHaveBeenCalledTimes(2);
  });

  it('isolates different users and sessions through the route', async () => {
    const factory = vi.fn<RuntimeFacadeFactory>(async ({ userId, sessionId }) => ({
      handle: vi.fn(async () => ({ userId, sessionId })),
    }));
    const handler = createRuntimeRouteHandler({
      authenticate: authenticatedByHeaders,
      scopeCache: createScopedRuntimeFacadeCache({ factory }),
    });

    await handler(
      request('/api/runtime/v1/plugins', {
        headers: { 'x-user-id': 'user-a', 'x-session-id': 'session-a' },
      }),
    );
    await handler(
      request('/api/runtime/v1/plugins', {
        headers: { 'x-user-id': 'user-a', 'x-session-id': 'session-b' },
      }),
    );
    await handler(
      request('/api/runtime/v1/plugins', {
        headers: { 'x-user-id': 'user-b', 'x-session-id': 'session-a' },
      }),
    );

    expect(factory).toHaveBeenCalledTimes(3);
  });

  it('honours an injected sessionIdFor on every cold-scope resolution', async () => {
    const factory = vi.fn<RuntimeFacadeFactory>(async ({ sessionId }) => ({
      handle: vi.fn(async () => ({ sessionId })),
    }));
    const sessionIdFor = vi.fn(
      (request: Request) => request.headers.get('x-tenant-session') ?? undefined,
    );
    const handler = createRuntimeRouteHandler({
      authenticate: authenticatedByHeaders,
      scopeCache: createScopedRuntimeFacadeCache({ factory }),
      sessionIdFor,
    });

    await handler(
      request('/api/runtime/v1/plugins', {
        headers: { 'x-tenant-session': 'tenant-session-1' },
      }),
    );

    expect(sessionIdFor).toHaveBeenCalledOnce();
    expect(factory.mock.calls[0]?.[0]).toMatchObject({ sessionId: 'tenant-session-1' });
  });

  it('returns a stable scope error when the injected session id is absent', async () => {
    const factory = vi.fn<RuntimeFacadeFactory>(async () => ({
      handle: vi.fn(async () => ({ ok: true })),
    }));
    const handler = createRuntimeRouteHandler({
      authenticate: authenticatedByHeaders,
      scopeCache: createScopedRuntimeFacadeCache({ factory }),
      sessionIdFor: () => undefined,
    });

    const response = await handler(request('/api/runtime/v1/plugins'));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'RUNTIME_FACADE_CACHE_SCOPE_INVALID', path: 'sessionId' },
    });
    expect(factory).not.toHaveBeenCalled();
  });

  it('rejects scopeCache and facadeFactory being configured together', () => {
    expect(() =>
      createRuntimeRouteHandler({
        scopeCache: createScopedRuntimeFacadeCache({
          factory: async () => ({ handle: async () => ({}) }),
        }),
        facadeFactory: async () => ({ handle: async () => ({}) }),
      }),
    ).toThrowError(/not both/);
  });

  it('keeps the existing uncached factory path when scopeCache is absent', async () => {
    const facade = { handle: vi.fn(async () => ({ ok: true })) };
    const factory = vi.fn<RuntimeFacadeFactory>(async () => facade);
    const handler = createRuntimeRouteHandler({
      authenticate: authenticatedByHeaders,
      facadeFactory: factory,
    });
    const init = { headers: { 'x-user-id': 'uncached-user', 'x-session-id': 'same-session' } };

    await handler(request('/api/runtime/v1/plugins', init));
    await handler(request('/api/runtime/v1/plugins', init));

    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent route requests in one cold scope', async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const facade = { handle: vi.fn(async () => ({ ok: true })) };
    const factory = vi.fn<RuntimeFacadeFactory>(async () => {
      await barrier;
      return facade;
    });
    const handler = createRuntimeRouteHandler({
      authenticate: authenticatedByHeaders,
      scopeCache: createScopedRuntimeFacadeCache({ factory }),
    });
    const init = {
      headers: { 'x-user-id': 'concurrent-user', 'x-session-id': 'concurrent-session' },
    };

    const first = handler(request('/api/runtime/v1/plugins', init));
    const second = handler(request('/api/runtime/v1/plugins', init));
    release();

    await Promise.all([first, second]);
    expect(factory).toHaveBeenCalledOnce();
    expect(facade.handle).toHaveBeenCalledTimes(2);
  });
});
