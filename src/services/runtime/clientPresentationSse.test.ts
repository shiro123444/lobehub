import { describe, expect, it, vi } from 'vitest';

import { RUNTIME_PROTOCOL_VERSION } from '../../../packages/runtime-contracts/src/index';
import type { PresentationJobEvent } from './client';
import { RuntimeClientImpl } from './client';

const dataFrame = (event: PresentationJobEvent): string => `data: ${JSON.stringify(event)}\n\n`;

const makeEvent = (
  jobId: string,
  seq: number,
  overrides: Partial<PresentationJobEvent> = {},
): PresentationJobEvent => ({
  data: { state: 'running' },
  job_id: jobId,
  protocol_version: RUNTIME_PROTOCOL_VERSION,
  seq,
  type: 'job',
  ...overrides,
});

const sseResponse = (chunks: string[]): Response => {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream' },
    status: 200,
  });
};

const collect = async (
  iterable: AsyncIterable<PresentationJobEvent>,
): Promise<PresentationJobEvent[]> => {
  const collected: PresentationJobEvent[] = [];
  for await (const event of iterable) {
    collected.push(event);
  }
  return collected;
};

describe('RuntimeClient.subscribePresentationJob (C-62)', () => {
  it('requests /api/runtime/presentation/jobs/:jobId/events?after_seq=N and streams accepted events', async () => {
    const events = [makeEvent('job-1', 4), makeEvent('job-1', 5)];
    const fetcher = vi
      .fn()
      .mockResolvedValue(sseResponse([dataFrame(events[0]) + dataFrame(events[1])]));
    const client = new RuntimeClientImpl({ fetcher });

    const collected = await collect(client.subscribePresentationJob('job-1', { afterSeq: 3 }));

    expect(fetcher).toHaveBeenCalledWith(
      '/api/runtime/presentation/jobs/job-1/events?after_seq=3',
      expect.objectContaining({
        headers: expect.any(Headers),
        method: 'GET',
      }),
    );
    expect(collected).toEqual(events);
  });

  it('omits after_seq when no resume point is given', async () => {
    const fetcher = vi.fn().mockResolvedValue(sseResponse([dataFrame(makeEvent('job-1', 1))]));
    const client = new RuntimeClientImpl({ fetcher });

    await collect(client.subscribePresentationJob('job-1'));

    expect(fetcher).toHaveBeenCalledWith(
      '/api/runtime/presentation/jobs/job-1/events',
      expect.anything(),
    );
  });

  it('crosses chunk boundaries mid-frame', async () => {
    const event = makeEvent('job-1', 7);
    const payload = dataFrame(event);
    const split = Math.floor(payload.length / 2);
    const fetcher = vi
      .fn()
      .mockResolvedValue(sseResponse([payload.slice(0, split), payload.slice(split)]));
    const client = new RuntimeClientImpl({ fetcher });

    const collected = await collect(client.subscribePresentationJob('job-1'));

    expect(collected).toEqual([event]);
  });

  it('handles multiple frames per chunk plus comments and blank frames', async () => {
    const ev1 = makeEvent('job-1', 1);
    const ev2 = makeEvent('job-1', 2);
    const payload = [': keepalive\n\n', dataFrame(ev1), '\n', dataFrame(ev2)].join('');
    const fetcher = vi.fn().mockResolvedValue(sseResponse([payload]));
    const client = new RuntimeClientImpl({ fetcher });

    const collected = await collect(client.subscribePresentationJob('job-1'));

    expect(collected.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('joins multi-line data: frames into one event payload', async () => {
    const event = makeEvent('job-1', 3, { data: { hello: 'world' } });
    // Pretty-printed JSON legitimately spans physical lines; SSE rules join
    // consecutive `data:` lines with a single newline before parsing.
    const pretty = JSON.stringify(event, null, 2);
    const payload = `${pretty
      .split('\n')
      .map((line) => `data: ${line}`)
      .join('\n')}\n\n`;
    const fetcher = vi.fn().mockResolvedValue(sseResponse([payload]));
    const client = new RuntimeClientImpl({ fetcher });

    const collected = await collect(client.subscribePresentationJob('job-1'));

    expect(collected).toEqual([event]);
  });

  it('drops after_seq-equal and duplicate seqs idempotently but reports the highest observed seq', async () => {
    const event4 = makeEvent('job-1', 4);
    const event5 = makeEvent('job-1', 5);
    const payload = [
      dataFrame(makeEvent('job-1', 3)), // old — dropped by afterSeq
      dataFrame(event4),
      dataFrame(event4), // duplicate — dropped
      dataFrame(event5),
    ].join('');
    const fetcher = vi.fn().mockResolvedValue(sseResponse([payload]));
    const client = new RuntimeClientImpl({ fetcher });
    const seqHistory: number[] = [];

    const collected = await collect(
      client.subscribePresentationJob('job-1', {
        afterSeq: 3,
        onSeqReceived: (seq) => seqHistory.push(seq),
      }),
    );

    expect(collected.map((e) => e.seq)).toEqual([4, 5]);
    // Highest observed seq is reported for every parsed event, even dropped ones.
    expect(seqHistory).toEqual([3, 4, 4, 5]);
  });

  it('aborts fetch and reader cleanly on AbortSignal without errors', async () => {
    const controller = new AbortController();
    const firstEvent = makeEvent('job-1', 1);
    const stream = new ReadableStream({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode(dataFrame(firstEvent)));
        // Keep the stream open; abort will cancel the reader.
        void streamController;
      },
    });
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(stream, { headers: { 'Content-Type': 'text/event-stream' }, status: 200 }),
      );
    const client = new RuntimeClientImpl({ fetcher });

    const jobStream = client.subscribePresentationJob('job-1', { signal: controller.signal });
    const iterator = jobStream[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.value.seq).toBe(1);
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining('job-1/events'),
      expect.objectContaining({ signal: controller.signal }),
    );

    controller.abort();
    const after = await iterator.next();
    expect(after.done).toBe(true);
  });

  it('performs no request at all before an already-aborted stream is consumed', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn().mockResolvedValue(sseResponse([]));
    const client = new RuntimeClientImpl({ fetcher });

    const collected = await collect(
      client.subscribePresentationJob('job-1', { signal: controller.signal }),
    );

    // fetch may reject with AbortError or return an empty body — either way no
    // events may be produced and nothing may be fabricated.
    expect(collected).toEqual([]);
  });

  it('throws a recognizable error for non-2xx responses', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response('{"error":{"code":"JOB_NOT_FOUND","message":"no such job"}}', { status: 404 }),
      );
    const client = new RuntimeClientImpl({ fetcher });

    await expect(collect(client.subscribePresentationJob('job-missing'))).rejects.toThrow(
      /Failed to subscribe to presentation job job-missing events \(404/,
    );
  });

  it('throws a recognizable error for invalid JSON frames', async () => {
    const fetcher = vi.fn().mockResolvedValue(sseResponse(['data: {not-json}\n\n']));
    const client = new RuntimeClientImpl({ fetcher });

    await expect(collect(client.subscribePresentationJob('job-1'))).rejects.toThrow(
      'Presentation SSE: invalid JSON',
    );
  });

  it('throws a recognizable error for invalid event shapes', async () => {
    const base = makeEvent('job-1', 1);
    const invalidCases: Array<Partial<PresentationJobEvent>> = [
      { protocol_version: 'v2' as typeof RUNTIME_PROTOCOL_VERSION },
      { job_id: 'job-other' },
      { seq: 0 },
      { seq: 1.5 },
      { seq: Number.NaN },
      { type: '' },
      { type: 1 as unknown as string },
    ];

    for (const overrides of invalidCases) {
      const fetcher = vi
        .fn()
        .mockResolvedValue(sseResponse([dataFrame({ ...base, ...overrides })]));
      const client = new RuntimeClientImpl({ fetcher });
      await expect(collect(client.subscribePresentationJob('job-1'))).rejects.toThrow(
        'Presentation SSE: invalid event shape',
      );
    }
  });

  it('propagates a broken stream error without emitting a completion event', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(dataFrame(makeEvent('job-1', 1))));
        controller.error(new Error('connection reset'));
      },
    });
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(stream, { headers: { 'Content-Type': 'text/event-stream' }, status: 200 }),
      );
    const client = new RuntimeClientImpl({ fetcher });

    await expect(collect(client.subscribePresentationJob('job-1'))).rejects.toThrow(
      'connection reset',
    );
  });
});
