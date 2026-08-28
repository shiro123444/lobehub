import { describe, expect, it, vi } from 'vitest';

import type {
  AgentProfile,
  RuntimeEvent,
  RuntimePluginInstallationInput,
  RuntimeRunInput,
} from '../../../../packages/cordis-kernel/src/index';
import { InMemoryPersistence } from '../../../../packages/cordis-kernel/src/persistence';
import {
  createScopedPersistencePort,
  createScopedRuntimeFacade,
  createScopedRuntimeFactory,
  type RuntimeScope,
  ScopeAccessError,
} from './index';

const scope = (userId: string, sessionId: string): RuntimeScope => ({ userId, sessionId });

const runInput = (
  runId: string,
  currentScope: RuntimeScope = scope('user-a', 'session-a'),
): RuntimeRunInput => ({
  runId,
  sessionId: currentScope.sessionId,
  profileId: 'profile-1',
  strategyPluginId: 'general-chat',
});

const event = (runId: string, seq: number, sessionId = 'session-a'): RuntimeEvent => ({
  protocol_version: 'runtime.v1',
  session_id: sessionId,
  run_id: runId,
  seq,
  type: `run.event.${seq}`,
  data: { seq },
});

const installation = (id = 'builtin-tools', version = '1.0.0'): RuntimePluginInstallationInput => ({
  id,
  version,
  kind: 'capability',
  source: 'builtin',
  state: 'installed',
});

const profile: AgentProfile = {
  id: 'profile-1',
  strategyPluginId: 'general-chat',
  model: 'test-model',
  provider: 'test-provider',
  systemPrompt: 'Be concise.',
  enabledCapabilities: ['search'],
};

const envelope = (payload: Record<string, unknown> = {}) => ({
  protocol_version: 'runtime.v1',
  request_id: 'request-1',
  command: 'run.get',
  payload,
});

