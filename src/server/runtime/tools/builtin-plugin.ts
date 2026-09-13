import type { ToolRegistry } from '../../../../packages/cordis-kernel/src/tool';
import type { RuntimePluginManifest } from '../../../../packages/cordis-kernel/src/types';
import type { BuiltinToolsPluginOptions } from './types';

export const createBuiltinToolsPlugin = (
  options: BuiltinToolsPluginOptions,
): RuntimePluginManifest => {
  const pluginId = options.id ?? 'tools.builtin';
  const version = options.version ?? '1.0.0';

  return {
    apply: (ctx) => {
      const toolRegistry = (ctx as any).get?.('cordis.tools') as ToolRegistry | undefined;
      if (!toolRegistry) {
        throw new Error('cordis.tools service is required to mount builtin tools plugin');
      }

      for (const tool of options.tools) {
        const canonicalName = `${tool.identifier}:${tool.apiName}`;

        toolRegistry.register(ctx, {
          description: tool.description ?? `Builtin tool ${canonicalName}`,
          execute: (args, toolCtx) => tool.handler(args, toolCtx as any),
          inputSchema: tool.inputSchema ?? {},
          name: canonicalName,
        });

        // Also register short name alias if not colliding
        try {
          toolRegistry.register(ctx, {
            description: tool.description ?? `Builtin tool ${tool.apiName}`,
            execute: (args, toolCtx) => tool.handler(args, toolCtx as any),
            inputSchema: tool.inputSchema ?? {},
            name: tool.apiName,
          });
        } catch {
          // If alias already exists (collision between providers), canonicalName remains unique
        }
      }
    },
    id: pluginId,
    inject: ['cordis.tools'],
    kind: 'capability',
    version,
  };
};
