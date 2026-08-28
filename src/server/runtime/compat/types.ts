/**
 * C-21 Legacy Agent compatibility seam — shared structural types.
 *
 * This module is framework-neutral: it must never import AgentRuntimeService,
 * database schemas, or any execution chain. Legacy agents only exist here as
 * plain data structures (`LegacyAgentOperationView`) and as an injectable port
 * (`LegacyAgentOperationPort`) that a caller can back with the real legacy
 * service, an eval stub, or nothing at all.
 */

/** Statuses stored in the legacy `agent_operations` table. */
export const LEGACY_OPERATION_STATUSES = [
  'idle',
  'running',
  'waiting_for_human',
  'done',
  'error',
  'interrupted',
] as const;

export type LegacyOperationStatus = (typeof LEGACY_OPERATION_STATUSES)[number];

/** Error payload shape used by `agent_operations.error` (jsonb). */
export interface LegacyAgentOperationError {
  [key: string]: unknown;
  message?: string;
}

export interface LegacyAgentOperationStartInput {
  /** Legacy agent id; becomes `profileId` on the runtime.v1 side when present. */
  readonly agentId?: string;
  readonly appContext?: Record<string, unknown>;
  readonly groupId?: string;
  readonly metadata?: Record<string, unknown>;
  /**
   * Caller-provided legacy operation id. When supplied it is forwarded as both
   * `metadata.operationId` and `idempotencyKey` so runtime.v1 facades that map
   * idempotency keys onto runIds keep the legacy identifier stable.
   */
  readonly operationId?: string;
  readonly sessionId?: string;
  readonly taskId?: string;
  readonly threadId?: string;
  readonly topicId?: string;
  /** What initiated this operation (chat / signal / cron / bot / eval ...). */
  readonly trigger?: string;
  /** Owning user id; echoed through metadata and required for scope honesty. */
  readonly userId: string;
  readonly userMessage: string;
}

export interface LegacyAgentOperationResumeInput {
  readonly input: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * The single result shape returned by this seam regardless of which backend
 * (legacy path or runtime.v1) served the call. The legacy identity fields
 * `operationId` / `agentId` / `status` / `error` are always preserved.
 */
export interface LegacyAgentOperationView {
  readonly agentId?: string;
  readonly completedAt?: string;
  readonly completionReason?: string;
  readonly error?: LegacyAgentOperationError;
  readonly operationId: string;
  /** Runtime runId when the result was served from the runtime.v1 backend. */
  readonly runId?: string;
  readonly sessionId?: string;
  /** Which backend produced this view. */
  readonly source: 'legacy' | 'runtime.v1';
  readonly startedAt?: string;
  readonly status: LegacyOperationStatus;
}

/**
 * Injectable boundary for the legacy execution side. Implementations must be
 * externally scoped (typically per userId); this seam deliberately carries no
 * service constructor or DB access of its own.
 */
export interface LegacyAgentOperationPort {
  cancel: (operationId: string) => MaybePromise<LegacyAgentOperationView>;
  get: (operationId: string) => MaybePromise<LegacyAgentOperationView | null>;
  resume?: (
    operationId: string,
    input: LegacyAgentOperationResumeInput,
  ) => MaybePromise<LegacyAgentOperationView>;
  start: (input: LegacyAgentOperationStartInput) => MaybePromise<LegacyAgentOperationView>;
}

export type MaybePromise<T> = T | Promise<T>;

/** Stable error codes surfaced by the compatibility seam itself. */
export type LegacyCompatErrorCode =
  | 'LEGACY_COMPAT_INVALID_INPUT'
  | 'LEGACY_COMPAT_RESPONSE_INVALID'
  | 'LEGACY_COMPAT_RUNTIME_FAILED';

export class LegacyCompatError extends Error {
  constructor(
    public readonly code: LegacyCompatErrorCode | string,
    message: string,
    public readonly path?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'LegacyCompatError';
  }
}
