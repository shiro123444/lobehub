import { describe, expect, it } from 'vitest';

import {
  RUN_STATES,
  RUNTIME_PROTOCOL_VERSION,
} from '../../../../packages/runtime-contracts/src/index';
import {
  buildRunCancelEnvelope,
  buildRunGetEnvelope,
  buildRunResumeEnvelope,
  buildRunStartEnvelope,
  completionReasonFor,
  isTerminalRunState,
  LEGACY_COMPAT_PROTOCOL_VERSION,
  LEGACY_COMPAT_RUN_STATES,
  legacyViewFromSnapshot,
  mapLegacyStatusToRunState,
  mapRunStateToLegacyStatus,
  parseRunSnapshotLike,
  toLegacyCompatError,
} from './mapper';
import { LegacyCompatError } from './types';

const baseStartInput = {
  userId: 'user-1',
  userMessage: 'hello',
  agentId: 'agent-1',
  sessionId: 'session-1',
  topicId: 'topic-1',
  threadId: 'thread-1',
  taskId: 'task-1',
  trigger: 'chat',
  operationId: 'op-1',
} as const;

describe('C-21 mapper: local contract copies stay frozen', () => {
  it('keeps protocol version and run states in sync with @lobechat/runtime-contracts', () => {
    expect(LEGACY_COMPAT_PROTOCOL_VERSION).toBe(RUNTIME_PROTOCOL_VERSION);
    expect([...LEGACY_COMPAT_RUN_STATES]).toEqual([...RUN_STATES]);
  });
});

describe('C-21 mapper: status translation', () => {
  it('maps every legacy operation status onto its runtime.v1 run state', () => {
    expect(mapLegacyStatusToRunState('idle')).toBe('created');
    expect(mapLegacyStatusToRunState('running')).toBe('running');
    expect(mapLegacyStatusToRunState('waiting_for_human')).toBe('waiting_human');
    expect(mapLegacyStatusToRunState('done')).toBe('completed');
    expect(mapLegacyStatusToRunState('error')).toBe('failed');
    expect(mapLegacyStatusToRunState('interrupted')).toBe('cancelled');
    expect(mapLegacyStatusToRunState('mystery')).toBeUndefined();
  });

  it('maps every runtime.v1 run state back onto a legacy status', () => {
    expect(mapRunStateToLegacyStatus('created')).toBe('idle');
    expect(mapRunStateToLegacyStatus('queued')).toBe('idle');
    expect(mapRunStateToLegacyStatus('running')).toBe('running');
    expect(mapRunStateToLegacyStatus('waiting_tool')).toBe('running');
    expect(mapRunStateToLegacyStatus('waiting_child')).toBe('running');
    expect(mapRunStateToLegacyStatus('retrying')).toBe('running');
    expect(mapRunStateToLegacyStatus('waiting_human')).toBe('waiting_for_human');
    expect(mapRunStateToLegacyStatus('completed')).toBe('done');
    expect(mapRunStateToLegacyStatus('failed')).toBe('error');
    expect(mapRunStateToLegacyStatus('cancelled')).toBe('interrupted');
    expect(mapRunStateToLegacyStatus('flying')).toBeUndefined();
  });

  it('derives completion reasons only for honest states', () => {
    expect(completionReasonFor('completed')).toBe('done');
    expect(completionReasonFor('failed')).toBe('error');
    expect(completionReasonFor('cancelled')).toBe('interrupted');
    expect(completionReasonFor('waiting_human')).toBe('waiting_for_human');
    expect(completionReasonFor('running')).toBeUndefined();
    expect(isTerminalRunState('completed')).toBe(true);
    expect(isTerminalRunState('running')).toBe(false);
  });
});

