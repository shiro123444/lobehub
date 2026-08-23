import { type ToolManifest } from '@lobechat/types';
import { safeParseJSON } from '@lobechat/utils';
import { TRPCError } from '@trpc/server';
import debug from 'debug';

import { appEnv } from '@/envs/app';
import {
  type MCPClientParams,
  type McpTool,
  type StdioMCPParams,
  type ToolCallResult,
} from '@/libs/mcp';
import { MCPClient } from '@/libs/mcp';

const log = debug('lobe-mcp:proxy');

interface ManagedProcess {
  client: MCPClient;
  identifier: string;
  lastUsedAt: number;
  params: StdioMCPParams;
  startedAt: number;
}

/**
 * MCPProxyService — 管理服务端 MCP stdio 进程
 *
 * 让 Web 端用户也能使用 stdio 类型的 MCP 插件：
 * - 服务端启动 MCP 进程
 * - 前端通过 HTTP (tRPC) 调用
 * - 自动清理空闲进程
 */
export class MCPProxyService {
  private processes: Map<string, ManagedProcess> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // 定期清理空闲进程
    this.cleanupTimer = setInterval(() => this.cleanupIdleProcesses(), 60_000);
  }

  /**
   * 检查 MCP Proxy 是否启用
   */
  static isEnabled(): boolean {
    return !!appEnv.MCP_PROXY_ENABLED;
  }

  /**
   * 生成进程缓存 key
   */
  private getCacheKey(params: StdioMCPParams): string {
    return `${params.command}::${JSON.stringify([...params.args].sort())}`;
  }

  /**
   * 获取或创建 MCP 客户端
   */
  private async getOrCreateClient(params: StdioMCPParams): Promise<ManagedProcess> {
    const key = this.getCacheKey(params);

    const existing = this.processes.get(key);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing;
    }

    // 检查进程数限制
    const maxProcesses = appEnv.MCP_PROXY_MAX_PROCESSES ?? 50;
    if (this.processes.size >= maxProcesses) {
      // 清理最旧的空闲进程
      this.evictOldestIdle();
    }

    log('Starting MCP process: %s with args: %O', params.command, params.args);

    const client = new MCPClient(params);
    await client.initialize();

    const managed: ManagedProcess = {
      client,
      identifier: params.name,
      lastUsedAt: Date.now(),
      params,
      startedAt: Date.now(),
    };

    this.processes.set(key, managed);
    log('MCP process started and cached: %s (total: %d)', params.name, this.processes.size);

    return managed;
  }

  /**
   * 调用 MCP 工具
   */
  async callTool(params: {
    args: unknown;
    clientParams: StdioMCPParams;
    toolName: string;
  }): Promise<ToolCallResult> {
    const { clientParams, toolName, args } = params;

    const managed = await this.getOrCreateClient(clientParams);

    log('Calling tool "%s" on MCP process "%s"', toolName, managed.identifier);

    try {
      const result = await managed.client.callTool(toolName, args);
      log('Tool "%s" called successfully', toolName);
      return result as ToolCallResult;
    } catch (error) {
      log('Tool "%s" failed: %O', toolName, error);

      // 如果连接断开，移除缓存以便下次重建
      this.processes.delete(this.getCacheKey(clientParams));

      throw new TRPCError({
        cause: error,
        code: 'INTERNAL_SERVER_ERROR',
        message: `MCP proxy tool call failed: ${(error as Error).message}`,
      });
    }
  }

  /**
   * 列出 MCP 工具
   */
  async listTools(params: StdioMCPParams): Promise<McpTool[]> {
    const managed = await this.getOrCreateClient(params);

    try {
      return await managed.client.listTools();
    } catch (error) {
      this.processes.delete(this.getCacheKey(params));
      throw new TRPCError({
        cause: error,
        code: 'INTERNAL_SERVER_ERROR',
        message: `MCP proxy listTools failed: ${(error as Error).message}`,
      });
    }
  }

  /**
   * 获取 MCP manifest
   */
  async getManifest(params: StdioMCPParams): Promise<ToolManifest> {
    const managed = await this.getOrCreateClient(params);

    try {
      const manifest = await managed.client.listManifests();

      return {
        api: manifest.tools
          ? manifest.tools.map((t) => ({
              description: t.description,
              name: t.name,
              parameters: t.inputSchema,
            }))
          : [],
        identifier: params.name,
        meta: {
          avatar: 'MCP_AVATAR',
          description: `${params.name} MCP server (self-hosted proxy)`,
          title: params.name,
        },
        ...manifest,
        // @ts-ignore
        mcpParams: { ...params, type: 'stdio' },
        type: 'mcp' as any,
      } as ToolManifest;
    } catch (error) {
      this.processes.delete(this.getCacheKey(params));
      throw new TRPCError({
        cause: error,
        code: 'INTERNAL_SERVER_ERROR',
        message: `MCP proxy getManifest failed: ${(error as Error).message}`,
      });
    }
  }

  /**
   * 关闭指定进程
   */
  async closeProcess(params: StdioMCPParams): Promise<void> {
    const key = this.getCacheKey(params);
    const managed = this.processes.get(key);

    if (managed) {
      await managed.client.disconnect();
      this.processes.delete(key);
      log('MCP process closed: %s', managed.identifier);
    }
  }

  /**
   * 清理空闲进程
   */
  private cleanupIdleProcesses(): void {
    const idleTimeout = appEnv.MCP_PROXY_IDLE_TIMEOUT ?? 300_000;
    const now = Date.now();

    for (const [key, managed] of this.processes) {
      if (now - managed.lastUsedAt > idleTimeout) {
        log('Cleaning up idle MCP process: %s (idle: %dms)', managed.identifier, now - managed.lastUsedAt);
        managed.client.disconnect().catch((err) => {
          log('Error disconnecting idle process: %O', err);
        });
        this.processes.delete(key);
      }
    }
  }

  /**
   * 驱逐最旧的空闲进程
   */
  private evictOldestIdle(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, managed] of this.processes) {
      if (managed.lastUsedAt < oldestTime) {
        oldestTime = managed.lastUsedAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const managed = this.processes.get(oldestKey)!;
      log('Evicting oldest idle MCP process: %s', managed.identifier);
      managed.client.disconnect().catch(() => {});
      this.processes.delete(oldestKey);
    }
  }

  /**
   * 关闭所有进程（用于 graceful shutdown）
   */
  async shutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    const closePromises: Promise<void>[] = [];
    for (const [, managed] of this.processes) {
      closePromises.push(
        managed.client.disconnect().catch((err) => {
          log('Error during shutdown: %O', err);
        }),
      );
    }

    await Promise.all(closePromises);
    this.processes.clear();
    log('MCP Proxy shutdown complete');
  }

  /**
   * 获取当前运行状态
   */
  getStatus(): { activeProcesses: number; identifiers: string[] } {
    const identifiers: string[] = [];
    for (const [, managed] of this.processes) {
      identifiers.push(managed.identifier);
    }
    return {
      activeProcesses: this.processes.size,
      identifiers,
    };
  }
}

// Export a singleton instance
export const mcpProxyService = new MCPProxyService();
