import { describe, expect, it, vi } from 'vitest';

import { createPresentationJobEventSseResponse, serializePresentationJobEvent } from './sse';
import type { PresentationJobEvent } from './job-event-journal';

const event = (jobId: string, seq: number, data: unknown = seq): PresentationJobEvent => ({
  data,
  job_id: jobId,
  protocol_version: 'runtime.v1',
  seq,
  type: 'presentation.job.updated',
});

const readChunk = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> => {
  const result = await reader.read();
  return new TextDecoder().decode(result.value);
};

describe('Presentation job SSE serializer', () => {
  it('serializes only the strict C-60 event fields with id and data frames', () => {
    const value = serializePresentationJobEvent({
      ...event('job-1', 3, { state: 'running' }),
      internal: 'hidden',
    } as PresentationJobEvent & { internal: string });

    expect(value).toBe(
      'id: 3\ndata: {"protocol_version":"runtime.v1","type":"presentation.job.updated","job_id":"job-1","seq":3,"data":{"state":"running"}}\n\n',
    );
  });

  it('rejects invalid protocol, missing data, and non-serializable event data', () => {
    expect(() =>
      serializePresentationJobEvent({
        ...event('job-1', 1),
        protocol_version: 'runtime.v2',
      } as never),
    ).toThrow(expect.objectContaining({ code: 'PRESENTATION_EVENT_INVALID' }));
    expect(() =>
      serializePresentationJobEvent({ ...event('job-1', 1), data: undefined } as never),
    ).toThrow(expect.objectContaining({ code: 'PRESENTATION_EVENT_INVALID' }));
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => serializePresentationJobEvent(event('job-1', 1, circular))).toThrow(
      expect.objectContaining({ code: 'PRESENTATION_EVENT_INVALID' }),
    );
  });

  it('replays after afterSeq and exposes text/event-stream headers', async () => {
    const controller = new AbortController();
    const response = createPresentationJobEventSseResponse(
      [event('job-2', 1), event('job-2', 2)],
      controller.signal,
      { heartbeatIntervalMs: 60_000 },
      1,
    );
    const reader = response.body.getReader();

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream');
    expect(await readChunk(reader)).toContain('"seq":2');
    controller.abort();
    await reader.cancel();
  });

  it('sends replay before live events even when live arrives during subscription', async () => {
    const controller = new AbortController();
    let notify: ((value: PresentationJobEvent) => void) | undefined;
    const response = createPresentationJobEventSseResponse([event('job-3', 1)], controller.signal, {
      heartbeatIntervalMs: 60_000,
      subscribe: (listener) => {
        notify = listener;
        listener(event('job-3', 2, 'live-during-replay'));
        return () => {};
      },
    });
    const reader = response.body.getReader();

    expect(await readChunk(reader)).toContain('"seq":1');
    expect(await readChunk(reader)).toContain('"seq":2');
    expect(notify).toBeTypeOf('function');
    controller.abort();
    await reader.cancel();
  });

  it('deduplicates live events and keeps sequence output increasing', async () => {
    const controller = new AbortController();
    let notify: ((value: PresentationJobEvent) => void) | undefined;
    const response = createPresentationJobEventSseResponse([], controller.signal, {
      heartbeatIntervalMs: 60_000,
      subscribe: (listener) => {
        notify = listener;
        return () => {};
      },
    });
    const reader = response.body.getReader();
    notify!(event('job-4', 1));
    notify!(event('job-4', 1, 'duplicate'));
    notify!(event('job-4', 2));

    expect(await readChunk(reader)).toContain('"seq":1');
    expect(await readChunk(reader)).toContain('"seq":2');
    controller.abort();
    await reader.cancel();
  });

  it('unsubscribes on AbortSignal without cancelling the producer', async () => {
    const controller = new AbortController();
    const unsubscribe = vi.fn();
    let notify: ((value: PresentationJobEvent) => void) | undefined;
    const response = createPresentationJobEventSseResponse([], controller.signal, {
      heartbeatIntervalMs: 60_000,
      subscribe: (listener) => {
        notify = listener;
        return unsubscribe;
      },
    });
    const reader = response.body.getReader();
    controller.abort();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    notify?.(event('job-5', 1));
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });

  it('supports replay-only mode and heartbeat comments', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const response = createPresentationJobEventSseResponse(
        [event('job-6', 1)],
        controller.signal,
        { heartbeatIntervalMs: 10 },
      );
      const reader = response.body.getReader();
      expect(await readChunk(reader)).toContain('"seq":1');
      vi.advanceTimersByTime(10);
      await expect(readChunk(reader)).resolves.toContain(': heartbeat');
      controller.abort();
      await reader.cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses an injected serializer once per emitted replay event', async () => {
    const controller = new AbortController();
    const serializer = vi.fn((value: PresentationJobEvent) => `data: ${value.seq}\n\n`);
    const response = createPresentationJobEventSseResponse([event('job-7', 1)], controller.signal, {
      heartbeatIntervalMs: 60_000,
      serializer,
    });
    const reader = response.body.getReader();

    expect(await readChunk(reader)).toBe('data: 1\n\n');
    expect(serializer).toHaveBeenCalledTimes(1);
    controller.abort();
    await reader.cancel();
  });

  it('rejects invalid replay sequence ordering before returning a stream', () => {
    expect(() =>
      createPresentationJobEventSseResponse(
        [event('job-8', 2), event('job-8', 1)],
        new AbortController().signal,
      ),
    ).toThrow(expect.objectContaining({ code: 'PRESENTATION_EVENT_INVALID' }));
  });
});
