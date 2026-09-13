import { describe, expect, it } from 'vitest';

import { Context } from './context';
import { PluginManager } from './index';
import { ToolRegistry } from './tool';
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
  it('disposes an uncommitted candidate so a late dependency cannot activate it', async () => {
    const manager = new PluginManager([
      manifest('adapter', '1', (ctx) => {
        ctx.provide('value', 'v1');
      }),
    ]);
    await manager.mount('adapter');
    manager.install(
      manifest(
        'adapter',
        '2',
        (ctx) => {
          ctx.provide('value', 'v2');
        },
        ['later'],
      ),
    );
    await manager.reload('adapter');
    manager.context.provide('later', {});
    await manager.context.flushPending();
    expect(manager.context.get('value')).toBe('v1');
    expect(manager.context.getFibers().filter((fiber) => fiber.name === 'adapter')).toHaveLength(1);
    await manager.context.dispose();
  });
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

  it('supports dynamically installing, mounting, and uninstalling plugins at runtime', async () => {
    let disposed = false;
    const manager = new PluginManager();
    expect(manager.has('dynamic')).toBe(false);

    manager.install(
      manifest('dynamic', '1.0.0', (ctx) => {
        ctx.effect(() => () => {
          disposed = true;
        });
      }),
    );

    expect(manager.has('dynamic')).toBe(true);
    expect(manager.getState('dynamic')).toBe('installed');

    await manager.mount('dynamic');
    expect(manager.getState('dynamic')).toBe('active');

    await manager.uninstall('dynamic');
    expect(disposed).toBe(true);
    expect(manager.has('dynamic')).toBe(false);
  });

  it('accepts an injected context sharing services with plugins', async () => {
    const { Context } = await import('./context');
    const customContext = new Context();
    customContext.provide('shared.config', { mode: 'microkernel' });

    let receivedMode = '';
    const manager = new PluginManager([], customContext);
    manager.install(
      manifest(
        'config-consumer',
        '1.0.0',
        (ctx) => {
          const config = (ctx as any).get('shared.config');
          receivedMode = config?.mode;
        },
        ['shared.config'],
      ),
    );

    await manager.mount('config-consumer');
    expect(receivedMode).toBe('microkernel');
  });

  it('isolates candidate fiber tools during reload and promotes atomically without TOOL_DUPLICATE', async () => {
    const context = new Context();
    const toolRegistry = new ToolRegistry();
    context.provide('cordis.tools', toolRegistry);

    const manager = new PluginManager(
      [
        manifest('calc', '1.0.0', (ctx) => {
          toolRegistry.register(ctx, {
            description: 'v1 add',
            execute: (args: any) => args.a + args.b,
            inputSchema: {},
            name: 'add',
          });
        }),
        manifest('calc', '2.0.0', (ctx) => {
          toolRegistry.register(ctx, {
            description: 'v2 add with logging',
            execute: (args: any) => (args.a + args.b) * 10,
            inputSchema: {},
            name: 'add',
          });
        }),
      ],
      context,
    );

    await manager.mount('calc');
    expect(toolRegistry.list().map((t) => t.name)).toEqual(['add']);
    expect(await toolRegistry.execute('add', { a: 2, b: 3 }, context as any)).toBe(5);

    // Reloading to 2.0.0 must NOT collide on duplicate tool registration 'add'
    expect(await manager.reload('calc')).toBe('active');
    expect(toolRegistry.list().map((t) => t.name)).toEqual(['add']);
    expect(await toolRegistry.execute('add', { a: 2, b: 3 }, context as any)).toBe(50);
  });

  it('keeps active service and tools 100% intact when candidate activation fails', async () => {
    const context = new Context();
    const toolRegistry = new ToolRegistry();
    context.provide('cordis.tools', toolRegistry);

    const manager = new PluginManager(
      [
        manifest('svc', '1.0.0', (ctx) => {
          ctx.provide('svc.api', { version: 1 });
          toolRegistry.register(ctx, {
            description: 'v1 tool',
            execute: () => 'v1-result',
            inputSchema: {},
            name: 'svcTool',
          });
        }),
        manifest('svc', '2.0.0', (ctx) => {
          ctx.provide('svc.api', { version: 2 });
          toolRegistry.register(ctx, {
            description: 'v2 tool',
            execute: () => 'v2-result',
            inputSchema: {},
            name: 'svcTool',
          });
          throw new Error('candidate exploded');
        }),
      ],
      context,
    );

    await manager.mount('svc');
    expect(await manager.getState('svc')).toBe('active');
    expect((context.get('svc.api') as any)?.version).toBe(1);

    // Reload attempts v2, which explodes during activation
    const reloadState = await manager.reload('svc');
    expect(reloadState).toBe('active');
    expect(await manager.getState('svc')).toBe('active');

    // Live service must STILL be version 1, not wiped or corrupted
    expect((context.get('svc.api') as any)?.version).toBe(1);
    // Live tool must STILL execute v1
    expect(await toolRegistry.execute('svcTool', {}, context as any)).toBe('v1-result');
  });

  it('version reload does not oscillate and supports targetVersion selection', async () => {
    let activeVersion = '';
    const manager = new PluginManager([
      manifest('versioned', '1.0.0', () => {
        activeVersion = '1.0.0';
      }),
      manifest('versioned', '2.0.0', () => {
        activeVersion = '2.0.0';
      }),
    ]);

    await manager.mount('versioned');
    expect(activeVersion).toBe('1.0.0');

    // Reload without targetVersion promotes to latest (2.0.0)
    await manager.reload('versioned');
    expect(activeVersion).toBe('2.0.0');

    // Reload without targetVersion again remains on latest (2.0.0) - NO OSCILLATION!
    await manager.reload('versioned');
    expect(activeVersion).toBe('2.0.0');

    // Explicit rollback to 1.0.0 via targetVersion
    await manager.reload('versioned', undefined, '1.0.0');
    expect(activeVersion).toBe('1.0.0');

    // Non-existent version throws PLUGIN_NOT_FOUND
    await expect(manager.reload('versioned', undefined, '9.9.9')).rejects.toMatchObject({
      code: 'PLUGIN_NOT_FOUND',
    });
  });

  it('serializes uninstall inside enqueue without race conditions', async () => {
    let unmounted = false;
    const manager = new PluginManager([
      manifest('serial', '1.0.0', (ctx) => {
        ctx.effect(() => () => {
          unmounted = true;
        });
      }),
    ]);

    await manager.mount('serial');
    expect(manager.getState('serial')).toBe('active');

    // Concurrent uninstall and mount
    const p1 = manager.uninstall('serial');
    const p2 = manager.mount('serial').catch((err) => err);

    await Promise.all([p1, p2]);
    expect(unmounted).toBe(true);
    expect(manager.has('serial')).toBe(false);
    expect(await p2).toMatchObject({ code: 'PLUGIN_NOT_FOUND' });
  });
});
