import { describe, expect, it, vi } from 'vitest';

import { RuntimeHttpAdapter } from './adapter';
import type {
  RuntimeCommandEnvelope,
  RuntimeFacadeFactory,
  RuntimeFacadePort,
  RuntimeFacadeScope,
} from './route-handler';
import { handleRuntimeRequest } from './route-handler';

const envelope = (
  request_id: string,
  command: string,
  payload: Record<string, unknown> = {},
): RuntimeCommandEnvelope => ({
  protocol_version: 'runtime.v1',
  request_id,
  command,
  payload,
});

const request = (url: string, init: RequestInit = {}): Request =>
  new Request(`https://example.test${url}`, init);

const createFacade = (
  implementation: RuntimeFacadePort['handle'] = async (input) => ({
    command: input.command,
    payload: input.payload,
  }),
) => {
  const handle = vi.fn(implementation);
  return { facade: { handle } satisfies RuntimeFacadePort, handle };
};

describe('framework-neutral Runtime route handler', () => {
  it('routes POST /runs using the submitted runtime.v1 envelope', async () => {
    const { facade, handle } = createFacade(async () => ({ runId: 'run-1', state: 'running' }));
    const factory = vi.fn<RuntimeFacadeFactory>(async () => facade);

    const response = await handleRuntimeRequest(
      request('/api/runtime/v1/runs', {
        method: 'POST',
        body: JSON.stringify(envelope('start-1', 'run.start', { runId: 'run-1' })),
      }),
      { userId: 'user-1', serverDB: { scope: 'db-1' } },
      factory,
    );

    expect(response).toMatchObject({ status: 200, body: { runId: 'run-1', state: 'running' } });
    expect(handle).toHaveBeenCalledWith(envelope('start-1', 'run.start', { runId: 'run-1' }));
  });

  it('builds run.get payload from the authenticated request path', async () => {
    const { facade, handle } = createFacade();
    const factory = vi.fn<RuntimeFacadeFactory>(async () => facade);

    await handleRuntimeRequest(
      request('/api/runtime/v1/runs/run-2', {
        headers: { 'x-request-id': 'get-2' },
      }),
      { userId: 'user-2', serverDB: 'db-2' },
      factory,
    );

    expect(handle).toHaveBeenCalledWith(envelope('get-2', 'run.get', { runId: 'run-2' }));
  });

  it('generates unique request IDs for GET requests without an explicit ID', async () => {
    const { facade, handle } = createFacade();
    const factory = vi.fn<RuntimeFacadeFactory>(async () => facade);

    await handleRuntimeRequest(
      request('/api/runtime/v1/plugins'),
      { userId: 'user-get-id', serverDB: 'db-get-id' },
      factory,
    );
    await handleRuntimeRequest(
      request('/api/runtime/v1/plugins'),
      { userId: 'user-get-id', serverDB: 'db-get-id' },
      factory,
    );

    const [first, second] = handle.mock.calls.map(([input]) => input.request_id);
    expect(first).toMatch(/^runtime-get-/);
    expect(second).toMatch(/^runtime-get-/);
    expect(second).not.toBe(first);
  });

  it('preserves numeric after_seq for event replay', async () => {
    const { facade, handle } = createFacade(async () => []);
    const factory = vi.fn<RuntimeFacadeFactory>(async () => facade);

    const response = await handleRuntimeRequest(
      request('/api/runtime/v1/runs/run-3/events?after_seq=7&request_id=events-3'),
      { userId: 'user-3', serverDB: 'db-3' },
      factory,
    );

    expect(response).toMatchObject({ status: 200, body: [] });
    expect(handle).toHaveBeenCalledWith(
      envelope('events-3', 'run.events', { runId: 'run-3', after_seq: 7 }),
    );
  });

  it('routes cancel, resume, and plugin operations to their command names', async () => {
    const { facade, handle } = createFacade();
    const factory = vi.fn<RuntimeFacadeFactory>(async () => facade);
    const cases = [
      ['/api/runtime/v1/runs/run-4/cancel', 'POST', 'cancel-4', 'run.cancel', { runId: 'run-4' }],
      [
        '/api/runtime/v1/runs/run-4/resume',
        'POST',
        'resume-4',
        'run.resume',
        { runId: 'run-4', input: 'continue' },
      ],
      ['/api/runtime/v1/plugins', 'GET', 'plugins-4', 'plugin.list', {}],
      ['/api/runtime/v1/plugins/tool/mount', 'POST', 'mount-4', 'plugin.mount', { id: 'tool' }],
      [
        '/api/runtime/v1/plugins/tool/unmount',
        'POST',
        'unmount-4',
        'plugin.unmount',
        { id: 'tool' },
      ],
    ] as const;

    for (const [url, method, requestId, command, payload] of cases) {
      const body = command === 'run.resume' ? JSON.stringify({ input: 'continue' }) : undefined;
      await handleRuntimeRequest(
        request(url, {
          method,
          headers: { 'x-request-id': requestId },
          ...(body ? { body } : {}),
        }),
        { userId: 'user-4', serverDB: 'db-4' },
        factory,
      );
      expect(handle).toHaveBeenLastCalledWith(envelope(requestId, command, payload));
    }
  });

  it('passes the authenticated user scope to every factory call', async () => {
    const { facade } = createFacade();
    const scopes: RuntimeFacadeScope[] = [];
    const factory = vi.fn<RuntimeFacadeFactory>(async (scope) => {
      scopes.push(scope);
      return facade;
    });

    await handleRuntimeRequest(
      request('/api/runtime/v1/plugins?request_id=scope-a'),
      { userId: 'user-a', serverDB: 'db-a' },
      factory,
    );
    await handleRuntimeRequest(
      request('/api/runtime/v1/plugins?request_id=scope-b'),
      { userId: 'user-b', serverDB: 'db-b' },
      factory,
    );

    expect(scopes.map(({ userId, serverDB }) => ({ userId, serverDB }))).toEqual([
      { userId: 'user-a', serverDB: 'db-a' },
      { userId: 'user-b', serverDB: 'db-b' },
    ]);
  });

  it('keeps request-id idempotency when a scoped binding supplies one adapter', async () => {
    const { facade, handle } = createFacade(async () => ({ accepted: true }));
    const adapter = new RuntimeHttpAdapter(facade);
    const factory = vi.fn<RuntimeFacadeFactory>(async () => ({ facade, adapter }));
    const input = envelope('same-route-request', 'run.start', { runId: 'run-5' });
    const init = { method: 'POST', body: JSON.stringify(input) } satisfies RequestInit;

    const first = await handleRuntimeRequest(
      request('/api/runtime/v1/runs', init),
      { userId: 'user-5', serverDB: 'db-5' },
      factory,
    );
    const second = await handleRuntimeRequest(
      request('/api/runtime/v1/runs', init),
      { userId: 'user-5', serverDB: 'db-5' },
      factory,
    );

    expect(second).toBe(first);
    expect(handle).toHaveBeenCalledOnce();
  });

  it('reuses an adapter for a pure facade across requests in one scope', async () => {
    const { facade, handle } = createFacade(async () => ({ accepted: true }));
    const factory = vi.fn<RuntimeFacadeFactory>(async () => facade);
    const input = envelope('pure-facade-request', 'run.start', { runId: 'run-pure' });
    const init = { method: 'POST', body: JSON.stringify(input) } satisfies RequestInit;
    const scope = { userId: 'user-pure', serverDB: 'db-pure' };

    const first = await handleRuntimeRequest(request('/api/runtime/v1/runs', init), scope, factory);
    const second = await handleRuntimeRequest(
      request('/api/runtime/v1/runs', init),
      scope,
      factory,
    );

    expect(second).toBe(first);
    expect(handle).toHaveBeenCalledOnce();
  });

  it('isolates idempotency caches for different user scopes sharing a pure facade', async () => {
    const { facade, handle } = createFacade(async () => ({ accepted: true }));
    const factory = vi.fn<RuntimeFacadeFactory>(async () => facade);
    const input = envelope('same-request-different-users', 'run.start', { runId: 'run-scope' });
    const init = { method: 'POST', body: JSON.stringify(input) } satisfies RequestInit;

    const first = await handleRuntimeRequest(
      request('/api/runtime/v1/runs', init),
      { userId: 'user-a', serverDB: 'shared-db' },
      factory,
    );
    const second = await handleRuntimeRequest(
      request('/api/runtime/v1/runs', init),
      { userId: 'user-b', serverDB: 'shared-db' },
      factory,
    );

    expect(second).not.toBe(first);
    expect(handle).toHaveBeenCalledTimes(2);
  });

  it('retains protocol validation and stable error paths at the route seam', async () => {
    const { facade, handle } = createFacade();
    const factory = vi.fn<RuntimeFacadeFactory>(async () => facade);

    const response = await handleRuntimeRequest(
      request('/api/runtime/v1/runs', {
        method: 'POST',
        body: JSON.stringify({
          protocol_version: 'runtime.v0',
          request_id: 'bad-version',
          command: 'run.start',
          payload: {},
        }),
      }),
      { userId: 'user-6', serverDB: 'db-6' },
      factory,
    );

    expect(response).toMatchObject({
      status: 400,
      body: { error: { code: 'PROTOCOL_INVALID', path: 'protocol_version' } },
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it('maps an invalid after_seq query to PROTOCOL_INVALID', async () => {
    const { facade, handle } = createFacade();
    const factory = vi.fn<RuntimeFacadeFactory>(async () => facade);

    const response = await handleRuntimeRequest(
      request('/api/runtime/v1/runs/run-7/events?after_seq=not-a-number&request_id=events-7'),
      { userId: 'user-7', serverDB: 'db-7' },
      factory,
    );

    expect(response).toMatchObject({
      status: 400,
      body: { error: { code: 'PROTOCOL_INVALID', path: 'payload.after_seq' } },
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it('maps facade errors without changing their stable code', async () => {
    const { facade } = createFacade(async () => {
      throw Object.assign(new Error('missing run'), {
        code: 'RUN_NOT_FOUND',
        details: { runId: 'run-missing' },
      });
    });
    const factory = vi.fn<RuntimeFacadeFactory>(async () => facade);

    const response = await handleRuntimeRequest(
      request('/api/runtime/v1/runs/run-missing', {
        headers: { 'x-request-id': 'missing-8' },
      }),
      { userId: 'user-8', serverDB: 'db-8' },
      factory,
    );

    expect(response).toMatchObject({
      status: 404,
      body: { error: { code: 'RUN_NOT_FOUND', details: { runId: 'run-missing' } } },
    });
  });

  it('maps factory failures to stable JSON errors', async () => {
    const factory = vi.fn<RuntimeFacadeFactory>(async () => {
      throw Object.assign(new Error('runtime is not configured'), {
        code: 'RUNTIME_FACADE_UNAVAILABLE',
      });
    });

    const response = await handleRuntimeRequest(
      request('/api/runtime/v1/plugins?request_id=factory-9'),
      { userId: 'user-9', serverDB: 'db-9' },
      factory,
    );

    expect(response).toMatchObject({
      status: 503,
      body: { error: { code: 'RUNTIME_FACADE_UNAVAILABLE' } },
    });
  });

  it('reports malformed JSON and unknown routes without invoking the facade', async () => {
    const { facade, handle } = createFacade();
    const factory = vi.fn<RuntimeFacadeFactory>(async () => facade);

    const malformed = await handleRuntimeRequest(
      request('/api/runtime/v1/runs', { method: 'POST', body: '{' }),
      { userId: 'user-10', serverDB: 'db-10' },
      factory,
    );
    const unknown = await handleRuntimeRequest(
      request('/api/runtime/v1/not-a-route?request_id=unknown-10'),
      { userId: 'user-10', serverDB: 'db-10' },
      factory,
    );

    expect(malformed).toMatchObject({
      status: 400,
      body: { error: { code: 'PROTOCOL_INVALID' } },
    });
    expect(unknown).toMatchObject({
      status: 404,
      body: { error: { code: 'COMMAND_NOT_FOUND' } },
    });
    expect(handle).not.toHaveBeenCalled();
  });
});
