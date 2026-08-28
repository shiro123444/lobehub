// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import type {
  PresentationFactoryScope,
  PresentationPortFactory,
  PresentationPortScopeCacheBinding,
} from '@/server/runtime/presentation/factory';
import {
  createScopedPresentationPortCache,
  presentationPortFactoryFromScopeCache,
} from '@/server/runtime/presentation/factory';
import type { PresentationJob, PresentationPort } from '@/server/runtime/presentation/handler';

import type { PresentationAuthBoundary } from './route';
import { createPresentationRouteHandler } from './route';

vi.mock('@/app/(backend)/middleware/auth', () => ({
  checkAuth:
    (
      handler: (
        request: Request,
        scope: { userId: string; serverDB: unknown },
      ) => Promise<Response>,
    ) =>
    async (request: Request) =>
      handler(request, { userId: 'default-auth-user', serverDB: 'default-auth-db' }),
}));

const request = (path: string, init: RequestInit = {}): Request =>
  new Request(`https://example.test/api/runtime/presentation${path}`, init);

const authenticated =
  (userId: string, serverDB: unknown): PresentationAuthBoundary =>
  (handler) =>
  async (request) =>
    handler(request, { userId, serverDB });

const job = {
  jobId: 'job-1',
  state: 'completed',
  artifactIds: ['artifact-1'],
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:00:01.000Z',
} as PresentationJob;

const portFor = (overrides: Partial<PresentationPort> = {}): PresentationPort => ({
  createJob: vi.fn(async () => job),
  getJob: vi.fn(async () => job),
  cancelJob: vi.fn(async () => ({ ...job, state: 'cancelled' as const })),
  retryJob: vi.fn(async () => ({ ...job, state: 'running' as const })),
  getArtifact: vi.fn(async () => null),
  exportArtifact: vi.fn(async () => ({ artifactId: 'export-1', format: 'pptx' as const })),
  ...overrides,
});

const createHandler = (
  port: PresentationPort,
  options: { authenticate?: PresentationAuthBoundary; factory?: PresentationPortFactory } = {},
) =>
  createPresentationRouteHandler({
    authenticate: options.authenticate,
    portFactory: options.factory ?? (async () => port),
  });

