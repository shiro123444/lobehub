import type {
  ArtifactSnapshot,
  PresentationJob,
  PresentationJobState,
} from '../../../../packages/cordis-kernel/src/presentation';
import type { RunError } from '../../../../packages/runtime-contracts/src';
import type {
  PresentationJobEvent,
  PresentationJobEventJournalPort,
  PresentationJobEventScope,
} from './job-event-journal';

export const PRESENTATION_JOB_EVENT_TYPES = {
  accepted: 'presentation.job.accepted',
  artifactReady: 'presentation.job.artifact.ready',
  cancelled: 'presentation.job.cancelled',
  completed: 'presentation.job.completed',
  failed: 'presentation.job.failed',
  plannerStarted: 'presentation.job.planner.started',
  progress: 'presentation.job.progress',
  qualityFailed: 'presentation.job.quality.failed',
  queued: 'presentation.job.queued',
  workerStarted: 'presentation.job.worker.started',
} as const;

export type PresentationJobEventType =
  (typeof PRESENTATION_JOB_EVENT_TYPES)[keyof typeof PRESENTATION_JOB_EVENT_TYPES];

export interface PresentationEventScope {
  readonly sessionId: string;
  readonly userId: string;
}

export interface PresentationJobEventPublishOptions {
  readonly idempotencyKey?: string;
  readonly scope?: PresentationEventScope;
}

export interface PresentationJobEventPublishInput extends PresentationJobEventPublishOptions {
  readonly data: unknown;
  readonly jobId: string;
  readonly type: string;
}

export type PresentationJobEventPublisherErrorCode =
  | 'PRESENTATION_EVENT_PUBLISHER_DISPOSED'
  | 'PRESENTATION_EVENT_PUBLISHER_INVALID'
  | 'PRESENTATION_EVENT_SCOPE_DENIED'
  | 'PRESENTATION_EVENT_PUBLISH_FAILED';

export class PresentationJobEventPublisherError extends Error {
  constructor(
    public readonly code: PresentationJobEventPublisherErrorCode,
    message: string,
    public readonly path?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PresentationJobEventPublisherError';
  }
}

export interface PresentationJobEventPublisherPort {
  assertScope: (scope?: PresentationEventScope) => void;
  dispose: () => void;
  publish: {
    (input: PresentationJobEventPublishInput): PresentationJobEvent;
    (
      jobId: string,
      type: string,
      data: unknown,
      options?: PresentationJobEventPublishOptions,
    ): PresentationJobEvent;
  };
  readonly scope?: PresentationEventScope;
}

export interface PresentationJobEventPublisherOptions {
  readonly journal: PresentationJobEventJournalPort;
  readonly now?: () => string;
  readonly scope?: PresentationEventScope;
}

export interface PresentationJobSnapshotOptions {
  readonly artifactIds?: readonly string[];
  readonly createdAt?: string;
  readonly error?: unknown;
  readonly now?: () => string;
  readonly updatedAt?: string;
}

export interface PresentationEventArtifactInput {
  readonly artifactId?: string;
  readonly bytes?: Uint8Array;
  readonly createdAt?: string;
  readonly metadata?: Record<string, unknown>;
  readonly mimeType?: string;
  readonly name?: string;
  readonly path?: string;
  readonly sizeBytes?: number;
  readonly type?: string;
  readonly updatedAt?: string;
  readonly uri?: string;
}

const FORBIDDEN_WIRE_KEYS = new Set(['bytes', 'path', 'workspace', 'workspacePath']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/** Keep event payloads JSON-safe and prevent internal binary/path leakage. */
const wireSafe = (value: unknown, key: string | undefined, seen: WeakSet<object>): unknown => {
  if (key && FORBIDDEN_WIRE_KEYS.has(key)) return undefined;
  if (value instanceof Uint8Array) return undefined;
  if (Array.isArray(value)) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    return value
      .map((item) => wireSafe(item, undefined, seen))
      .filter((item): item is Exclude<typeof item, undefined> => item !== undefined);
  }
  if (isPlainRecord(value)) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    const output: Record<string, unknown> = {};
    for (const [nestedKey, nested] of Object.entries(value)) {
      const safe = wireSafe(nested, nestedKey, seen);
      if (safe !== undefined) output[nestedKey] = safe;
    }
    return output;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value;
  return undefined;
};

/** Keep event payloads JSON-safe and prevent internal binary/path leakage. */
export const presentationEventWireSafe = (value: unknown, key?: string): unknown =>
  wireSafe(value, key, new WeakSet<object>());

const invalid = (message: string, path?: string): PresentationJobEventPublisherError =>
  new PresentationJobEventPublisherError('PRESENTATION_EVENT_PUBLISHER_INVALID', message, path);

const scopeDenied = (message: string, path?: string): PresentationJobEventPublisherError =>
  new PresentationJobEventPublisherError('PRESENTATION_EVENT_SCOPE_DENIED', message, path);

