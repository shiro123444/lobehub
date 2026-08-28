import { describe, expect, it } from 'vitest';

import type { Context } from './context';
import { PluginManager } from './index';
import type { RuntimePluginManifest } from './types';

const manifest = (
  id: string,
  version: string,
  apply: RuntimePluginManifest['apply'],
  inject?: string[],
): RuntimePluginManifest => ({
  id,
  version,
  kind: 'capability',
  apply,
  inject,
});

describe('@lobechat/cordis-kernel PluginManager', () => {
  it('mounts a built-in manifest and is idempotent', async () => {
    let starts = 0;
    const manager = new PluginManager([
      manifest('builtin', '1.0.0', () => {
        starts += 1;
      }),
    ]);

    expect(await manager.getState('builtin')).toBe('installed');
    expect(await manager.mount('builtin')).toBe('active');
    expect(await manager.mount('builtin')).toBe('active');
    expect(starts).toBe(1);
    expect((await manager.list())[0]).toMatchObject({ id: 'builtin', state: 'active' });
    await manager.unmount('builtin');
  });

  it('keeps missing dependencies pending and activates after the provider mounts', async () => {
    const manager = new PluginManager([
      manifest('consumer', '1.0.0', () => {}, ['service']),
      manifest('provider', '1.0.0', (context) => {
        context.provide('service', { ready: true });
      }),
    ]);

    expect(await manager.mount('consumer')).toBe('pending');
    expect(await manager.mount('provider')).toBe('active');
    expect(await manager.getState('consumer')).toBe('active');
    await manager.unmount('consumer');
    await manager.unmount('provider');
  });

  it('unmounts through unloading and is idempotent', async () => {
    let disposals = 0;
    let starts = 0;
    const manager = new PluginManager([
      manifest('unloadable', '1.0.0', (context) => {
        starts += 1;
        context.effect(() => () => {
          disposals += 1;
        });
      }),
    ]);

    await manager.mount('unloadable');
    expect(await manager.unmount('unloadable')).toBe('disabled');
    expect(await manager.unmount('unloadable')).toBe('disabled');
    expect(disposals).toBe(1);
    expect(await manager.mount('unloadable')).toBe('active');
    expect(starts).toBe(2);
    await manager.unmount('unloadable');
    expect(disposals).toBe(2);
  });

  it('retains failed state and the original error after mount failure', async () => {
    const failure = new Error('built-in failed');
    const manager = new PluginManager([
      manifest('broken', '1.0.0', () => {
        throw failure;
      }),
    ]);

    expect(await manager.mount('broken')).toBe('failed');
    expect(await manager.getState('broken')).toBe('failed');
    expect(manager.getError('broken')).toBe(failure);
    expect(await manager.mount('broken')).toBe('failed');
  });

  it('reloads atomically and an old provider cannot remove the new provider', async () => {
    let rootContext: Context | undefined;
    const oldService = { version: 'old' };
    const newService = { version: 'new' };
    const manager = new PluginManager([
      manifest('adapter', '1.0.0', (context) => {
        rootContext = context as Context;
        context.provide('adapter', oldService);
      }),
      manifest('adapter', '2.0.0', (context) => {
        context.provide('adapter', newService);
      }),
    ]);

    await manager.mount('adapter');
    expect(await manager.reload('adapter')).toBe('active');
    expect(rootContext?.get('adapter')).toBe(newService);
    expect(await manager.getState('adapter')).toBe('active');
    await manager.unmount('adapter');
  });

  it('keeps the old active plugin when reload fails', async () => {
    const reloadFailure = new Error('reload failed');
    let starts = 0;
    const manager = new PluginManager([
      manifest('reloadable', '1.0.0', () => {
        starts += 1;
      }),
      manifest('reloadable', '2.0.0', () => {
        throw reloadFailure;
      }),
    ]);

    await manager.mount('reloadable');
    expect(await manager.reload('reloadable')).toBe('active');
    expect(await manager.getState('reloadable')).toBe('active');
    expect(manager.getError('reloadable')).toBe(reloadFailure);
    expect(starts).toBe(1);
    await manager.unmount('reloadable');
  });

  it('rejects duplicate id@version manifests', () => {
    const plugin = manifest('duplicate', '1.0.0', () => {});
    let error: unknown;

    try {
      new PluginManager([plugin, plugin]);
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ code: 'PLUGIN_DUPLICATE' });
  });
});
