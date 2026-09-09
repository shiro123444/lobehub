import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type {
  PresentationJob,
  PresentationJobInput,
} from '../../../../packages/runtime-contracts/src/index';
import { type PresentationJobEvent, RuntimeClientImpl } from '../../../services/runtime/client';
import { useJobPolling } from '../hooks/useJobPolling';
import {
  createPresentationStudioStore,
  type PresentationStreamClient,
  type PresentationStudioStoreHook,
  toPresentationError,
} from './presentationStore';

const input = (): PresentationJobInput => ({
  notebookId: 'studio',
  sourceVersionIds: ['src-1'],
  title: 'Real wiring deck',
});

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const textResponse = (status: number, text: string): Response => new Response(text, { status });

const queuedJob = (jobId = 'job-http'): PresentationJob => ({
  createdAt: '2026-08-30T10:00:00.000Z',
  jobId,
  state: 'queued',
  updatedAt: '2026-08-30T10:00:00.000Z',
});

const StreamHarness = ({
  store,
  options = {},
}: {
  store: PresentationStudioStoreHook;
  options?: Parameters<typeof useJobPolling>[1];
}) => {
  useJobPolling(store, { pollIntervalMs: 40, ...options });
  return null;
};

describe('C-60 real RuntimeClient wiring', () => {
  it('drives create/cancel/retry/query/export through the real RuntimeClientImpl endpoints', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url);
      if (href === '/api/runtime/presentation/jobs' && init?.method === 'POST') {
        return jsonResponse(200, queuedJob());
      }
      if (href === '/api/runtime/presentation/jobs/job-http/cancel' && init?.method === 'POST') {
        return jsonResponse(200, { ...queuedJob('job-http'), state: 'cancelled' });
      }
      if (href === '/api/runtime/presentation/jobs/job-http/retry' && init?.method === 'POST') {
        return jsonResponse(200, queuedJob());
      }
      if (href === '/api/runtime/presentation/artifacts/art-1' && init?.method === 'GET') {
        return jsonResponse(200, {
          artifactId: 'art-1',
          createdAt: '2026-08-30T10:01:00.000Z',
          status: 'ready',
          type: 'svg',
        });
      }
      if (href === '/api/runtime/presentation/artifacts/export' && init?.method === 'POST') {
        return jsonResponse(200, {
          artifactId: 'art-1',
          format: 'pptx',
          uri: 'https://files.example/art-1.pptx',
        });
      }
      return textResponse(404, 'not found');
    });

    const client = new RuntimeClientImpl({ fetcher });
    const store = createPresentationStudioStore(client);

    // create
    const jobId = await store.getState().createJob(input());
    expect(jobId).toBe('job-http');
    const createCall = fetcher.mock.calls.find(([url]) =>
      String(url).endsWith('/presentation/jobs'),
    );
    expect(createCall?.[1]?.method).toBe('POST');
    expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({ title: 'Real wiring deck' });

    // query / refresh
    await store.getState().refreshJob('job-http');
    expect(store.getState().jobs['job-http']).toBeTruthy();

    // cancel
    await store.getState().cancelJob('job-http');
    expect(store.getState().jobs['job-http'].state).toBe('cancelled');

    // retry
    await store.getState().retryJob('job-http');
    expect(store.getState().jobs['job-http'].state).toBe('queued');

    // export
    await store.getState().exportArtifact('art-1', 'pptx');
    expect(store.getState().exported?.format).toBe('pptx');
    const exportCall = fetcher.mock.calls.find(([url]) =>
      String(url).endsWith('/artifacts/export'),
    );
    expect(JSON.parse(String(exportCall?.[1]?.body))).toEqual({
      artifactId: 'art-1',
      format: 'pptx',
    });
  });

  it('maps 404 to null honestly instead of fabricating a job', async () => {
    const fetcher = vi.fn(async () => textResponse(404, 'not found'));
    const store = createPresentationStudioStore(new RuntimeClientImpl({ fetcher }));

    await store.getState().refreshJob('missing-job');

    expect(Object.keys(store.getState().jobs)).toHaveLength(0);
    expect(store.getState().clientError).toBeNull();
  });

  it('surfaces structured provider errors from JSON bodies', async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse(503, {
        error: { code: 'PROVIDER_UNAVAILABLE', message: 'PPT Master is not configured' },
      }),
    );
    const store = createPresentationStudioStore(new RuntimeClientImpl({ fetcher }));

    const jobId = await store.getState().createJob(input());

    expect(jobId).toBeNull();
    expect(store.getState().clientError).toEqual({
      code: 'PROVIDER_UNAVAILABLE',
      message: 'PPT Master is not configured',
    });
  });

  it('parses `CODE: message` and plain errors into structured info', () => {
    expect(toPresentationError(new Error('HTTP 409 INVALID_TRANSITION: already terminal'))).toEqual(
      {
        code: 'INVALID_TRANSITION',
        message: 'already terminal',
      },
    );
    expect(toPresentationError(new Error('network down'))).toEqual({
      code: 'RUNTIME_ERROR',
      message: 'network down',
    });
  });
});

