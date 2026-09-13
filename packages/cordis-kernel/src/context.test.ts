import { describe, expect, it } from 'vitest';

import { Context } from './index';
import type { Fiber as FiberContract } from './types';

const manifest = (id: string, apply: Parameters<Context['plugin']>[0]['apply']) => ({
  id,
  version: '0.1.0',
  kind: 'kernel' as const,
  apply,
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe('@lobechat/cordis-kernel', () => {
  it('isolates scoped services while sharing root services', async () => {
    const root = new Context();
    const a = root.withScope('a');
    const b = root.withScope('b');
    root.provide('shared', 1);
    a.provide('user', 'alice');
    b.provide('user', 'bob');
    expect(a.get('user')).toBe('alice');
    expect(b.get('user')).toBe('bob');
    expect(root.get('user')).toBeUndefined();
    expect(b.get('shared')).toBe(1);
    await root.dispose();
    expect(a.get('user')).toBeUndefined();
  });

  it('disposes dependent siblings before their provider', async () => {
    const context = new Context();
    const order: string[] = [];
    const provider = await context.plugin(
      manifest('provider', (ctx) => {
        ctx.provide('service', {});
        return () => {
          order.push('provider');
        };
      }),
    );
    const consumer = await context.plugin({
      ...manifest('consumer', () => () => {
        order.push('consumer');
      }),
      inject: ['service'],
    });
    await provider.dispose();
    expect(consumer.state).toBe('disposed');
    expect(order).toEqual(['consumer', 'provider']);
    await context.dispose();
  });
  it('keeps injected plugins pending and activates them after provide', async () => {
    const context = new Context();
    let activations = 0;
    const service = { name: 'service' };

    const fiber = await context.plugin({
      ...manifest('pending-consumer', () => {
        activations += 1;
      }),
      inject: ['service'],
    });

    expect(fiber.state).toBe('pending');
    context.provide('service', service);
    await context.flushPending();

    expect(fiber.state).toBe('active');
    expect(activations).toBe(1);
    await context.dispose();
  });

  it('waits for an async provider to become active before pending activation', async () => {
    const context = new Context();
    const providerReady = deferred();
    let resolveConsumer!: (fiber: FiberContract) => void;
    const consumerReady = new Promise<FiberContract>((resolve) => {
      resolveConsumer = resolve;
    });
    let consumerStarted = false;

    const providerPromise = context.plugin({
      ...manifest('async-provider', async (providerContext) => {
        providerContext.provide('adapter', { ready: true });
        const consumer = await providerContext.plugin({
          ...manifest('barrier-consumer', () => {
            consumerStarted = true;
          }),
          inject: ['adapter'],
        });
        resolveConsumer(consumer);
        await providerReady.promise;
      }),
    });

    const consumer = await consumerReady;
    expect(consumer.state).toBe('pending');
    expect(consumerStarted).toBe(false);

    providerReady.resolve();
    await providerPromise;
    await context.flushPending();

    expect(consumer.state).toBe('active');
    expect(consumerStarted).toBe(true);
    await context.dispose();
  });

  it('disposes effects and listeners in LIFO order', async () => {
    const context = new Context();
    const order: string[] = [];

    context.effect(() => () => {
      order.push('effect');
    });
    context.on('event', () => {
      order.push('listener');
    });
    context.provide('service', { ready: true });
    context.effect(() => () => {
      order.push('last');
    });

    context.events.emit('event');
    await context.dispose();
    context.events.emit('event');

    expect(order).toEqual(['listener', 'last', 'effect']);
    expect(context.get('service')).toBeUndefined();
  });

  it('rolls back services, listeners, and effects after startup failure', async () => {
    const context = new Context();
    const events: string[] = [];

    await expect(
      context.plugin(
        manifest('failing-plugin', (pluginContext) => {
          pluginContext.provide('temporary', { value: true });
          pluginContext.on('event', () => {
            events.push('listener-called');
          });
          pluginContext.effect(() => () => {
            events.push('effect-disposed');
          });
          throw new Error('startup failed');
        }),
      ),
    ).rejects.toThrow('startup failed');

    expect(context.get('temporary')).toBeUndefined();
    context.events.emit('event');
    expect(events).toEqual(['effect-disposed']);
    expect(context.getFibers().find((fiber) => fiber.name === 'failing-plugin')?.state).toBe(
      'failed',
    );
    await context.dispose();
  });

  it('does not let an old provider disposer remove its replacement', async () => {
    const context = new Context();
    const first = { version: 1 };
    const second = { version: 2 };

    const firstDisposer = context.provide('adapter', first);
    const secondDisposer = context.provide('adapter', second);

    await firstDisposer();
    expect(context.get('adapter')).toBe(second);

    await secondDisposer();
    expect(context.get('adapter')).toBeUndefined();
    await context.dispose();
  });

  it('makes repeated dispose calls idempotent', async () => {
    const context = new Context();
    let disposals = 0;
    context.effect(() => () => {
      disposals += 1;
    });

    await Promise.all([context.dispose(), context.dispose(), context.dispose()]);
    await context.dispose();

    expect(disposals).toBe(1);
    expect(context.fiber.state).toBe('disposed');
  });

  it('deduplicates identical disposer functions in collect', async () => {
    const context = new Context();
    let runs = 0;
    const disposer = () => {
      runs += 1;
    };

    const first = context.fiber.collect(disposer);
    const second = context.fiber.collect(disposer);

    expect(first).toBe(second);
    await first();
    await second();
    expect(runs).toBe(1);

    await context.dispose();
    expect(runs).toBe(1);
  });

  it('ensures public effect disposer is single-shot and repeat calls are no-op', async () => {
    const context = new Context();
    let cleanups = 0;

    const dispose = context.effect(() => () => {
      cleanups += 1;
    });

    const res1 = dispose();
    const res2 = dispose();

    expect(res1).toBeUndefined();
    expect(res2).toBeUndefined();
    expect(cleanups).toBe(1);

    await context.dispose();
    expect(cleanups).toBe(1);
  });

  it('rethrows errors to public caller awaiting effect disposer while owner dispose continues', async () => {
    const context = new Context();
    let secondRan = false;

    context.effect(() => () => {
      secondRan = true;
    });

    const disposeFailing = context.effect(() => () => {
      throw new Error('failing effect');
    });

    expect(() => disposeFailing()).toThrow('failing effect');
    await expect(context.dispose()).resolves.toBeUndefined();
    expect(secondRan).toBe(true);
  });

  it('executes synchronous effect disposers immediately', async () => {
    const context = new Context();
    let active = true;

    const dispose = context.effect(() => () => {
      active = false;
    });

    expect(active).toBe(true);
    dispose();
    expect(active).toBe(false);

    await context.dispose();
  });

  it('deduplicates identical disposer across effect and collect', async () => {
    const ctx = new Context();
    let calls = 0;
    const dispose = () => {
      calls += 1;
    };
    ctx.effect(() => dispose);
    ctx.effect(() => dispose);
    ctx.fiber.collect(dispose);
    await ctx.dispose();
    expect(calls).toBe(1);
  });

  it('joins every shared asynchronous disposer in reverse order', async () => {
    const ctx = new Context();
    const firstGate = deferred();
    const secondGate = deferred();
    const firstStarted = deferred();
    const order: string[] = [];
    const first = async () => {
      order.push('first');
      firstStarted.resolve();
      await firstGate.promise;
    };
    const second = async () => {
      order.push('second');
      await secondGate.promise;
    };
    ctx.fiber.collect(first);
    ctx.fiber.collect(second);
    const dispose = ctx.effect(() => [first, second]);
    const cleanup = dispose();
    let settled = false;
    const disposing = ctx.dispose().then(() => {
      settled = true;
    });
    try {
      expect(order).toEqual(['second']);
      secondGate.resolve();
      await firstStarted.promise;
      expect(settled).toBe(false);
      expect(order).toEqual(['second', 'first']);
    } finally {
      firstGate.resolve();
      secondGate.resolve();
      await cleanup;
      await disposing;
    }
    expect(order).toEqual(['second', 'first']);
  });

  it('lets owner dispose join in-flight cleanup started via collect', async () => {
    const ctx = new Context();
    const gate = deferred();
    let cleanupRan = false;
    const dispose = ctx.fiber.collect(async () => {
      await gate.promise;
      cleanupRan = true;
    });
    const first = dispose();
    const second = ctx.dispose();
    let ownerSettled = false;
    void second.then(() => {
      ownerSettled = true;
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(ownerSettled).toBe(false);
    gate.resolve();
    await second;
    expect(cleanupRan).toBe(true);
    await first;
  });

  it('reclaims partially collected disposers when an async generator throws', async () => {
    const ctx = new Context();
    const gate = deferred();
    const cleaned: string[] = [];

    async function* failingGenerator() {
      yield () => {
        cleaned.push('first');
      };
      yield async () => {
        cleaned.push('second');
      };
      await gate.promise;
      throw new Error('generator failure');
    }

    ctx.effect(() => failingGenerator());

    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(cleaned).toEqual([]);

    gate.resolve();
    for (let i = 0; i < 10; i++) await Promise.resolve();

    await ctx.dispose();
    expect(cleaned.sort()).toEqual(['first', 'second']);
  });

  it('does not produce unhandled rejection when async generator and its cleanup both fail', async () => {
    const ctx = new Context();
    const gate = deferred();
    let otherCleaned = false;

    ctx.effect(() => () => {
      otherCleaned = true;
    });

    async function* failingGenerator() {
      yield async () => {
        throw new Error('async cleanup failure');
      };
      await gate.promise;
      throw new Error('generator error');
    }

    ctx.effect(() => failingGenerator());

    gate.resolve();
    for (let i = 0; i < 10; i++) await Promise.resolve();

    await expect(ctx.dispose()).resolves.toBeUndefined();
    expect(otherCleaned).toBe(true);
  });
});
