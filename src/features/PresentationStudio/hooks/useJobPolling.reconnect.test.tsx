import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PresentationJob } from '../../../../packages/runtime-contracts/src/index';
import type { PresentationJobEvent } from '../../../services/runtime/client';
import type {
  PresentationStreamClient,
  PresentationStudioStoreHook,
} from '../store/presentationStore';
import { createPresentationStudioStore } from '../store/presentationStore';
import { useJobPolling } from './useJobPolling';

const t0 = '2026-08-30T10:00:00.000Z';

const queuedJob = (jobId: string): PresentationJob => ({
  createdAt: t0,
  jobId,
  state: 'queued',
  updatedAt: t0,
});

const jobEvent = (jobId: string, seq: number, state = 'running'): PresentationJobEvent => ({
  data: { ...queuedJob(jobId), state },
  job_id: jobId,
  protocol_version: 'runtime.v1',
  seq,
  type: 'job',
});

const baseClient = (overrides: Partial<PresentationStreamClient>): PresentationStreamClient => ({
  createPresentationJob: vi.fn(),
  getPresentationJob: vi.fn(async () => null),
  cancelPresentationJob: vi.fn(),
  retryPresentationJob: vi.fn(),
  getArtifact: vi.fn(),
  exportArtifact: vi.fn(),
  ...overrides,
});

const Harness = ({
  store,
  options,
}: {
  store: PresentationStudioStoreHook;
  options: Parameters<typeof useJobPolling>[1];
}) => {
  useJobPolling(store, { pollIntervalMs: 10 ** 9, ...options });
  return null;
};

const seedStore = (store: PresentationStudioStoreHook) => {
  store.setState({
    jobs: { 'job-ev': queuedJob('job-ev') },
    jobOrder: ['job-ev'],
    selectedJobId: 'job-ev',
  });
};

