import { RUNTIME_PROTOCOL_VERSION } from '../../../../packages/runtime-contracts/src';

export interface PresentationJobEvent {
  readonly data: unknown;
  readonly job_id: string;
  readonly protocol_version: typeof RUNTIME_PROTOCOL_VERSION;
  readonly seq: number;
  readonly type: string;
}

export interface PresentationJobEventScope {
  readonly sessionId?: string;
  readonly userId: string;
}

export type PresentationJobEventListener = (event: PresentationJobEvent) => void;
export type PresentationJobEventDisposer = () => void;

export interface PresentationJobEventSubscriptionOptions {
  readonly signal?: AbortSignal;
}

export interface PresentationJobEventJournalPort {
  readonly scope?: PresentationJobEventScope;
  append: (jobId: string, event: PresentationJobEvent) => PresentationJobEvent | undefined;
  dispose: () => void;
  has: (jobId: string) => boolean;
  replay: (jobId: string, afterSeq?: number) => PresentationJobEvent[];
  subscribe: (
    jobId: string,
    listener: PresentationJobEventListener,
    options?: PresentationJobEventSubscriptionOptions,
  ) => PresentationJobEventDisposer;
}

export type PresentationJobEventJournalErrorCode =
  | 'PRESENTATION_EVENT_INVALID'
  | 'PRESENTATION_EVENT_SEQ_INVALID'
  | 'PRESENTATION_EVENT_JOURNAL_DISPOSED'
  | 'PRESENTATION_EVENT_SCOPE_DENIED';

export class PresentationJobEventJournalError extends Error {
  constructor(
    public readonly code: PresentationJobEventJournalErrorCode,
    message: string,
    public readonly path?: string,
  ) {
    super(message);
    this.name = 'PresentationJobEventJournalError';
  }
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const assertJobId = (jobId: string): void => {
  if (!isNonEmptyString(jobId)) {
    throw new PresentationJobEventJournalError(
      'PRESENTATION_EVENT_INVALID',
      'jobId must be a non-empty string',
      'jobId',
    );
  }
};

const assertAfterSeq = (afterSeq: number): void => {
  if (!Number.isSafeInteger(afterSeq) || afterSeq < -1) {
    throw new PresentationJobEventJournalError(
      'PRESENTATION_EVENT_SEQ_INVALID',
      'afterSeq must be a safe integer greater than or equal to -1',
      'after_seq',
    );
  }
};

const assertJsonSerializable = (value: unknown): void => {
  try {
    if (JSON.stringify(value) === undefined) throw new Error('value is undefined');
    structuredClone(value);
  } catch {
    throw new PresentationJobEventJournalError(
      'PRESENTATION_EVENT_INVALID',
      'event data must be JSON serializable',
      'data',
    );
  }
};

export function validatePresentationJobEvent(
  jobId: string,
  event: unknown,
): asserts event is PresentationJobEvent {
  assertJobId(jobId);
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new PresentationJobEventJournalError(
      'PRESENTATION_EVENT_INVALID',
      'event must be an object',
      'event',
    );
  }
  const candidate = event as Partial<PresentationJobEvent>;
  if (candidate.job_id !== jobId) {
    throw new PresentationJobEventJournalError(
      'PRESENTATION_EVENT_INVALID',
      'event job_id must match the journal jobId',
      'job_id',
    );
  }
  if (candidate.protocol_version !== RUNTIME_PROTOCOL_VERSION) {
    throw new PresentationJobEventJournalError(
      'PRESENTATION_EVENT_INVALID',
      `protocol_version must be ${RUNTIME_PROTOCOL_VERSION}`,
      'protocol_version',
    );
  }
  if (!isNonEmptyString(candidate.type)) {
    throw new PresentationJobEventJournalError(
      'PRESENTATION_EVENT_INVALID',
      'event type must be a non-empty string',
      'type',
    );
  }
  if (
    typeof candidate.seq !== 'number' ||
    !Number.isSafeInteger(candidate.seq) ||
    candidate.seq < 1
  ) {
    throw new PresentationJobEventJournalError(
      'PRESENTATION_EVENT_SEQ_INVALID',
      'event seq must be a positive safe integer',
      'seq',
    );
  }
  if (!('data' in candidate) || candidate.data === undefined) {
    throw new PresentationJobEventJournalError(
      'PRESENTATION_EVENT_INVALID',
      'event data is required',
      'data',
    );
  }
  assertJsonSerializable(candidate.data);
}

const copyValue = <T>(value: T): T => {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
};

const copyEvent = (event: PresentationJobEvent): PresentationJobEvent => ({
  data: copyValue(event.data),
  job_id: event.job_id,
  protocol_version: event.protocol_version,
  seq: event.seq,
  type: event.type,
});

