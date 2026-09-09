/**
 * C-82 server-only image-generation event seam.
 *
 * Events are scoped to an authenticated user/session and contain only
 * JSON-safe projections. This module deliberately has no provider, database,
 * HTTP, filesystem, or process boundary.
 */

import {
  type AssetMetadata,
  type AssetRef,
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeScope,
} from '../../../../packages/runtime-contracts/src';

export const IMAGE_GENERATION_EVENT_TYPES = {
  accepted: 'image.generation.accepted',
  assetReady: 'image.generation.asset.ready',
  cancelled: 'image.generation.cancelled',
  failed: 'image.generation.failed',
  progress: 'image.generation.progress',
  started: 'image.generation.started',
} as const;

export type ImageGenerationEventType =
  (typeof IMAGE_GENERATION_EVENT_TYPES)[keyof typeof IMAGE_GENERATION_EVENT_TYPES];

export interface ImageGenerationEvent {
  readonly assetId?: string;
  readonly data: Record<string, unknown>;
  readonly idempotencyKey: string;
  readonly jobId: string;
  readonly protocol_version: typeof RUNTIME_PROTOCOL_VERSION;
  readonly scope: RuntimeScope;
  readonly seq: number;
  readonly type: ImageGenerationEventType;
}

/** Optional typed projection used by asset-ready event producers. */
export interface ImageGenerationAssetEventData extends Record<string, unknown> {
  readonly asset?: AssetRef;
  readonly metadata?: AssetMetadata;
}

export interface ImageGenerationEventPublishInput {
  readonly assetId?: string;
  readonly data?: unknown;
  readonly idempotencyKey?: string;
  readonly jobId: string;
  readonly scope?: RuntimeScope;
  readonly type: ImageGenerationEventType | string;
}

export interface ImageGenerationEventJournalOptions {
  readonly scope?: RuntimeScope;
}

export interface ImageGenerationEventSubscriptionOptions {
  readonly signal?: AbortSignal;
}

export type ImageGenerationEventListener = (event: ImageGenerationEvent) => void;
export type ImageGenerationEventDisposer = () => void;

export interface ImageGenerationEventJournalPort {
  append: {
    (event: ImageGenerationEvent): ImageGenerationEvent | undefined;
    (jobId: string, event: ImageGenerationEvent): ImageGenerationEvent | undefined;
  };
  dispose: () => void;
  has: (jobId: string) => boolean;
  replay: (jobId: string, afterSeq?: number) => ImageGenerationEvent[];
  readonly scope?: RuntimeScope;
  subscribe: (
    jobId: string,
    listener: ImageGenerationEventListener,
    options?: ImageGenerationEventSubscriptionOptions,
  ) => ImageGenerationEventDisposer;
}

export type ImageGenerationEventErrorCode =
  | 'ASSET_EVENT_INVALID'
  | 'ASSET_EVENT_JOURNAL_DISPOSED'
  | 'ASSET_EVENT_PUBLISHER_DISPOSED'
  | 'ASSET_EVENT_PUBLISH_FAILED'
  | 'ASSET_IDEMPOTENCY_CONFLICT'
  | 'ASSET_SCOPE_MISMATCH';