describe('PresentationStudio SSE reconnect backoff (C-64)', () => {
  it('reconnects with increasing afterSeq after a break and recovers to live', async () => {
    let calls = 0;
    let closeFirst: () => void = () => undefined;
    const firstClosed = new Promise<void>((resolve) => {
      closeFirst = resolve;
    });
    const subscribe = vi.fn((jobId: string, _options?: { afterSeq?: number }) => {
      calls += 1;
      if (calls === 1) {
        // First stream: one event, then stays open until we close it.
        return (async function* () {
          yield jobEvent(jobId, 1);
          await firstClosed;
        })();
      }
      // Recovery stream: one event, then stays open until aborted.
      return (async function* () {
        yield jobEvent(jobId, 2);
        await new Promise<void>(() => undefined);
      })();
    });
    const store = createPresentationStudioStore(
      baseClient({ subscribePresentationJob: subscribe }),
    );
    seedStore(store);

    const waits: { delay: number; signal: AbortSignal; resolve: () => void }[] = [];
    const wait = (delay: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        waits.push({ delay, signal, resolve });
      });

    const { unmount } = render(<Harness options={{ wait }} store={store} />);

    // First stream serves seq 1 from afterSeq 0.
    await waitFor(() => expect(store.getState().lastSeqByJob['job-ev']).toBe(1));
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe.mock.calls[0][1]).toMatchObject({ afterSeq: 0 });
    expect(store.getState().streamStatus).toBe('live');

    // Stream closed → reconnecting with the backoff wait pending.
    closeFirst();
    await new Promise((r) => setTimeout(r, 10));
    expect(waits).toHaveLength(1);
    expect(waits[0].delay).toBe(1000);
    expect(store.getState().streamStatus).toBe('reconnecting');

    // Resume the wait → second attempt resumes from lastSeqByJob.
    waits[0].resolve();
    await waitFor(() => expect(store.getState().lastSeqByJob['job-ev']).toBe(2));
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(subscribe.mock.calls[1][1]).toMatchObject({ afterSeq: 1 });
    expect(store.getState().streamStatus).toBe('live');

    unmount();
  });

  it('records exponential backoff delays and degrades to polling after the budget', async () => {
    let calls = 0;
    const subscribe = vi.fn((jobId: string, _options?: { afterSeq?: number }) => {
      calls += 1;
      const seq = calls;
      return (async function* () {
        yield jobEvent(jobId, seq);
      })();
    });
    const getPresentationJob = vi.fn(async () => ({
      ...queuedJob('job-ev'),
      state: 'running' as const,
    }));
    const store = createPresentationStudioStore(
      baseClient({ subscribePresentationJob: subscribe, getPresentationJob }),
    );
    seedStore(store);

    const wait = vi.fn(async (_delay: number) => undefined);
    const { unmount } = render(
      <Harness
        options={{ wait, maxReconnectAttempts: 3, backoffBaseMs: 250, pollIntervalMs: 20 }}
        store={store}
      />,
    );

    await new Promise((r) => setTimeout(r, 40));

    // Initial attempt + 3 reconnect attempts
    expect(subscribe).toHaveBeenCalledTimes(4);
    // afterSeq grows with each reconnect attempt
    expect(subscribe.mock.calls.map(([, options]) => options?.afterSeq)).toEqual([0, 1, 2, 3]);
    // exponential delays 250 → 500 → 1000
    expect(wait.mock.calls.map(([delay]) => delay)).toEqual([250, 500, 1000]);
    // budget exhausted → polling, and the poll loop takes over
    expect(store.getState().streamStatus).toBe('polling');
    await new Promise((r) => setTimeout(r, 20));
    expect(getPresentationJob).toHaveBeenCalledWith('job-ev');
    // Nothing is fabricated: no terminal state, seqs preserved.
    expect(store.getState().jobs['job-ev'].state).toBe('running');
    expect(store.getState().lastSeqByJob['job-ev']).toBe(4);
    // No further reconnect attempts after the budget.
    expect(subscribe).toHaveBeenCalledTimes(4);

    unmount();
  });

  it('degrades straight to polling on an unrecoverable protocol error', async () => {
    const subscribe = vi.fn((_jobId: string) => {
      throw new Error('[RuntimeClient] Presentation SSE: invalid event shape for job job-ev');
    });
    const getPresentationJob = vi.fn(async () => ({
      ...queuedJob('job-ev'),
      state: 'running' as const,
    }));
    const store = createPresentationStudioStore(
      baseClient({ subscribePresentationJob: subscribe, getPresentationJob }),
    );
    seedStore(store);

    const { unmount } = render(
      <Harness
        options={{ wait: vi.fn(async () => undefined), pollIntervalMs: 20 }}
        store={store}
      />,
    );

    await new Promise((r) => setTimeout(r, 40));

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(store.getState().streamStatus).toBe('polling');
    expect(getPresentationJob).toHaveBeenCalledWith('job-ev');
    expect(store.getState().jobs['job-ev'].state).toBe('running');

    unmount();
  });

  it('cancels the pending backoff wait on unmount and allows no further attempts', async () => {
    const subscribe = vi.fn((jobId: string) =>
      (async function* () {
        yield jobEvent(jobId, 1);
      })(),
    );
    const store = createPresentationStudioStore(
      baseClient({ subscribePresentationJob: subscribe }),
    );
    seedStore(store);

    const capturedSignals: AbortSignal[] = [];
    const wait = (_delay: number, signal: AbortSignal) =>
      new Promise<void>((_, reject) => {
        capturedSignals.push(signal);
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
          once: true,
        });
      });

    const { unmount } = render(<Harness options={{ wait }} store={store} />);

    await new Promise((r) => setTimeout(r, 10));
    expect(capturedSignals).toHaveLength(1);
    expect(store.getState().streamStatus).toBe('reconnecting');
    expect(subscribe).toHaveBeenCalledTimes(1);

    unmount();

    expect(capturedSignals[0].aborted).toBe(true);
    // No attempts after cancel — the leaked wait would have reconnected.
    await new Promise((r) => setTimeout(r, 20));
    expect(subscribe).toHaveBeenCalledTimes(1);
  });
});
