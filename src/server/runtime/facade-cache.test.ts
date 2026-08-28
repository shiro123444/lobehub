// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import type { RuntimeFacadePort } from './adapter';
import {
  createScopedRuntimeFacadeCache,
  RuntimeFacadeCacheError,
  runtimeFacadeFactoryFromScopeCache,
  ScopedRuntimeFacadeCache,
} from './facade-cache';
import type { RuntimeFacadeFactory, RuntimeFacadeFactoryResult } from './factory';

const request = (sessionId: string): Request =>
  new Request(`https://example.test/runtime?session=${sessionId}`);

const facadeFor = (name: string): RuntimeFacadePort => ({
  handle: vi.fn(async () => ({ name })),
});

const session = (userId = 'user-1', sessionId = 'session-1') => ({
  userId,
  sessionId,
  serverDB: { userId },
  request: request(sessionId),
});

describe('C-28 scoped RuntimeFacade cache', () => {
  it('loads once and reuses the same facade for one user/session scope', async () => {
    const facade = facadeFor('one');
    const factory = vi.fn<RuntimeFacadeFactory>(async (scope) => {
      expect(scope.userId).toBe('user-1');
      expect(scope.sessionId).toBe('session-1');
      expect(scope.serverDB).toEqual({ userId: 'user-1' });
      return facade;
    });
    const binding = createScopedRuntimeFacadeCache({ factory });

    const first = await binding.resolve(session());
    const second = await binding.resolve(session());

    expect(first).toBe(facade);
    expect(second).toBe(first);
    expect(factory).toHaveBeenCalledOnce();
    expect(binding.cache.size).toBe(1);
  });

  it('isolates distinct users and sessions', async () => {
    const factory = vi.fn<RuntimeFacadeFactory>(async ({ userId, sessionId }) =>
      facadeFor(`${userId}:${sessionId}`),
    );
    const binding = createScopedRuntimeFacadeCache({ factory });

    const userA = await binding.resolve(session('user-a', 'session-1'));
    const userB = await binding.resolve(session('user-b', 'session-1'));
    const sessionB = await binding.resolve(session('user-a', 'session-2'));

    expect(factory).toHaveBeenCalledTimes(3);
    expect(userB).not.toBe(userA);
    expect(sessionB).not.toBe(userA);
    expect(binding.cache.size).toBe(3);
  });

  it('coalesces concurrent cold loads for one scope', async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const facade = facadeFor('concurrent');
    const factory = vi.fn<RuntimeFacadeFactory>(async () => {
      await barrier;
      return facade;
    });
    const binding = createScopedRuntimeFacadeCache({ factory });

    const first = binding.resolve(session());
    const second = binding.resolve(session());
    release();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(facade);
    expect(secondResult).toBe(facade);
    expect(factory).toHaveBeenCalledOnce();
  });

  it('uses the injected request session resolver rather than a fixed session', async () => {
    const factory = vi.fn<RuntimeFacadeFactory>(async ({ sessionId }) => facadeFor(sessionId!));
    const binding = createScopedRuntimeFacadeCache({ factory });
    const scopedFactory = runtimeFacadeFactoryFromScopeCache(
      binding,
      (request) => request.headers.get('x-runtime-session') ?? undefined,
    );

    const first = await scopedFactory({
      userId: 'user-1',
      serverDB: 'db-1',
      request: new Request('https://example.test', {
        headers: { 'x-runtime-session': 'session-from-request' },
      }),
    });

    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', sessionId: 'session-from-request' }),
    );
    expect(first).toBe(await binding.resolve(session('user-1', 'session-from-request')));
  });

  it('rejects a missing session before calling the underlying factory', async () => {
    const factory = vi.fn<RuntimeFacadeFactory>(async () => facadeFor('never'));
    const binding = createScopedRuntimeFacadeCache({ factory });
    const scopedFactory = runtimeFacadeFactoryFromScopeCache(binding, () => undefined);

    await expect(
      scopedFactory({ userId: 'user-1', serverDB: 'db-1', request: request('ignored') }),
    ).rejects.toMatchObject({
      name: 'RuntimeFacadeCacheError',
      code: 'RUNTIME_FACADE_CACHE_SCOPE_INVALID',
      path: 'sessionId',
    });
    expect(factory).not.toHaveBeenCalled();
  });

  it('retries a failed cold load and preserves the original error', async () => {
    const failure = new Error('factory unavailable');
    const factory = vi
      .fn<RuntimeFacadeFactory>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(facadeFor('retry'));
    const binding = createScopedRuntimeFacadeCache({ factory });

    await expect(binding.resolve(session())).rejects.toBe(failure);
    await expect(binding.resolve(session())).resolves.toBeDefined();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('keeps a binding result intact, disposes it once, and can reload after reset', async () => {
    const firstFacade = facadeFor('binding');
    const dispose = vi.fn();
    const firstResult = { facade: firstFacade, adapter: {} as never, dispose };
    const secondFacade = facadeFor('reloaded');
    const factory = vi
      .fn<RuntimeFacadeFactory>()
      .mockResolvedValueOnce(firstResult)
      .mockResolvedValueOnce(secondFacade);
    const binding = createScopedRuntimeFacadeCache({ factory });

    const first = await binding.resolve(session());
    expect(first).toBe(firstResult as RuntimeFacadeFactoryResult);
    expect(binding.cache.peek({ userId: 'user-1', sessionId: 'session-1' })).toBe(firstFacade);
    expect(binding.reset()).toBe(1);
    expect(dispose).not.toHaveBeenCalled();
    await binding.resolve(session());
    expect(factory).toHaveBeenCalledTimes(2);

    await binding.dispose();
    await binding.dispose();
    expect(dispose).not.toHaveBeenCalled();
  });

  it('disposes a facade-owned resource and validates constructor inputs', async () => {
    const dispose = vi.fn();
    const facade = { ...facadeFor('owned'), dispose };
    const cache = new ScopedRuntimeFacadeCache({ load: async () => facade });

    await cache.resolve({ userId: 'user-1', sessionId: 'session-1' }, session());
    await cache.dispose();
    await cache.dispose();

    expect(dispose).toHaveBeenCalledOnce();
    expect(cache.size).toBe(0);
    expect(() => new ScopedRuntimeFacadeCache({ load: undefined as never })).toThrowError(
      RuntimeFacadeCacheError,
    );
  });
});
