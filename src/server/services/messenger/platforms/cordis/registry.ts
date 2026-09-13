import { Context } from '../../../../../../packages/cordis-kernel/src/context';
import { PluginManager } from '../../../../../../packages/cordis-kernel/src/manager';
import type { InstallationCredentials } from '../../installations/types';
import type { MessengerPlatformBinder } from '../../types';
import type { MessengerPlatformDefinition, SerializedMessengerPlatformDefinition } from '../types';
import { createMessengerPlatformPlugin } from './plugin';

export interface CordisMessengerPlatformRegistryOptions {
  context?: Context;
  pluginManager?: PluginManager;
}

/**
 * Cordis-backed Messenger Platform Registry.
 *
 * Models every messenger platform (Slack, Telegram, Discord, etc.) as a
 * native Cordis plugin with lifecycle states (installed, active, disabled),
 * enabling dynamic hot-plugging, live credential updates, and clean unmounting.
 */
export class CordisMessengerPlatformRegistry {
  public readonly context: Context;
  public readonly pluginManager: PluginManager;
  private readonly platformDefinitions = new Map<string, MessengerPlatformDefinition>();

  constructor(options: CordisMessengerPlatformRegistryOptions = {}) {
    if (
      options.context &&
      options.pluginManager &&
      options.context !== options.pluginManager.context
    ) {
      throw new Error(
        'Incompatible context: options.context does not match options.pluginManager.context',
      );
    }
    this.context = options.context ?? options.pluginManager?.context ?? new Context();
    this.pluginManager = options.pluginManager ?? new PluginManager([], this.context);
  }

  /**
   * Register a platform definition and install it into Cordis PluginManager.
   */
  register(definition: MessengerPlatformDefinition, autoMount = true): this {
    if (this.platformDefinitions.has(definition.id)) {
      throw new Error(`Messenger platform "${definition.id}" is already registered`);
    }

    this.platformDefinitions.set(definition.id, definition);
    const plugin = createMessengerPlatformPlugin(definition);
    this.pluginManager.install(plugin);

    if (autoMount) {
      void this.pluginManager.mount(plugin.id);
    }

    return this;
  }

  /**
   * Dynamically mount an installed platform plugin.
   */
  async mountPlatform(platformId: string): Promise<void> {
    await this.pluginManager.mount(`messenger.${platformId}`);
  }

  /**
   * Dynamically unmount an active platform plugin.
   */
  async unmountPlatform(platformId: string): Promise<void> {
    await this.pluginManager.unmount(`messenger.${platformId}`);
  }

  /**
   * Dynamically hot-reload a platform plugin with an optional updated definition.
   */
  async reloadPlatform(
    platformId: string,
    updatedDefinition?: MessengerPlatformDefinition,
  ): Promise<void> {
    if (updatedDefinition) {
      this.platformDefinitions.set(platformId, updatedDefinition);
      const plugin = createMessengerPlatformPlugin(updatedDefinition, `reload-${Date.now()}`);
      this.pluginManager.install(plugin);
    }
    await this.pluginManager.reload(`messenger.${platformId}`);
  }

  /**
   * Get an active platform definition from Cordis Context.
   */
  getPlatform(platform: string): MessengerPlatformDefinition | undefined {
    return this.context.get<MessengerPlatformDefinition>(`messenger.platform.${platform}`);
  }

  /**
   * List all currently active platforms in Cordis.
   */
  listPlatforms(): MessengerPlatformDefinition[] {
    const active: MessengerPlatformDefinition[] = [];
    for (const [id] of this.platformDefinitions) {
      const platform = this.getPlatform(id);
      if (platform) active.push(platform);
    }
    return active;
  }

  /**
   * List serialized platform definitions for frontend consumption.
   */
  listSerializedPlatforms(): SerializedMessengerPlatformDefinition[] {
    return this.listPlatforms().map(({ createBinder, oauth, webhookGate, ...rest }) => rest);
  }

  /**
   * Create a platform binder from the resolved active definition.
   */
  createBinder(creds: InstallationCredentials): MessengerPlatformBinder | null {
    const definition = this.getPlatform(creds.platform);
    return definition ? definition.createBinder(creds) : null;
  }
}