describe('C-21 mapper: envelope builders', () => {
  it('builds a run.start envelope carrying legacy identity through metadata and idempotency', () => {
    const envelope = buildRunStartEnvelope(baseStartInput, 'req-1');

    expect(envelope.protocol_version).toBe(LEGACY_COMPAT_PROTOCOL_VERSION);
    expect(envelope.request_id).toBe('req-1');
    expect(envelope.command).toBe('run.start');
    expect(envelope.payload).toMatchObject({
      sessionId: 'session-1',
      userMessage: 'hello',
      profileId: 'agent-1',
      idempotencyKey: 'op-1',
      metadata: {
        operationId: 'op-1',
        trigger: 'chat',
        topicId: 'topic-1',
        threadId: 'thread-1',
        taskId: 'task-1',
      },
      userContext: { userId: 'user-1' },
    });
  });

  it('builds run.get / run.cancel / run.resume envelopes keyed by the legacy operation id', () => {
    expect(buildRunGetEnvelope('op-9', 'req-2').payload).toEqual({ runId: 'op-9' });
    expect(buildRunCancelEnvelope('op-9', 'req-3')).toMatchObject({
      command: 'run.cancel',
      payload: { runId: 'op-9' },
    });
    expect(
      buildRunResumeEnvelope('op-9', { input: 'again', metadata: { hint: true } }, 'req-4'),
    ).toMatchObject({
      command: 'run.resume',
      payload: { runId: 'op-9', input: 'again', metadata: { hint: true } },
    });
  });
});

describe('C-21 mapper: RunSnapshot → legacy view', () => {
  it('preserves legacy operationId/agentId/status/error fields from a full snapshot', () => {
    const view = legacyViewFromSnapshot({
      runId: 'run-1',
      sessionId: 'session-1',
      state: 'failed',
      profileId: 'agent-1',
      parentRunId: 'run-0',
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:01:00.000Z',
      result: null,
      error: { code: 'PROVIDER_TIMEOUT', message: 'upstream died', details: { attempt: 2 } },
      metadata: { operationId: 'op-legacy-1' },
    });

    expect(view).toMatchObject({
      operationId: 'op-legacy-1',
      agentId: 'agent-1',
      status: 'error',
      error: { code: 'PROVIDER_TIMEOUT', message: 'upstream died', details: { attempt: 2 } },
      completionReason: 'error',
      sessionId: 'session-1',
      runId: 'run-1',
      startedAt: '2026-08-27T00:00:00.000Z',
      completedAt: '2026-08-27T00:01:00.000Z',
      source: 'runtime.v1',
    });
  });

  it('falls back honestly when optional snapshot fields are missing', () => {
    const view = legacyViewFromSnapshot({
      runId: 'run-2',
      sessionId: 'session-2',
      state: 'running',
    });

    expect(view.operationId).toBe('run-2');
    expect(view.agentId).toBeUndefined();
    expect(view.error).toBeUndefined();
    expect(view.completionReason).toBeUndefined();
    expect(view.startedAt).toBeUndefined();
    expect(view.completedAt).toBeUndefined();
    expect(view.status).toBe('running');
    expect(view.source).toBe('runtime.v1');
  });

  it('rejects structurally untrustworthy snapshots instead of fabricating views', () => {
    expect(() => legacyViewFromSnapshot(null)).toThrow(LegacyCompatError);
    expect(() => legacyViewFromSnapshot({ state: 'running' })).toThrow(/runId/);
    expect(() => legacyViewFromSnapshot({ runId: 'r', state: 'running' })).toThrow(/sessionId/);
    expect(() => legacyViewFromSnapshot({ runId: 'r', sessionId: 's' })).toThrow(/state/);
    expect(() =>
      legacyViewFromSnapshot({ runId: 'r', sessionId: 's', state: 'quantum_superposition' }),
    ).toThrow(LegacyCompatError);

    const parsed = parseRunSnapshotLike({ runId: 'r', sessionId: 's', state: 'queued' });
    expect(parsed.state).toBe('queued');
  });

  it('normalizes unexpected errors while preserving their stable codes', () => {
    const codedError = Object.assign(new Error('boom'), { code: 'RUN_ALREADY_TERMINAL' });
    expect(toLegacyCompatError(codedError)).toMatchObject({
      code: 'RUN_ALREADY_TERMINAL',
      message: 'boom',
    });
    expect(
      toLegacyCompatError(new LegacyCompatError('LEGACY_COMPAT_INVALID_INPUT', 'x')),
    ).toBeInstanceOf(LegacyCompatError);
    expect(toLegacyCompatError('plain string')).toMatchObject({
      code: 'LEGACY_COMPAT_RUNTIME_FAILED',
    });
  });
});