const scopeKey = (scope: PresentationJobEventScope): string =>
  JSON.stringify([scope.userId, scope.sessionId ?? '']);

const validateScope = (scope: PresentationJobEventScope): PresentationJobEventScope => {
  if (!isNonEmptyString(scope?.userId)) {
    throw new PresentationJobEventJournalError(
      'PRESENTATION_EVENT_SCOPE_DENIED',
      'scope userId must be a non-empty string',
      'userId',
    );
  }
  if (scope.sessionId !== undefined && !isNonEmptyString(scope.sessionId)) {
    throw new PresentationJobEventJournalError(
      'PRESENTATION_EVENT_SCOPE_DENIED',
      'scope sessionId must be a non-empty string when provided',
      'sessionId',
    );
  }
  return { userId: scope.userId, ...(scope.sessionId ? { sessionId: scope.sessionId } : {}) };
};

interface Subscription {
  abortListener?: () => void;
  readonly listener: PresentationJobEventListener;
  active: boolean;
  readonly signal?: AbortSignal;
}

export interface PresentationJobEventJournalOptions {
  readonly scope?: PresentationJobEventScope;
}

/**
 * A server-only in-memory presentation event log. An instance may be bound to
 * one authenticated scope; production wiring should create/reuse such an
 * instance through a scope-aware factory rather than sharing it globally.
 */
export class PresentationJobEventJournal implements PresentationJobEventJournalPort {
  readonly scope?: PresentationJobEventScope;

  private readonly events = new Map<string, PresentationJobEvent[]>();
  private readonly subscriptions = new Map<string, Set<Subscription>>();
  private disposed = false;

  constructor(options: PresentationJobEventJournalOptions = {}) {
    this.scope = options.scope ? validateScope(options.scope) : undefined;
  }

  append(jobId: string, event: PresentationJobEvent): PresentationJobEvent | undefined {
    this.assertOpen();
    validatePresentationJobEvent(jobId, event);
    const stream = this.events.get(jobId) ?? [];
    const latest = stream.at(-1);
    if (latest && event.seq <= latest.seq) return;

    const stored = copyEvent(event);
    stream.push(stored);
    this.events.set(jobId, stream);
    for (const subscription of [...(this.subscriptions.get(jobId) ?? [])]) {
      if (!subscription.active) continue;
      try {
        subscription.listener(copyEvent(stored));
      } catch {
        // One consumer must not stop journal delivery to other consumers.
      }
    }
    return copyEvent(stored);
  }

  has(jobId: string): boolean {
    if (this.disposed) return false;
    assertJobId(jobId);
    return this.events.has(jobId);
  }

  replay(jobId: string, afterSeq = -1): PresentationJobEvent[] {
    if (this.disposed) return [];
    assertJobId(jobId);
    assertAfterSeq(afterSeq);
    return (this.events.get(jobId) ?? []).filter((event) => event.seq > afterSeq).map(copyEvent);
  }

  subscribe(
    jobId: string,
    listener: PresentationJobEventListener,
    options: PresentationJobEventSubscriptionOptions = {},
  ): PresentationJobEventDisposer {
    this.assertOpen();
    assertJobId(jobId);
    if (typeof listener !== 'function') {
      throw new PresentationJobEventJournalError(
        'PRESENTATION_EVENT_INVALID',
        'listener must be a function',
        'listener',
      );
    }

    const subscription: Subscription = {
      active: true,
      listener,
      signal: options.signal,
    };
    const subscriptions = this.subscriptions.get(jobId) ?? new Set<Subscription>();
    subscriptions.add(subscription);
    this.subscriptions.set(jobId, subscriptions);

    const dispose = (): void => {
      if (!subscription.active) return;
      subscription.active = false;
      subscriptions.delete(subscription);
      if (subscriptions.size === 0) this.subscriptions.delete(jobId);
      subscription.signal?.removeEventListener('abort', dispose);
    };
    subscription.abortListener = dispose;

    if (options.signal?.aborted) {
      dispose();
    } else {
      options.signal?.addEventListener('abort', dispose, { once: true });
    }
    return dispose;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [jobId, subscriptions] of this.subscriptions) {
      for (const subscription of subscriptions) {
        subscription.active = false;
        if (subscription.abortListener) {
          subscription.signal?.removeEventListener('abort', subscription.abortListener);
        }
      }
      this.subscriptions.delete(jobId);
    }
    this.events.clear();
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new PresentationJobEventJournalError(
        'PRESENTATION_EVENT_JOURNAL_DISPOSED',
        'Presentation event journal has been disposed',
      );
    }
  }
}

export { PresentationJobEventJournal as InMemoryPresentationJobEventJournal };