export class ImageGenerationEventError extends Error {
  constructor(
    public readonly code: ImageGenerationEventErrorCode,
    message: string,
    public readonly path?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ImageGenerationEventError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const unsafeKey = (key: string): boolean =>
  /^(?:bytes?|buffer|path|workspace(?:Path)?|prompt|negativePrompt|secret|token|password|authorization|apiKey|accessKey|privateKey|clientSecret|argv|command|cookie)$/iu.test(
    key,
  );

const invalid = (message: string, path?: string): ImageGenerationEventError =>
  new ImageGenerationEventError('ASSET_EVENT_INVALID', message, path);

const scopeMismatch = (message: string, path = 'scope'): ImageGenerationEventError =>
  new ImageGenerationEventError('ASSET_SCOPE_MISMATCH', message, path);

const normalizeScope = (value: unknown): RuntimeScope => {
  if (!isRecord(value) || !nonEmptyString(value.userId)) {
    throw scopeMismatch('scope.userId must be a non-empty string', 'scope.userId');
  }
  if (!nonEmptyString(value.sessionId)) {
    throw scopeMismatch('scope.sessionId must be a non-empty string', 'scope.sessionId');
  }
  return { sessionId: value.sessionId.trim(), userId: value.userId.trim() };
};

const sameScope = (left: RuntimeScope, right: RuntimeScope): boolean =>
  left.userId === right.userId && left.sessionId === right.sessionId;

const copyScope = (scope: RuntimeScope): RuntimeScope => ({
  sessionId: scope.sessionId,
  userId: scope.userId,
});

const copyValue = <T>(value: T): T => {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
};

const projectWireValue = (
  value: unknown,
  key: string | undefined,
  seen: WeakSet<object>,
): unknown => {
  if (key && unsafeKey(key)) return undefined;
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    return value
      .map((item) => projectWireValue(item, undefined, seen))
      .filter((item): item is Exclude<typeof item, undefined> => item !== undefined);
  }
  if (!isPlainRecord(value)) return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  const output: Record<string, unknown> = {};
  for (const [nestedKey, nestedValue] of Object.entries(value)) {
    const projected = projectWireValue(nestedValue, nestedKey, seen);
    if (projected !== undefined) output[nestedKey] = projected;
  }
  return output;
};

const projectData = (value: unknown): Record<string, unknown> => {
  const projected = projectWireValue(value ?? {}, undefined, new WeakSet<object>());
  if (!isPlainRecord(projected)) throw invalid('data must be a plain object', 'data');
  return projected;
};

function assertJobId(jobId: unknown): asserts jobId is string {
  if (!nonEmptyString(jobId)) throw invalid('jobId must be a non-empty string', 'jobId');
}

function assertSeq(seq: unknown): asserts seq is number {
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) {
    throw invalid('seq must be a positive safe integer', 'seq');
  }
}

const assertAfterSeq = (afterSeq: number): void => {
  if (!Number.isSafeInteger(afterSeq) || afterSeq < -1) {
    throw invalid('afterSeq must be a safe integer greater than or equal to -1', 'afterSeq');
  }
};

function assertEventType(type: unknown): asserts type is ImageGenerationEventType {
  if (!Object.values(IMAGE_GENERATION_EVENT_TYPES).includes(type as ImageGenerationEventType)) {
    throw invalid('unsupported image-generation event type', 'type');
  }
}

const normalizeAssetId = (assetId: unknown): string | undefined => {
  if (assetId === undefined) return undefined;
  if (!nonEmptyString(assetId)) throw invalid('assetId must be non-empty when provided', 'assetId');
  return assetId.trim();
};

const normalizeIdempotencyKey = (key: unknown): string | undefined => {
  if (key === undefined) return undefined;
  if (!nonEmptyString(key)) {
    throw invalid('idempotencyKey must be non-empty when provided', 'idempotencyKey');
  }
  return key.trim();
};

function validateEvent(event: unknown): asserts event is ImageGenerationEvent {
  if (!isRecord(event)) throw invalid('event must be a plain object', 'event');
  assertJobId(event.jobId);
  assertEventType(event.type);
  assertSeq(event.seq);
  if (event.protocol_version !== RUNTIME_PROTOCOL_VERSION) {
    throw invalid(`protocol_version must be ${RUNTIME_PROTOCOL_VERSION}`, 'protocol_version');
  }
  if (!nonEmptyString(event.idempotencyKey)) {
    throw invalid('idempotencyKey must be a non-empty string', 'idempotencyKey');
  }
  normalizeScope(event.scope);
  normalizeAssetId(event.assetId);
  if (!isPlainRecord(event.data)) throw invalid('event data must be a plain object', 'data');
  const projected = projectData(event.data);
  if (JSON.stringify(projected) !== JSON.stringify(event.data)) {
    throw invalid('event data must be a projected wire-safe object', 'data');
  }
}

