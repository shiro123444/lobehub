import { describe, expect, it } from 'vitest';

import {
  IMAGE_GENERATION_EVENT_TYPES,
  ImageGenerationEventError,
  ImageGenerationEventPublisher,
  InMemoryImageGenerationEventJournal,
} from './asset-events';

const scope = { sessionId: 'session-1', userId: 'user-1' } as const;
const otherScope = { sessionId: 'session-2', userId: 'user-1' } as const;

const expectEventError = (operation: () => unknown, code: string) => {
  expect(operation).toThrowError(
    expect.objectContaining({ code, name: 'ImageGenerationEventError' }),
  );
};

describe('C-82 image-generation event model', () => {
  it('publishes the required lifecycle types with scoped monotonic sequence', () => {
    const journal = new InMemoryImageGenerationEventJournal({ scope });
    const publisher = new ImageGenerationEventPublisher({ journal, scope });
    const types = [
      IMAGE_GENERATION_EVENT_TYPES.accepted,
      IMAGE_GENERATION_EVENT_TYPES.started,
      IMAGE_GENERATION_EVENT_TYPES.progress,
      IMAGE_GENERATION_EVENT_TYPES.assetReady,
      IMAGE_GENERATION_EVENT_TYPES.failed,
      IMAGE_GENERATION_EVENT_TYPES.cancelled,
    ];

    const events = types.map((type, index) =>
      publisher.publish({
        assetId: index === 3 ? 'asset-1' : undefined,
        data: { index, progress: index / types.length },
        idempotencyKey: `event-${index}`,
        jobId: 'job-1',
        type,
      }),
    );

    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(events.every((event) => event.scope.userId === scope.userId)).toBe(true);
    expect(journal.replay('job-1')).toEqual(events);
  });

  it('deduplicates an idempotency key without a second notification', () => {
    const journal = new InMemoryImageGenerationEventJournal({ scope });
    const publisher = new ImageGenerationEventPublisher({ journal, scope });
    const received: number[] = [];
    journal.subscribe('job-1', (event) => received.push(event.seq));

    const first = publisher.publish({
      data: { stage: 'accepted' },
      idempotencyKey: 'same-event',
      jobId: 'job-1',
      type: IMAGE_GENERATION_EVENT_TYPES.accepted,
    });
    const duplicate = publisher.publish({
      data: { stage: 'accepted' },
      idempotencyKey: 'same-event',
      jobId: 'job-1',
      type: IMAGE_GENERATION_EVENT_TYPES.accepted,
    });

    expect(duplicate).toEqual(first);
    expect(received).toEqual([1]);
    expectEventError(
      () =>
        publisher.publish({
          data: { stage: 'started' },
          idempotencyKey: 'same-event',
          jobId: 'job-1',
          type: IMAGE_GENERATION_EVENT_TYPES.started,
        }),
      'ASSET_IDEMPOTENCY_CONFLICT',
    );
  });

  it('filters unsafe payload fields and returns defensive copies', () => {
    const journal = new InMemoryImageGenerationEventJournal({ scope });
    const publisher = new ImageGenerationEventPublisher({ journal, scope });
    const event = publisher.publish({
      data: {
        asset: { metadata: { bytes: new Uint8Array([1]), visible: true }, ref: 'asset://1' },
        path: '/secret/path',
        prompt: 'full prompt must not be stored',
        safe: { value: 'kept' },
        secret: 'do-not-store',
      },
      idempotencyKey: 'safe-event',
      jobId: 'job-1',
      type: IMAGE_GENERATION_EVENT_TYPES.assetReady,
    });

    expect(event.data).toEqual({
      asset: { metadata: { visible: true }, ref: 'asset://1' },
      safe: { value: 'kept' },
    });
    expect(JSON.stringify(event)).not.toContain('full prompt');
    expect(JSON.stringify(event)).not.toContain('do-not-store');
    const mutable = journal.replay('job-1')[0];
    mutable.data.safe = { value: 'mutated' };
    expect(journal.replay('job-1')[0].data.safe).toEqual({ value: 'kept' });
  });

  it('enforces scope isolation for publishers and journals', () => {
    const journal = new InMemoryImageGenerationEventJournal({ scope });
    const publisher = new ImageGenerationEventPublisher({ journal, scope });

    expectEventError(
      () =>
        publisher.publish({
          data: {},
          idempotencyKey: 'cross-scope',
          jobId: 'job-1',
          scope: otherScope,
          type: IMAGE_GENERATION_EVENT_TYPES.accepted,
        }),
      'ASSET_SCOPE_MISMATCH',
    );
    expectEventError(
      () => new ImageGenerationEventPublisher({ journal, scope: otherScope }),
      'ASSET_SCOPE_MISMATCH',
    );
    expect(journal.replay('job-1')).toEqual([]);
  });

  it('replays after a sequence and filters duplicate/old journal appends', () => {
    const journal = new InMemoryImageGenerationEventJournal({ scope });
    const publisher = new ImageGenerationEventPublisher({ journal, scope });
    const first = publisher.publish({
      data: { progress: 0.1 },
      idempotencyKey: 'progress-1',
      jobId: 'job-1',
      type: IMAGE_GENERATION_EVENT_TYPES.progress,
    });
    const second = publisher.publish({
      data: { progress: 0.9 },
      idempotencyKey: 'progress-2',
      jobId: 'job-1',
      type: IMAGE_GENERATION_EVENT_TYPES.progress,
    });

    expect(journal.replay('job-1', first.seq)).toEqual([second]);
    expect(
      journal.append({ ...first, idempotencyKey: 'old-copy', seq: first.seq }),
    ).toBeUndefined();
  });

  it('cleans subscriptions on abort and makes dispose idempotent', () => {
    const journal = new InMemoryImageGenerationEventJournal({ scope });
    const publisher = new ImageGenerationEventPublisher({ journal, scope });
    const controller = new AbortController();
    const received: number[] = [];
    journal.subscribe('job-1', (event) => received.push(event.seq), {
      signal: controller.signal,
    });
    controller.abort();

    publisher.publish({
      data: {},
      idempotencyKey: 'after-abort',
      jobId: 'job-1',
      type: IMAGE_GENERATION_EVENT_TYPES.accepted,
    });
    expect(received).toEqual([]);

    journal.dispose();
    journal.dispose();
    expectEventError(
      () =>
        journal.subscribe('job-1', () => {
          // no-op
        }),
      'ASSET_EVENT_JOURNAL_DISPOSED',
    );
    expectEventError(
      () =>
        publisher.publish({
          data: {},
          idempotencyKey: 'after-dispose',
          jobId: 'job-1',
          type: IMAGE_GENERATION_EVENT_TYPES.accepted,
        }),
      'ASSET_EVENT_JOURNAL_DISPOSED',
    );
    publisher.dispose();
    publisher.dispose();
    expectEventError(
      () =>
        publisher.publish({
          data: {},
          idempotencyKey: 'publisher-disposed',
          jobId: 'job-1',
          type: IMAGE_GENERATION_EVENT_TYPES.accepted,
        }),
      'ASSET_EVENT_PUBLISHER_DISPOSED',
    );
    expect(ImageGenerationEventError).toBeDefined();
  });
});
