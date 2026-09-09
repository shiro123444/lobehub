import { describe, expect, it, vi } from 'vitest';

import type { PresentationStreamClient } from './presentationStore';
import { aggregateJobStreamStatus, createPresentationStudioStore } from './presentationStore';

const baseClient = (): PresentationStreamClient => ({
  createPresentationJob: vi.fn(),
  getPresentationJob: vi.fn(async () => null),
  cancelPresentationJob: vi.fn(),
  retryPresentationJob: vi.fn(),
  getArtifact: vi.fn(),
  exportArtifact: vi.fn(),
});

describe('presentationStore streamStatusByJob (C-66)', () => {
  it('setStreamStatusForJob is idempotent and keeps other jobs untouched', () => {
    const store = createPresentationStudioStore(baseClient());

    store.getState().setStreamStatusForJob('job-a', 'live');
    store.getState().setStreamStatusForJob('job-b', 'polling');

    expect(store.getState().streamStatusByJob['job-a']).toBe('live');
    expect(store.getState().streamStatusByJob['job-b']).toBe('polling');

    // Same value is a no-op and the aggregate stays put.
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    store.getState().setStreamStatusForJob('job-a', 'live');
    unsubscribe();

    expect(notifications).toBe(0);
    expect(store.getState().streamStatusByJob['job-b']).toBe('polling');
  });

  it('aggregates with precedence: any live > reconnecting > polling; null when empty', () => {
    const store = createPresentationStudioStore(baseClient());

    expect(store.getState().streamStatus).toBeNull();

    store.getState().setStreamStatusForJob('job-a', 'polling');
    store.getState().setStreamStatusForJob('job-b', 'reconnecting');
    expect(store.getState().streamStatus).toBe('reconnecting');

    store.getState().setStreamStatusForJob('job-a', 'live');
    expect(store.getState().streamStatus).toBe('live');

    expect(
      aggregateJobStreamStatus({
        'job-a': 'polling',
        'job-b': 'polling',
      }),
    ).toBe('polling');
    expect(aggregateJobStreamStatus({})).toBeNull();
  });

  it('clearing one job (null) only removes that job and recomputes the aggregate', () => {
    const store = createPresentationStudioStore(baseClient());
    store.getState().setStreamStatusForJob('job-a', 'live');
    store.getState().setStreamStatusForJob('job-b', 'polling');
    store.getState().setStreamStatusForJob('job-c', 'polling');

    store.getState().setStreamStatusForJob('job-b', null);

    expect(store.getState().streamStatusByJob['job-b']).toBeUndefined();
    expect(store.getState().streamStatusByJob['job-a']).toBe('live');
    expect(store.getState().streamStatusByJob['job-c']).toBe('polling');
    expect(store.getState().streamStatus).toBe('live');
  });

  it('keeps the legacy setStreamStatus signature working without touching per-job map', () => {
    const store = createPresentationStudioStore(baseClient());
    store.getState().setStreamStatus('polling');

    expect(store.getState().streamStatus).toBe('polling');
    expect(store.getState().streamStatusByJob).toEqual({});
  });
});