const copyEvent = (event: ImageGenerationEvent): ImageGenerationEvent => ({
  ...(event.assetId === undefined ? {} : { assetId: event.assetId }),
  data: copyValue(event.data),
  idempotencyKey: event.idempotencyKey,
  jobId: event.jobId,
  protocol_version: event.protocol_version,
  scope: copyScope(event.scope),
  seq: event.seq,
  type: event.type,
});

const eventIdentity = (event: ImageGenerationEvent): string =>
  JSON.stringify({
    assetId: event.assetId,
    data: event.data,
    jobId: event.jobId,
    scope: event.scope,
    type: event.type,
  });

interface Subscription {
  active: boolean;
  readonly listener: ImageGenerationEventListener;
  readonly signal?: AbortSignal;
}

/** A scope-bound in-memory journal; each instance is an independent seam. */
export class InMemoryImageGenerationEventJournal implements ImageGenerationEventJournalPort {
  private readonly events = new Map<string, ImageGenerationEvent[]>();
  private readonly eventKeys = new Map<string, ImageGenerationEvent>();
  private readonly subscriptions = new Map<string, Set<Subscription>>();
  private journalScope?: RuntimeScope;
  private disposed = false;

  constructor(options: ImageGenerationEventJournalOptions = {}) {
    this.journalScope = options.scope ? normalizeScope(options.scope) : undefined;
  }

  get scope(): RuntimeScope | undefined {
    return this.journalScope ? copyScope(this.journalScope) : undefined;
  }

  append(event: ImageGenerationEvent): ImageGenerationEvent | undefined;
  append(jobId: string, event: ImageGenerationEvent): ImageGenerationEvent | undefined;
  append(
    eventOrJobId: ImageGenerationEvent | string,
    suppliedEvent?: ImageGenerationEvent,
  ): ImageGenerationEvent | undefined {
    this.assertOpen();
    const event = typeof eventOrJobId === 'string' ? suppliedEvent : eventOrJobId;
    if (!event) throw invalid('event is required', 'event');
    validateEvent(event);
    if (typeof eventOrJobId === 'string' && event.jobId !== eventOrJobId) {
      throw invalid('event jobId must match append jobId', 'jobId');
    }
    const eventScope = normalizeScope(event.scope);
    this.bindScope(eventScope);

    const key = `${event.jobId}\u0000${event.idempotencyKey}`;
    const existingByKey = this.eventKeys.get(key);
    if (existingByKey) {
      if (eventIdentity(existingByKey) !== eventIdentity(event)) {
        throw new ImageGenerationEventError(
          'ASSET_IDEMPOTENCY_CONFLICT',
          'idempotencyKey is already bound to another event',
          'idempotencyKey',
        );
      }
      return copyEvent(existingByKey);
    }

    const stream = this.events.get(event.jobId) ?? [];
    const latest = stream.at(-1);
    if (latest && event.seq <= latest.seq) return;

    const stored = copyEvent(event);
    stream.push(stored);
    this.events.set(event.jobId, stream);
    this.eventKeys.set(key, stored);

    for (const subscription of this.subscriptions.get(event.jobId) ?? []) {
      if (!subscription.active) continue;
      try {
        subscription.listener(copyEvent(stored));
      } catch {
        // A consumer cannot prevent journal delivery to other consumers.
      }
    }
    return copyEvent(stored);
  }

  has(jobId: string): boolean {
    assertJobId(jobId);
    return !this.disposed && this.events.has(jobId);
  }

  replay(jobId: string, afterSeq = -1): ImageGenerationEvent[] {
    assertJobId(jobId);
    assertAfterSeq(afterSeq);
    if (this.disposed) return [];
    return (this.events.get(jobId) ?? []).filter((event) => event.seq > afterSeq).map(copyEvent);
  }

