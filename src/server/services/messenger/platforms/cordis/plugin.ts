import type { RuntimePluginManifest } from '../../../../../../packages/cordis-kernel/src/types';
import type { MessengerPlatformDefinition } from '../types';

export const createMessengerPlatformPlugin = (
  definition: MessengerPlatformDefinition,
  version = '1.0.0',
): RuntimePluginManifest => {
  const pluginId = `messenger.${definition.id}`;

  return {
    apply: (ctx) => {
      // Provide the platform definition into Cordis context; automatically unbound on unmount/reload
      ctx.provide(`messenger.platform.${definition.id}`, definition);
    },
    id: pluginId,
    kind: 'capability',
    version,
  };
};
