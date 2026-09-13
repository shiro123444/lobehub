import { describe, expect, it, vi } from 'vitest';

import type { RuntimeCommandEnvelope, RuntimeFacadePort, RuntimeHttpResponse } from './adapter';
import { RuntimeHttpAdapter } from './adapter';

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

const createFacade = (
  implementation: RuntimeFacadePort['handle'] = async (request) => ({
    command: request.command,
    payload: request.payload,
  }),
) => {
  const handle = vi.fn(implementation);
  const facade: RuntimeFacadePort = { handle };
  return { facade, handle };
};

const errorWith = (
  code: string,
  message: string,
  details?: unknown,
): Error & { code: string; details?: unknown } =>
  Object.assign(new Error(message), { code, details });

describe('RuntimeHttpAdapter', () => {
  it('accepts a runtime.v1 envelope and routes run.start', async () => {
    const { facade, handle } = createFacade(async () => ({
      runId: 'run-1',
      state: 'running',
    }));
    const adapter = new RuntimeHttpAdapter(facade);
    const request = envelope('start-1', 'run.start', { runId: 'run-1' });

    const response = await adapter.handle(request);

    expect(response).toMatchObject({
      status: 200,
      body: { runId: 'run-1', state: 'running' },
    });
    expect(handle).toHaveBeenCalledWith(request);
  });

  it('routes every supported run command through the facade', async () => {
    const { facade, handle } = createFacade();
    const adapter = new RuntimeHttpAdapter(facade);
    const commands = ['run.start', 'run.get', 'run.cancel', 'run.resume', 'run.events'];

    for (const [index, command] of commands.entries()) {
      const response = await adapter.handle(envelope(`run-${index}`, command, { runId: 'run-1' }));
      expect(response.status).toBe(200);
    }

    expect(handle.mock.calls.map(([request]) => request.command)).toEqual(commands);
  });

  it('routes plugin.list, plugin.mount, plugin.unmount, and plugin.reload', async () => {
    const { facade, handle } = createFacade();
    const adapter = new RuntimeHttpAdapter(facade);

    for (const [index, command] of [
      'plugin.list',
      'plugin.mount',
      'plugin.unmount',
      'plugin.reload',
    ].entries()) {
      await expect(
        adapter.handle(envelope(`plugin-${index}`, command, { id: 'builtin' })),
      ).resolves.toMatchObject({ status: 200 });
    }

    expect(handle.mock.calls.map(([request]) => request.command)).toEqual([
      'plugin.list',
      'plugin.mount',
      'plugin.unmount',
      'plugin.reload',
    ]);
  });

  it('maps an invalid protocol version to PROTOCOL_INVALID', async () => {
    const { facade, handle } = createFacade();
    const adapter = new RuntimeHttpAdapter(facade);

    const response = await adapter.handle({
      protocol_version: 'runtime.v0',
      request_id: 'invalid-version',
      command: 'run.start',
      payload: {},
    });

    expect(response).toMatchObject({
      status: 400,
      body: { error: { code: 'PROTOCOL_INVALID', path: 'protocol_version' } },
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it('maps missing envelope fields and keeps the error path', async () => {
    const { facade } = createFacade();
    const adapter = new RuntimeHttpAdapter(facade);

    const response = await adapter.handle({
      protocol_version: 'runtime.v1',
      request_id: 'missing-command',
      payload: {},
    });

    expect(response).toMatchObject({
      status: 400,
      body: { error: { code: 'PROTOCOL_INVALID', path: 'command' } },
    });
  });

  it('accepts encoded envelopes without executing payload values', async () => {
    const { facade, handle } = createFacade(async () => null);
    const adapter = new RuntimeHttpAdapter(facade);
    const request = envelope('encoded-1', 'run.get', { runId: 'run-1', untouched: 'value' });

    const response = await adapter.handle(JSON.stringify(request));

    expect(response).toMatchObject({ status: 200, body: null });
    expect(handle).toHaveBeenCalledWith(request);
  });

  it('preserves after_seq for ordered event replay', async () => {
    const events = [
      { protocol_version: 'runtime.v1', run_id: 'run-1', seq: 2, type: 'state', data: {} },
    ];
    const { facade, handle } = createFacade(async () => events);
    const adapter = new RuntimeHttpAdapter(facade);
    const request = envelope('events-1', 'run.events', { runId: 'run-1', after_seq: 1 });

    const response = await adapter.handle(request);

    expect(response).toMatchObject({ status: 200, body: events });
    expect(handle).toHaveBeenCalledWith(request);
  });

  it('rejects an invalid after_seq before calling the facade', async () => {
    const { facade, handle } = createFacade();
    const adapter = new RuntimeHttpAdapter(facade);

    const response = await adapter.handle(
      envelope('events-invalid', 'run.events', { runId: 'run-1', after_seq: -1 }),
    );

    expect(response).toMatchObject({
      status: 400,
      body: { error: { code: 'PROTOCOL_INVALID', path: 'payload.after_seq' } },
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it('returns the same result and performs one call for a repeated request_id', async () => {
    const { facade, handle } = createFacade(async () => ({ runId: 'run-idempotent' }));
    const adapter = new RuntimeHttpAdapter(facade);
    const request = envelope('same-request', 'run.start', { runId: 'run-idempotent' });

    const first = await adapter.handle(request);
    const second = await adapter.handle(request);

    expect(second).toBe(first);
    expect(handle).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent requests with the same request_id', async () => {
    let resolveResult!: (value: unknown) => void;
    const { facade, handle } = createFacade(
      () =>
        new Promise((resolve) => {
          resolveResult = resolve;
        }),
    );
    const adapter = new RuntimeHttpAdapter(facade);
    const request = envelope('concurrent-request', 'run.start');

    const first = adapter.handle(request);
    const second = adapter.handle(request);
    await Promise.resolve();
    resolveResult({ runId: 'run-concurrent' });

    const [firstResponse, secondResponse] = await Promise.all([first, second]);

    expect(secondResponse).toBe(firstResponse);
    expect(handle).toHaveBeenCalledOnce();
  });

  it('maps unsupported commands to COMMAND_NOT_FOUND', async () => {
    const { facade, handle } = createFacade();
    const adapter = new RuntimeHttpAdapter(facade);

    const response = await adapter.handle(envelope('unknown-command', 'run.unknown'));

    expect(response).toMatchObject({
      status: 404,
      body: { error: { code: 'COMMAND_NOT_FOUND' } },
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it('maps facade errors to stable status and code without losing details', async () => {
    const failure = errorWith('RUN_NOT_FOUND', 'Run does not exist', { runId: 'missing' });
    const { facade } = createFacade(async () => {
      throw failure;
    });
    const adapter = new RuntimeHttpAdapter(facade);

    const response = await adapter.handle(envelope('missing-run', 'run.get', { runId: 'missing' }));

    expect(response).toEqual({
      status: 404,
      headers: { 'content-type': 'application/json' },
      body: {
        error: {
          code: 'RUN_NOT_FOUND',
          message: 'Run does not exist',
          details: { runId: 'missing' },
        },
      },
    } satisfies RuntimeHttpResponse);
  });

  it('preserves provider failures as internal stable errors', async () => {
    const { facade } = createFacade(async () => {
      throw errorWith('MODEL_PROVIDER_ERROR', 'provider unavailable');
    });
    const adapter = new RuntimeHttpAdapter(facade);

    const response = await adapter.handle(envelope('provider-failure', 'run.start'));

    expect(response).toMatchObject({
      status: 500,
      body: { error: { code: 'MODEL_PROVIDER_ERROR', message: 'provider unavailable' } },
    });
  });

  it('returns a JSON-safe response body for snapshots and events', async () => {
    const { facade } = createFacade(async () => ({
      runId: 'run-safe',
      nested: ['event', { ok: true }],
    }));
    const adapter = new RuntimeHttpAdapter(facade);

    const response = await adapter.handle(envelope('json-safe', 'run.get'));

    expect(() => JSON.stringify(response.body)).not.toThrow();
    expect(response.body).toEqual({ runId: 'run-safe', nested: ['event', { ok: true }] });
  });
});
