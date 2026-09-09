import { describe, expect, it, vi } from 'vitest';

import { type PresentationJobEvent, PresentationJobEventJournal } from './job-event-journal';
import {
  createPresentationArtifactSnapshot,
  createPresentationJobSnapshot,
  PRESENTATION_JOB_EVENT_TYPES,
  PresentationJobEventPublisher,
} from './publisher';

const scope = { userId: 'user-1', sessionId: 'session-1' };

const event = (jobId: string, seq: number): PresentationJobEvent => ({
  data: { seq },
  job_id: jobId,
  protocol_version: 'runtime.v1',
  seq,
  type: PRESENTATION_JOB_EVENT_TYPES.accepted,
});

describe('PresentationJobEventPublisher', () => {
  it('publishes strict runtime.v1 events with monotonic sequences', () => {
    const journal = new PresentationJobEventJournal({ scope });
    const publisher = new PresentationJobEventPublisher({ journal, scope });

    const first = publisher.publish({
      data: { job: createPresentationJobSnapshot('job-1', 'queued', { now: () => 't1' }) },
      idempotencyKey: 'accepted',
      jobId: 'job-1',
      type: PRESENTATION_JOB_EVENT_TYPES.accepted,
    });
    const second = publisher.publish({
      data: { job: createPresentationJobSnapshot('job-1', 'queued', { now: () => 't2' }) },
      idempotencyKey: 'queued',
      jobId: 'job-1',
      type: PRESENTATION_JOB_EVENT_TYPES.queued,
    });

    expect([first.seq, second.seq]).toEqual([1, 2]);
    expect(journal.replay('job-1')).toEqual([first, second]);
  });

  it('makes an idempotency key return the original event without a second append', () => {
    const journal = new PresentationJobEventJournal();
    const publisher = new PresentationJobEventPublisher(journal);

    const first = publisher.publish(
      'job-2',
      PRESENTATION_JOB_EVENT_TYPES.accepted,
      { state: 'queued' },
      {
        idempotencyKey: 'accepted',
      },
    );
    const duplicate = publisher.publish(
      'job-2',
      PRESENTATION_JOB_EVENT_TYPES.accepted,
      {
        state: 'changed',
      },
      { idempotencyKey: 'accepted' },
    );

    expect(duplicate).toEqual(first);
    expect(journal.replay('job-2')).toHaveLength(1);
  });

  it('continues after sequences already present in the injected journal', () => {
    const journal = new PresentationJobEventJournal();
    journal.append('job-3', event('job-3', 1));
    journal.append('job-3', event('job-3', 2));
    const publisher = new PresentationJobEventPublisher(journal);

    const next = publisher.publish('job-3', PRESENTATION_JOB_EVENT_TYPES.workerStarted, {
      phase: 'worker',
    });

    expect(next.seq).toBe(3);
  });

  it('rejects a missing or cross-scope publish before touching the journal', () => {
    const journal = new PresentationJobEventJournal({ scope });
    const publisher = new PresentationJobEventPublisher({ journal, scope });

    expect(() =>
      publisher.publish({
        data: {},
        jobId: 'job-4',
        type: PRESENTATION_JOB_EVENT_TYPES.accepted,
        scope: { userId: 'other-user', sessionId: 'session-1' },
      }),
    ).toThrow(expect.objectContaining({ code: 'PRESENTATION_EVENT_SCOPE_DENIED' }));
    const unbound = new PresentationJobEventPublisher({
      journal: new PresentationJobEventJournal({ scope: { userId: 'user-1' } }),
    });
    expect(() => unbound.assertScope()).toThrow(
      expect.objectContaining({ code: 'PRESENTATION_EVENT_SCOPE_DENIED' }),
    );
    expect(journal.replay('job-4')).toEqual([]);
  });

  it('rejects an explicit publisher scope that disagrees with journal scope', () => {
    expect(
      () =>
        new PresentationJobEventPublisher({
          journal: new PresentationJobEventJournal({ scope }),
          scope: { userId: 'other-user', sessionId: 'session-1' },
        }),
    ).toThrow(expect.objectContaining({ code: 'PRESENTATION_EVENT_SCOPE_DENIED' }));
  });

  it('disposes idempotently and rejects future publication', () => {
    const publisher = new PresentationJobEventPublisher(new PresentationJobEventJournal());
    publisher.dispose();
    publisher.dispose();

    expect(() => publisher.publish('job-5', PRESENTATION_JOB_EVENT_TYPES.accepted, {})).toThrow(
      expect.objectContaining({ code: 'PRESENTATION_EVENT_PUBLISHER_DISPOSED' }),
    );
  });

  it('projects artifact payloads without bytes or filesystem paths', () => {
    const snapshot = createPresentationArtifactSnapshot(
      'job-6',
      {
        artifactId: 'artifact-6',
        bytes: new Uint8Array([1, 2]),
        metadata: { path: '/private/metadata', title: 'Deck' },
        mimeType: 'application/test',
        name: 'deck.pptx',
        path: '/private/workspace/deck.pptx',
        type: 'pptx',
      },
      { now: () => 't6' },
    );

    expect(snapshot).toEqual({
      artifactId: 'artifact-6',
      createdAt: 't6',
      metadata: { title: 'Deck' },
      mimeType: 'application/test',
      name: 'deck.pptx',
      sizeBytes: 2,
      status: 'ready',
      type: 'pptx',
      updatedAt: 't6',
    });
  });

  it('publishes artifact and terminal snapshots with stable event types', () => {
    const journal = new PresentationJobEventJournal();
    const publisher = new PresentationJobEventPublisher(journal);
    const artifact = createPresentationArtifactSnapshot(
      'job-7',
      {
        artifactId: 'artifact-7',
        bytes: new Uint8Array([1]),
        mimeType: 'application/test',
        name: 'deck.pptx',
        type: 'pptx',
      },
      { now: () => 't7' },
    );

    const artifactEvent = publisher.publish({
      data: { artifact },
      idempotencyKey: 'artifact:artifact-7',
      jobId: 'job-7',
      type: PRESENTATION_JOB_EVENT_TYPES.artifactReady,
    });
    const completedEvent = publisher.publish({
      data: {
        job: createPresentationJobSnapshot('job-7', 'completed', {
          artifactIds: ['artifact-7'],
          now: () => 't8',
        }),
      },
      idempotencyKey: 'terminal:completed',
      jobId: 'job-7',
      type: PRESENTATION_JOB_EVENT_TYPES.completed,
    });

    expect(artifactEvent.type).toBe('presentation.job.artifact.ready');
    expect(completedEvent.data).toMatchObject({ job: { state: 'completed' } });
  });

  it('does not convert journal failures into successful events', () => {
    const failure = new Error('journal unavailable');
    const journal = {
      append: vi.fn(() => {
        throw failure;
      }),
      dispose: vi.fn(),
      has: vi.fn(() => false),
      replay: vi.fn(() => []),
      subscribe: vi.fn(),
    };
    const publisher = new PresentationJobEventPublisher(journal);

    expect(() => publisher.publish('job-8', PRESENTATION_JOB_EVENT_TYPES.accepted, {})).toThrow(
      failure,
    );
  });
});
