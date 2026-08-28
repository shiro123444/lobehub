import { describe, expect, it } from 'vitest';

import { InMemoryRuntimeFacade } from './facade';
import type { RuntimeEvent } from './run';

const event = (runId: string, seq: number, state = 'running'): RuntimeEvent => ({
  protocol_version: 'runtime.v1',
  session_id: `session-${runId}`,
  run_id: runId,
  seq,
  type: 'run.state_changed',
  data: { state },
});

const envelope = (request_id: string, command: string, payload: Record<string, unknown> = {}) => ({
  protocol_version: 'runtime.v1' as const,
  request_id,
  command,
  payload,
});

describe('@lobechat/cordis-kernel RuntimeFacade EventJournal bridge', () => {
  it('exposes EventJournal subscription by runId', () => {
    const facade = new InMemoryRuntimeFacade();
    const received: number[] = [];

    facade.subscribe('run-a', ({ seq }) => received.push(seq));
    facade.eventJournal.append('run-a', event('run-a', 1));
    facade.eventJournal.append('run-b', event('run-b', 1));

    expect(received).toEqual([1]);
  });

  it('returns a disposer that stops future events for the subscribed run', () => {
    const facade = new InMemoryRuntimeFacade();
    const received: number[] = [];
    const dispose = facade.subscribe('run-b', ({ seq }) => received.push(seq));

    facade.eventJournal.append('run-b', event('run-b', 1));
    dispose();
    facade.eventJournal.append('run-b', event('run-b', 2));

    expect(received).toEqual([1]);
  });

  it('bridges subscribeRunEvents to the same EventJournal listener', () => {
    const facade = new InMemoryRuntimeFacade();
    const received: string[] = [];
    const dispose = facade.subscribeRunEvents('run-c', ({ type }) => received.push(type));

    facade.eventJournal.append('run-c', event('run-c', 1));
    dispose();

    expect(received).toEqual(['run.state_changed']);
  });

  it('bridges onRunEvent without changing run-specific filtering', () => {
    const facade = new InMemoryRuntimeFacade();
    const received: number[] = [];

    facade.onRunEvent('run-d', ({ seq }) => received.push(seq));
    facade.eventJournal.append('run-d', event('run-d', 1));
    facade.eventJournal.append('run-e', event('run-e', 1));

    expect(received).toEqual([1]);
  });

  it('keeps subscriptions for separate runIds independent', () => {
    const facade = new InMemoryRuntimeFacade();
    const first: number[] = [];
    const second: number[] = [];
    const disposeFirst = facade.subscribe('run-f', ({ seq }) => first.push(seq));
    facade.subscribe('run-g', ({ seq }) => second.push(seq));

    disposeFirst();
    facade.eventJournal.append('run-f', event('run-f', 1));
    facade.eventJournal.append('run-g', event('run-g', 1));

    expect(first).toEqual([]);
    expect(second).toEqual([1]);
  });

  it('keeps disposer calls idempotent', () => {
    const facade = new InMemoryRuntimeFacade();
    const received: number[] = [];
    const dispose = facade.subscribe('run-h', ({ seq }) => received.push(seq));

    dispose();
    dispose();
    facade.eventJournal.append('run-h', event('run-h', 1));

    expect(received).toEqual([]);
  });

  it('delivers events appended after facade replay through the same journal', async () => {
    const facade = new InMemoryRuntimeFacade();
    facade.eventJournal.append('run-i', event('run-i', 1));

    const replay = await facade.handle(envelope('replay-i', 'run.events', { runId: 'run-i' }));
    const received: number[] = [];
    const dispose = facade.subscribeRunEvents('run-i', ({ seq }) => received.push(seq));
    facade.eventJournal.append('run-i', event('run-i', 2, 'completed'));
    dispose();

    expect((replay as RuntimeEvent[]).map(({ seq }) => seq)).toEqual([1]);
    expect(received).toEqual([2]);
    await expect(
      facade.handle(envelope('replay-i-after', 'run.events', { runId: 'run-i', after_seq: 1 })),
    ).resolves.toMatchObject([{ seq: 2 }]);
  });

  it('does not duplicate listener delivery when EventJournal ignores duplicate seq', () => {
    const facade = new InMemoryRuntimeFacade();
    const received: number[] = [];
    facade.subscribe('run-j', ({ seq }) => received.push(seq));

    facade.eventJournal.append('run-j', event('run-j', 1));
    facade.eventJournal.append('run-j', event('run-j', 1, 'different-state'));

    expect(received).toEqual([1]);
    expect(facade.eventJournal.replay('run-j')).toHaveLength(1);
  });

  it('preserves existing command publication and replay behavior with subscriptions', async () => {
    const facade = new InMemoryRuntimeFacade();
    const received: number[] = [];
    facade.subscribe('run-k', ({ seq }) => received.push(seq));

    await facade.handle(
      envelope('start-k', 'run.start', {
        runId: 'run-k',
        sessionId: 'session-run-k',
        profileId: 'profile-k',
        userMessage: 'hello',
      }),
    );
    await facade.handle(envelope('cancel-k', 'run.cancel', { runId: 'run-k' }));

    expect(received).toEqual([1, 2]);
    await expect(
      facade.handle(envelope('events-k', 'run.events', { runId: 'run-k' })),
    ).resolves.toMatchObject([{ seq: 1 }, { seq: 2 }]);
  });
});
