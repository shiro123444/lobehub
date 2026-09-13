import { describe, expect, it, vi } from 'vitest';

import { Context } from '../../../../../packages/cordis-kernel/src/context';
import { PluginManager } from '../../../../../packages/cordis-kernel/src/manager';
import { ToolRegistry } from '../../../../../packages/cordis-kernel/src/tool';
import { createMcpPluginManifest } from '../mcp-plugin';
import type { McpClientLike } from '../types';

describe('createMcpPluginManifest', () => {
  it('mounts MCP tools, executes them, and cleans up client on unmount', async () => {
    const context = new Context();
    const toolRegistry = new ToolRegistry();
    context.provide('cordis.tools', toolRegistry);

    const closeMock = vi.fn();
    const callToolMock = vi.fn(async (name: string, args: any) => ({
      result: `executed ${name} with ${JSON.stringify(args)}`,
    }));

    const mockClient: McpClientLike = {
      callTool: callToolMock,
      close: closeMock,
      initialize: vi.fn(),
      listTools: vi.fn(async () => [
        {
          description: 'Fetch web page content',
          inputSchema: { type: 'object' },
          name: 'fetch',
        },
      ]),
    };

    const plugin = createMcpPluginManifest({
      clientFactory: () => mockClient,
      clientParams: { args: [], command: 'node', name: 'fetcher', type: 'stdio' },
      id: 'fetcher',
    });

    const manager = new PluginManager([plugin], context);
    await manager.mount('mcp.fetcher');

    // Tool should be registered
    const tools = toolRegistry.list();
    expect(tools.map((t) => t.name)).toContain('fetcher:fetch');
    expect(tools.map((t) => t.name)).toContain('fetch');

    // Context should have the MCP client provided
    expect(context.get('mcp.client.fetcher')).toBe(mockClient);

    // Execute through ToolRegistry
    const result = (await toolRegistry.execute(
      'fetcher:fetch',
      { url: 'https://lobehub.com' },
      context as any,
    )) as any;
    expect(result).toEqual({ result: 'executed fetch with {"url":"https://lobehub.com"}' });
    expect(callToolMock).toHaveBeenCalledWith('fetch', { url: 'https://lobehub.com' });

    // Unmount should dispose fiber, run effect cleanup (closing client) and remove tools
    await manager.unmount('mcp.fetcher');
    expect(closeMock).toHaveBeenCalled();
    expect(toolRegistry.list().map((t) => t.name)).not.toContain('fetcher:fetch');
  });

  it('supports hot-reloading MCP plugin with new tools without leaked state', async () => {
    const context = new Context();
    const toolRegistry = new ToolRegistry();
    context.provide('cordis.tools', toolRegistry);

    const closeV1 = vi.fn();
    const closeV2 = vi.fn();

    const clientV1: McpClientLike = {
      callTool: vi.fn(async () => 'v1 output'),
      close: closeV1,
      listTools: vi.fn(async () => [{ name: 'v1Tool' }]),
    };

    const clientV2: McpClientLike = {
      callTool: vi.fn(async () => 'v2 output'),
      close: closeV2,
      listTools: vi.fn(async () => [{ name: 'v2Tool' }]),
    };

    const pluginV1 = createMcpPluginManifest({
      clientFactory: () => clientV1,
      clientParams: { name: 'server', type: 'stdio' } as any,
      id: 'server',
      version: '1.0.0',
    });

    const pluginV2 = createMcpPluginManifest({
      clientFactory: () => clientV2,
      clientParams: { name: 'server', type: 'stdio' } as any,
      id: 'server',
      version: '2.0.0',
    });

    const manager = new PluginManager([pluginV1, pluginV2], context);
    await manager.mount('mcp.server');

    expect(toolRegistry.list().map((t) => t.name)).toContain('server:v1Tool');
    expect(toolRegistry.list().map((t) => t.name)).not.toContain('server:v2Tool');

    // Hot-reload to v2
    await manager.reload('mcp.server');

    // Old client should be closed, old tools removed, new tools active!
    expect(closeV1).toHaveBeenCalled();
    expect(toolRegistry.list().map((t) => t.name)).not.toContain('server:v1Tool');
    expect(toolRegistry.list().map((t) => t.name)).toContain('server:v2Tool');

    const result = await toolRegistry.execute('server:v2Tool', {}, context as any);
    expect(result).toBe('v2 output');

    await manager.unmount('mcp.server');
    expect(closeV2).toHaveBeenCalled();
  });

  it('supports real MCPClient disconnect contract and cleans up properly', async () => {
    const context = new Context();
    const toolRegistry = new ToolRegistry();
    context.provide('cordis.tools', toolRegistry);

    const disconnectMock = vi.fn();
    const mockClient: McpClientLike = {
      callTool: vi.fn(),
      disconnect: disconnectMock,
      listTools: vi.fn(async () => [{ name: 'testTool' }]),
    };

    const plugin = createMcpPluginManifest({
      clientFactory: () => mockClient,
      clientParams: { args: [], command: 'node', name: 'realServer', type: 'stdio' },
      id: 'realServer',
    });

    const manager = new PluginManager([plugin], context);
    await manager.mount('mcp.realServer');

    expect(toolRegistry.list().map((t) => t.name)).toContain('realServer:testTool');

    await manager.unmount('mcp.realServer');
    expect(disconnectMock).toHaveBeenCalledTimes(1);
    expect(toolRegistry.list().map((t) => t.name)).not.toContain('realServer:testTool');
  });

  it('rejects empty tools when allowEmptyTools is not enabled and disconnects immediately', async () => {
    const context = new Context();
    const toolRegistry = new ToolRegistry();
    context.provide('cordis.tools', toolRegistry);

    const disconnectMock = vi.fn();
    const emptyClient: McpClientLike = {
      callTool: vi.fn(),
      disconnect: disconnectMock,
      listTools: vi.fn(async () => []),
    };

    const plugin = createMcpPluginManifest({
      clientFactory: () => emptyClient,
      clientParams: { args: [], command: 'node', name: 'emptyServer', type: 'stdio' },
      id: 'emptyServer',
    });

    const manager = new PluginManager([plugin], context);
    const state = await manager.mount('mcp.emptyServer');

    expect(state).toBe('failed');
    expect(manager.getState('mcp.emptyServer')).toBe('failed');
    // Fiber disposal must invoke disconnectMock immediately to prevent resource leak
    expect(disconnectMock).toHaveBeenCalled();
    expect(toolRegistry.list()).toHaveLength(0);
  });

  it('allows empty tools when allowEmptyTools: true is explicitly specified', async () => {
    const context = new Context();
    const toolRegistry = new ToolRegistry();
    context.provide('cordis.tools', toolRegistry);

    const emptyClient: McpClientLike = {
      callTool: vi.fn(),
      disconnect: vi.fn(),
      listTools: vi.fn(async () => []),
    };

    const plugin = createMcpPluginManifest({
      allowEmptyTools: true,
      clientFactory: () => emptyClient,
      clientParams: { args: [], command: 'node', name: 'emptyServer2', type: 'stdio' },
      id: 'emptyServer2',
    });

    const manager = new PluginManager([plugin], context);
    const state = await manager.mount('mcp.emptyServer2');

    expect(state).toBe('active');
    expect(toolRegistry.list()).toHaveLength(0);
    await manager.unmount('mcp.emptyServer2');
  });
});