const normalizeScope = (scope: unknown): PresentationEventScope => {
  if (!isRecord(scope)) throw scopeDenied('event scope is required', 'scope');
  if (!nonEmptyString(scope.userId)) throw scopeDenied('userId must be non-empty', 'userId');
  if (!nonEmptyString(scope.sessionId)) {
    throw scopeDenied('sessionId must be non-empty', 'sessionId');
  }
  return { userId: scope.userId, sessionId: scope.sessionId };
};

const normalizeJournalScope = (scope: PresentationJobEventScope): PresentationJobEventScope => {
  if (!nonEmptyString(scope.userId)) throw scopeDenied('userId must be non-empty', 'userId');
  if (scope.sessionId !== undefined && !nonEmptyString(scope.sessionId)) {
    throw scopeDenied('sessionId must be non-empty when provided', 'sessionId');
  }
  return {
    userId: scope.userId,
    ...(scope.sessionId !== undefined ? { sessionId: scope.sessionId } : {}),
  };
};

const matchesScope = (
  expected: PresentationJobEventScope | PresentationEventScope,
  actual: PresentationEventScope,
): boolean =>
  expected.userId === actual.userId &&
  (expected.sessionId === undefined || expected.sessionId === actual.sessionId);

const errorProperty = (error: unknown, key: string): unknown =>
  isRecord(error) ? error[key] : undefined;

export const presentationRunError = (
  error: unknown,
  fallbackCode = 'PRESENTATION_WORKER_FAILED',
): RunError => {
  const code = nonEmptyString(errorProperty(error, 'code'))
    ? (errorProperty(error, 'code') as string)
    : fallbackCode;
  const message =
    error instanceof Error && error.message
      ? error.message
      : nonEmptyString(errorProperty(error, 'message'))
        ? (errorProperty(error, 'message') as string)
        : String(error);
  const details = presentationEventWireSafe(errorProperty(error, 'details'));
  const cause = errorProperty(error, 'cause');
  const causeDetails =
    details === undefined && cause instanceof Error ? { cause: cause.message } : undefined;
  return {
    code,
    message,
    ...(details !== undefined || causeDetails !== undefined
      ? { details: details ?? causeDetails }
      : {}),
  };
};

export const createPresentationJobSnapshot = (
  jobId: string,
  state: PresentationJobState,
  options: PresentationJobSnapshotOptions = {},
): PresentationJob => {
  const now = options.now?.() ?? new Date().toISOString();
  return {
    jobId,
    state,
    ...(options.artifactIds ? { artifactIds: [...options.artifactIds] } : {}),
    ...(options.error !== undefined ? { error: presentationRunError(options.error) } : {}),
    createdAt: options.createdAt ?? now,
    updatedAt: options.updatedAt ?? now,
  };
};

