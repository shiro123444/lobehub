/**
 * QZ-CORDIS-A — Context/Fiber lifecycle compatibility suite.
 *
 * Baseline: 5ebc348f6a (packages/cordis-kernel).
 * Reference: /home/shiro/Projects/deepseek-harness/vendor/cordis/src/fiber.ts
 *
 * Two categories are kept apart on purpose:
 *
 * A. Verified upstream (dsh) behaviour — read off the vendored source, these
 *    are facts we may rely on when pinning the migration contract:
 *    - dsh:112-117 + :515  A public effect disposer is single-shot: a repeat
 *                          call returns undefined (`if (!runner.epoch) return ...
 *                          : undefined`). Joining an already-started cleanup is
 *                          the owner/outer effect's job, via `effectInertia`
 *                          and `runDisposable`.
 *    - dsh:458-483 + :504-520  The effect wrapper is registered before setup
 *                          runs, and `disposeAfter(waitForSetup())` runs a
 *                          disposer that arrives after an unload began, once.
 *    - dsh:675-696        `_unload` contains each disposer's failure so one
 *                          broken cleanup cannot strand the remaining ones.
 *
 *    These are not requirements imposed on this kernel; some tests encode them
 *    only to prove the reference really does differ from Qingzhou.
 *
 * B. Qingzhou compatibility requirements — the behaviour this kernel must
 *    guarantee after migration. When one of these fails, the reported reason is
 *    evidence about this kernel; whether it is a kernel gap or a wrong
 *    expectation must be judged per case, never assumed.
 *
 * Only public kernel API is used; no production code is modified.
 */

import { describe, expect, it } from 'vitest';

import { Context, PluginManager } from './index';
import type { RuntimePluginManifest } from './types';

const deferred = () => {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

/** Drain microtasks without sleeping. */
const flushMicrotasks = async (turns = 12): Promise<void> => {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
};

const manifest = (
  id: string,
  version: string,
  apply: RuntimePluginManifest['apply'],
  inject?: string[],
): RuntimePluginManifest => ({ id, version, kind: 'capability', apply, inject });

describe('QZ-CORDIS-A Context/Fiber lifecycle compatibility', () => {
  it('[1] runs a disposer that arrives after unload started, exactly once', async () => {
    const context = new Context();
    const gate = deferred();
    let disposerRuns = 0;

    context.effect(async () => {
      await gate.promise;
      return () => {
        disposerRuns += 1;
      };
    });

    const disposing = context.dispose();
    gate.resolve();
    await disposing;
    await flushMicrotasks();

    expect(disposerRuns).toBe(1);
  });

  it('[2] does not lose cleanup when setup disposes its owner synchronously', async () => {
    const context = new Context();
    let cleanupRuns = 0;
    let disposing: Promise<void> | undefined;

    let thrown: unknown;
    try {
      context.effect(() => {
        disposing = context.dispose();
        return () => {
          cleanupRuns += 1;
        };
      });
    } catch (error) {
      thrown = error;
    }

    await disposing;
    await flushMicrotasks();

    expect(thrown).toBeUndefined();
    expect(cleanupRuns).toBe(1);
  });

  it('[3] lets the owner dispose join the effect cleanup already in flight', async () => {
    const context = new Context();
    const gate = deferred();
    let cleanupRuns = 0;

    const dispose = context.effect(() => async () => {
      await gate.promise;
      cleanupRuns += 1;
    });

    // Upstream: the second *public* call is a no-op. The contract under test is
    // the owner join, so the second caller here is the owning context.
    const first = dispose();
    const second = context.dispose();

    let ownerSettled = false;
    void second.then(() => {
      ownerSettled = true;
    });
    await flushMicrotasks();

    // The owner unload must still be waiting on the in-flight cleanup.
    expect(ownerSettled).toBe(false);

    gate.resolve();
    await second;
    await flushMicrotasks();

    expect(cleanupRuns).toBe(1);
    await first;
  });

  it('[4] settles a self-initiated unload from setup after an await, cleaning once', async () => {
    const context = new Context();
    const reached = deferred();
    let selfDispose: Promise<void> | undefined;
    let cleanupRuns = 0;

    context.effect(async () => {
      await Promise.resolve();
      reached.resolve();
      // Initiate the owner unload without awaiting it here: awaiting inside
      // setup would make unload wait for setup while setup waits for unload.
      selfDispose = context.dispose();
      return () => {
        cleanupRuns += 1;
      };
    });

    await reached.promise;
    expect(selfDispose).toBeDefined();

    await selfDispose;
    await flushMicrotasks();

    expect(cleanupRuns).toBe(1);
  });

  it('[5] keeps cleaning remaining effects after one cleanup throws', async () => {
    const context = new Context();
    const ran: string[] = [];

    context.effect(() => () => {
      ran.push('first');
      throw new Error('cleanup boom');
    });
    context.effect(() => async () => {
      await Promise.resolve();
      ran.push('second');
    });
    context.effect(() => () => {
      ran.push('third');
    });

    await expect(context.dispose()).resolves.toBeUndefined();
    await flushMicrotasks();

    expect(ran.sort()).toEqual(['first', 'second', 'third']);
  });

  it('[6] refuses to publish a service from a fiber that is already unloading', async () => {
    const context = new Context();
    const gate = deferred();
    const lateAttempts: unknown[] = [];

    context.effect(async () => {
      await gate.promise;
      try {
        context.provide('late.service', { from: 'dying' });
      } catch (error) {
        lateAttempts.push(error);
      }
    });

    const disposing = context.dispose();
    gate.resolve();
    await disposing;
    await flushMicrotasks();

    expect(context.get('late.service')).toBeUndefined();
    expect(lateAttempts).toHaveLength(1);
    expect(lateAttempts[0]).toBeInstanceOf(Error);
  });

  it('[7] publishes a replacement service only after the candidate commits', async () => {
    const gate = deferred();
    const manager = new PluginManager([
      manifest('replacer', '1.0.0', (context) => {
        context.provide('svc', 'v1');
      }),
      manifest('replacer', '2.0.0', async (context) => {
        context.provide('svc', 'v2');
        await gate.promise;
      }),
    ]);

    await manager.mount('replacer');
    expect(manager.context.get('svc')).toBe('v1');

    const reloading = manager.reload('replacer');
    await flushMicrotasks();

    // Candidate holds its custom service staged: the live service must still be
    // the active v1, never the not-yet-committed v2 and never undefined.
    expect(manager.context.get('svc')).toBe('v1');

    gate.resolve();
    await reloading;

    expect(manager.context.get('svc')).toBe('v2');
    await manager.context.dispose();
  });

  it('[8] keeps a scope-A cleanup from removing a scope-B service', async () => {
    const root = new Context();
    const scopeA = root.withScope('a');
    const scopeB = root.withScope('b');

    root.provide('svc', 'root');
    const removeA = scopeA.provide('svc', 'a');
    scopeB.provide('svc', 'b');

    expect(scopeA.get('svc')).toBe('a');
    expect(scopeB.get('svc')).toBe('b');

    await removeA();

    expect(scopeA.get('svc')).toBe('root');
    expect(scopeB.get('svc')).toBe('b');
    expect(root.get('svc')).toBe('root');

    await root.dispose();
  });
});
