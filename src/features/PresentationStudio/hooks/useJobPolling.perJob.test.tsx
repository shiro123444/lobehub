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

const jobStreamClient = (handlers: {
  byJob: (jobId: string, options?: { afterSeq?: number }) => ReturnType<typeof vi.fn>;
  getPresentationJob?: (jobId: string) => Promise<PresentationJob | null>;
}): PresentationStreamClient => ({
  createPresentationJob: vi.fn(),
  getPresentationJob:
    handlers.getPresentationJob ??
    vi.fn(async (jobId: string) => ({ ...queuedJob(jobId), state: 'running' as const })),
  cancelPresentationJob: vi.fn(),
  retryPresentationJob: vi.fn(),
  getArtifact: vi.fn(),
  exportArtifact: vi.fn(),
  subscribePresentationJob: (jobId: string, options?: { afterSeq?: number }) =>
    handlers.byJob(jobId)(jobId, options),
});

const Harness = ({
  store,
  options,
}: {
  store: PresentationStudioStoreHook;
  options?: Parameters<typeof useJobPolling>[1];
}) => {
  useJobPolling(store, { pollIntervalMs: 10 ** 9, ...options });
  return null;
};

const seedTwo = (store: PresentationStudioStoreHook) => {
  store.setState({
    jobs: { 'job-a': queuedJob('job-a'), 'job-b': queuedJob('job-b') },
    jobOrder: ['job-a', 'job-b'],
    selectedJobId: 'job-a',
  });
};

describe('PresentationStudio per-job stream status (C-66)', () => {
  it('keeps a degraded job and a live job isolated: polling does not erase live', async () => {
    const subscribeA = vi.fn((jobId: string) =>
      (async function* () {
        yield jobEvent(jobId, 1);
        await new Promise<void>(() => undefined); // stays open until aborted
      })(),
    );
    const subscribeB = vi.fn((jobId: string) =>
      (async function* () {
        yield jobEvent(jobId, 2);
      })(),
    );
    const store = createPresentationStudioStore(
      jobStreamClient({ byJob: (jobId) => (jobId === 'job-a' ? subscribeA : subscribeB) }),
    );
    seedTwo(store);

    render(
      <Harness
        options={{ maxReconnectAttempts: 0, wait: vi.fn(async () => undefined) }}
        store={store}
      />,
    );

    await waitFor(() => {
      expect(store.getState().streamStatusByJob['job-b']).toBe('polling');
    });
    expect(store.getState().streamStatusByJob['job-a']).toBe('live');
    // Aggregate reflects live precedence and never lost it to the sibling.
    expect(store.getState().streamStatus).toBe('live');
    // seqs of both jobs are preserved — nothing was cleared or fabricated.
    expect(store.getState().lastSeqByJob['job-a']).toBe(1);
    expect(store.getState().lastSeqByJob['job-b']).toBe(2);
    expect(store.getState().jobs['job-b'].state).toBe('running');
  });

  it('keeps a live job live while its sibling reconnects with its own afterSeq', async () => {
    const subscribeA = vi.fn((jobId: string) =>
      (async function* () {
        yield jobEvent(jobId, 1);
        await new Promise<void>(() => undefined);
      })(),
    );
    let countB = 0;
    const subscribeB = vi.fn((jobId: string, _options?: { afterSeq?: number }) => {
      countB += 1;
      const seq = countB + 1;
      if (countB === 1) {
        return (async function* () {
          yield jobEvent(jobId, seq);
        })();
      }
      return (async function* () {
        yield jobEvent(jobId, seq);
        await new Promise<void>(() => undefined);
      })();
    });
    const store = createPresentationStudioStore(
      jobStreamClient({ byJob: (jobId) => (jobId === 'job-a' ? subscribeA : subscribeB) }),
    );
    seedTwo(store);

    const waits: { resolve: () => void }[] = [];
    const wait = () =>
      new Promise<void>((resolve) => {
        waits.push({ resolve });
      });

    render(<Harness options={{ wait }} store={store} />);

    // job-b broke and is mid-backoff; job-a stays live and untouched.
    await waitFor(() => {
      expect(store.getState().streamStatusByJob['job-b']).toBe('reconnecting');
    });
    expect(store.getState().streamStatusByJob['job-a']).toBe('live');
    expect(store.getState().streamStatus).toBe('live');

    // job-b reconnects from ITS OWN last seq (2), not job-a's.
    waits[0].resolve();
    await waitFor(() => {
      expect(store.getState().streamStatusByJob['job-b']).toBe('live');
    });
    expect(subscribeB.mock.calls[1][0]).toBe('job-b');
    expect(subscribeB.mock.calls[1][1]).toMatchObject({ afterSeq: 2 });
    expect(store.getState().lastSeqByJob['job-a']).toBe(1);
    expect(store.getState().streamStatus).toBe('live');
  });

  it('clears only the cancelled job status, keeping the sibling live and seqs intact', async () => {
    const subscribeA = vi.fn((jobId: string) =>
      (async function* () {
        yield jobEvent(jobId, 1);
        await new Promise<void>(() => undefined);
      })(),
    );
    const subscribeB = vi.fn((jobId: string) =>
      (async function* () {
        yield jobEvent(jobId, 2);
      })(),
    );
    const store = createPresentationStudioStore(
      jobStreamClient({ byJob: (jobId) => (jobId === 'job-a' ? subscribeA : subscribeB) }),
    );
    seedTwo(store);

    render(
      <Harness
        store={store}
        options={{
          maxReconnectAttempts: 0,
          wait: vi.fn(async () => undefined),
          pollIntervalMs: 20,
        }}
      />,
    );

    await waitFor(() => {
      expect(store.getState().streamStatusByJob['job-b']).toBe('polling');
    });

    // Simulate cancel while sibling streams: only job-b's status is cleared.
    store.setState((s) => ({
      jobs: { ...s.jobs, 'job-b': { ...s.jobs['job-b'], state: 'cancelled' } },
    }));

    await waitFor(() => {
      expect(store.getState().streamStatusByJob['job-b']).toBeUndefined();
    });
    expect(store.getState().streamStatusByJob['job-a']).toBe('live');
    expect(store.getState().streamStatus).toBe('live');
    expect(store.getState().jobs['job-b'].state).toBe('cancelled');
    expect(store.getState().lastSeqByJob['job-b']).toBe(2);
  });
});
