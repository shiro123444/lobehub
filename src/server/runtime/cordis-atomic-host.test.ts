/**
 * QZ-CORDIS-C — CordisAtomicHost behaviour suite.
 *
 * Only meaningful behaviour is asserted: the host must really sit on the
 * vendored upstream Cordis, real fibers must own tool lifetimes, staged
 * candidates (including nested ones) must stay hidden until committed, and a
 * fiber that never activates must be rejected.
 */

import { describe, expect, it } from 'vitest';

import * as Cordis from '../../../packages/cordis-foundation/src';
import type {
  RuntimeContext,
  RuntimePluginManifest,
} from '../../../packages/cordis-kernel/src/types';
import { CordisAtomicHost } from './cordis-atomic-host';

type ScopedRuntimeContext = RuntimeContext & { readonly scope?: string; invocation?: unknown };

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

/** Drain microtasks without sleeping. */
const flushMicrotasks = async (turns = 12): Promise<void> => {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
};

const toolDef = (name: string, value: unknown) => ({
  name,
  description: name,
  inputSchema: {},
  execute: () => value,
});

const manifestOf = (
  id: string,
  version: string,
  apply: (context: RuntimeContext) => void | Promise<void>,
  inject?: string[],
): RuntimePluginManifest => ({ id, version, kind: 'capability', apply, inject });

const names = (host: CordisAtomicHost) => host.tools.list().map((tool) => tool.name);

