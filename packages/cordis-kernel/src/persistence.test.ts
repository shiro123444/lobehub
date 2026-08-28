import { describe, expect, it } from 'vitest';

import type {
  AgentProfile,
  RuntimeEvent,
  RuntimePluginInstallationInput,
  RuntimeRunInput,
} from './index';
import { InMemoryPersistence } from './index';

const runInput = (runId = 'run-1'): RuntimeRunInput => ({
  runId,
  sessionId: 'session-1',
  profileId: 'profile-1',
  strategyPluginId: 'general-chat',
  state: 'created',
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:00:00.000Z',
  metadata: { source: 'test' },
});

const event = (runId: string, seq: number, type = `run.event.${seq}`): RuntimeEvent => ({
  protocol_version: 'runtime.v1',
  session_id: 'session-1',
  run_id: runId,
  seq,
  type,
  data: { seq },
});

const installationInput = (
  id = 'builtin-tools',
  version = '1.0.0',
): RuntimePluginInstallationInput => ({
  id,
  version,
  kind: 'capability',
  source: 'builtin',
  state: 'installed',
  metadata: { owner: 'kernel' },
});

const profile: AgentProfile = {
  id: 'profile-1',
  strategyPluginId: 'general-chat',
  model: 'gpt-test',
  provider: 'test-provider',
  systemPrompt: 'Be concise.',
  enabledCapabilities: ['search', 'artifact'],
  metadata: { team: 'runtime' },
};

