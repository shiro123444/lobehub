import { describe, expect, it, vi } from 'vitest';

import {
  createPresentationGenerationEventPublisherFactory,
  createPresentationJobEventJournalFactory,
  createPresentationRouteJournalBindings,
  PresentationEventJournalCache,
  type PresentationJobEventJournalLoaderResult,
  ScopedPresentationJobEventJournalCache,
} from './event-journal-cache';
import { type PresentationJobEvent, PresentationJobEventJournal } from './job-event-journal';

const scope = (userId = 'user-1', sessionId = 'session-1') => ({ userId, sessionId });

const event = (jobId: string, seq: number, data: unknown = { seq }): PresentationJobEvent => ({
  data,
  job_id: jobId,
  protocol_version: 'runtime.v1',
  seq,
  type: 'presentation.job.updated',
});

const makeCache = (
  load: (
    value: ReturnType<typeof scope>,
    context?: unknown,
  ) => PresentationJobEventJournalLoaderResult | Promise<PresentationJobEventJournalLoaderResult>,
) => new ScopedPresentationJobEventJournalCache({ load });

describe('ScopedPresentationJobEventJournalCache', () => {
  it('requires both authenticated userId and sessionId', async () => {
    const cache = makeCache(async (value) => new PresentationJobEventJournal({ scope: value }));

    await expect(cache.resolve({ userId: 'user-1' } as never)).rejects.toMatchObject({
      code: 'PRESENTATION_EVENT_JOURNAL_CACHE_SCOPE_INVALID',
      path: 'sessionId',
    });
    expect(() => cache.peek({ userId: 'user-1', sessionId: '   ' })).toThrow(
      expect.objectContaining({
        code: 'PRESENTATION_EVENT_JOURNAL_CACHE_SCOPE_INVALID',
        path: 'sessionId',
      }),
    );
  });

  it('loads once, reuses the same journal, and exposes it through peek', async () => {
    const load = vi.fn(
      async (value: ReturnType<typeof scope>) => new PresentationJobEventJournal({ scope: value }),
    );
    const cache = makeCache(load);

    const first = await cache.resolve(scope(), { requestId: 'first' });
    const second = await cache.resolve(scope(), { requestId: 'second' });

    expect(second).toBe(first);
    expect(cache.peek(scope())).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(scope(), { requestId: 'first' });
  });

  it('isolates distinct users and sessions', async () => {
    const load = vi.fn(
      async (value: ReturnType<typeof scope>) => new PresentationJobEventJournal({ scope: value }),
    );
    const cache = makeCache(load);

    const userA = await cache.resolve(scope('user-a', 'session-1'));
    const userB = await cache.resolve(scope('user-b', 'session-1'));
    const sessionB = await cache.resolve(scope('user-a', 'session-2'));

    expect(userA).not.toBe(userB);
    expect(userA).not.toBe(sessionB);
    expect(userB).not.toBe(sessionB);
    userA.append('job-a', event('job-a', 1));
    expect(userB.replay('job-a')).toEqual([]);
    expect(sessionB.replay('job-a')).toEqual([]);
  });

  it('coalesces concurrent resolves for one scope', async () => {
    let release: ((journal: PresentationJobEventJournal) => void) | undefined;
    const loading = new Promise<PresentationJobEventJournal>((resolve) => {
      release = resolve;
    });
    const load = vi.fn(async (value: ReturnType<typeof scope>) => {
      await loading;
      return new PresentationJobEventJournal({ scope: value });
    });
    const cache = makeCache(load);
    const first = cache.resolve(scope());
    const second = cache.resolve(scope());

    expect(load).toHaveBeenCalledTimes(1);
    release!(new PresentationJobEventJournal({ scope: scope() }));

    await expect(Promise.all([first, second])).resolves.toSatisfy(([a, b]) => a === b);
    expect(cache.size).toBe(1);
  });

  it('rejects a loader that attempts to reuse one port across scopes', async () => {
    const journal = new PresentationJobEventJournal();
    const cache = makeCache(async () => journal);

    const first = await cache.resolve(scope('user-a', 'session-a'));
    await expect(cache.resolve(scope('user-b', 'session-b'))).rejects.toMatchObject({
      code: 'PRESENTATION_EVENT_JOURNAL_CACHE_SCOPE_DENIED',
    });
    first.append('job-a', event('job-a', 1));
    expect(first.replay('job-a')).toHaveLength(1);
  });

  it('lets publisher and SSE factories resolve the identical journal', async () => {
    const load = vi.fn(
      async (value: ReturnType<typeof scope>) => new PresentationJobEventJournal({ scope: value }),
    );
    const cache = makeCache(load);
    const journalFactory = createPresentationJobEventJournalFactory(cache);
    const publisherFactory = createPresentationGenerationEventPublisherFactory(cache, {
      now: () => '2026-08-30T00:00:00.000Z',
    });

    const publisher = await publisherFactory(scope(), 'job-1', new Request('https://example.test'));
    const journal = await journalFactory(scope(), { requestId: 'sse' });
    publisher.publish('job-1', 'presentation.job.accepted', { state: 'queued' });

    expect(journal).toBe(cache.peek(scope()));
    expect(journal.replay('job-1')).toHaveLength(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('builds both route factories from one cache and forwards generation inputs', async () => {
    const load = vi.fn(
      async (value: ReturnType<typeof scope>) => new PresentationJobEventJournal({ scope: value }),
    );
    const cache = makeCache(load);
    const now = () => '2026-08-30T00:00:00.000Z';
    const bindings = createPresentationRouteJournalBindings(cache, { now });
    const request = new Request('https://example.test/runtime/presentation/generate');

    const publisher = await bindings.generationEventPublisherFactory(scope(), 'job-1', request);
    const journal = await bindings.jobEventJournalFactory(scope(), { request });

    publisher.publish('job-1', 'presentation.job.accepted', { state: 'queued' });

    expect(journal).toBe(cache.peek(scope()));
    expect(journal.replay('job-1')).toHaveLength(1);
    expect(load).toHaveBeenCalledWith(scope(), { jobId: 'job-1', request });
  });

  it('keeps the bundled publisher and journal isolated across scopes', async () => {
    const cache = makeCache(async (value) => new PresentationJobEventJournal({ scope: value }));
    const bindings = createPresentationRouteJournalBindings(cache);
    const request = new Request('https://example.test/runtime/presentation/generate');
    const firstScope = scope('user-a', 'session-a');
    const secondScope = scope('user-b', 'session-b');

    const publisher = await bindings.generationEventPublisherFactory(firstScope, 'job-1', request);
    const firstJournal = await bindings.jobEventJournalFactory(firstScope);
    const secondJournal = await bindings.jobEventJournalFactory(secondScope);

    publisher.publish('job-1', 'presentation.job.accepted', { state: 'queued' });

    expect(firstJournal.replay('job-1')).toHaveLength(1);
    expect(secondJournal.replay('job-1')).toEqual([]);
  });

  it('passes bundled reset and dispose errors through both route seams', async () => {
    const cache = makeCache(async () => new PresentationJobEventJournal());
    const bindings = createPresentationRouteJournalBindings(cache);
    const request = new Request('https://example.test/runtime/presentation/generate');
    const publisher = await bindings.generationEventPublisherFactory(scope(), 'job-1', request);
    const journal = await bindings.jobEventJournalFactory(scope());

    cache.reset(scope());

    expect(() => publisher.publish('job-1', 'presentation.job.accepted', {})).toThrow(
      expect.objectContaining({ code: 'PRESENTATION_EVENT_JOURNAL_CACHE_RESET' }),
    );
    await expect(bindings.jobEventJournalFactory(scope())).resolves.not.toBe(journal);

    await cache.dispose();

    await expect(bindings.jobEventJournalFactory(scope())).rejects.toMatchObject({
      code: 'PRESENTATION_EVENT_JOURNAL_CACHE_DISPOSED',
    });
  });

  it('supports an injected separate subscriber binding and cleans it with reset', async () => {
    const source = new PresentationJobEventJournal();
    const subscriberDispose = vi.fn(() => source.dispose());
    const cache = makeCache(async () => ({
      journal: source,
      subscriber: { subscribe: source.subscribe.bind(source) },
      dispose: subscriberDispose,
    }));
    const journal = await cache.resolve(scope());
    const listener = vi.fn();
    journal.subscribe('job-1', listener);
    journal.append('job-1', event('job-1', 1));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(cache.reset(scope())).toBe(1);
    expect(subscriberDispose).toHaveBeenCalledTimes(1);
    expect(() => journal.append('job-1', event('job-1', 2))).toThrow(
      expect.objectContaining({ code: 'PRESENTATION_EVENT_JOURNAL_CACHE_RESET' }),
    );
    expect(() => journal.subscribe('job-1', listener)).toThrow(
      expect.objectContaining({ code: 'PRESENTATION_EVENT_JOURNAL_CACHE_RESET' }),
    );
  });

  it('allows a fresh journal after reset while rejecting the old one', async () => {
    const load = vi.fn(async () => new PresentationJobEventJournal());
    const cache = makeCache(load);
    const oldJournal = await cache.resolve(scope());

    expect(cache.reset(scope())).toBe(1);
    const freshJournal = await cache.resolve(scope());

    expect(freshJournal).not.toBe(oldJournal);
    expect(load).toHaveBeenCalledTimes(2);
    expect(() => oldJournal.append('job-1', event('job-1', 1))).toThrow(
      expect.objectContaining({ code: 'PRESENTATION_EVENT_JOURNAL_CACHE_RESET' }),
    );
    freshJournal.append('job-1', event('job-1', 1));
    expect(freshJournal.replay('job-1')).toHaveLength(1);
  });

  it('invalidates an in-flight resolve on reset and disposes the loaded journal', async () => {
    let release: ((journal: PresentationJobEventJournal) => void) | undefined;
    const loading = new Promise<PresentationJobEventJournal>((resolve) => {
      release = resolve;
    });
    const loaded = new PresentationJobEventJournal();
    const cache = makeCache(async () => loading);
    const pending = cache.resolve(scope());

    expect(cache.reset(scope())).toBe(1);
    release!(loaded);

    await expect(pending).rejects.toMatchObject({
      code: 'PRESENTATION_EVENT_JOURNAL_CACHE_RESET',
    });
    expect(() => loaded.append('job-1', event('job-1', 1))).toThrow(
      expect.objectContaining({ code: 'PRESENTATION_EVENT_JOURNAL_DISPOSED' }),
    );
  });

  it('disposes idempotently and rejects future resolves and old writes/subscriptions', async () => {
    const cache = makeCache(async () => new PresentationJobEventJournal());
    const journal = await cache.resolve(scope());
    const listener = vi.fn();
    journal.subscribe('job-1', listener);

    await cache.dispose();
    await cache.dispose();

    expect(cache.size).toBe(0);
    await expect(cache.resolve(scope())).rejects.toMatchObject({
      code: 'PRESENTATION_EVENT_JOURNAL_CACHE_DISPOSED',
    });
    expect(() => journal.append('job-1', event('job-1', 1))).toThrow(
      expect.objectContaining({ code: 'PRESENTATION_EVENT_JOURNAL_CACHE_DISPOSED' }),
    );
    expect(() => journal.subscribe('job-1', listener)).toThrow(
      expect.objectContaining({ code: 'PRESENTATION_EVENT_JOURNAL_CACHE_DISPOSED' }),
    );
  });

  it('supports scoped dispose without affecting another scope', async () => {
    const load = vi.fn(async () => new PresentationJobEventJournal());
    const cache = makeCache(load);
    const first = await cache.resolve(scope('user-a', 'session-a'));
    const second = await cache.resolve(scope('user-b', 'session-b'));

    await cache.dispose(scope('user-a', 'session-a'));

    await expect(cache.resolve(scope('user-a', 'session-a'))).rejects.toMatchObject({
      code: 'PRESENTATION_EVENT_JOURNAL_CACHE_DISPOSED',
    });
    await expect(cache.resolve(scope('user-b', 'session-b'))).resolves.toBe(second);
    expect(() => first.replay('job-1')).toThrow(
      expect.objectContaining({ code: 'PRESENTATION_EVENT_JOURNAL_CACHE_DISPOSED' }),
    );
  });

  it('does not cache loader failures and preserves the real error', async () => {
    const failure = new Error('journal loader failed');
    const load = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(new PresentationJobEventJournal());
    const cache = makeCache(load);

    await expect(cache.resolve(scope())).rejects.toBe(failure);
    await expect(cache.resolve(scope())).resolves.toBeDefined();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not create a singleton: separate caches keep separate journals', async () => {
    const firstCache = new PresentationEventJournalCache({
      load: async () => new PresentationJobEventJournal(),
    });
    const secondCache = new PresentationEventJournalCache({
      load: async () => new PresentationJobEventJournal(),
    });

    const first = await firstCache.resolve(scope());
    const second = await secondCache.resolve(scope());

    expect(first).not.toBe(second);
  });
});