describe('Next presentation route wiring', () => {
  it('uses the existing checkAuth boundary and forwards its scope', async () => {
    const port = portFor();
    const scopes: PresentationFactoryScope[] = [];
    const factory = vi.fn(async (value: PresentationFactoryScope) => {
      scopes.push(value);
      return port;
    });
    const handler = createHandler(port, { factory });

    const response = await handler(request('/jobs/job-1'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(job);
    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toMatchObject({
      userId: 'default-auth-user',
      serverDB: 'default-auth-db',
    });
  });

  it('creates a job through an injected authenticated route', async () => {
    const port = portFor();
    const handler = createHandler(port, {
      authenticate: authenticated('route-user', { db: 'route-db' }),
    });
    const input = {
      notebookId: 'notebook-1',
      sourceVersionIds: ['version-1'],
      title: 'A deck',
    };

    const response = await handler(
      request('/jobs', { method: 'POST', body: JSON.stringify(input) }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(job);
    expect(port.createJob).toHaveBeenCalledWith(input);
  });

  it('supports the C-15-L collection export endpoint', async () => {
    const exportArtifact = vi.fn(async () => ({ artifactId: 'export-1', format: 'pptx' as const }));
    const port = portFor({ exportArtifact });
    const handler = createHandler(port, {
      authenticate: authenticated('export-user', 'export-db'),
    });

    const response = await handler(
      request('/artifacts/export', {
        method: 'POST',
        body: JSON.stringify({ artifactId: 'artifact-1', format: 'pptx' }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ artifactId: 'export-1', format: 'pptx' });
    expect(exportArtifact).toHaveBeenCalledWith('artifact-1', 'pptx');
  });

  it('retains the path-parameter export endpoint', async () => {
    const exportArtifact = vi.fn(async () => ({ artifactId: 'export-2', format: 'svg' as const }));
    const port = portFor({ exportArtifact });
    const handler = createHandler(port, {
      authenticate: authenticated('export-user', 'export-db'),
    });

    const response = await handler(
      request('/artifacts/artifact-1/export', {
        method: 'POST',
        body: JSON.stringify({ format: 'svg' }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ artifactId: 'export-2', format: 'svg' });
    expect(exportArtifact).toHaveBeenCalledWith('artifact-1', 'svg');
  });

  it('preserves provider-unavailable errors as JSON', async () => {
    const factory = vi.fn<PresentationPortFactory>(async () => {
      throw Object.assign(new Error('provider missing'), { code: 'PROVIDER_UNAVAILABLE' });
    });
    const handler = createPresentationRouteHandler({
      authenticate: authenticated('missing-provider-user', 'missing-provider-db'),
      portFactory: factory,
    });

    const response = await handler(request('/jobs/job-1'));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PROVIDER_UNAVAILABLE', message: 'provider missing' },
    });
  });

  it('returns failed provider state without changing it to ready', async () => {
    const failed = {
      ...job,
      state: 'failed' as const,
      error: { code: 'PPTX_INVALID', message: 'bad artifact' },
    };
    const port = portFor({ createJob: vi.fn(async () => failed) });
    const handler = createHandler(port);

    const response = await handler(
      request('/jobs', {
        method: 'POST',
        body: JSON.stringify({
          notebookId: 'notebook-1',
          sourceVersionIds: ['version-1'],
          title: 'A deck',
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(failed);
  });
});

describe('C-27 presentation route scoped-cache adoption', () => {
  const createBinding = (
    baseFactory: PresentationPortFactory,
    serverDBFor?: ConstructorParameters<typeof createScopedPresentationPortCache>[0]['serverDBFor'],
  ): PresentationPortScopeCacheBinding =>
    createScopedPresentationPortCache({
      factory: baseFactory,
      ...(serverDBFor ? { serverDBFor } : {}),
    });

  const cachedHandler = (
    baseFactory: PresentationPortFactory,
    options: {
      sessionIdFor?: (request: Request) => string | undefined;
      serverDBFor?: ConstructorParameters<
        typeof createScopedPresentationPortCache
      >[0]['serverDBFor'];
    } = {},
  ) =>
    createPresentationRouteHandler({
      scopeCache: createBinding(baseFactory, options.serverDBFor),
      ...(options.sessionIdFor ? { sessionIdFor: options.sessionIdFor } : {}),
    });

  it('reuses one port per authenticated scope across requests without re-running the factory', async () => {
    const ports: PresentationPort[] = [];
    const baseFactory = vi.fn(async () => {
      const port = portFor();
      ports.push(port);
      return port;
    });
    const handler = cachedHandler(baseFactory);
    const getSession = (session: string): RequestInit => ({ headers: { 'x-session-id': session } });

    const first = await handler(request('/jobs/job-1', getSession('sess-1')));
    const second = await handler(request('/jobs/job-2', getSession('sess-1')));
    const third = await handler(request('/jobs/job-1', getSession('sess-1')));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);
    expect(baseFactory).toHaveBeenCalledTimes(1);
    expect(ports).toHaveLength(1);
    const reusedPort = ports[0]!;
    expect(vi.mocked(reusedPort.getJob)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(reusedPort.getJob).mock.calls.map(([jobId]) => jobId)).toEqual([
      'job-1',
      'job-2',
      'job-1',
    ]);
  });

  it('isolates different sessions and users through the same route', async () => {
    const baseFactory = vi.fn(async ({ sessionId }: PresentationFactoryScope) => portFor());
    const handler = cachedHandler(baseFactory);

    await handler(request('/jobs/job-1', { headers: { 'x-session-id': 'sess-a' } }));
    await handler(request('/jobs/job-1', { headers: { 'x-session-id': 'sess-b' } }));
    await handler(request('/jobs/job-1', { headers: { 'x-session-id': 'sess-a' } }));

    expect(baseFactory).toHaveBeenCalledTimes(2);
    const seenSessions = baseFactory.mock.calls.map(([scope]) => scope.sessionId);
    expect(seenSessions).toEqual(['sess-a', 'sess-b']);
  });

  it('honours an injected sessionIdFor source and forwards serverDBFor to the wrapped factory', async () => {
    const baseFactory = vi.fn(async () => portFor());
    const serverDBFor = vi.fn(() => ({ db: 'scoped' }));
    const handler = cachedHandler(baseFactory, {
      sessionIdFor: (req) => req.headers.get('x-tenant-session') ?? undefined,
      serverDBFor,
    });

    await handler(request('/jobs/job-1', { headers: { 'x-tenant-session': 'tenant-77' } }));

    expect(baseFactory).toHaveBeenCalledTimes(1);
    expect(baseFactory.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 'tenant-77',
      serverDB: { db: 'scoped' },
    });
    expect(serverDBFor).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'tenant-77' }));
  });

  it('fails honestly with a stable code when the authenticated session id is missing', async () => {
    const baseFactory = vi.fn(async () => portFor());
    const handler = cachedHandler(baseFactory, {
      sessionIdFor: () => undefined,
    });

    const response = await handler(request('/jobs/job-1'));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PRESENTATION_CACHE_SCOPE_INVALID' },
    });
    expect(baseFactory).not.toHaveBeenCalled();
  });

  it('rejects contradictory wiring: scopeCache together with portFactory', () => {
    const binding = createBinding(async () => portFor());
    expect(() =>
      createPresentationRouteHandler({
        scopeCache: binding,
        portFactory: async () => portFor(),
      }),
    ).toThrowError(/not both/);
  });

  it('keeps the default uncached behavior when the option is absent', async () => {
    const port = portFor();
    const factory = vi.fn(async () => port);
    const handler = createHandler(port, { factory });

    await handler(request('/jobs/job-1', { headers: { 'x-session-id': 'sess-1' } }));
    await handler(request('/jobs/job-1', { headers: { 'x-session-id': 'sess-1' } }));

    // Uncached: the factory runs on every request even for identical sessions.
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('exposes the C-27 adapter directly for non-route consumers', async () => {
    const resolve = vi.fn(async () => portFor());
    const binding = {
      resolve,
      reset: vi.fn(),
      dispose: vi.fn(),
      cache: {},
    } as unknown as PresentationPortScopeCacheBinding;
    const adapter = presentationPortFactoryFromScopeCache(
      binding,
      (req) => req.headers.get('x-session-id') ?? undefined,
    );

    const requestScope: PresentationFactoryScope = {
      userId: 'adapter-user',
      serverDB: 'adapter-db',
      request: request('/jobs/job-1', { headers: { 'x-session-id': 'adapter-session' } }),
    };
    const port = await adapter(requestScope);

    expect(port.getJob).toBeTypeOf('function');
    expect(resolve).toHaveBeenCalledWith({
      userId: 'adapter-user',
      sessionId: 'adapter-session',
      request: requestScope.request,
    });

    // Missing sessionId from the source fails honestly through the adapter —
    // verified against a real binding so scope validation actually applies.
    const realBinding = createBinding(async () => portFor());
    const broken = presentationPortFactoryFromScopeCache(realBinding, () => undefined);
    await expect(broken(requestScope)).rejects.toMatchObject({
      code: 'PRESENTATION_CACHE_SCOPE_INVALID',
    });
  });
});
