import type { ToolRegistry } from '../../../../packages/cordis-kernel/src/tool';
import type { RuntimePluginManifest } from '../../../../packages/cordis-kernel/src/types';
import type { McpClientLike, McpPluginOptions } from './types';

export const disconnectMcpClient = async (client: McpClientLike): Promise<void> => {
  if (typeof client.disconnect === 'function') {
    await client.disconnect();
  } else if (typeof client.close === 'function') {
    await client.close();
  }
};

export const createMcpPluginManifest = (options: McpPluginOptions): RuntimePluginManifest => {
  const pluginId = `mcp.${options.id}`;
  const version = options.version ?? '1.0.0';

  return {
    apply: async (ctx) => {
      const toolRegistry = (ctx as any).get?.('cordis.tools') as ToolRegistry | undefined;
      if (!toolRegistry) {
        throw new Error('cordis.tools service is required to mount MCP plugin');
      }

      let client: McpClientLike;
      if (options.clientFactory) {
        client = await options.clientFactory(options.clientParams);
        ctx.effect(() => async () => {
          await disconnectMcpClient(client);
        });
      } else {
        const { MCPClient } = await import('@/libs/mcp');
        const mcpClient = new MCPClient(options.clientParams);
        client = mcpClient as unknown as McpClientLike;
        ctx.effect(() => async () => {
          await disconnectMcpClient(client);
        });
        await mcpClient.initialize();
      }

      // Provide the connected client to the context so other plugins or services can access it
      ctx.provide(`mcp.client.${options.id}`, client);

      // Discover and register all tools from the MCP server
      const tools = await client.listTools();
      if ((!tools || tools.length === 0) && !options.allowEmptyTools) {
        throw new Error(
          `MCP server "${options.id}" returned no tools and allowEmptyTools is not enabled`,
        );
      }

      for (const tool of tools) {
        const canonicalName = `${options.id}:${tool.name}`;

        toolRegistry.register(ctx, {
          description: tool.description ?? `MCP tool ${canonicalName}`,
          execute: async (args) => {
            return await client.callTool(tool.name, args);
          },
          inputSchema: tool.inputSchema ?? {},
          name: canonicalName,
        });

        // Register short alias if not already taken
        try {
          toolRegistry.register(ctx, {
            description: tool.description ?? `MCP tool ${tool.name}`,
            execute: async (args) => {
              return await client.callTool(tool.name, args);
            },
            inputSchema: tool.inputSchema ?? {},
            name: tool.name,
          });
        } catch {
          // If collision occurs, canonicalName remains available
        }
      }
    },
    id: pluginId,
    inject: ['cordis.tools'],
    kind: 'capability',
    version,
  };
};
