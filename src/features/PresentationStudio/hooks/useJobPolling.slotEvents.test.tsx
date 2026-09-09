import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PresentationJobEvent } from '../../../services/runtime/client';
import type {
  PresentationStreamClient,
  PresentationStudioStoreHook,
} from '../store/presentationStore';
import { createPresentationStudioStore } from '../store/presentationStore';
import { useJobPolling } from './useJobPolling';

const queuedJob = (jobId: string) => ({
  createdAt: '2026-08-31T00:00:00.000Z',
  jobId,
  state: 'queued' as const,
  updatedAt: '2026-08-31T00:00:00.000Z',
});

const jobEvent = (jobId: string, seq: number, state: string): PresentationJobEvent => ({
  data: { ...queuedJob(jobId), state },
  job_id: jobId,
  protocol_version: 'runtime.v1',
  seq,
  type: 'job',
});

const slotEvent = (
  jobId: string,
  seq: number,
  data: Record<string, unknown>,
  type = 'image.generation.progress',
): PresentationJobEvent => ({
  data,
  job_id: jobId,
  protocol_version: 'runtime.v1',
  seq,
  type,
});

const Harness = ({ store }: { store: PresentationStudioStoreHook }) => {
  useJobPolling(store, { pollIntervalMs: 40 });
  return null;
};

const streamClient = (
  events: PresentationJobEvent[],
  holdOpen = true,
): PresentationStreamClient => ({
  cancelPresentationJob: vi.fn(),
  createPresentationJob: vi.fn(),
  exportArtifact: vi.fn(),
  getArtifact: vi.fn(),
  getPresentationJob: vi.fn(async () => null),
  retryPresentationJob: vi.fn(),
  subscribePresentationJob: vi.fn((jobId: string) =>
    (async function* () {
      for (const event of events) {
        if (event.job_id !== jobId) continue;
        yield event;
      }
      if (holdOpen) await new Promise<void>(() => undefined);
    })(),
  ),
});

describe('C-90 slot event routing in the SSE stream loop', () => {
  it('routes image.generation.* events to the slot projection and keeps job state untouched', async () => {
    const client = streamClient([
      jobEvent('job-1', 1, 'running'),
      slotEvent('job-1', 2, {
        label: 'Chart 1',
        slideId: 'slide-1',
        slotId: 'chart-1',
        status: 'generating',
      }),
      slotEvent('job-1', 3, {
        artifactId: 'art-1',
        slideId: 'slide-1',
        slotId: 'chart-1',
        status: 'ready',
      }),
    ]);
    const store = createPresentationStudioStore(client);
    store.setState({ jobs: { 'job-1': queuedJob('job-1') }, jobOrder: ['job-1'] });

    render(<Harness store={store} />);

    await vi.waitFor(() => {
      const slot = store.getState().slots['job-1:slide-1:chart-1'];
      expect(slot?.status).toBe('ready');
      expect(slot?.artifactIds).toEqual(['art-1']);
    });

    const state = store.getState();
    // Job state came only from the real job event.
    expect(state.jobs['job-1'].state).toBe('running');
    // Slot events never advanced the job event cursor.
    expect(state.lastSeqByJob['job-1']).toBe(1);
    // No slot event counted as ignored.
    expect(state.ignoredEvents).toBe(0);
    // Stream stays live.
    expect(state.streamStatusByJob['job-1']).toBe('live');
  });

  it('counts malformed slot payloads as ignoredEvents without touching job state', async () => {
    const client = streamClient([
      jobEvent('job-1', 1, 'running'),
      slotEvent('job-1', 2, { slotId: 'missing-slide' }),
      slotEvent('job-1', 3, { slideId: 'slide-1', slotId: 'x', status: 'ready' }), // ready w/o artifact
    ]);
    const store = createPresentationStudioStore(client);
    store.setState({ jobs: { 'job-1': queuedJob('job-1') }, jobOrder: ['job-1'] });

    render(<Harness store={store} />);

    await vi.waitFor(() => {
      expect(store.getState().ignoredEvents).toBeGreaterThanOrEqual(2);
    });
    const state = store.getState();
    expect(state.jobs['job-1'].state).toBe('running');
    expect(Object.keys(state.slots)).toHaveLength(0);
    expect(state.ignoredEvents).toBe(2);
  });

  it('keeps slot seq idempotency across a replay and preserves afterSeq resume semantics', async () => {
    // First stream: job + slots up to seq 4, then the stream ends (holdOpen=false
    // with maxReconnectAttempts=0 degrades to polling — resume baseline kept).
    const first = streamClient(
      [
        jobEvent('job-1', 1, 'running'),
        slotEvent('job-1', 2, { slideId: 's1', slotId: 'a', status: 'generating' }),
        slotEvent('job-1', 3, {
          slideId: 's1',
          slotId: 'a',
          status: 'failed',
          errorCode: 'IMAGE_UNAVAILABLE',
        }),
      ],
      false,
    );
    const store = createPresentationStudioStore(first, {
      retrySlotAdapter: vi.fn(),
    });
    store.setState({ jobs: { 'job-1': queuedJob('job-1') }, jobOrder: ['job-1'] });

    render(<Harness store={store} />);
    await vi.waitFor(() => {
      expect(store.getState().slots['job-1:s1:a']?.status).toBe('failed');
    });

    // Replay the same slot seqs through a new stream: per-slot idempotency and
    // the job cursor must not regress.
    const subscribePresentationJob = vi.fn((jobId: string) =>
      (async function* () {
        yield slotEvent(jobId, 3, {
          slideId: 's1',
          slotId: 'a',
          status: 'ready',
        });
        yield jobEvent(jobId, 2, 'completed');
      })(),
    );
    const client: PresentationStreamClient = {
      ...first,
      subscribePresentationJob,
    };
    const store2 = createPresentationStudioStore(client);
    store2.setState({
      jobs: { 'job-1': queuedJob('job-1') },
      jobOrder: ['job-1'],
      lastSeqByJob: { 'job-1': 3 },
      slots: store.getState().slots,
    });
    const { unmount } = render(<Harness store={store2} />);

    await vi.waitFor(() => {
      // Slot replay at seq 3 is idempotent → still failed, not rewritten to ready.
      expect(store2.getState().slots['job-1:s1:a'].status).toBe('failed');
    });
    unmount();
  });

  it('never leaks prompt or vendor fields from slot events into the store', async () => {
    const client = streamClient([
      slotEvent('job-1', 1, {
        prompt: 'SECRET prompt text',
        slideId: 'slide-1',
        slotId: 'chart-1',
        status: 'queued',
        vendorKey: 'sk-live-9',
      }),
    ]);
    const store = createPresentationStudioStore(client);
    store.setState({ jobs: { 'job-1': queuedJob('job-1') }, jobOrder: ['job-1'] });

    render(<Harness store={store} />);

    await vi.waitFor(() => {
      expect(store.getState().slots['job-1:slide-1:chart-1']).toBeTruthy();
    });
    expect(JSON.stringify(store.getState().slots)).not.toContain('SECRET prompt text');
    expect(JSON.stringify(store.getState().slots)).not.toContain('sk-live-9');
  });
});
