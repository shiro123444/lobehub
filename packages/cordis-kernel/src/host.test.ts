import { describe, expect, it } from 'vitest';

import type { Context } from './context';
import { RuntimeHost } from './index';
import type { RuntimePluginManifest } from './types';

const manifest = (
  id: string,
  apply: RuntimePluginManifest['apply'],
  inject?: string[],
): RuntimePluginManifest => ({
  id,
  version: '1.0.0',
  kind: 'kernel',
  apply,
  inject,
});

describe('@lobechat/cordis-kernel RuntimeHost', () => {
  it('starts once and returns an active snapshot', async () => {
    let starts = 0;
    const host = new RuntimeHost([
      manifest('alpha', () => {
        starts += 1;
      }),
    ]);

    const first = await host.start();
    const second = await host.start();

    expect(first).toEqual({ state: 'active', activePlugins: ['alpha'] });
    expect(second).toEqual(first);
    expect(starts).toBe(1);
    await host.dispose();
  });

  it('activates manifests with dependencies through pending fibers', async () => {
    const starts: string[] = [];
    const host = new RuntimeHost([
      manifest(
        'consumer',
        () => {
          starts.push('consumer');
        },
        ['service'],
      ),
      manifest('provider', (context) => {
        starts.push('provider');
        context.provide('service', { ready: true });
      }),
    ]);

    const snapshot = await host.start();

    expect(starts).toEqual(['provider', 'consumer']);
    expect(snapshot.activePlugins).toEqual(['consumer', 'provider']);
    await host.dispose();
  });

  it('reports missing dependencies and rolls back startup', async () => {
    const host = new RuntimeHost([manifest('consumer', () => {}, ['missing-service'])]);

    await expect(host.start()).rejects.toMatchObject({ code: 'PLUGIN_DEPENDENCY_MISSING' });
    expect(host.snapshot()).toEqual({ state: 'created', activePlugins: [] });
    await host.dispose();
  });

  it('reports startup failure and disposes previously active fibers', async () => {
    let childContext: Context | undefined;
    let disposed = 0;
    let listenerCalls = 0;
    const host = new RuntimeHost([
      manifest('first', (context) => {
        childContext = context as Context;
        context.effect(() => () => {
          disposed += 1;
        });
        context.on('event', () => {
          listenerCalls += 1;
        });
      }),
      manifest('failing', () => {
        throw new Error('boom');
      }),
    ]);

    await expect(host.start()).rejects.toMatchObject({ code: 'PLUGIN_START_FAILED' });
    childContext?.events.emit('event');

    expect(disposed).toBe(1);
    expect(listenerCalls).toBe(0);
    expect(host.snapshot()).toEqual({ state: 'created', activePlugins: [] });
    await host.dispose();
  });

  it('rejects duplicate id@version manifests', () => {
    const plugin = manifest('duplicate', () => {});
    let error: unknown;

    try {
      new RuntimeHost([plugin, plugin]);
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ code: 'PLUGIN_DUPLICATE' });
  });

  it('disposes idempotently and rejects start after disposal', async () => {
    let disposed = 0;
    const host = new RuntimeHost([
      manifest('cleanup', (context) => {
        context.effect(() => () => {
          disposed += 1;
        });
      }),
    ]);
    await host.start();

    await Promise.all([host.dispose(), host.dispose()]);
    await host.dispose();

    expect(disposed).toBe(1);
    expect(host.snapshot()).toEqual({ state: 'disposed', activePlugins: [] });
    await expect(host.start()).rejects.toMatchObject({ code: 'HOST_ALREADY_DISPOSED' });
  });
});