describe('@lobechat/cordis-kernel InMemoryPersistence', () => {
  it('creates and reads a runtime run through Promise-based CRUD', async () => {
    const persistence = new InMemoryPersistence();

    const created = await persistence.createRun(runInput());
    const read = await persistence.getRun('run-1');

    expect(created).toMatchObject({
      runId: 'run-1',
      sessionId: 'session-1',
      state: 'created',
      parentRunId: undefined,
    });
    expect(read).toEqual(created);
  });

  it('keeps duplicate run creation idempotent by runId', async () => {
    const persistence = new InMemoryPersistence();
    const first = await persistence.createRun(runInput());
    const duplicate = await persistence.createRun({ ...runInput(), state: 'running' });

    expect(duplicate).toEqual(first);
    expect(await persistence.listRuns()).toHaveLength(1);
  });

  it('updates and lists runtime runs without changing their identity', async () => {
    const persistence = new InMemoryPersistence();
    await persistence.createRun(runInput());

    const updated = await persistence.updateRun('run-1', {
      state: 'running',
      metadata: { source: 'test', priority: 'high' },
    });

    expect(updated).toMatchObject({
      runId: 'run-1',
      state: 'running',
      metadata: { source: 'test', priority: 'high' },
    });
    expect((await persistence.listRuns()).map(({ runId }) => runId)).toEqual(['run-1']);
  });

  it('deletes a runtime run and returns false when it is already absent', async () => {
    const persistence = new InMemoryPersistence();
    await persistence.createRun(runInput());

    await expect(persistence.deleteRun('run-1')).resolves.toBe(true);
    await expect(persistence.getRun('run-1')).resolves.toBeNull();
    await expect(persistence.deleteRun('run-1')).resolves.toBe(false);
  });

  it('appends ordered events and replays only events after afterSeq', async () => {
    const persistence = new InMemoryPersistence();
    await persistence.createRun(runInput());
    await persistence.appendRunEvent('run-1', event('run-1', 1));
    const second = await persistence.appendRunEvent('run-1', event('run-1', 2));

    await expect(persistence.getRunEvent('run-1', 2)).resolves.toEqual(second);
    await expect(persistence.replayRunEvents('run-1', 1)).resolves.toEqual([second]);
  });

  it('makes duplicate event writes idempotent without duplicating replay output', async () => {
    const persistence = new InMemoryPersistence();
    const first = await persistence.appendRunEvent('run-1', event('run-1', 1));
    const duplicate = await persistence.appendRunEvent('run-1', event('run-1', 1));

    expect(duplicate).toEqual(first);
    expect(await persistence.replayRunEvents('run-1')).toEqual([first]);
  });

  it('rejects descending or conflicting event sequences with EVENT_SEQ_INVALID', async () => {
    const persistence = new InMemoryPersistence();
    await persistence.appendRunEvent('run-1', event('run-1', 2));

    await expect(persistence.appendRunEvent('run-1', event('run-1', 1))).rejects.toMatchObject({
      code: 'EVENT_SEQ_INVALID',
    });
    await expect(
      persistence.appendRunEvent('run-1', event('run-1', 2, 'different-event')),
    ).rejects.toMatchObject({ code: 'EVENT_SEQ_INVALID' });
  });

  it('deletes an event stream and leaves an unknown replay empty', async () => {
    const persistence = new InMemoryPersistence();
    await persistence.appendRunEvent('run-1', event('run-1', 1));
    await persistence.appendRunEvent('run-1', event('run-1', 2));

    await expect(persistence.deleteRunEvents('run-1')).resolves.toBe(2);
    await expect(persistence.replayRunEvents('run-1')).resolves.toEqual([]);
    await expect(persistence.deleteRunEvents('missing')).resolves.toBe(0);
  });

  it('creates, reads, lists, and updates plugin installations by id and version', async () => {
    const persistence = new InMemoryPersistence({
      now: () => '2026-08-26T00:00:00.000Z',
    });
    const input = installationInput();
    const created = await persistence.createPluginInstallation(input);
    const updated = await persistence.updatePluginInstallation(input.id, input.version, {
      state: 'active',
    });

    expect(await persistence.getPluginInstallation(input.id, input.version)).toEqual(updated);
    expect(updated).toMatchObject({ id: input.id, version: input.version, state: 'active' });
    expect(await persistence.listPluginInstallations()).toEqual([updated]);
    expect(created.createdAt).toBe('2026-08-26T00:00:00.000Z');
  });

  it('deletes a plugin installation without affecting another version', async () => {
    const persistence = new InMemoryPersistence();
    await persistence.createPluginInstallation(installationInput('plugin', '1.0.0'));
    await persistence.createPluginInstallation(installationInput('plugin', '2.0.0'));

    await expect(persistence.deletePluginInstallation('plugin', '1.0.0')).resolves.toBe(true);
    await expect(persistence.getPluginInstallation('plugin', '1.0.0')).resolves.toBeNull();
    await expect(persistence.getPluginInstallation('plugin', '2.0.0')).resolves.toMatchObject({
      version: '2.0.0',
    });
  });

  it('writes and reads an AgentProfile-compatible projection', async () => {
    const persistence = new InMemoryPersistence();
    const saved = await persistence.putAgentProfile(profile);

    expect(saved).toEqual(profile);
    expect(await persistence.getAgentProfile(profile.id)).toEqual(profile);
    expect(await persistence.listAgentProfiles()).toEqual([profile]);
  });

  it('upserts profile projection fields and deletes the projection', async () => {
    const persistence = new InMemoryPersistence();
    await persistence.putAgentProfile(profile);
    const updated = await persistence.putAgentProfile({
      ...profile,
      enabledCapabilities: ['search'],
      metadata: { team: 'updated' },
    });

    expect(updated).toMatchObject({
      enabledCapabilities: ['search'],
      metadata: { team: 'updated' },
    });
    await expect(persistence.deleteAgentProfile(profile.id)).resolves.toBe(true);
    await expect(persistence.getAgentProfile(profile.id)).resolves.toBeNull();
  });

  it('exposes every persistence operation as a Promise', () => {
    const persistence = new InMemoryPersistence();
    const operations = [
      persistence.getRun('missing'),
      persistence.listRuns(),
      persistence.replayRunEvents('missing'),
      persistence.listPluginInstallations(),
      persistence.getAgentProfile('missing'),
      persistence.listAgentProfiles(),
    ];

    expect(operations.every((operation) => operation instanceof Promise)).toBe(true);
  });
});
