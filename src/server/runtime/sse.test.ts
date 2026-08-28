import { describe, expect, it, vi } from 'vitest';

import { InMemoryRuntimeFacade } from '../../../packages/cordis-kernel/src/facade';
import type { RuntimeEvent } from '../../../packages/cordis-kernel/src/run';
import type { RuntimeEventListener } from './adapter';
import type { RuntimeFacadeFactory } from './factory';
import {
  createRuntimeSseResponse,
  formatRuntimeSseEvent,
  handleRuntimeSseRequest,
  isRuntimeSseStreamResponse,
  type RuntimeSseStreamResponse,
} from './sse';

const request = (url: string, init: RequestInit = {}): Request =>
  new Request(`https://example.test${url}`, init);

const event = (seq: number, runId = 'run-sse', sessionId = 'session-sse'): RuntimeEvent => ({
  protocol_version: 'runtime.v1',
  session_id: sessionId,
  run_id: runId,
  seq,
  type: 'run.state_changed',
  data: { state: seq === 1 ? 'running' : 'completed' },
});

const asStream = (
  value: Awaited<ReturnType<typeof handleRuntimeSseRequest>>,
): RuntimeSseStreamResponse => {
  if (!isRuntimeSseStreamResponse(value)) throw new Error('expected an SSE response');
  return value;
};

const readText = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> => {
  const result = await reader.read();
  return result.value ? new TextDecoder().decode(result.value) : '';
};

const facadeFor = (result: unknown) => {
  const handle = vi.fn(async (input: { command: string }) => {
    void input;
    return result;
  });
  const factory = vi.fn<RuntimeFacadeFactory>(async () => ({ handle }));
  return { factory, handle };
};

