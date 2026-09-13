import { describe, expect, it, vi } from 'vitest';

import { Context } from '../../../../../../../packages/cordis-kernel/src/context';
import { PluginManager } from '../../../../../../../packages/cordis-kernel/src/manager';
import { CordisMessengerPlatformRegistry } from '../registry';

const buildDefinition = (overrides: Partial<any> = {}) => ({
  connectionMode: 'webhook' as const,
  createBinder: vi.fn(() => ({ id: 'binder-v1' }) as any),
  id: 'slack' as const,
  name: 'Slack',
  oauth: { exchangeCode: vi.fn() },
  webhookGate: { preprocess: vi.fn() },
  ...overrides,
});

describe('CordisMessengerPlatformRegistry', () => {
  it('registers and mounts a platform as a Cordis plugin', async () => {
    const registry = new CordisMessengerPlatformRegistry();
    const def = buildDefinition() as any;

    registry.register(def);
    // Wait for auto-mount tick
    await Promise.resolve();

    expect(registry.getPlatform('slack')).toBe(def);
    expect(registry.listPlatforms()).toEqual([def]);

    const serialized = registry.listSerializedPlatforms();
    expect(serialized).toEqual([{ connectionMode: 'webhook', id: 'slack', name: 'Slack' }]);
  });

  it('creates binder via active platform definition', async () => {
    const registry = new CordisMessengerPlatformRegistry();
    const binderFactory = vi.fn(() => ({ kind: 'slack-binder' }) as any);
    registry.register(buildDefinition({ createBinder: binderFactory }) as any);
    await Promise.resolve();

    const creds = {
      applicationId: 'app-1',
      botToken: 'token-1',
      installationKey: 'slack:team-1',
      metadata: {},
      platform: 'slack' as const,
      tenantId: 'team-1',
    };

    const binder = registry.createBinder(creds);
    expect(binderFactory).toHaveBeenCalledWith(creds);
    expect(binder).toEqual({ kind: 'slack-binder' });
  });

  it('supports dynamically unmounting and mounting platforms', async () => {
    const registry = new CordisMessengerPlatformRegistry();
    const def = buildDefinition() as any;
    registry.register(def);
    await Promise.resolve();

    expect(registry.getPlatform('slack')).toBeDefined();

    // Dynamically unmount
    await registry.unmountPlatform('slack');
    expect(registry.getPlatform('slack')).toBeUndefined();
    expect(registry.listPlatforms()).toHaveLength(0);

    // Dynamically remount
    await registry.mountPlatform('slack');
    expect(registry.getPlatform('slack')).toBeDefined();
    expect(registry.listPlatforms()).toHaveLength(1);
  });

  it('supports hot-reloading platform with updated definition', async () => {
    const registry = new CordisMessengerPlatformRegistry();
    registry.register(buildDefinition({ name: 'Slack v1' }) as any);
    await Promise.resolve();

    expect(registry.getPlatform('slack')?.name).toBe('Slack v1');

    const updated = buildDefinition({
      createBinder: vi.fn(() => ({ id: 'binder-v2' }) as any),
      name: 'Slack v2',
    }) as any;

    await registry.reloadPlatform('slack', updated);
    expect(registry.getPlatform('slack')?.name).toBe('Slack v2');

    const creds = {
      applicationId: 'app-2',
      botToken: 'token-2',
      installationKey: 'slack:team-2',
      metadata: {},
      platform: 'slack' as const,
      tenantId: 'team-2',
    };

    const binder = registry.createBinder(creds);
    expect(binder).toEqual({ id: 'binder-v2' });
  });

  it('guarantees context consistency when initialized with pluginManager', () => {
    const sharedContext = new Context();
    const pluginManager = new PluginManager([], sharedContext);

    const registry = new CordisMessengerPlatformRegistry({ pluginManager });
    expect(registry.context).toBe(sharedContext);

    // Mismatched context throws error
    const differentContext = new Context();
    expect(
      () => new CordisMessengerPlatformRegistry({ context: differentContext, pluginManager }),
    ).toThrow('Incompatible context');
  });
});
