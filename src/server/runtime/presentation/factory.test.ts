import { describe, expect, it, vi } from 'vitest';

import type { PresentationPort } from '../../../../packages/cordis-kernel/src/presentation';
import type { PresentationCachedSession } from './factory';
import { createScopedPresentationPortCache, getPresentationPortFactory } from './factory';

let portSequence = 0;

const makePort = (attachDisposer?: () => void): PresentationPort => {
  portSequence += 1;
  return {
    createJob: vi.fn(async () => ({
      jobId: `job-${portSequence}`,
      state: 'queued',
      createdAt: '',
      updatedAt: '',
    })),
    getJob: vi.fn(async () => null),
    cancelJob: vi.fn(),
    retryJob: vi.fn(),
    getArtifact: vi.fn(async () => null),
    exportArtifact: vi.fn(),
    ...(attachDisposer ? { dispose: attachDisposer } : {}),
  } as unknown as PresentationPort & { dispose?: () => void };
};

const session = (
  userId = 'user-1',
  sessionId = 'session-1',
  url = `https://example.test/session-${sessionId}-${Math.random().toString(36).slice(2)}`,
): PresentationCachedSession => ({ userId, sessionId, request: new Request(url) });

describe('C-25 scoped presentation cache factory integration', () => {
  it('wraps an existing factory and passes authenticated userId+sessionId+request+serverDB through on cold load', async () => {
    const baseFactory = vi.fn(() => makePort());
    const serverDBFor = vi.fn(() => ({ handle: 'db-stub' }));
    const binding = createScopedPresentationPortCache({ factory: baseFactory, serverDBFor });

    const request = new Request('https://example.test/api/runtime/presentation/jobs');
    const port = await binding.resolve({ userId: 'user-9', sessionId: 'session-9', request });

    expect(port.createJob).toBeTypeOf('function');
    expect(baseFactory).toHaveBeenCalledTimes(1);
    expect(baseFactory).toHaveBeenCalledWith({
      userId: 'user-9',
      sessionId: 'session-9',
      request,
      serverDB: { handle: 'db-stub' },
    });
    expect(serverDBFor).toHaveBeenCalledWith({
      userId: 'user-9',
      sessionId: 'session-9',
      request,
    });
    expect(vi.mocked(port.getJob)).not.toHaveBeenCalled();
  });

  it('reuses one port within a scope across new requests without re-running the wrapped factory', async () => {
    const baseFactory = vi.fn(() => makePort());
    const binding = createScopedPresentationPortCache({ factory: baseFactory });

    const first = await binding.resolve(session('u1', 's1'));
    const second = await binding.resolve(session('u1', 's1'));
    const third = await binding.resolve(session('u1', 's1'));

    expect(baseFactory).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(binding.cache.size).toBe(1);
  });

  it('isolates different scopes — every distinct {userId, sessionId} pair loads separately', async () => {
    const baseFactory = vi.fn(() => makePort());
    const binding = createScopedPresentationPortCache({ factory: baseFactory });

    const a = await binding.resolve(session('u1', 's1'));
    const b = await binding.resolve(session('u2', 's1'));
    const c = await binding.resolve(session('u1', 's2'));

    expect(baseFactory).toHaveBeenCalledTimes(3);
    expect(b === a).toBe(false);
    expect(c === a).toBe(false);
    expect(c === b).toBe(false);
    expect(binding.cache.size).toBe(3);
  });

  it('passes serverDB undefined when no resolver is configured, keeping the seam dependency-free', async () => {
    const baseFactory = vi.fn((_scope) => makePort());
    const binding = createScopedPresentationPortCache({ factory: baseFactory });

    await binding.resolve(session());

    expect(baseFactory.mock.calls[0]?.[0]).toMatchObject({
      userId: 'user-1',
      sessionId: 'session-1',
      serverDB: undefined,
    });
  });

  it('rejects invalid or missing Request with a stable code before any provider contact', async () => {
    const baseFactory = vi.fn(() => makePort());
    const binding = createScopedPresentationPortCache({ factory: baseFactory });

    for (const broken of [
      session('user-1', '', 'https://example.test/x'),
      session('', 'session-1'),
      { userId: 'user-1', sessionId: 'session-1', request: undefined },
      { userId: 'user-1', sessionId: 'session-1', request: 'not-a-request' },
    ] as unknown as PresentationCachedSession[]) {
      await expect(binding.resolve(broken)).rejects.toMatchObject({
        name: 'PresentationCacheError',
      });
    }
    expect(baseFactory).not.toHaveBeenCalled();
    expect(binding.cache.size).toBe(0);

    // Direct raw-cache use without context is also guarded inside the loader.
    await expect(
      binding.cache.resolve({ userId: 'user-1', sessionId: 'session-1' }),
    ).rejects.toMatchObject({ code: 'PRESENTATION_CACHE_REQUEST_INVALID' });
    expect(baseFactory).not.toHaveBeenCalled();
  });

  it('reset()/dispose() delegate to the cache: disposers run on dispose, not on reset; reload afterwards is fresh', async () => {
    const disposer = vi.fn();
    const baseFactory = vi.fn(() => makePort(disposer));
    const binding = createScopedPresentationPortCache({ factory: baseFactory });

    const original = await binding.resolve(session());
    expect(binding.reset()).toBe(1);
    expect(disposer).not.toHaveBeenCalled();

    const afterReset = await binding.resolve(session());
    expect(afterReset === original).toBe(false);

    await binding.dispose();
    expect(disposer).toHaveBeenCalledTimes(1);
    expect(binding.cache.size).toBe(0);
    await binding.dispose(); // idempotent
    expect(disposer).toHaveBeenCalledTimes(1);

    const revived = await binding.resolve(session());
    expect(revived === afterReset).toBe(false);
    expect(baseFactory).toHaveBeenCalledTimes(3);
  });

  it('requires a real factory function at construction and installs nothing globally', () => {
    expect(() => createScopedPresentationPortCache({ factory: undefined as never })).toThrowError(
      /PresentationPortFactory/,
    );

    // Creating a binding must not reconfigure the module-level presentation
    // factory wiring: the default (unconfigured) resolver stays untouched.
    const before = getPresentationPortFactory();
    createScopedPresentationPortCache({ factory: vi.fn(() => makePort()) });
    expect(getPresentationPortFactory()).toBe(before);
  });
});
