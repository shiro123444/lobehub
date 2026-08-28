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
});
