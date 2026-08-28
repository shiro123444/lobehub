/**
 * C-21 Legacy Agent compatibility seam — pure mappings between the legacy
 * `agent_operations` world and runtime.v1 commands / RunSnapshot outputs.
 *
 * Everything here is structural: plain records in, plain records out. No
 * service, database, HTTP or execution-chain imports.
 */

import type { RuntimeCommandEnvelope } from '../adapter';
import {
  LEGACY_OPERATION_STATUSES,
  type LegacyAgentOperationError,
  type LegacyAgentOperationResumeInput,
  type LegacyAgentOperationStartInput,
  type LegacyAgentOperationView,
  LegacyCompatError,
  type LegacyOperationStatus,
} from './types';

/** Local copy of the frozen protocol version; cross-checked against @lobechat/runtime-contracts in tests. */
export const LEGACY_COMPAT_PROTOCOL_VERSION = 'runtime.v1' as const;

/** Local copy of contracts RUN_STATES; cross-checked against @lobechat/runtime-contracts in tests. */
export const LEGACY_COMPAT_RUN_STATES = [
  'created',
  'queued',
  'running',
  'waiting_tool',
  'waiting_human',
  'waiting_child',
  'retrying',
  'completed',
  'failed',
  'cancelled',
] as const;

export type LegacyCompatRunState = (typeof LEGACY_COMPAT_RUN_STATES)[number];

export const isLegacyCompatRunState = (value: unknown): value is LegacyCompatRunState =>
  typeof value === 'string' && (LEGACY_COMPAT_RUN_STATES as readonly string[]).includes(value);

export const isLegacyOperationStatus = (value: unknown): value is LegacyOperationStatus =>
  typeof value === 'string' && (LEGACY_OPERATION_STATUSES as readonly string[]).includes(value);

/** legacy agent_operations.status → runtime.v1 RunState. Unknown statuses return undefined. */
export const mapLegacyStatusToRunState = (status: string): LegacyCompatRunState | undefined => {
  switch (status) {
    case 'idle': {
      return 'created';
    }
    case 'running': {
      return 'running';
    }
    case 'waiting_for_human': {
      return 'waiting_human';
    }
    case 'done': {
      return 'completed';
    }
    case 'error': {
      return 'failed';
    }
    case 'interrupted': {
      return 'cancelled';
    }
    default: {
      return undefined;
    }
  }
};

const RUNNING_PROXY_STATES: readonly LegacyCompatRunState[] = [
  'running',
  'waiting_tool',
  'waiting_child',
  'retrying',
];

const TERMINAL_STATES: readonly LegacyCompatRunState[] = ['completed', 'failed', 'cancelled'];

export const isTerminalRunState = (state: LegacyCompatRunState): boolean =>
  TERMINAL_STATES.includes(state);

/** runtime.v1 RunState → legacy agent_operations.status. Unknown states return undefined. */
export const mapRunStateToLegacyStatus = (state: string): LegacyOperationStatus | undefined => {
  if (!isLegacyCompatRunState(state)) return undefined;
  if (state === 'created' || state === 'queued') return 'idle';
  if (RUNNING_PROXY_STATES.includes(state)) return 'running';
  if (state === 'waiting_human') return 'waiting_for_human';
  if (state === 'completed') return 'done';
  if (state === 'failed') return 'error';
  return 'interrupted';
};

/** Legacy completion_reason derived honestly from the run state. */
export const completionReasonFor = (state: LegacyCompatRunState): string | undefined => {
  if (state === 'completed') return 'done';
  if (state === 'failed') return 'error';
  if (state === 'cancelled') return 'interrupted';
  if (state === 'waiting_human') return 'waiting_for_human';
  return undefined;
};

// ---------------------------------------------------------------------------
// Envelope builders (runtime.v1 side of the seam)
// ---------------------------------------------------------------------------

export interface LegacyEnvelopeOverrides {
  readonly requestId: string;
}

export const buildRunStartEnvelope = (
  input: LegacyAgentOperationStartInput,
  requestId: string,
): RuntimeCommandEnvelope => ({
  protocol_version: LEGACY_COMPAT_PROTOCOL_VERSION,
  request_id: requestId,
  command: 'run.start',
  payload: {
    sessionId: input.sessionId,
    userMessage: input.userMessage,
    ...(input.agentId ? { profileId: input.agentId } : {}),
    ...(input.operationId ? { idempotencyKey: input.operationId } : {}),
    metadata: {
      ...compactEntries({
        operationId: input.operationId,
        trigger: input.trigger,
        topicId: input.topicId,
        threadId: input.threadId,
        taskId: input.taskId,
        groupId: input.groupId,
      }),
      ...input.metadata,
    },
    userContext: {
      userId: input.userId,
      ...compactEntries({ appContext: input.appContext }),
    },
  },
});

export const buildRunGetEnvelope = (
  operationId: string,
  requestId: string,
): RuntimeCommandEnvelope => ({
  protocol_version: LEGACY_COMPAT_PROTOCOL_VERSION,
  request_id: requestId,
  command: 'run.get',
  payload: { runId: operationId },
});