describe('C-60 frozen job event stream semantics', () => {
  it('applyPresentationEvent upserts job snapshots, artifacts and dedupes by seq', () => {
    const store = createPresentationStudioStore();

    const runningJob = { ...queuedJob('job-ev'), state: 'running' as const };
    store.getState().applyPresentationEvent({
      data: runningJob,
      job_id: 'job-ev',
      protocol_version: 'runtime.v1',
      seq: 1,
      type: 'job',
    });

    expect(store.getState().jobs['job-ev'].state).toBe('running');
    expect(store.getState().lastSeqByJob['job-ev']).toBe(1);

    // artifact event
    store.getState().applyPresentationEvent({
      data: {
        artifactId: 'art-9',
        createdAt: '2026-08-30T10:00:00.000Z',
        status: 'ready',
        type: 'svg',
      },
      job_id: 'job-ev',
      protocol_version: 'runtime.v1',
      seq: 2,
      type: 'artifact',
    });
    expect(store.getState().artifacts['art-9'].status).toBe('ready');
    expect(store.getState().lastSeqByJob['job-ev']).toBe(2);

    // replay of seq 2 is idempotent
    store.getState().applyPresentationEvent({
      data: {
        artifactId: 'art-9-old',
        createdAt: '2026-08-30T10:00:00.000Z',
        status: 'pending',
        type: 'svg',
      },
      job_id: 'job-ev',
      protocol_version: 'runtime.v1',
      seq: 2,
      type: 'artifact',
    });
    expect(store.getState().artifacts['art-9-old']).toBeUndefined();
    expect(store.getState().lastSeqByJob['job-ev']).toBe(2);
  });

  it('streams events through subscribePresentationJob instead of polling and resumes from last seq', async () => {
    vi.useFakeTimers();

    const getPresentationJob = vi.fn();
    const subscribePresentationJob = vi.fn((jobId: string, _options?: { afterSeq?: number }) => {
      const events: PresentationJobEvent[] = [
        {
          data: { ...queuedJob(jobId), state: 'running' },
          job_id: jobId,
          protocol_version: 'runtime.v1',
          seq: 1,
          type: 'job',
        },
      ];
      return (async function* () {
        for (const event of events) {
          yield event;
          // Keep the stream open (until aborted) so polling stays dormant.
          await new Promise<void>(() => undefined);
        }
      })();
    });

    const client: PresentationStreamClient = {
      createPresentationJob: vi.fn(),
      getPresentationJob,
      cancelPresentationJob: vi.fn(),
      retryPresentationJob: vi.fn(),
      getArtifact: vi.fn(),
      exportArtifact: vi.fn(),
      subscribePresentationJob,
    };
    const store = createPresentationStudioStore(client);
    store.setState({
      jobs: { 'job-ev': queuedJob('job-ev') },
      jobOrder: ['job-ev'],
      selectedJobId: 'job-ev',
    });

    render(<StreamHarness store={store} />);

    await vi.advanceTimersByTimeAsync(50);

    expect(subscribePresentationJob).toHaveBeenCalledWith(
      'job-ev',
      expect.objectContaining({ afterSeq: 0, signal: expect.any(AbortSignal) }),
    );
    expect(subscribePresentationJob.mock.calls[0][1]?.afterSeq).toBe(0);
    expect(store.getState().jobs['job-ev'].state).toBe('running');
    expect(store.getState().lastSeqByJob['job-ev']).toBe(1);
    expect(getPresentationJob).not.toHaveBeenCalled();
    expect(store.getState().streamStatus).toBe('live');

    vi.useRealTimers();
  });

  it('degrades to polling when the stream seam is absent and preserves last seq', async () => {
    vi.useFakeTimers();

    const getPresentationJob = vi.fn(async () => ({
      ...queuedJob('job-pp'),
      state: 'running' as const,
    }));
    const client: PresentationStreamClient = {
      createPresentationJob: vi.fn(),
      getPresentationJob,
      cancelPresentationJob: vi.fn(),
      retryPresentationJob: vi.fn(),
      getArtifact: vi.fn(),
      exportArtifact: vi.fn(),
    };
    const store = createPresentationStudioStore(client);
    store.setState({
      jobs: { 'job-pp': queuedJob('job-pp') },
      jobOrder: ['job-pp'],
      selectedJobId: 'job-pp',
    });

    render(<StreamHarness store={store} />);

    await vi.advanceTimersByTimeAsync(60);

    expect(getPresentationJob).toHaveBeenCalledWith('job-pp');
    expect(store.getState().streamStatus).toBe('polling');
    // Nothing was received from a stream: the resume baseline stays at 0.
    expect(store.getState().lastSeqByJob['job-pp'] ?? 0).toBe(0);

    vi.useRealTimers();
  });

  it('falls back to polling after the stream ends without faking a completion', async () => {
    vi.useFakeTimers();

    const subscribePresentationJob = vi.fn(() => (async function* () {})());
    const getPresentationJob = vi.fn(async () => ({
      ...queuedJob('job-ev'),
      state: 'running' as const,
    }));
    const client: PresentationStreamClient = {
      createPresentationJob: vi.fn(),
      getPresentationJob,
      cancelPresentationJob: vi.fn(),
      retryPresentationJob: vi.fn(),
      getArtifact: vi.fn(),
      exportArtifact: vi.fn(),
      subscribePresentationJob,
    };
    const store = createPresentationStudioStore(client);
    store.setState({
      jobs: { 'job-ev': queuedJob('job-ev') },
      jobOrder: ['job-ev'],
      selectedJobId: 'job-ev',
    });

    // Reconnect budget off: the instant stream end must degrade to polling.
    render(<StreamHarness options={{ maxReconnectAttempts: 0 }} store={store} />);

    await vi.advanceTimersByTimeAsync(60);

    expect(subscribePresentationJob).toHaveBeenCalled();
    // Stream ended → polling fallback keeps the job fresh and honest
    expect(getPresentationJob).toHaveBeenCalledWith('job-ev');
    expect(store.getState().jobs['job-ev'].state).toBe('running');
    expect(store.getState().streamStatus).toBe('polling');

    vi.useRealTimers();
  });
});