describe('framework-neutral Runtime SSE transport', () => {
  it('formats an event with an id, JSON data, and SSE framing', () => {
    expect(formatRuntimeSseEvent(event(4))).toBe(`id: 4\ndata: ${JSON.stringify(event(4))}\n\n`);
  });

  it('replays run events after after_seq through a text/event-stream response', async () => {
    const { factory, handle } = facadeFor([event(2)]);
    const response = asStream(
      await handleRuntimeSseRequest(
        request('/api/runtime/v1/runs/run-sse/events?after_seq=1&request_id=sse-1'),
        { userId: 'user-sse', serverDB: 'db-sse' },
        factory,
        { heartbeatIntervalMs: 1000 },
      ),
    );
    const reader = response.body.getReader();

    expect(response.headers).toMatchObject({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
    });
    await expect(readText(reader)).resolves.toContain('id: 2\n');
    expect(handle).toHaveBeenCalledWith({
      protocol_version: 'runtime.v1',
      request_id: 'sse-1',
      command: 'run.events',
      payload: { runId: 'run-sse', after_seq: 1 },
    });
    await reader.cancel();
  });

  it('emits replay frames in strictly increasing sequence order', async () => {
    const controller = new AbortController();
    const response = createRuntimeSseResponse([event(1), event(3)], controller.signal, {
      heartbeatIntervalMs: 1000,
    });
    const reader = response.body.getReader();

    expect(await readText(reader)).toContain('id: 1\n');
    expect(await readText(reader)).toContain('id: 3\n');
    controller.abort();
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });

  it('sends periodic heartbeat comments while the stream is open', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const response = createRuntimeSseResponse([], controller.signal, {
        heartbeatIntervalMs: 10,
      });
      const reader = response.body.getReader();
      const pending = readText(reader);

      await vi.advanceTimersByTimeAsync(10);
      await expect(pending).resolves.toBe(': heartbeat\n\n');
      controller.abort();
      await expect(reader.read()).resolves.toMatchObject({ done: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes cleanly on AbortSignal without issuing run.cancel', async () => {
    const controller = new AbortController();
    const { factory, handle } = facadeFor([event(1)]);
    const response = asStream(
      await handleRuntimeSseRequest(
        new Request('https://example.test/api/runtime/v1/runs/run-sse/events', {
          signal: controller.signal,
        }),
        { userId: 'user-sse', serverDB: 'db-sse' },
        factory,
        { heartbeatIntervalMs: 1000 },
      ),
    );
    const reader = response.body.getReader();

    await readText(reader);
    controller.abort();
    await expect(reader.read()).resolves.toMatchObject({ done: true });
    expect(handle.mock.calls.map(([input]) => input.command)).toEqual(['run.events']);
  });

  it('keeps invalid after_seq as a JSON protocol error', async () => {
    const { factory, handle } = facadeFor([]);
    const response = await handleRuntimeSseRequest(
      request('/api/runtime/v1/runs/run-sse/events?after_seq=-1&request_id=sse-invalid'),
      { userId: 'user-sse', serverDB: 'db-sse' },
      factory,
    );

    expect(response).toMatchObject({
      status: 400,
      headers: { 'content-type': 'application/json' },
      body: { error: { code: 'PROTOCOL_INVALID', path: 'payload.after_seq' } },
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it('keeps facade and authentication failures as JSON responses', async () => {
    const factory = vi.fn<RuntimeFacadeFactory>(async () => {
      throw Object.assign(new Error('scope rejected'), { code: 'AUTH_REQUIRED' });
    });
    const response = await handleRuntimeSseRequest(
      request('/api/runtime/v1/runs/run-sse/events?request_id=sse-auth'),
      { userId: 'user-sse', serverDB: 'db-sse' },
      factory,
    );

    expect(response).toMatchObject({
      status: 500,
      headers: { 'content-type': 'application/json' },
      body: { error: { code: 'AUTH_REQUIRED', message: 'scope rejected' } },
    });
  });

  it('returns a stable JSON error when event sequences are not monotonic', async () => {
    const { factory } = facadeFor([event(2), event(1)]);
    const response = await handleRuntimeSseRequest(
      request('/api/runtime/v1/runs/run-sse/events?request_id=sse-order'),
      { userId: 'user-sse', serverDB: 'db-sse' },
      factory,
    );

    expect(response).toMatchObject({
      status: 500,
      headers: { 'content-type': 'application/json' },
      body: { error: { code: 'RUNTIME_RESPONSE_INVALID', path: 'events[1].seq' } },
    });
  });

  it('returns a stable JSON error when the facade does not return an event array', async () => {
    const { factory } = facadeFor({ state: 'running' });
    const response = await handleRuntimeSseRequest(
      request('/api/runtime/v1/runs/run-sse/events?request_id=sse-shape'),
      { userId: 'user-sse', serverDB: 'db-sse' },
      factory,
    );

    expect(response).toMatchObject({
      status: 500,
      body: { error: { code: 'RUNTIME_RESPONSE_INVALID', path: 'body' } },
    });
  });

  it('does not treat other runtime paths as SSE requests', async () => {
    const { factory, handle } = facadeFor([]);
    const response = await handleRuntimeSseRequest(
      request('/api/runtime/v1/runs/run-sse'),
      { userId: 'user-sse', serverDB: 'db-sse' },
      factory,
    );

    expect(response).toMatchObject({
      status: 404,
      body: { error: { code: 'COMMAND_NOT_FOUND', path: 'path' } },
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it('replays before registering a live subscriber and then emits new events', async () => {
    const controller = new AbortController();
    let listener: RuntimeEventListener | undefined;
    let unsubscribeCount = 0;
    const handle = vi.fn(async () => [event(1)]);
    const subscribe = vi.fn((runId: string, next: RuntimeEventListener) => {
      expect(runId).toBe('run-sse');
      listener = next;
      return () => {
        unsubscribeCount += 1;
      };
    });
    const facade = { handle, subscribe };
    const factory = vi.fn<RuntimeFacadeFactory>(async () => facade);
    const response = asStream(
      await handleRuntimeSseRequest(
        request('/api/runtime/v1/runs/run-sse/events?request_id=live-1', {
          signal: controller.signal,
        }),
        { userId: 'user-sse', serverDB: 'db-sse' },
        factory,
        { heartbeatIntervalMs: 1000 },
      ),
    );
    const reader = response.body.getReader();

    expect(await readText(reader)).toContain('id: 1\n');
    expect(subscribe).toHaveBeenCalledOnce();
    listener?.(event(2));
    expect(await readText(reader)).toContain('id: 2\n');

    controller.abort();
    await expect(reader.read()).resolves.toMatchObject({ done: true });
    expect(unsubscribeCount).toBe(1);
  });

  it('drops duplicate and old live events while preserving later sequence order', async () => {
    const controller = new AbortController();
    let listener: RuntimeEventListener | undefined;
    const handle = vi.fn(async () => [event(1)]);
    const subscribe = vi.fn((_runId: string, next: RuntimeEventListener) => {
      listener = next;
      return undefined;
    });
    const factory = vi.fn<RuntimeFacadeFactory>(async () => ({ handle, subscribe }));
    const response = asStream(
      await handleRuntimeSseRequest(
        request('/api/runtime/v1/runs/run-sse/events?request_id=live-2', {
          signal: controller.signal,
        }),
        { userId: 'user-sse', serverDB: 'db-sse' },
        factory,
        { heartbeatIntervalMs: 1000 },
      ),
    );
    const reader = response.body.getReader();

    await readText(reader);
    listener?.(event(1));
    listener?.(event(0));
    const nextFrame = readText(reader);
    listener?.(event(3));
    await expect(nextFrame).resolves.toContain('id: 3\n');

    controller.abort();
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });

  it('uses after_seq as the live cursor when replay is empty', async () => {
    const controller = new AbortController();
    let listener: RuntimeEventListener | undefined;
    const handle = vi.fn(async () => []);
    const subscribe = vi.fn((_runId: string, next: RuntimeEventListener) => {
      listener = next;
      return () => {};
    });
    const factory = vi.fn<RuntimeFacadeFactory>(async () => ({ handle, subscribe }));
    const response = asStream(
      await handleRuntimeSseRequest(
        request('/api/runtime/v1/runs/run-sse/events?after_seq=5&request_id=live-3', {
          signal: controller.signal,
        }),
        { userId: 'user-sse', serverDB: 'db-sse' },
        factory,
        { heartbeatIntervalMs: 1000 },
      ),
    );
    const reader = response.body.getReader();
    const nextFrame = readText(reader);

    listener?.(event(5));
    listener?.(event(6));
    await expect(nextFrame).resolves.toContain('id: 6\n');

    controller.abort();
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });

  it('supports subscribeRunEvents as the facade live-event seam', async () => {
    const controller = new AbortController();
    let listener: RuntimeEventListener | undefined;
    const dispose = vi.fn();
    const handle = vi.fn(async () => [event(1)]);
    const subscribeRunEvents = vi.fn((_runId: string, next: RuntimeEventListener) => {
      listener = next;
      return { dispose };
    });
    const factory = vi.fn<RuntimeFacadeFactory>(async () => ({ handle, subscribeRunEvents }));
    const response = asStream(
      await handleRuntimeSseRequest(
        request('/api/runtime/v1/runs/run-sse/events?request_id=live-4', {
          signal: controller.signal,
        }),
        { userId: 'user-sse', serverDB: 'db-sse' },
        factory,
        { heartbeatIntervalMs: 1000 },
      ),
    );
    const reader = response.body.getReader();

    await readText(reader);
    listener?.(event(2));
    await expect(readText(reader)).resolves.toContain('id: 2\n');
    controller.abort();
    await expect(reader.read()).resolves.toMatchObject({ done: true });
    expect(subscribeRunEvents).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('unsubscribes when the reader is cancelled and ignores later callbacks', async () => {
    let listener: RuntimeEventListener | undefined;
    const unsubscribe = vi.fn();
    const handle = vi.fn(async () => [event(1)]);
    const subscribe = vi.fn((_runId: string, next: RuntimeEventListener) => {
      listener = next;
      return unsubscribe;
    });
    const factory = vi.fn<RuntimeFacadeFactory>(async () => ({ handle, subscribe }));
    const response = asStream(
      await handleRuntimeSseRequest(
        request('/api/runtime/v1/runs/run-sse/events?request_id=live-5'),
        { userId: 'user-sse', serverDB: 'db-sse' },
        factory,
        { heartbeatIntervalMs: 1000 },
      ),
    );
    const reader = response.body.getReader();

    await readText(reader);
    await reader.cancel();
    listener?.(event(2));
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('keeps a facade without subscription capability replay-only', async () => {
    const controller = new AbortController();
    const { factory, handle } = facadeFor([event(1)]);
    const response = asStream(
      await handleRuntimeSseRequest(
        request('/api/runtime/v1/runs/run-sse/events?request_id=live-6', {
          signal: controller.signal,
        }),
        { userId: 'user-sse', serverDB: 'db-sse' },
        factory,
        { heartbeatIntervalMs: 1000 },
      ),
    );
    const reader = response.body.getReader();

    await expect(readText(reader)).resolves.toContain('id: 1\n');
    controller.abort();
    await expect(reader.read()).resolves.toMatchObject({ done: true });
    expect(handle).toHaveBeenCalledOnce();
  });

  it('keeps strict sequence filtering when a subscriber emits synchronously', async () => {
    const controller = new AbortController();
    const handle = vi.fn(async () => [event(1)]);
    const subscribe = vi.fn((_runId: string, listener: RuntimeEventListener) => {
      listener(event(2));
      listener(event(2));
      listener(event(1));
      return () => {};
    });
    const factory = vi.fn<RuntimeFacadeFactory>(async () => ({ handle, subscribe }));
    const response = asStream(
      await handleRuntimeSseRequest(
        request('/api/runtime/v1/runs/run-sse/events?request_id=live-7', {
          signal: controller.signal,
        }),
        { userId: 'user-sse', serverDB: 'db-sse' },
        factory,
        { heartbeatIntervalMs: 1000 },
      ),
    );
    const reader = response.body.getReader();

    expect(await readText(reader)).toContain('id: 1\n');
    expect(await readText(reader)).toContain('id: 2\n');
    controller.abort();
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });

  it('streams events appended through the kernel facade EventJournal bridge', async () => {
    const controller = new AbortController();
    const facade = new InMemoryRuntimeFacade();
    facade.eventJournal.append('run-kernel-live', event(1, 'run-kernel-live'));
    const factory = vi.fn<RuntimeFacadeFactory>(async () => facade);
    const response = asStream(
      await handleRuntimeSseRequest(
        request('/api/runtime/v1/runs/run-kernel-live/events?request_id=kernel-live', {
          signal: controller.signal,
        }),
        { userId: 'user-kernel', serverDB: 'db-kernel' },
        factory,
        { heartbeatIntervalMs: 1000 },
      ),
    );
    const reader = response.body.getReader();

    expect(await readText(reader)).toContain('id: 1\n');
    facade.eventJournal.append('run-kernel-live', event(2, 'run-kernel-live'));
    expect(await readText(reader)).toContain('id: 2\n');

    controller.abort();
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });
});
