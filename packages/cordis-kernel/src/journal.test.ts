import { describe, expect, it } from 'vitest';

import { EventJournal } from './index';
import type { RuntimeEvent } from './run';

const event = (runId: string, seq: number, data: unknown = seq): RuntimeEvent => ({
  protocol_version: 'runtime.v1',
  session_id: 'session-1',
  run_id: runId,
  seq,
  type: 'run.state_changed',
  data,
});

describe('@lobechat/cordis-kernel EventJournal', () => {
  it('appends and replays events in sequence order', () => {
    const journal = new EventJournal();
    journal.append('run-1', event('run-1', 1, 'created'));
    journal.append('run-1', event('run-1', 2, 'queued'));

    expect(journal.replay('run-1')).toEqual([
      event('run-1', 1, 'created'),
      event('run-1', 2, 'queued'),
    ]);
  });

  it('treats a duplicate sequence as idempotent without repeating side effects', () => {
    const journal = new EventJournal();
    const received: number[] = [];
    journal.subscribe('run-duplicate', ({ seq }) => received.push(seq));
    const first = journal.append('run-duplicate', event('run-duplicate', 1, 'first'));
    const duplicate = journal.append('run-duplicate', event('run-duplicate', 1, 'retry'));

    expect(duplicate).toEqual(first);
    expect(journal.replay('run-duplicate')).toEqual([first]);
    expect(received).toEqual([1]);
  });

  it('rejects a descending sequence with EVENT_SEQ_INVALID', () => {
    const journal = new EventJournal();
    journal.append('run-invalid', event('run-invalid', 2));

    expect(() => journal.append('run-invalid', event('run-invalid', 1))).toThrow(
      expect.objectContaining({ code: 'EVENT_SEQ_INVALID' }),
    );
  });

  it('filters replay results strictly after afterSeq', () => {
    const journal = new EventJournal();
    for (const seq of [1, 2, 3]) journal.append('run-filter', event('run-filter', seq));

    expect(journal.replay('run-filter', 1).map(({ seq }) => seq)).toEqual([2, 3]);
    expect(journal.replay('run-filter', 3)).toEqual([]);
  });

  it('replays an unknown run as an empty stream', () => {
    const journal = new EventJournal();

    expect(journal.replay('missing-run')).toEqual([]);
    expect(journal.has('missing-run')).toBe(false);
  });

  it('notifies subscribers for future events', () => {
    const journal = new EventJournal();
    const received: RuntimeEvent[] = [];
    journal.subscribe('run-subscribe', (receivedEvent) => received.push(receivedEvent));

    journal.append('run-subscribe', event('run-subscribe', 1));

    expect(received).toEqual([event('run-subscribe', 1)]);
  });

  it('stops notifications after the subscription disposer runs', () => {
    const journal = new EventJournal();
    const received: number[] = [];
    const dispose = journal.subscribe('run-cancel', ({ seq }) => received.push(seq));

    journal.append('run-cancel', event('run-cancel', 1));
    dispose();
    dispose();
    journal.append('run-cancel', event('run-cancel', 2));

    expect(received).toEqual([1]);
  });

  it('supports subscribing before an unknown run receives its first event', () => {
    const journal = new EventJournal();
    const received: RuntimeEvent[] = [];
    journal.subscribe('future-run', (receivedEvent) => received.push(receivedEvent));

    journal.append('future-run', event('future-run', 1, 'created'));

    expect(received).toEqual([event('future-run', 1, 'created')]);
  });

  it('does not expose mutable journal storage through replay results', () => {
    const journal = new EventJournal();
    const original = event('run-copy', 1, { state: 'created' });
    journal.append('run-copy', original);
    const replayed = journal.replay('run-copy');
    replayed[0]!.type = 'mutated';

    expect(journal.replay('run-copy')[0]!.type).toBe('run.state_changed');
  });
});