  subscribe(
    jobId: string,
    listener: ImageGenerationEventListener,
    options: ImageGenerationEventSubscriptionOptions = {},
  ): ImageGenerationEventDisposer {
    this.assertOpen();
    assertJobId(jobId);
    if (typeof listener !== 'function') throw invalid('listener must be a function', 'listener');

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
      options.signal?.removeEventListener('abort', dispose);
    };

    if (options.signal?.aborted) dispose();
    else options.signal?.addEventListener('abort', dispose, { once: true });
    return dispose;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscriptions of this.subscriptions.values()) {
      for (const subscription of subscriptions) subscription.active = false;
    }
    this.subscriptions.clear();
    this.events.clear();
    this.eventKeys.clear();
  }

  private bindScope(scope: RuntimeScope): void {
    if (this.journalScope && !sameScope(this.journalScope, scope)) {
      throw scopeMismatch('event scope does not match journal scope');
    }
    this.journalScope ??= copyScope(scope);
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new ImageGenerationEventError(
        'ASSET_EVENT_JOURNAL_DISPOSED',
        'image-generation event journal has been disposed',
      );
    }
  }
}

export interface ImageGenerationEventPublisherOptions {
  readonly journal: ImageGenerationEventJournalPort;
  readonly scope?: RuntimeScope;
}

export interface ImageGenerationEventPublisherPort {
  assertScope: (scope?: RuntimeScope) => void;
  dispose: () => void;
  publish: (input: ImageGenerationEventPublishInput) => ImageGenerationEvent;
  readonly scope?: RuntimeScope;
}

const isJournalPort = (value: unknown): value is ImageGenerationEventJournalPort =>
  isRecord(value) &&
  typeof value.append === 'function' &&
  typeof value.replay === 'function' &&
  typeof value.subscribe === 'function' &&
  typeof value.dispose === 'function';

/** Scope-bound publisher with monotonic sequencing and idempotent keys. */
export class ImageGenerationEventPublisher implements ImageGenerationEventPublisherPort {
  private readonly journal: ImageGenerationEventJournalPort;
  private readonly nextSeqByJob = new Map<string, number>();
  private readonly eventsByKey = new Map<string, ImageGenerationEvent>();
  private readonly publisherScope?: RuntimeScope;
  private disposed = false;

  constructor(options: ImageGenerationEventPublisherOptions);
  constructor(journal: ImageGenerationEventJournalPort, scope?: RuntimeScope);
  constructor(
    optionsOrJournal: ImageGenerationEventPublisherOptions | ImageGenerationEventJournalPort,
    legacyScope?: RuntimeScope,
  ) {
    const options = isJournalPort(optionsOrJournal)
      ? { journal: optionsOrJournal, ...(legacyScope ? { scope: legacyScope } : {}) }
      : optionsOrJournal;
    if (!options || !isJournalPort(options.journal)) {
      throw invalid('ImageGenerationEventJournalPort is required', 'journal');
    }
    this.journal = options.journal;
    this.publisherScope = options.scope ? normalizeScope(options.scope) : undefined;
    if (
      this.publisherScope &&
      this.journal.scope &&
      !sameScope(this.publisherScope, this.journal.scope)
    ) {
      throw scopeMismatch('publisher scope does not match journal scope');
    }
  }

  get scope(): RuntimeScope | undefined {
    return this.publisherScope ? copyScope(this.publisherScope) : this.journal.scope;
  }

  assertScope(scope?: RuntimeScope): void {
    const actual = scope ? normalizeScope(scope) : this.scope;
    if (!actual) throw scopeMismatch('an authenticated user/session scope is required');
    if (this.publisherScope && !sameScope(this.publisherScope, actual)) {
      throw scopeMismatch('publisher scope does not match event scope');
    }
    if (this.journal.scope && !sameScope(this.journal.scope, actual)) {
      throw scopeMismatch('event scope does not match journal scope');
    }
  }