describe('QZ-CORDIS-C CordisAtomicHost', () => {
  it('[1] mounts onto the real upstream Cordis context', async () => {
    const host = new CordisAtomicHost();

    expect(Cordis.Context.is(host.native)).toBe(true);
    expect(host.context.fiber.state).toBe('active');

    await host.dispose();
  });

  it('[2] registers tools on the real fiber and reclaims them on unload', async () => {
    const host = new CordisAtomicHost();
    const instance = await host.mount(
      manifestOf('alpha.plugin', '1.0.0', (context) => {
        host.tools.register(context, toolDef('alpha.op', 'alpha'));
      }),
    );

    expect(instance.state).toBe('active');
    expect(names(host)).toEqual(['alpha.op']);
    await expect(host.tools.execute('alpha.op', {}, host.context)).resolves.toBe('alpha');

    await instance.dispose();

    expect(names(host)).toEqual([]);
    await expect(host.tools.execute('alpha.op', {}, host.context)).rejects.toMatchObject({
      code: 'TOOL_NOT_FOUND',
    });

    await host.dispose();
  });

  it('[3] keeps live tools and preserves the cause when a staged candidate fails', async () => {
    const host = new CordisAtomicHost();
    await host.mount(
      manifestOf('stable.plugin', '1.0.0', (context) => {
        host.tools.register(context, toolDef('stable.op', 'stable'));
      }),
    );

    const cause = new Error('provider missing');
    const failure = new Error('candidate exploded', { cause });

    await expect(
      host.mount(
        manifestOf('candidate.plugin', '1.0.0', (context) => {
          host.tools.register(context, toolDef('candidate.op', 'candidate'));
          throw failure;
        }),
        true,
      ),
    ).rejects.toBe(failure);

    expect(failure.cause).toBe(cause);
    expect(names(host)).toEqual(['stable.op']);
    await expect(host.tools.execute('stable.op', {}, host.context)).resolves.toBe('stable');
    await expect(host.tools.execute('candidate.op', {}, host.context)).rejects.toMatchObject({
      code: 'TOOL_NOT_FOUND',
    });

    await host.dispose();
  });

  it('[4] commits a staged replacement and the old disposer cannot delete it', async () => {
    const host = new CordisAtomicHost();
    const first = await host.mount(
      manifestOf('dup.plugin', '1.0.0', (context) => {
        host.tools.register(context, toolDef('dup.op', 'v1'));
      }),
    );

    const candidate = await host.mount(
      manifestOf('dup.plugin', '2.0.0', (context) => {
        host.tools.register(context, toolDef('dup.op', 'v2'));
      }),
      true,
    );

    // Staged candidate stays out of the live catalog until committed.
    expect(names(host)).toEqual(['dup.op']);
    await expect(host.tools.execute('dup.op', {}, host.context)).resolves.toBe('v1');

    host.commit(candidate);

    await expect(host.tools.execute('dup.op', {}, host.context)).resolves.toBe('v2');

    await first.dispose();

    await expect(host.tools.execute('dup.op', {}, host.context)).resolves.toBe('v2');
    expect(names(host)).toEqual(['dup.op']);

    await candidate.dispose();
    expect(names(host)).toEqual([]);
    await host.dispose();
  });

  it('[5] exposes the real upstream waterfall dispatch', async () => {
    const host = new CordisAtomicHost();
    let observed = 0;

    host.native.on('internal/config', (_config, next) => {
      observed += 1;
      return next();
    });

    await host.mount(manifestOf('probe.plugin', '1.0.0', () => {}));

    expect(typeof host.native.waterfall).toBe('function');
    expect(observed).toBeGreaterThan(0);

    await host.dispose();
  });

  it('[6] returns an independent context object per withScope call', async () => {
    const host = new CordisAtomicHost();

    const first = host.context.withScope('scope-a') as ScopedRuntimeContext;
    const second = host.context.withScope('scope-a') as ScopedRuntimeContext;
    const root = host.context as ScopedRuntimeContext;

    expect(first).not.toBe(second);
    expect(first).not.toBe(host.context);
    expect(first.scope).toBe('scope-a');
    expect(second.scope).toBe('scope-a');
    expect(root.scope).toBeUndefined();

    first.invocation = { marker: 'a' };

    expect(second.invocation).toBeUndefined();
    expect(root.invocation).toBeUndefined();

    await host.dispose();
  });

  it('[7] rejects a manifest whose fiber never activates', async () => {
    const host = new CordisAtomicHost();

    await expect(
      host.mount(manifestOf('pending.plugin', '1.0.0', () => {}, ['missing.service'])),
    ).rejects.toMatchObject({ code: 'CORDIS_ATOMIC_MOUNT_INACTIVE', state: 'pending' });

    expect(names(host)).toEqual([]);
    await host.dispose();
  });

  it('[8] joins repeated disposal and rejects mounting after host disposal', async () => {
    const host = new CordisAtomicHost();
    const instance = await host.mount(
      manifestOf('idem.plugin', '1.0.0', (context) => {
        host.tools.register(context, toolDef('idem.op', 'idem'));
      }),
    );

    const first = instance.dispose();
    const second = instance.dispose();
    expect(first).toBe(second);
    await first;

    expect(names(host)).toEqual([]);

    await host.dispose();
    await host.dispose();

    await expect(host.mount(manifestOf('late.plugin', '1.0.0', () => {}))).rejects.toMatchObject({
      code: 'CORDIS_ATOMIC_HOST_DISPOSED',
    });
  });

  it('[9] makes instance.context.dispose join the unload already in flight', async () => {
    const host = new CordisAtomicHost();
    const gate = deferred();
    let cleanupStarted = false;
    let cleanupFinished = false;

    const instance = await host.mount(
      manifestOf('slow.plugin', '1.0.0', (context) => {
        context.effect(() => async () => {
          cleanupStarted = true;
          await gate.promise;
          cleanupFinished = true;
        });
      }),
    );

    const first = instance.dispose();
    await flushMicrotasks();
    expect(cleanupStarted).toBe(true);

    let secondSettled = false;
    const second = instance.context.dispose();
    void second.then(() => {
      secondSettled = true;
    });
    await flushMicrotasks();

    // The second caller must join the same cleanup, not resolve early.
    expect(second).toBe(first);
    expect(secondSettled).toBe(false);

    gate.resolve();
    await Promise.all([first, second]);
    expect(cleanupFinished).toBe(true);

    await host.dispose();
  });

  it('[10] closes the host when the root context is disposed', async () => {
    const host = new CordisAtomicHost();
    await host.mount(
      manifestOf('rooted.plugin', '1.0.0', (context) => {
        host.tools.register(context, toolDef('rooted.op', 'rooted'));
      }),
    );

    await host.context.dispose();

    expect(names(host)).toEqual([]);
    await expect(host.mount(manifestOf('after.plugin', '1.0.0', () => {}))).rejects.toMatchObject({
      code: 'CORDIS_ATOMIC_HOST_DISPOSED',
    });
  });

  it('[11] commits and unloads a nested staged candidate', async () => {
    const host = new CordisAtomicHost();

    const child: RuntimePluginManifest = {
      id: 'child.plugin',
      version: '1.0.0',
      kind: 'capability',
      apply: (context: RuntimeContext) => {
        host.tools.register(context, toolDef('child.op', 'child'));
      },
    };
    const parent: RuntimePluginManifest = {
      id: 'parent.plugin',
      version: '1.0.0',
      kind: 'capability',
      apply: async (context: RuntimeContext) => {
        await context.plugin(child, undefined, true);
      },
    };

    const candidate = await host.mount(parent, true);

    // The nested candidate is staged with its parent: nothing leaks.
    expect(names(host)).toEqual([]);
    await expect(host.tools.execute('child.op', {}, host.context)).rejects.toMatchObject({
      code: 'TOOL_NOT_FOUND',
    });

    host.commit(candidate);

    await expect(host.tools.execute('child.op', {}, host.context)).resolves.toBe('child');

    await candidate.dispose();

    expect(names(host)).toEqual([]);
    await host.dispose();
  });

  it('[12] rejects committing a disposed candidate without touching live tools', async () => {
    const host = new CordisAtomicHost();
    const live = await host.mount(
      manifestOf('live.plugin', '1.0.0', (context) => {
        host.tools.register(context, toolDef('live.op', 'live'));
      }),
    );
    const candidate = await host.mount(
      manifestOf('live.plugin', '2.0.0', (context) => {
        host.tools.register(context, toolDef('live.op', 'candidate'));
      }),
      true,
    );

    await candidate.dispose();

    expect(() => host.commit(candidate)).toThrowError(
      expect.objectContaining({ code: 'CORDIS_ATOMIC_COMMIT_INACTIVE' }),
    );

    await expect(host.tools.execute('live.op', {}, host.context)).resolves.toBe('live');
    expect(names(host)).toEqual(['live.op']);

    await live.dispose();
    await host.dispose();
  });

  it('[13] exposes registrations made after commit immediately', async () => {
    const host = new CordisAtomicHost();
    const candidate = await host.mount(
      manifestOf('post.plugin', '1.0.0', (context) => {
        host.tools.register(context, toolDef('post.a', 'a'));
      }),
      true,
    );

    expect(names(host)).toEqual([]);

    host.commit(candidate);
    expect(names(host)).toEqual(['post.a']);

    // isStaging now reads false, so a later registration is immediately live.
    host.tools.register(candidate.context, toolDef('post.b', 'b'));

    expect(names(host).sort()).toEqual(['post.a', 'post.b']);
    await expect(host.tools.execute('post.b', {}, host.context)).resolves.toBe('b');

    await candidate.dispose();
    expect(names(host)).toEqual([]);
    await host.dispose();
  });

  it('[14] rejects every adapted mutation after teardown without running setup', async () => {
    const host = new CordisAtomicHost();
    await host.dispose();

    let effectSetup = 0;
    let listenerCalls = 0;

    expect(() =>
      host.context.effect(() => {
        effectSetup += 1;
        return () => {};
      }),
    ).toThrowError(expect.objectContaining({ code: 'CORDIS_ATOMIC_HOST_DISPOSED' }));

    expect(() =>
      host.context.on('probe.event', () => {
        listenerCalls += 1;
      }),
    ).toThrowError(expect.objectContaining({ code: 'CORDIS_ATOMIC_HOST_DISPOSED' }));

    // If the guard were missing, the listener would be registered and observe
    // this dispatch.
    (host.native as unknown as { emit: (name: string) => void }).emit('probe.event');

    expect(() => host.context.provide('late.service', {})).toThrowError(
      expect.objectContaining({ code: 'CORDIS_ATOMIC_HOST_DISPOSED' }),
    );

    // Exercises the root owner's collect path through the public registry API.
    expect(() => host.tools.register(host.context, toolDef('late.op', 'late'))).toThrowError(
      expect.objectContaining({ code: 'CORDIS_ATOMIC_HOST_DISPOSED' }),
    );

    expect(effectSetup).toBe(0);
    expect(listenerCalls).toBe(0);
    expect(names(host)).toEqual([]);
  });

  it('[15] rejects mounting after the root fiber is disposed through the adapter', async () => {
    const host = new CordisAtomicHost();

    await host.context.fiber.dispose();

    await expect(
      host.mount(manifestOf('after-root.plugin', '1.0.0', () => {})),
    ).rejects.toMatchObject({ code: 'CORDIS_ATOMIC_HOST_DISPOSED' });
  });
});