export const createPresentationArtifactSnapshot = (
  jobId: string,
  artifact: PresentationEventArtifactInput,
  options: { readonly now?: () => string } = {},
): ArtifactSnapshot => {
  const now = options.now?.() ?? new Date().toISOString();
  const metadata = presentationEventWireSafe(artifact.metadata);
  const sizeBytes =
    artifact.sizeBytes ??
    (artifact.bytes instanceof Uint8Array ? artifact.bytes.byteLength : undefined);
  return {
    artifactId: nonEmptyString(artifact.artifactId) ? artifact.artifactId : `${jobId}:artifact`,
    createdAt: artifact.createdAt ?? now,
    ...(isPlainRecord(metadata) && Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(nonEmptyString(artifact.mimeType) ? { mimeType: artifact.mimeType } : {}),
    ...(nonEmptyString(artifact.name) ? { name: artifact.name } : {}),
    ...(typeof sizeBytes === 'number' && Number.isSafeInteger(sizeBytes) && sizeBytes >= 0
      ? { sizeBytes }
      : {}),
    status: 'ready',
    type: nonEmptyString(artifact.type) ? artifact.type : 'presentation',
    ...((artifact.updatedAt ?? now) ? { updatedAt: artifact.updatedAt ?? now } : {}),
    ...(nonEmptyString(artifact.uri) ? { uri: artifact.uri } : {}),
  };
};

const copyEvent = (event: PresentationJobEvent): PresentationJobEvent => {
  let data = event.data;
  try {
    data = structuredClone(event.data);
  } catch {
    // The journal validates data before accepting it; retain a safe fallback
    // for structural test doubles.
  }
  return {
    data,
    job_id: event.job_id,
    protocol_version: event.protocol_version,
    seq: event.seq,
    type: event.type,
  };
};

const isJournalPort = (value: unknown): value is PresentationJobEventJournalPort =>
  isRecord(value) &&
  typeof value.append === 'function' &&
  typeof value.replay === 'function' &&
  typeof value.dispose === 'function' &&
  typeof value.subscribe === 'function';

export class PresentationJobEventPublisher implements PresentationJobEventPublisherPort {
  readonly scope?: PresentationEventScope;

  private readonly journal: PresentationJobEventJournalPort;
  private readonly now: () => string;
  private readonly journalScope?: PresentationJobEventScope;
  private readonly nextSeqByJob = new Map<string, number>();
  private readonly eventsByKey = new Map<string, PresentationJobEvent>();
  private disposed = false;

  constructor(options: PresentationJobEventPublisherOptions);
  constructor(journal: PresentationJobEventJournalPort, scope?: PresentationEventScope);
  constructor(
    optionsOrJournal: PresentationJobEventPublisherOptions | PresentationJobEventJournalPort,
    legacyScope?: PresentationEventScope,
  ) {
    const options = isJournalPort(optionsOrJournal)
      ? { journal: optionsOrJournal, ...(legacyScope ? { scope: legacyScope } : {}) }
      : optionsOrJournal;
    if (!options || !isJournalPort(options.journal)) {
      throw invalid('PresentationJobEventJournalPort is required', 'journal');
    }
    this.journal = options.journal;
    this.now = options.now ?? (() => new Date().toISOString());
    this.journalScope = options.journal.scope
      ? normalizeJournalScope(options.journal.scope)
      : undefined;
    this.scope = options.scope ? normalizeScope(options.scope) : undefined;
    if (this.scope && this.journalScope && !matchesScope(this.journalScope, this.scope)) {
      throw scopeDenied('publisher scope does not match journal scope', 'scope');
    }
  }

  assertScope(scope?: PresentationEventScope): void {
    const actual = scope
      ? normalizeScope(scope)
      : (this.scope ??
        (this.journalScope?.sessionId
          ? { userId: this.journalScope.userId, sessionId: this.journalScope.sessionId }
          : undefined));
    if (!actual && (this.scope || this.journalScope)) {
      throw scopeDenied('an authenticated user/session scope is required', 'scope');
    }
    if (actual && this.scope && !matchesScope(this.scope, actual)) {
      throw scopeDenied('publisher scope does not match event scope', 'scope');
    }
    if (actual && this.journalScope && !matchesScope(this.journalScope, actual)) {
      throw scopeDenied('event scope does not match journal scope', 'scope');
    }
  }

  publish(input: PresentationJobEventPublishInput): PresentationJobEvent;
  publish(
    jobId: string,
    type: string,
    data: unknown,
    options?: PresentationJobEventPublishOptions,
  ): PresentationJobEvent;
  publish(
    inputOrJobId: PresentationJobEventPublishInput | string,
    type?: string,
    data?: unknown,
    options?: PresentationJobEventPublishOptions,
  ): PresentationJobEvent {
    const input: PresentationJobEventPublishInput =
      typeof inputOrJobId === 'string'
        ? {
            data,
            jobId: inputOrJobId,
            type: type ?? '',
            ...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
            ...(options?.scope ? { scope: options.scope } : {}),
          }
        : inputOrJobId;
    this.assertOpen();
    this.assertScope(input.scope);
    if (!nonEmptyString(input.jobId)) throw invalid('jobId must be non-empty', 'jobId');
    if (!nonEmptyString(input.type)) throw invalid('event type must be non-empty', 'type');
    if (input.idempotencyKey !== undefined && !nonEmptyString(input.idempotencyKey)) {
      throw invalid('idempotencyKey must be non-empty when provided', 'idempotencyKey');
    }
    const wireData = presentationEventWireSafe(input.data);
    if (wireData === undefined) throw invalid('event data must be JSON-safe', 'data');

    const key = input.idempotencyKey ? `${input.jobId}\u0000${input.idempotencyKey}` : undefined;
    const existing = key ? this.eventsByKey.get(key) : undefined;
    if (existing) return copyEvent(existing);

    let nextSeq = this.nextSeqByJob.get(input.jobId);
    if (nextSeq === undefined) {
      const existingEvents = this.journal.replay(input.jobId);
      nextSeq = (existingEvents.at(-1)?.seq ?? 0) + 1;
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const candidate: PresentationJobEvent = {
        data: wireData,
        job_id: input.jobId,
        protocol_version: 'runtime.v1',
        seq: nextSeq,
        type: input.type,
      };
      const accepted = this.journal.append(input.jobId, candidate);
      if (accepted) {
        const stored = copyEvent(accepted);
        const currentNext = this.nextSeqByJob.get(input.jobId) ?? 0;
        this.nextSeqByJob.set(input.jobId, Math.max(currentNext, stored.seq + 1));
        if (key) this.eventsByKey.set(key, stored);
        return copyEvent(stored);
      }
      const latest = this.journal.replay(input.jobId).at(-1)?.seq;
      if (latest === undefined || latest < nextSeq) break;
      nextSeq = latest + 1;
    }
    throw new PresentationJobEventPublisherError(
      'PRESENTATION_EVENT_PUBLISH_FAILED',
      'Presentation event journal did not accept the event',
      'journal',
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.nextSeqByJob.clear();
    this.eventsByKey.clear();
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new PresentationJobEventPublisherError(
        'PRESENTATION_EVENT_PUBLISHER_DISPOSED',
        'Presentation event publisher has been disposed',
      );
    }
  }
}

export const createPresentationJobEventPublisher = (
  options: PresentationJobEventPublisherOptions,
): PresentationJobEventPublisher => new PresentationJobEventPublisher(options);