  publish(input: ImageGenerationEventPublishInput): ImageGenerationEvent {
    this.assertOpen();
    if (!isRecord(input)) throw invalid('publish input must be an object', 'input');
    assertJobId(input.jobId);
    const type = input.type;
    assertEventType(type);
    const scope = input.scope ? normalizeScope(input.scope) : this.scope;
    if (!scope) throw scopeMismatch('an authenticated user/session scope is required');
    this.assertScope(scope);
    const assetId = normalizeAssetId(input.assetId);
    const data = projectData(input.data);
    const suppliedKey = normalizeIdempotencyKey(input.idempotencyKey);
    const localKey = suppliedKey ? `${input.jobId}\u0000${suppliedKey}` : undefined;
    const localExisting = localKey ? this.eventsByKey.get(localKey) : undefined;
    if (localExisting) {
      const requestedIdentity = eventIdentity({
        ...(assetId === undefined ? {} : { assetId }),
        data,
        idempotencyKey: localExisting.idempotencyKey,
        jobId: input.jobId,
        protocol_version: RUNTIME_PROTOCOL_VERSION,
        scope,
        seq: localExisting.seq,
        type,
      });
      if (requestedIdentity !== eventIdentity(localExisting)) {
        throw new ImageGenerationEventError(
          'ASSET_IDEMPOTENCY_CONFLICT',
          'idempotencyKey is already bound to another event',
          'idempotencyKey',
        );
      }
      return copyEvent(localExisting);
    }

    for (let attempt = 0; attempt < 16; attempt += 1) {
      const cachedNext = this.nextSeqByJob.get(input.jobId);
      const nextSeq = cachedNext ?? (this.journal.replay(input.jobId).at(-1)?.seq ?? 0) + 1;
      const idempotencyKey = suppliedKey ?? `event:${type}:${nextSeq}`;
      const candidate: ImageGenerationEvent = {
        ...(assetId === undefined ? {} : { assetId }),
        data,
        idempotencyKey,
        jobId: input.jobId,
        protocol_version: RUNTIME_PROTOCOL_VERSION,
        scope,
        seq: nextSeq,
        type,
      };
      const accepted = this.journal.append(candidate);
      if (accepted) {
        const stored = copyEvent(accepted);
        this.nextSeqByJob.set(input.jobId, Math.max(nextSeq + 1, stored.seq + 1));
        if (suppliedKey) this.eventsByKey.set(localKey!, stored);
        return stored;
      }
      this.nextSeqByJob.delete(input.jobId);
    }

    throw new ImageGenerationEventError(
      'ASSET_EVENT_PUBLISH_FAILED',
      'image-generation event journal did not accept the event',
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
      throw new ImageGenerationEventError(
        'ASSET_EVENT_PUBLISHER_DISPOSED',
        'image-generation event publisher has been disposed',
      );
    }
  }
}

export const createImageGenerationEventPublisher = (
  options: ImageGenerationEventPublisherOptions,
): ImageGenerationEventPublisher => new ImageGenerationEventPublisher(options);

export const ASSET_GENERATION_EVENT_TYPES = IMAGE_GENERATION_EVENT_TYPES;
export type AssetGenerationEvent = ImageGenerationEvent;
export type AssetGenerationEventErrorCode = ImageGenerationEventErrorCode;
export type AssetGenerationEventJournalOptions = ImageGenerationEventJournalOptions;
export type AssetGenerationEventJournalPort = ImageGenerationEventJournalPort;
export type AssetGenerationEventListener = ImageGenerationEventListener;
export type AssetGenerationEventPublishInput = ImageGenerationEventPublishInput;
export type AssetGenerationEventPublisherOptions = ImageGenerationEventPublisherOptions;
export type AssetGenerationEventPublisherPort = ImageGenerationEventPublisherPort;
export { ImageGenerationEventError as AssetGenerationEventError };
export { ImageGenerationEventPublisher as AssetGenerationEventPublisher };
export { InMemoryImageGenerationEventJournal as InMemoryAssetGenerationEventJournal };