export const buildRunCancelEnvelope = (
  operationId: string,
  requestId: string,
): RuntimeCommandEnvelope => ({
  protocol_version: LEGACY_COMPAT_PROTOCOL_VERSION,
  request_id: requestId,
  command: 'run.cancel',
  payload: { runId: operationId },
});

export const buildRunResumeEnvelope = (
  operationId: string,
  resumeInput: LegacyAgentOperationResumeInput,
  requestId: string,
): RuntimeCommandEnvelope => ({
  protocol_version: LEGACY_COMPAT_PROTOCOL_VERSION,
  request_id: requestId,
  command: 'run.resume',
  payload: {
    runId: operationId,
    input: resumeInput.input,
    ...(resumeInput.metadata ? { metadata: resumeInput.metadata } : {}),
  },
});

// ---------------------------------------------------------------------------
// Snapshot parsing and RunSnapshot → legacy view projection
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const ownString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
};

const compactEntries = (entries: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));

/**
 * Structurally validates that a facade response looks like a RunSnapshot.
 * Throws LEGACY_COMPAT_RESPONSE_INVALID instead of fabricating a view when the
 * response cannot be trusted.
 */
export const parseRunSnapshotLike = (
  value: unknown,
): Record<string, unknown> & {
  runId: string;
  sessionId: string;
  state: LegacyCompatRunState;
} => {
  if (!isRecord(value)) {
    throw new LegacyCompatError(
      'LEGACY_COMPAT_RESPONSE_INVALID',
      'Runtime facade response must be an object',
    );
  }
  const runId = ownString(value, 'runId');
  if (!runId) {
    throw new LegacyCompatError(
      'LEGACY_COMPAT_RESPONSE_INVALID',
      'Runtime facade response must contain a non-empty runId',
      'runId',
    );
  }
  const sessionId = ownString(value, 'sessionId');
  if (!sessionId) {
    throw new LegacyCompatError(
      'LEGACY_COMPAT_RESPONSE_INVALID',
      'Runtime facade response must contain a non-empty sessionId',
      'sessionId',
    );
  }
  const state = value.state;
  if (!isLegacyCompatRunState(state)) {
    throw new LegacyCompatError(
      'LEGACY_COMPAT_RESPONSE_INVALID',
      'Runtime facade response must contain a known runtime.v1 run state',
      'state',
      { received: state },
    );
  }
  return { ...value, runId, sessionId, state };
};

const legacyErrorFromSnapshotError = (
  snapshot: Record<string, unknown>,
): LegacyAgentOperationError | undefined => {
  const raw = snapshot.error;
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) return { message: String(raw) };
  return { ...raw };
};

export const legacyViewFromSnapshot = (response: unknown): LegacyAgentOperationView => {
  const snapshot = parseRunSnapshotLike(response);
  const status = mapRunStateToLegacyStatus(snapshot.state);
  if (!status) {
    // Unreachable while LEGACY_COMPAT_RUN_STATES stays in sync with contracts.
    throw new LegacyCompatError(
      'LEGACY_COMPAT_RESPONSE_INVALID',
      `No legacy status maps from run state ${snapshot.state}`,
      'state',
    );
  }

  const metadata = isRecord(snapshot.metadata) ? snapshot.metadata : undefined;
  const operationId = (metadata ? ownString(metadata, 'operationId') : undefined) ?? snapshot.runId;

  const error = legacyErrorFromSnapshotError(snapshot);
  const completionReason = completionReasonFor(snapshot.state);
  const createdAt = ownString(snapshot, 'createdAt');
  const updatedAt = ownString(snapshot, 'updatedAt');

  return {
    operationId,
    ...(ownString(snapshot, 'profileId') ? { agentId: ownString(snapshot, 'profileId') } : {}),
    status,
    ...(error ? { error } : {}),
    ...(completionReason ? { completionReason } : {}),
    sessionId: snapshot.sessionId,
    runId: snapshot.runId,
    ...(createdAt ? { startedAt: createdAt } : {}),
    ...(updatedAt && isTerminalRunState(snapshot.state) ? { completedAt: updatedAt } : {}),
    source: 'runtime.v1',
  };
};

// ---------------------------------------------------------------------------
// Error normalization for facade rejections
// ---------------------------------------------------------------------------

/** Wraps an unexpected facade rejection while preserving its stable code/message. */
export const toLegacyCompatError = (error: unknown): LegacyCompatError => {
  if (error instanceof LegacyCompatError) return error;
  if (error instanceof Error) {
    const code =
      (typeof (error as { code?: unknown }).code === 'string' &&
        ((error as { code?: unknown }).code as string)) ||
      'LEGACY_COMPAT_RUNTIME_FAILED';
    return new LegacyCompatError(code, error.message);
  }
  if (isRecord(error)) {
    const code = ownString(error, 'code') ?? 'LEGACY_COMPAT_RUNTIME_FAILED';
    const message = ownString(error, 'message') ?? 'Runtime facade request failed';
    return new LegacyCompatError(code, message);
  }
  return new LegacyCompatError(
    'LEGACY_COMPAT_RUNTIME_FAILED',
    typeof error === 'string' ? error : 'Runtime facade request failed',
  );
};