describe('scoped runtime persistence bridge', () => {
  it('rejects missing authenticated scope values with SCOPE_INVALID', () => {
    expect(() =>
      createScopedPersistencePort(new InMemoryPersistence(), {
        userId: '',
        sessionId: 'session-a',
      }),
    ).toThrowError(ScopeAccessError);

    try {
      createScopedPersistencePort(new InMemoryPersistence(), {
        userId: 'user-a',
        sessionId: '',
      });
    } catch (error) {
      expect(error).toMatchObject({ code: 'SCOPE_INVALID', path: 'sessionId' });
    }
  });

  it('keeps owned run CRUD visible only to its user and session scope', async () => {
    const persistence = new InMemoryPersistence();
    const first = createScopedPersistencePort(persistence, scope('user-a', 'session-a'));
    const second = createScopedPersistencePort(persistence, scope('user-b', 'session-b'));

    const created = await first.createRun(runInput('run-1'));

    await expect(first.getRun('run-1')).resolves.toEqual(created);
    await expect(first.listRuns()).resolves.toHaveLength(1);
    await expect(second.listRuns()).resolves.toEqual([]);
  });

  it('rejects cross-scope run reads and writes with SCOPE_ACCESS_DENIED', async () => {
    const persistence = new InMemoryPersistence();
    const first = createScopedPersistencePort(persistence, scope('user-a', 'session-a'));
    const second = createScopedPersistencePort(persistence, scope('user-b', 'session-b'));
    await first.createRun(runInput('run-2'));

    await expect(second.getRun('run-2')).rejects.toMatchObject({
      code: 'SCOPE_ACCESS_DENIED',
      path: 'runId',
    });
    await expect(second.updateRun('run-2', { state: 'running' })).rejects.toMatchObject({
      code: 'SCOPE_ACCESS_DENIED',
    });
    await expect(second.deleteRun('run-2')).rejects.toMatchObject({
      code: 'SCOPE_ACCESS_DENIED',
    });
  });

  it('rejects a run or event whose session does not match the bound scope', async () => {
    const scoped = createScopedPersistencePort(
      new InMemoryPersistence(),
      scope('user-a', 'session-a'),
    );

    await expect(
      scoped.createRun(runInput('run-3', scope('user-a', 'session-b'))),
    ).rejects.toMatchObject({
      code: 'SCOPE_ACCESS_DENIED',
      path: 'sessionId',
    });
    await expect(
      scoped.appendRunEvent('run-3', event('run-3', 1, 'session-b')),
    ).rejects.toMatchObject({
      code: 'SCOPE_ACCESS_DENIED',
      path: 'event.session_id',
    });
  });

  it('scopes event append, lookup, and after-sequence replay', async () => {
    const persistence = new InMemoryPersistence();
    const first = createScopedPersistencePort(persistence, scope('user-a', 'session-a'));
    const second = createScopedPersistencePort(persistence, scope('user-b', 'session-b'));
    await first.createRun(runInput('run-4'));
    await first.appendRunEvent('run-4', event('run-4', 1));
    const secondEvent = await first.appendRunEvent('run-4', event('run-4', 2));

    await expect(first.getRunEvent('run-4', 2)).resolves.toEqual(secondEvent);
    await expect(first.replayRunEvents('run-4', 1)).resolves.toEqual([secondEvent]);
    await expect(second.replayRunEvents('run-4')).rejects.toMatchObject({
      code: 'SCOPE_ACCESS_DENIED',
    });
  });

  it('prevents a child in one scope from referring to a parent in another scope', async () => {
    const persistence = new InMemoryPersistence();
    const first = createScopedPersistencePort(persistence, scope('user-a', 'session-a'));
    const second = createScopedPersistencePort(persistence, scope('user-b', 'session-b'));
    await first.createRun(runInput('parent-run'));

    await expect(
      second.createRun({
        ...runInput('child-run', scope('user-b', 'session-b')),
        parentRunId: 'parent-run',
      }),
    ).rejects.toMatchObject({ code: 'SCOPE_ACCESS_DENIED', path: 'parentRunId' });
  });

  it('isolates plugin installations and rejects cross-scope family access', async () => {
    const persistence = new InMemoryPersistence();
    const first = createScopedPersistencePort(persistence, scope('user-a', 'session-a'));
    const second = createScopedPersistencePort(persistence, scope('user-b', 'session-b'));
    await first.createPluginInstallation(installation());

    await expect(first.listPluginInstallations()).resolves.toHaveLength(1);
    await expect(second.listPluginInstallations()).resolves.toEqual([]);
    await expect(second.getPluginInstallation('builtin-tools')).rejects.toMatchObject({
      code: 'SCOPE_ACCESS_DENIED',
    });
    await expect(second.deletePluginInstallation('builtin-tools')).rejects.toMatchObject({
      code: 'SCOPE_ACCESS_DENIED',
    });
  });

  it('isolates AgentProfile-compatible projection reads and writes', async () => {
    const persistence = new InMemoryPersistence();
    const first = createScopedPersistencePort(persistence, scope('user-a', 'session-a'));
    const second = createScopedPersistencePort(persistence, scope('user-b', 'session-b'));
    await first.putAgentProfile(profile);

    await expect(first.getAgentProfile(profile.id)).resolves.toEqual(profile);
    await expect(second.listAgentProfiles()).resolves.toEqual([]);
    await expect(second.getAgentProfile(profile.id)).rejects.toMatchObject({
      code: 'SCOPE_ACCESS_DENIED',
      path: 'profileId',
    });
    await expect(second.deleteAgentProfile(profile.id)).rejects.toMatchObject({
      code: 'SCOPE_ACCESS_DENIED',
    });
  });

  it('keeps concurrent same-id writes isolated and rejects the losing scope', async () => {
    const persistence = new InMemoryPersistence();
    const first = createScopedPersistencePort(persistence, scope('user-a', 'session-a'));
    const second = createScopedPersistencePort(persistence, scope('user-b', 'session-b'));

    const outcomes = await Promise.allSettled([
      first.createRun(runInput('concurrent-run')),
      second.createRun(runInput('concurrent-run', scope('user-b', 'session-b'))),
    ]);

    expect(outcomes[0]?.status).toBe('fulfilled');
    expect(outcomes[1]).toMatchObject({
      status: 'rejected',
      reason: { code: 'SCOPE_ACCESS_DENIED' },
    });
    await expect(first.getRun('concurrent-run')).resolves.toMatchObject({
      sessionId: 'session-a',
    });
    await expect(second.listRuns()).resolves.toEqual([]);
  });

  it('binds facade input to the authenticated scope and rejects mismatches', async () => {
    const handle = vi.fn(async (input: unknown) => input);
    const facade = createScopedRuntimeFacade({ handle }, scope('user-a', 'session-a'));

    await expect(facade.handle(envelope({ runId: 'run-5' }))).resolves.toMatchObject({
      payload: { runId: 'run-5', userId: 'user-a', sessionId: 'session-a' },
    });
    await expect(
      facade.handle(envelope({ runId: 'run-5', userId: 'user-b' })),
    ).rejects.toMatchObject({ code: 'SCOPE_ACCESS_DENIED', path: 'userId' });
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('also validates and binds JSON-encoded facade envelopes', async () => {
    const handle = vi.fn(async (input: unknown) => input);
    const facade = createScopedRuntimeFacade({ handle }, scope('user-a', 'session-a'));

    await expect(facade.handle(JSON.stringify(envelope()))).resolves.toMatchObject({
      payload: { userId: 'user-a', sessionId: 'session-a' },
    });
    await expect(
      facade.handle(JSON.stringify(envelope({ sessionId: 'session-b' }))),
    ).rejects.toMatchObject({ code: 'SCOPE_ACCESS_DENIED', path: 'sessionId' });
  });

  it('passes a fresh scoped persistence port to each injected factory scope', async () => {
    const persistence = new InMemoryPersistence();
    const received: RuntimeScope[] = [];
    const factory = createScopedRuntimeFactory({
      persistence,
      facadeFactory: (receivedScope, scopedPersistence) => {
        received.push(receivedScope);
        expect(scopedPersistence.scope).toEqual(receivedScope);
        return { handle: async () => null };
      },
    });

    const first = factory(scope('user-a', 'session-a'));
    const second = factory(scope('user-b', 'session-b'));

    expect(first.persistence).not.toBe(second.persistence);
    expect(received).toEqual([scope('user-a', 'session-a'), scope('user-b', 'session-b')]);
    await expect(first.facade.handle(envelope())).resolves.toBeNull();
    await expect(second.facade.handle(envelope())).resolves.toBeNull();
  });
});
