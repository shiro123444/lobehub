import { describe, expect, it, vi } from 'vitest';

import { PresentationJobEventJournal, type PresentationJobEvent } from './job-event-journal';

const event = (jobId: string, seq: number, data: unknown = seq): PresentationJobEvent => ({
  data,
  job_id: jobId,
  protocol_version: 'runtime.v1',
  seq,
  type: 'presentation.job.updated',
});

describe('PresentationJobEventJournal', () => {
  it('appends and replays the C-60 wire shape in sequence order', () => {
    const journal = new PresentationJobEventJournal();

    journal.append('job-1', event('job-1', 1, { state: 'queued' }));
    journal.append('job-1', event('job-1', 2, { state: 'running' }));

    expect(journal.replay('job-1')).toEqual([
      event('job-1', 1, { state: 'queued' }),
      event('job-1', 2, { state: 'running' }),
    ]);
  });

  it('ignores duplicate and old sequences without notifying subscribers twice', () => {
    const journal = new PresentationJobEventJournal();
    const received: number[] = [];
    journal.subscribe('job-2', ({ seq }) => received.push(seq));

    expect(journal.append('job-2', event('job-2', 2))).toBeDefined();
    expect(journal.append('job-2', event('job-2', 2, 'duplicate'))).toBeUndefined();
    expect(journal.append('job-2', event('job-2', 1, 'old'))).toBeUndefined();

    expect(received).toEqual([2]);
    expect(journal.replay('job-2')).toEqual([event('job-2', 2)]);
  });

  it('replays only events strictly after afterSeq', () => {
    const journal = new PresentationJobEventJournal();
    for (const seq of [1, 2, 3]) journal.append('job-3', event('job-3', seq));

    expect(journal.replay('job-3', 1).map(({ seq }) => seq)).toEqual([2, 3]);
    expect(journal.replay('job-3', 3)).toEqual([]);
  });

  it('delivers accepted events to a live subscriber', () => {
    const journal = new PresentationJobEventJournal();
    const received: PresentationJobEvent[] = [];
    journal.subscribe('job-live', (value) => received.push(value));

    journal.append('job-live', event('job-live', 1));

    expect(received).toEqual([event('job-live', 1)]);
  });

  it('removes a subscriber after an idempotent disposer or AbortSignal abort', () => {
    const journal = new PresentationJobEventJournal();
    const received: number[] = [];
    const dispose = journal.subscribe('job-dispose', ({ seq }) => received.push(seq));
    const controller = new AbortController();
    journal.subscribe('job-dispose', ({ seq }) => received.push(seq * 10), {
      signal: controller.signal,
    });

    journal.append('job-dispose', event('job-dispose', 1));
    dispose();
    dispose();
    controller.abort();
    journal.append('job-dispose', event('job-dispose', 2));

    expect(received).toEqual([1, 10]);
  });

  it('supports subscribing before the first event and exposes known-job state', () => {
    const journal = new PresentationJobEventJournal();
    const received: number[] = [];
    journal.subscribe('future-job', ({ seq }) => received.push(seq));

    expect(journal.has('future-job')).toBe(false);
    journal.append('future-job', event('future-job', 1));

    expect(journal.has('future-job')).toBe(true);
    expect(received).toEqual([1]);
  });

  it('rejects a mismatched job id and invalid sequence with stable codes', () => {
    const journal = new PresentationJobEventJournal();

    expect(() => journal.append('job-invalid', event('other-job', 1))).toThrow(
      expect.objectContaining({ code: 'PRESENTATION_EVENT_INVALID', path: 'job_id' }),
    );
    expect(() => journal.append('job-invalid', event('job-invalid', -1))).toThrow(
      expect.objectContaining({ code: 'PRESENTATION_EVENT_SEQ_INVALID', path: 'seq' }),
    );
  });

  it('rejects an invalid protocol or non-serializable data', () => {
    const journal = new PresentationJobEventJournal();

    expect(() =>
      journal.append('job-invalid', {
        ...event('job-invalid', 1),
        protocol_version: 'runtime.v2',
      } as unknown as PresentationJobEvent),
    ).toThrow(expect.objectContaining({ code: 'PRESENTATION_EVENT_INVALID' }));
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => journal.append('job-invalid', event('job-invalid', 1, circular))).toThrow(
      expect.objectContaining({ code: 'PRESENTATION_EVENT_INVALID', path: 'data' }),
    );
  });

  it('does not expose mutable event data from replay or live delivery', () => {
    const journal = new PresentationJobEventJournal();
    const original = event('job-copy', 1, { state: 'queued' });
    journal.append('job-copy', original);
    const replayed = journal.replay('job-copy');
    (replayed[0]!.data as { state: string }).state = 'mutated';

    expect(journal.replay('job-copy')[0]!.data).toEqual({ state: 'queued' });
  });

  it('cleans all state on idempotent journal dispose', () => {
    const journal = new PresentationJobEventJournal();
    const listener = vi.fn();
    journal.append('job-disposed', event('job-disposed', 1));
    journal.subscribe('job-disposed', listener);

    journal.dispose();
    journal.dispose();

    expect(journal.has('job-disposed')).toBe(false);
    expect(journal.replay('job-disposed')).toEqual([]);
    expect(() => journal.append('job-disposed', event('job-disposed', 2))).toThrow(
      expect.objectContaining({ code: 'PRESENTATION_EVENT_JOURNAL_DISPOSED' }),
    );
    expect(listener).not.toHaveBeenCalled();
  });

  it('can carry a server scope without sharing scope metadata implicitly', () => {
    const journal = new PresentationJobEventJournal({
      scope: { userId: 'user-1', sessionId: 'session-1' },
    });

    expect(journal.scope).toEqual({ userId: 'user-1', sessionId: 'session-1' });
  });
});
