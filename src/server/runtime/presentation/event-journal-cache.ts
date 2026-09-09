import type {
  PresentationJobEvent,
  PresentationJobEventDisposer,
  PresentationJobEventJournalPort,
  PresentationJobEventListener,
  PresentationJobEventScope,
  PresentationJobEventSubscriptionOptions,
} from './job-event-journal';
import type {
  PresentationEventScope,
  PresentationJobEventPublisherOptions,
  PresentationJobEventPublisherPort,
} from './publisher';
import { createPresentationJobEventPublisher } from './publisher';

/** A server-authenticated cache key. Client headers are intentionally absent. */
export interface PresentationEventJournalScope {
  readonly sessionId: string;
  readonly userId: string;
}

export interface PresentationJobEventJournalSubscriberPort {
  readonly scope?: PresentationJobEventScope;
  subscribe: PresentationJobEventJournalPort['subscribe'];
}

export interface PresentationJobEventJournalBinding {
  readonly dispose?: () => void | Promise<void>;
  readonly journal: PresentationJobEventJournalPort;
  readonly subscriber?: PresentationJobEventJournalSubscriberPort;
}

export type PresentationJobEventJournalLoaderResult =
  | PresentationJobEventJournalBinding
  | PresentationJobEventJournalPort;

export type PresentationJobEventJournalLoader<TContext = unknown> = (
  scope: PresentationEventJournalScope,
  context?: TContext,
) => PresentationJobEventJournalLoaderResult | Promise<PresentationJobEventJournalLoaderResult>;

export type PresentationJobEventJournalCacheErrorCode =
  | 'PRESENTATION_EVENT_JOURNAL_CACHE_INVALID_LOADER'
  | 'PRESENTATION_EVENT_JOURNAL_CACHE_INVALID_PORT'
  | 'PRESENTATION_EVENT_JOURNAL_CACHE_RESET'
  | 'PRESENTATION_EVENT_JOURNAL_CACHE_SCOPE_DENIED'
  | 'PRESENTATION_EVENT_JOURNAL_CACHE_SCOPE_INVALID'
  | 'PRESENTATION_EVENT_JOURNAL_CACHE_DISPOSED';

