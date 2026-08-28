import { describe, expect, it } from 'vitest';

import { RunStore } from './index';
import type { StartRunInput } from './run';

const input = (overrides: Partial<StartRunInput> = {}): StartRunInput => ({
  sessionId: 'session-1',
  profileId: 'profile-1',
  userMessage: 'hello',
  ...overrides,
});

const expectCode = (operation: () => unknown, code: string) => {
  try {
    operation();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
};

describe('@lobechat/cordis-kernel RunStore', () => {
  it('follows the legal queued, running, waiting, and completed path', () => {
    const store = new RunStore();

    expect(store.create('run-1', input()).state).toBe('created');
    expect(store.enqueue('run-1').state).toBe('queued');
    expect(store.start('run-1').state).toBe('running');
    expect(store.wait('run-1', 'tool').state).toBe('waiting_tool');
    expect(store.resume('run-1', { input: 'tool result' }).state).toBe('running');
    expect(store.complete('run-1', { answer: 42 }).state).toBe('completed');
  });

  it('rejects illegal transitions with INVALID_TRANSITION', () => {
    const store = new RunStore();
    store.create('run-invalid', input());

    expectCode(() => store.start('run-invalid'), 'INVALID_TRANSITION');
    expectCode(() => store.wait('run-invalid', 'human'), 'INVALID_TRANSITION');
  });

  it('cancels a nonterminal run and rejects later operations as terminal', () => {
    const store = new RunStore();
    store.create('run-cancel', input());

    expect(store.cancel('run-cancel').state).toBe('cancelled');
    expectCode(() => store.cancel('run-cancel'), 'RUN_ALREADY_TERMINAL');
    expectCode(() => store.resume('run-cancel'), 'RUN_ALREADY_TERMINAL');
  });

  it('resumes a human wait and merges resume metadata', () => {
    const store = new RunStore();
    store.create('run-human', input({ metadata: { attempt: 1 } }));
    store.enqueue('run-human');
    store.start('run-human');
    store.wait('run-human', 'human');

    const resumed = store.resume('run-human', {
      input: 'approved',
      metadata: { approved: true },
    });

    expect(resumed.state).toBe('running');
    expect(resumed.metadata).toEqual({ attempt: 1, approved: true });
  });

  it('records parentRunId for child runs', () => {
    const store = new RunStore();
    store.create('parent', input());
    const child = store.create('child', input({ parentRunId: 'parent' }));

    expect(child.parentRunId).toBe('parent');
    expect(store.get('child')?.parentRunId).toBe('parent');
  });

  it('moves a running run through retrying and back to running', () => {
    const store = new RunStore();
    store.create('run-retry', input());
    store.enqueue('run-retry');
    store.start('run-retry');

    expect(store.retry('run-retry').state).toBe('retrying');
    expect(store.resume('run-retry').state).toBe('running');
    expect(store.fail('run-retry', { code: 'MODEL_FAILED', message: 'try again' }).state).toBe(
      'failed',
    );
    expectCode(() => store.resume('run-retry'), 'RUN_ALREADY_TERMINAL');
  });

  it('keeps failed runs terminal', () => {
    const store = new RunStore();
    store.create('run-failed', input());
    store.enqueue('run-failed');
    store.start('run-failed');

    const failed = store.fail('run-failed', new Error('boom'));
    expect(failed.error).toMatchObject({ code: 'RUN_FAILED', message: 'boom' });
    expectCode(() => store.cancel('run-failed'), 'RUN_ALREADY_TERMINAL');
  });

  it('creates each runId only once', () => {
    const store = new RunStore();
    const first = store.create('same-id', input({ sessionId: 'first' }));
    const second = store.create('same-id', input({ sessionId: 'second' }));

    expect(second.sessionId).toBe('first');
    expect(second.createdAt).toBe(first.createdAt);
    expect(store.getEvents('same-id')).toHaveLength(1);
  });

  it('emits per-run RuntimeEvent values with monotonic seq', () => {
    const store = new RunStore();
    store.create('run-events', input());
    store.enqueue('run-events');
    store.start('run-events');
    store.wait('run-events', 'child');
    store.resume('run-events');
    store.complete('run-events');

    const events = store.getEvents('run-events');
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(events.every((event) => event.run_id === 'run-events')).toBe(true);
    expect(store.getEvents('run-events', 3).map((event) => event.seq)).toEqual([4, 5, 6]);
  });
});
