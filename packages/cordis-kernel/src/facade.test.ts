import { describe, expect, it } from 'vitest';

import { InMemoryRuntimeFacade } from './index';
import { EventJournal } from './journal';
import type { CommandEnvelope } from './protocol';
import { RunStore } from './run';
import type { RuntimePluginManifest } from './types';

const envelope = (
  request_id: string,
  command: string,
  payload: Record<string, unknown> = {},
): CommandEnvelope => ({
  protocol_version: 'runtime.v1',
  request_id,
  command,
  payload,
});

const startPayload = (runId = 'run-1') => ({
  runId,
  sessionId: 'session-1',
  profileId: 'profile-1',
  userMessage: 'hello',
});

const plugin = (
  id: string,
  apply: RuntimePluginManifest['apply'] = () => {},
): RuntimePluginManifest => ({
  id,
  version: '1.0.0',
  kind: 'capability',
  apply,
});

describe('@lobechat/cordis-kernel InMemoryRuntimeFacade', () => {
  it('routes run.start and run.get through RunStore', async () => {
    const facade = new InMemoryRuntimeFacade();

    const started = await facade.handle(envelope('start-1', 'run.start', startPayload()));
    const fetched = await facade.handle(envelope('get-1', 'run.get', { runId: 'run-1' }));

    expect(started).toMatchObject({ runId: 'run-1', state: 'running' });
    expect(fetched).toEqual(started);
  });

  it('routes run.cancel and returns the cancelled snapshot', async () => {
    const facade = new InMemoryRuntimeFacade();
    await facade.handle(envelope('start-2', 'run.start', startPayload('run-2')));

    const cancelled = await facade.handle(envelope('cancel-2', 'run.cancel', { runId: 'run-2' }));

    expect(cancelled).toMatchObject({ runId: 'run-2', state: 'cancelled' });
  });

  it('routes run.resume and publishes the resumed event', async () => {
    const runs = new RunStore();
    const journal = new EventJournal();
    const facade = new InMemoryRuntimeFacade({ runStore: runs, eventJournal: journal });
    await facade.handle(envelope('start-3', 'run.start', startPayload('run-3')));
    runs.wait('run-3', 'human');

    const resumed = await facade.handle(
      envelope('resume-3', 'run.resume', {
        runId: 'run-3',
        input: 'approved',
        metadata: { approved: true },
      }),
    );

    expect(resumed).toMatchObject({ state: 'running', metadata: { approved: true } });
    expect(journal.replay('run-3').map(({ seq }) => seq)).toEqual([1, 2]);
  });

  it('replays run.events after after_seq', async () => {
    const facade = new InMemoryRuntimeFacade();
    await facade.handle(envelope('start-4', 'run.start', startPayload('run-4')));
    await facade.handle(envelope('cancel-4', 'run.cancel', { runId: 'run-4' }));

    const events = await facade.handle(
      envelope('events-4', 'run.events', { runId: 'run-4', after_seq: 1 }),
    );

    expect(events).toMatchObject([
      { run_id: 'run-4', seq: 2, data: { command: 'run.cancel', state: 'cancelled' } },
    ]);
  });

  it('makes duplicate request_id return the same result without another event', async () => {
    const facade = new InMemoryRuntimeFacade();
    const request = envelope('same-request', 'run.start', startPayload('run-idempotent'));

    const first = await facade.handle(request);
    const second = await facade.handle(request);

    expect(second).toBe(first);
    expect(facade.eventJournal.replay('run-idempotent')).toHaveLength(1);
  });

  it('deduplicates concurrent requests with the same request_id', async () => {
    let starts = 0;
    const facade = new InMemoryRuntimeFacade({
      plugins: [
        plugin('counter', () => {
          starts += 1;
        }),
      ],
    });
    const request = envelope('mount-same', 'plugin.mount', { id: 'counter' });

    const [first, second] = await Promise.all([facade.handle(request), facade.handle(request)]);

    expect(first).toBe('active');
    expect(second).toBe('active');
    expect(starts).toBe(1);
  });

  it('passes protocol validation errors through unchanged', async () => {
    const facade = new InMemoryRuntimeFacade();

    await expect(
      facade.handle({ protocol_version: 'runtime.v1', request_id: 'invalid', command: 'run.get' }),
    ).rejects.toMatchObject({ code: 'PROTOCOL_INVALID', path: 'payload' });
  });

  it('reports unknown commands with COMMAND_NOT_FOUND', async () => {
    const facade = new InMemoryRuntimeFacade();

    await expect(facade.handle(envelope('unknown-command', 'run.unknown'))).rejects.toMatchObject({
      code: 'COMMAND_NOT_FOUND',
    });
  });

  it('routes plugin.list, plugin.mount, and plugin.unmount', async () => {
    const facade = new InMemoryRuntimeFacade({ plugins: [plugin('builtin')] });

    const listed = await facade.handle(envelope('plugin-list', 'plugin.list'));
    const mounted = await facade.handle(
      envelope('plugin-mount', 'plugin.mount', { id: 'builtin' }),
    );
    const unmounted = await facade.handle(
      envelope('plugin-unmount', 'plugin.unmount', { id: 'builtin' }),
    );

    expect(listed).toMatchObject([{ id: 'builtin', state: 'installed' }]);
    expect(mounted).toBe('active');
    expect(unmounted).toBe('disabled');
  });

  it('returns null for an unknown run and an empty event replay', async () => {
    const facade = new InMemoryRuntimeFacade();

    await expect(
      facade.handle(envelope('get-missing', 'run.get', { runId: 'missing' })),
    ).resolves.toBe(null);
    await expect(
      facade.handle(envelope('events-missing', 'run.events', { runId: 'missing' })),
    ).resolves.toEqual([]);
  });

  it('supports encoded envelopes without executing payload values', async () => {
    const facade = new InMemoryRuntimeFacade();
    const encoded = JSON.stringify(envelope('encoded-get', 'run.get', { runId: 'missing' }));

    await expect(facade.handle(encoded)).resolves.toBe(null);
  });
});