export class PresentationJobEventJournalCacheError extends Error {
  constructor(
    public readonly code: PresentationJobEventJournalCacheErrorCode,
    message: string,
    public readonly path?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PresentationJobEventJournalCacheError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const normalizeScope = (scope: unknown): PresentationEventJournalScope => {
  if (!isRecord(scope)) {
    throw new PresentationJobEventJournalCacheError(
      'PRESENTATION_EVENT_JOURNAL_CACHE_SCOPE_INVALID',
      'userId and sessionId are required',
      'scope',
    );
  }
  if (!isNonEmptyString(scope.userId)) {
    throw new PresentationJobEventJournalCacheError(
      'PRESENTATION_EVENT_JOURNAL_CACHE_SCOPE_INVALID',
      'userId must be a non-empty string',
      'userId',
    );
  }
  if (!isNonEmptyString(scope.sessionId)) {
    throw new PresentationJobEventJournalCacheError(
      'PRESENTATION_EVENT_JOURNAL_CACHE_SCOPE_INVALID',
      'sessionId must be a non-empty string',
      'sessionId',
    );
  }
  return { userId: scope.userId, sessionId: scope.sessionId };
};

const scopeKey = (scope: PresentationEventJournalScope): string =>
  JSON.stringify([scope.userId, scope.sessionId]);

const isJournalPort = (value: unknown): value is PresentationJobEventJournalPort =>
  isRecord(value) &&
  typeof value.append === 'function' &&
  typeof value.dispose === 'function' &&
  typeof value.has === 'function' &&
  typeof value.replay === 'function' &&
  typeof value.subscribe === 'function';

const isSubscriberPort = (value: unknown): value is PresentationJobEventJournalSubscriberPort =>
  isRecord(value) && typeof value.subscribe === 'function';

interface ResolvedJournalBinding {
  readonly dispose: () => void | Promise<void>;
  readonly journal: PresentationJobEventJournalPort;
  readonly subscriber: PresentationJobEventJournalSubscriberPort;
}

const resolveBinding = (value: unknown): ResolvedJournalBinding => {
  if (isJournalPort(value)) {
    return {
      dispose: value.dispose.bind(value),
      journal: value,
      subscriber: value,
    };
  }
  if (!isRecord(value) || !isJournalPort(value.journal)) {
    throw new PresentationJobEventJournalCacheError(
      'PRESENTATION_EVENT_JOURNAL_CACHE_INVALID_PORT',
      'Loader must supply a PresentationJobEventJournalPort or binding',
      'journal',
    );
  }
  const subscriber = value.subscriber ?? value.journal;
  if (!isSubscriberPort(subscriber)) {
    throw new PresentationJobEventJournalCacheError(
      'PRESENTATION_EVENT_JOURNAL_CACHE_INVALID_PORT',
      'Journal binding subscriber must provide subscribe()',
      'subscriber',
    );
  }
  const dispose =
    typeof value.dispose === 'function'
      ? (value.dispose as () => void | Promise<void>).bind(value)
      : value.journal.dispose.bind(value.journal);
  return { dispose, journal: value.journal, subscriber };
};

const assertPortScope = (
  port: { readonly scope?: PresentationJobEventScope },
  scope: PresentationEventJournalScope,
  path: 'journal' | 'subscriber',
): void => {
  if (!port.scope) return;
  if (port.scope.userId !== scope.userId || port.scope.sessionId !== scope.sessionId) {
    throw new PresentationJobEventJournalCacheError(
      'PRESENTATION_EVENT_JOURNAL_CACHE_SCOPE_DENIED',
      `${path} scope does not match the authenticated user/session`,
      path,
    );
  }
};

type ClosedCode =
  | 'PRESENTATION_EVENT_JOURNAL_CACHE_RESET'
  | 'PRESENTATION_EVENT_JOURNAL_CACHE_DISPOSED';

class ScopedPresentationJobEventJournal implements PresentationJobEventJournalPort {
  readonly scope: PresentationEventJournalScope;

  private closedCode?: ClosedCode;
  private closePromise?: Promise<void>;

  constructor(
    private readonly binding: ResolvedJournalBinding,
    scope: PresentationEventJournalScope,
  ) {
    this.scope = scope;
  }

  get isClosed(): boolean {
    return this.closedCode !== undefined;
  }

  append(jobId: string, event: PresentationJobEvent): PresentationJobEvent | undefined {
    this.assertOpen();
    return this.binding.journal.append(jobId, event);
  }

  dispose(): void {
    void this.close('PRESENTATION_EVENT_JOURNAL_CACHE_DISPOSED').catch(() => undefined);
  }

  has(jobId: string): boolean {
    this.assertOpen();
    return this.binding.journal.has(jobId);
  }

  replay(jobId: string, afterSeq?: number): PresentationJobEvent[] {
    this.assertOpen();
    return this.binding.journal.replay(jobId, afterSeq);
  }

  subscribe(
    jobId: string,
    listener: PresentationJobEventListener,
    options?: PresentationJobEventSubscriptionOptions,
  ): PresentationJobEventDisposer {
    this.assertOpen();
    return this.binding.subscriber.subscribe(jobId, listener, options);
  }

  close(code: ClosedCode): Promise<void> {
    if (this.closedCode) return this.closePromise ?? Promise.resolve();
    this.closedCode = code;
    try {
      this.closePromise = Promise.resolve(this.binding.dispose());
    } catch (error) {
      this.closePromise = Promise.reject(error);
    }
    return this.closePromise;
  }

  private assertOpen(): void {
    if (this.closedCode) {
      throw new PresentationJobEventJournalCacheError(
        this.closedCode,
        this.closedCode === 'PRESENTATION_EVENT_JOURNAL_CACHE_RESET'
          ? 'Presentation event journal was reset'
          : 'Presentation event journal cache was disposed',
      );
    }
  }
}

interface JournalRecord {
  readonly journal: ScopedPresentationJobEventJournal;
  readonly key: string;
}

export interface ScopedPresentationJobEventJournalCacheOptions<TContext = unknown> {
  readonly load: PresentationJobEventJournalLoader<TContext>;
}

/**
 * Explicit, server-owned journal cache. The cache has no module-level state;
 * callers decide whether and where one instance is retained.
 */
export class ScopedPresentationJobEventJournalCache<TContext = unknown> {
  private readonly entries = new Map<string, JournalRecord>();
  private readonly generations = new Map<string, number>();
  private readonly invalidatedGenerations = new Map<string, Map<number, ClosedCode>>();
  private readonly journalOwners = new WeakMap<object, string>();
  private readonly tasks = new Map<string, Promise<JournalRecord>>();
  private readonly scopedDisposePromises = new Map<string, Promise<void>>();
  private readonly load: PresentationJobEventJournalLoader<TContext>;
  private readonly disposedScopes = new Set<string>();
  private disposed = false;
  private disposePromise?: Promise<void>;

  constructor(options: ScopedPresentationJobEventJournalCacheOptions<TContext>) {
    if (!options || typeof options.load !== 'function') {
      throw new PresentationJobEventJournalCacheError(
        'PRESENTATION_EVENT_JOURNAL_CACHE_INVALID_LOADER',
        'A presentation event journal loader is required',
        'load',
      );
    }
    this.load = options.load;
  }

  get size(): number {
    return this.entries.size;
  }

  peek(scope: PresentationEventJournalScope): PresentationJobEventJournalPort | undefined {
    const normalized = normalizeScope(scope);
    const key = scopeKey(normalized);
    if (this.disposed || this.disposedScopes.has(key)) return;
    const record = this.entries.get(key);
    if (!record || record.journal.isClosed) return;
    return record.journal;
  }

  async resolve(
    scope: PresentationEventJournalScope,
    context?: TContext,
  ): Promise<PresentationJobEventJournalPort> {
    const normalized = normalizeScope(scope);
    const key = scopeKey(normalized);
    this.assertCacheOpen(key);
    const ready = this.entries.get(key);
    if (ready && !ready.journal.isClosed) return ready.journal;
    if (ready) this.entries.delete(key);
    return (await this.taskFor(normalized, key, context)).journal;
  }

  async subscribe(
    scope: PresentationEventJournalScope,
    jobId: string,
    listener: PresentationJobEventListener,
    options?: PresentationJobEventSubscriptionOptions,
    context?: TContext,
  ): Promise<PresentationJobEventDisposer> {
    const journal = await this.resolve(scope, context);
    return journal.subscribe(jobId, listener, options);
  }

  reset(scope?: PresentationEventJournalScope): number {
    if (this.disposed) return 0;
    const keys =
      scope === undefined
        ? new Set<string>([...this.entries.keys(), ...this.tasks.keys()])
        : new Set([scopeKey(normalizeScope(scope))]);
    let removed = 0;
    for (const key of keys) {
      if (this.disposedScopes.has(key)) continue;
      this.invalidate(key, 'PRESENTATION_EVENT_JOURNAL_CACHE_RESET');
      const record = this.entries.get(key);
      if (record) {
        removed += 1;
        this.entries.delete(key);
        void record.journal.close('PRESENTATION_EVENT_JOURNAL_CACHE_RESET').catch(() => undefined);
      } else if (this.tasks.has(key)) {
        removed += 1;
      }
      this.tasks.delete(key);
    }
    return removed;
  }

  async dispose(scope?: PresentationEventJournalScope): Promise<void> {
    if (scope === undefined) {
      if (this.disposePromise) return this.disposePromise;
      this.disposed = true;
      this.disposePromise = this.disposeKeys(
        new Set<string>([...this.entries.keys(), ...this.tasks.keys()]),
      );
      return this.disposePromise;
    }
    const normalized = normalizeScope(scope);
    const key = scopeKey(normalized);
    if (this.disposed || this.disposedScopes.has(key)) {
      return this.scopedDisposePromises.get(key) ?? Promise.resolve();
    }
    this.disposedScopes.add(key);
    const promise = this.disposeKeys(new Set([key]));
    this.scopedDisposePromises.set(key, promise);
    await promise;
  }

  private taskFor(
    scope: PresentationEventJournalScope,
    key: string,
    context?: TContext,
  ): Promise<JournalRecord> {
    const existing = this.tasks.get(key);
    if (existing) return existing;
    const generation = this.generations.get(key) ?? 0;
    const task = this.loadRecord(scope, key, generation, context);
    this.tasks.set(key, task);
    const release = (): void => {
      if (this.tasks.get(key) === task) this.tasks.delete(key);
    };
    void task.then(release, release);
    return task;
  }

  private async loadRecord(
    scope: PresentationEventJournalScope,
    key: string,
    generation: number,
    context?: TContext,
  ): Promise<JournalRecord> {
    const binding = resolveBinding(await this.load(scope, context));
    let journal: ScopedPresentationJobEventJournal | undefined;
    try {
      assertPortScope(binding.journal, scope, 'journal');
      assertPortScope(binding.subscriber, scope, 'subscriber');
      if (
        this.hasForeignOwner(binding.journal, key) ||
        this.hasForeignOwner(binding.subscriber, key)
      ) {
        throw new PresentationJobEventJournalCacheError(
          'PRESENTATION_EVENT_JOURNAL_CACHE_SCOPE_DENIED',
          'Loader returned a port already bound to another user/session scope',
          'scope',
        );
      }
      this.claimPort(binding.journal, key, 'journal');
      this.claimPort(binding.subscriber, key, 'subscriber');
      journal = new ScopedPresentationJobEventJournal(binding, scope);
      if (!this.isCurrent(key, generation)) {
        const code = this.closeCodeFor(key, generation);
        await journal.close(code);
        throw this.lifecycleError(code);
      }
      const record = { journal, key };
      this.entries.set(key, record);
      return record;
    } catch (error) {
      if (journal) {
        await journal
          .close(
            this.isCurrent(key, generation)
              ? 'PRESENTATION_EVENT_JOURNAL_CACHE_DISPOSED'
              : this.closeCodeFor(key, generation),
          )
          .catch(() => undefined);
      } else if (
        !this.hasForeignOwner(binding.journal, key) &&
        !this.hasForeignOwner(binding.subscriber, key)
      ) {
        await Promise.resolve(binding.dispose()).catch(() => undefined);
      }
      throw error;
    }
  }

  private async disposeKeys(keys: Set<string>): Promise<void> {
    const tasks: Promise<JournalRecord>[] = [];
    const closes: Promise<void>[] = [];
    for (const key of keys) {
      this.invalidate(key, 'PRESENTATION_EVENT_JOURNAL_CACHE_DISPOSED');
      const task = this.tasks.get(key);
      if (task) tasks.push(task);
      this.tasks.delete(key);
      const record = this.entries.get(key);
      if (record) {
        this.entries.delete(key);
        closes.push(record.journal.close('PRESENTATION_EVENT_JOURNAL_CACHE_DISPOSED'));
      }
    }
    await Promise.allSettled(tasks);
    const results = await Promise.allSettled(closes);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure) throw failure.reason;
  }

  private claimPort(port: object, key: string, role: 'journal' | 'subscriber'): void {
    const owner = this.journalOwners.get(port);
    if (owner && owner !== key) {
      throw new PresentationJobEventJournalCacheError(
        'PRESENTATION_EVENT_JOURNAL_CACHE_SCOPE_DENIED',
        `${role} port is already bound to another user/session scope`,
        role,
      );
    }
    this.journalOwners.set(port, key);
  }

  private hasForeignOwner(port: object, key: string): boolean {
    const owner = this.journalOwners.get(port);
    return owner !== undefined && owner !== key;
  }

  private invalidate(key: string, code: ClosedCode): void {
    const generation = this.generations.get(key) ?? 0;
    const invalidated = this.invalidatedGenerations.get(key) ?? new Map<number, ClosedCode>();
    invalidated.set(generation, code);
    this.invalidatedGenerations.set(key, invalidated);
    this.generations.set(key, generation + 1);
  }

  private assertCacheOpen(key: string): void {
    if (this.disposed) {
      throw new PresentationJobEventJournalCacheError(
        'PRESENTATION_EVENT_JOURNAL_CACHE_DISPOSED',
        'Presentation event journal cache was disposed',
      );
    }
    if (this.disposedScopes.has(key)) {
      throw new PresentationJobEventJournalCacheError(
        'PRESENTATION_EVENT_JOURNAL_CACHE_DISPOSED',
        'Presentation event journal scope was disposed',
      );
    }
  }

  private isCurrent(key: string, generation: number): boolean {
    return !this.disposed && (this.generations.get(key) ?? 0) === generation;
  }

  private closeCodeFor(key: string, generation: number): ClosedCode {
    return (
      this.invalidatedGenerations.get(key)?.get(generation) ??
      (this.disposed || this.disposedScopes.has(key)
        ? 'PRESENTATION_EVENT_JOURNAL_CACHE_DISPOSED'
        : 'PRESENTATION_EVENT_JOURNAL_CACHE_RESET')
    );
  }

  private lifecycleError(code: ClosedCode): PresentationJobEventJournalCacheError {
    return new PresentationJobEventJournalCacheError(
      code,
      'Presentation event journal resolution was invalidated',
    );
  }
}

export type PresentationJobEventJournalFactory<TContext = unknown> = (
  scope: PresentationEventJournalScope,
  context?: TContext,
) => Promise<PresentationJobEventJournalPort>;

export const createPresentationJobEventJournalFactory = <TContext = unknown>(
  cache: ScopedPresentationJobEventJournalCache<TContext>,
): PresentationJobEventJournalFactory<TContext> => {
  if (!cache || typeof cache.resolve !== 'function') {
    throw new PresentationJobEventJournalCacheError(
      'PRESENTATION_EVENT_JOURNAL_CACHE_INVALID_PORT',
      'A scoped presentation event journal cache is required',
      'cache',
    );
  }
  return (scope, context) => cache.resolve(scope, context);
};

export const presentationJobEventJournalFactoryFromCache = createPresentationJobEventJournalFactory;

export interface PresentationGenerationEventPublisherFactoryOptions extends Pick<
  PresentationJobEventPublisherOptions,
  'now'
> {}

export interface PresentationRouteJournalBindingsOptions extends PresentationGenerationEventPublisherFactoryOptions {}

export type PresentationGenerationEventPublisherFactory = (
  scope: PresentationEventScope,
  jobId: string,
  request: Request,
) => PresentationJobEventPublisherPort | Promise<PresentationJobEventPublisherPort>;

/** Binds C-65 generation publishers to the same explicit cache as SSE. */
export const createPresentationGenerationEventPublisherFactory = (
  cache: ScopedPresentationJobEventJournalCache,
  options: PresentationGenerationEventPublisherFactoryOptions = {},
): PresentationGenerationEventPublisherFactory => {
  if (!cache || typeof cache.resolve !== 'function') {
    throw new PresentationJobEventJournalCacheError(
      'PRESENTATION_EVENT_JOURNAL_CACHE_INVALID_PORT',
      'A scoped presentation event journal cache is required',
      'cache',
    );
  }
  return async (scope, jobId, request) => {
    const journal = await cache.resolve(scope, { jobId, request });
    return createPresentationJobEventPublisher({
      journal,
      scope,
      ...(options.now ? { now: options.now } : {}),
    });
  };
};

export interface PresentationRouteJournalBindings {
  readonly generationEventPublisherFactory: PresentationGenerationEventPublisherFactory;
  readonly jobEventJournalFactory: PresentationJobEventJournalFactory;
}

/**
 * Creates the two route seams from one caller-owned cache. The bundle itself
 * is stateless; scope resolution and lifecycle errors remain owned by cache.
 */
export const createPresentationRouteJournalBindings = (
  cache: ScopedPresentationJobEventJournalCache,
  options: PresentationRouteJournalBindingsOptions = {},
): PresentationRouteJournalBindings => ({
  generationEventPublisherFactory: createPresentationGenerationEventPublisherFactory(
    cache,
    options,
  ),
  jobEventJournalFactory: createPresentationJobEventJournalFactory(cache),
});

export const createScopedPresentationJobEventJournalCache = <TContext = unknown>(
  options: ScopedPresentationJobEventJournalCacheOptions<TContext>,
): ScopedPresentationJobEventJournalCache<TContext> =>
  new ScopedPresentationJobEventJournalCache(options);

export { ScopedPresentationJobEventJournalCache as PresentationEventJournalCache };
