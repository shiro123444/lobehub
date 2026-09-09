import { describe, expect, it, vi } from 'vitest';

import type { PresentationPort } from '../../../../packages/cordis-kernel/src/presentation';
import type { PresentationCacheLoader, PresentationCacheScope } from './cache';
import {
  bindPresentationCacheShutdown,
  PresentationCacheError,
  ScopedPresentationPortCache,
} from './cache';

const scopeA: PresentationCacheScope = { userId: 'user-a', sessionId: 'session-a' };
const scopeB: PresentationCacheScope = { userId: 'user-b', sessionId: 'session-b' };

let portSequence = 0;

const makePort = (overrides: Partial<PresentationPort> = {}): PresentationPort => {
  portSequence += 1;
  return {
    createJob: vi.fn(async () => ({
      jobId: `job-${portSequence}`,
      state: 'queued' as const,
      createdAt: '',
      updatedAt: '',
    })),
    getJob: vi.fn(async () => null),
    cancelJob: vi.fn(),
    retryJob: vi.fn(),
    getArtifact: vi.fn(async () => null),
    exportArtifact: vi.fn(),
    ...overrides,
  };
};

describe('C-23 scoped PresentationPort cache', () => {
  it('reuses one port across requests in the same scope without re-running the loader', async () => {
    const load = vi.fn(() => makePort());
    const cache = new ScopedPresentationPortCache({ load });

    const first = await cache.resolve(scopeA);
    const second = await cache.resolve(scopeA);
    const third = await cache.resolve(scopeA);

    expect(load).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(cache.size).toBe(1);

    // The wrapper never executes the provider itself.
    expect(vi.mocked(first.getJob)).not.toHaveBeenCalled();
  });

  it('never shares ports between different scopes — userId and sessionId both isolate', async () => {
    const load = vi.fn(() => makePort());
    const cache = new ScopedPresentationPortCache({ load });

    const a = await cache.resolve({ ...scopeA });
    const sameUserOtherSession = await cache.resolve({ userId: 'user-a', sessionId: 'session-x' });
    const otherUserSameSession = await cache.resolve({ userId: 'user-b', sessionId: 'session-a' });
    const b = await cache.resolve(scopeB);

    expect(load).toHaveBeenCalledTimes(4);
    expect(sameUserOtherSession === a).toBe(false);
    expect(otherUserSameSession === a).toBe(false);
    expect(b === a).toBe(false);
    expect(cache.size).toBe(4);
  });

  it('rejects invalid scopes with a stable error and never touches the loader', async () => {
    const load = vi.fn(() => makePort());
    const cache = new ScopedPresentationPortCache({ load });

    for (const broken of [
      { userId: '', sessionId: 's' },
      { userId: 'u', sessionId: '' },
      { userId: undefined, sessionId: 's' },
      { userId: 'u', sessionId: 42 },
    ] as unknown as PresentationCacheScope[]) {
      await expect(cache.resolve(broken)).rejects.toMatchObject({
        code: 'PRESENTATION_CACHE_SCOPE_INVALID',
      });
    }
    expect(cache.size).toBe(0);
    expect(load).not.toHaveBeenCalled();
  });

  it('rejects structurally invalid loader output and does not cache it', async () => {
    const badValue = { createJob: 'not a function' };
    const load = vi.fn<PresentationCacheLoader>(() => Promise.resolve(badValue as never));
    const cache = new ScopedPresentationPortCache({ load });

    await expect(cache.resolve(scopeA)).rejects.toBeInstanceOf(PresentationCacheError);
    await expect(cache.resolve(scopeA)).rejects.toMatchObject({
      code: 'PRESENTATION_CACHE_INVALID_PORT',
    });
    // Failed attempts stay un-cached; swapping the loader behavior retries.
    load.mockImplementation(() => makePort());
    const recovered = await cache.resolve(scopeA);
    expect(recovered.createJob).toBeTypeOf('function');
    expect(cache.size).toBe(1);
  });

  it('coalesces concurrent resolves onto a single in-flight load per scope', async () => {
    let resolver!: (port: PresentationPort) => void;
    const deferred = new Promise<PresentationPort>((resolve) => {
      resolver = resolve;
    });
    const load = vi.fn(() => deferred);
    const cache = new ScopedPresentationPortCache({ load });

    // Start three concurrent resolves against one blocked loader.
    const pending = [cache.resolve(scopeA), cache.resolve(scopeA), cache.resolve(scopeA)];
    expect(load).toHaveBeenCalledTimes(1);

    const port = makePort();
    resolver(port);

    const [p1, p2, p3] = await Promise.all(pending);

    expect(p1 === p2 && p2 === p3).toBe(true);
    expect(p1).toBe(port);
    expect(load).toHaveBeenCalledTimes(1);
    expect(await cache.resolve(scopeA)).toBe(port);
  });

  it('does not cache rejected loads; the next resolve retried the loader', async () => {
    const failing = vi.fn<PresentationCacheLoader>(() =>
      Promise.reject(new Error('provider exploded')),
    );
    const cache = new ScopedPresentationPortCache({ load: failing });

    await expect(cache.resolve(scopeA)).rejects.toThrow('provider exploded');
    expect(cache.size).toBe(0);
    expect(cache.peek(scopeA)).toBeUndefined();

    failing.mockImplementation(() => makePort());
    const port = await cache.resolve(scopeA);
    expect(failing).toHaveBeenCalledTimes(2);
    expect(port.createJob).toBeTypeOf('function');
  });

  it('dispose(scope) awaits and runs attached disposers, evicting only that scope', async () => {
    const disposerA = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    const disposerB = vi.fn();
    const load = vi.fn((requestScope: PresentationCacheScope) =>
      requestScope.userId === 'user-a'
        ? Promise.resolve({ port: makePort(), dispose: disposerA })
        : Promise.resolve({ port: makePort(), dispose: disposerB }),
    );
    const cache = new ScopedPresentationPortCache({ load });

    const portA = await cache.resolve(scopeA);
    const portB = await cache.resolve(scopeB);
    await cache.dispose(scopeA);

    expect(disposerA).toHaveBeenCalledTimes(1);
    expect(disposerB).not.toHaveBeenCalled();
    expect(cache.size).toBe(1);
    expect(cache.peek(scopeB)).toBe(portB);
    // Re-resolving a disposed scope loads fresh again.
    const revived = await cache.resolve(scopeA);
    expect(revived === portA).toBe(false);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('falls back to a structurally present port.dispose and surfaces disposer failures honestly', async () => {
    const failingDisposer = vi.fn(() => {
      throw new Error('cleanup failed');
    });
    const okDisposer = vi.fn();

    const allScopeCache = new ScopedPresentationPortCache({
      load: (requestScope: PresentationCacheScope) =>
        requestScope.userId === 'user-a'
          ? { port: { ...makePort(), dispose: okDisposer } }
          : { port: makePort(), dispose: okDisposer },
    });

    await allScopeCache.resolve(scopeA);
    await allScopeCache.resolve(scopeB);
    await allScopeCache.dispose(); // binding-less loaders still find port.dispose structurally
    expect(okDisposer).toHaveBeenCalledTimes(2);
    expect(allScopeCache.size).toBe(0);
    await allScopeCache.dispose(); // idempotent empty dispose
    expect(okDisposer).toHaveBeenCalledTimes(2);

    const failingCache = new ScopedPresentationPortCache({
      load: () => ({ port: { ...makePort(), dispose: failingDisposer } }),
    });
    await failingCache.resolve(scopeA);
    await expect(failingCache.dispose(scopeA)).rejects.toThrow('cleanup failed');
  });

  it('dispose waits for in-flight loads so late ports cannot leak past shutdown', async () => {
    let releaseLoader!: (value: PresentationPort) => void;
    const gate = new Promise<PresentationPort>((resolve) => {
      releaseLoader = resolve;
    });
    const disposer = vi.fn();
    const load = vi.fn(() => gate.then((port) => ({ port, dispose: disposer })));
    const cache = new ScopedPresentationPortCache({ load });

    const resolving = cache.resolve(scopeA);
    const disposing = cache.dispose();

    releaseLoader(makePort());
    await disposing;

    expect(disposer).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(0);
    // The abandoned resolve still receives its port for caller-owned use, but
    // nothing survives in the cache — late loads cannot leak past shutdown.
    const abandoned = await resolving;
    expect(abandoned.createJob).toBeTypeOf('function');
    expect(cache.peek(scopeA)).toBeUndefined();
  });

  it('reset() evicts entries without invoking disposers or touching providers', async () => {
    const disposer = vi.fn();
    const cache = new ScopedPresentationPortCache({
      load: () => Promise.resolve({ port: makePort(), dispose: disposer }),
    });

    const first = await cache.resolve(scopeA);
    await cache.resolve(scopeB);
    expect(cache.reset(scopeA)).toBe(1);
    expect(cache.size).toBe(1);
    expect(disposer).not.toHaveBeenCalled();

    expect(cache.reset()).toBe(1);
    expect(cache.size).toBe(0);
    expect(disposer).not.toHaveBeenCalled();

    const next = await cache.resolve(scopeA);
    expect(next === first).toBe(false);
  });

  it('bindPresentationCacheShutdown wires opt-in dispose hooks to caller events with clean unbind', async () => {
    class FakeProcess {
      readonly listeners = new Map<string, Array<(...args: unknown[]) => unknown>>();

      on(event: string, listener: (...args: unknown[]) => unknown): void {
        this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
      }

      off(event: string, listener: (...args: unknown[]) => unknown): void {
        this.listeners.set(
          event,
          (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener),
        );
      }

      emit(event: string): void {
        for (const listener of this.listeners.get(event) ?? []) listener();
      }
    }

    const fakeProcess = new FakeProcess();
    const cache = new ScopedPresentationPortCache({ load: () => Promise.resolve(makePort()) });
    await cache.resolve(scopeA);

    const binding = bindPresentationCacheShutdown(cache, ['SIGTERM', 'SIGINT'], fakeProcess);
    expect(binding.events).toEqual(['SIGTERM', 'SIGINT']);

    fakeProcess.emit('SIGTERM');
    await new Promise((resolve) => setImmediate(resolve));
    expect(cache.size).toBe(0);

    // Pre-evicted cache already settled — emitting again must not explode.
    expect(() => fakeProcess.emit('SIGINT')).not.toThrow();

    binding.unbind();
    fakeProcess.emit('SIGTERM');
    expect((fakeProcess.listeners.get('SIGTERM') ?? []).length).toBe(0);
    expect(fakeProcess.listeners.get('SIGINT')).toEqual([]);
  });

  it('C-25: forwards the per-resolve context to the loader on misses and skips it on hits', async () => {
    const contextOne = { request: new Request('https://example.test/one') };
    const load = vi.fn((_scope, context) => {
      expect(context).toBe(contextOne);
      return Promise.resolve(makePort());
    });
    const cache = new ScopedPresentationPortCache({ load });

    const port = await cache.resolve(scopeA, contextOne);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0]?.[1]).toBe(contextOne);

    // Cache hit: no loader contact, so a different (even missing) context is fine.
    await cache.resolve(scopeA, undefined);
    expect(load).toHaveBeenCalledTimes(1);
    expect(port.createJob).toBeTypeOf('function');
  });

  it('C-25: coalesced concurrent misses ride the first caller context only', async () => {
    const contexts = [
      { request: new Request('https://example.test/a') },
      { request: new Request('https://example.test/b') },
      { request: new Request('https://example.test/c') },
    ];
    let released!: () => void;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    const load = vi.fn(async (_scope, context) => {
      if (!vi.mocked(load).mock.calls.some(([, seen]) => seen === contexts[0])) {
        // first call must see the first context
        expect(context).toBe(contexts[0]);
      }
      await gate;
      return makePort();
    });
    const cache = new ScopedPresentationPortCache({ load });

    const pending = [
      cache.resolve(scopeA, contexts[0]),
      cache.resolve(scopeA, contexts[1]),
      cache.resolve(scopeA, contexts[2]),
    ];
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0]?.[1]).toBe(contexts[0]);
    released();
    await Promise.all(pending);
  });
});
