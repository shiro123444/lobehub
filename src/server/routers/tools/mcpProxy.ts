import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { type ToolCallContent } from '@/libs/mcp';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase, telemetry } from '@/libs/trpc/lambda/middleware';
import { FileService } from '@/server/services/file';
import { mcpProxyService } from '@/server/services/mcpProxy';
import { MCPProxyService } from '@/server/services/mcpProxy';
import { processContentBlocks } from '@/server/services/mcp/contentProcessor';

import { scheduleToolCallReport } from './_helpers';

// stdio 参数 schema
const stdioParamsSchema = z.object({
  args: z.array(z.string()).optional().default([]),
  command: z.string().min(1),
  env: z.record(z.string()).optional(),
  name: z.string().min(1),
  type: z.literal('stdio'),
});

const metaSchema = z
  .object({
    customPluginInfo: z
      .object({
        avatar: z.string().optional(),
        description: z.string().optional(),
        name: z.string().optional(),
      })
      .optional(),
    isCustomPlugin: z.boolean().optional(),
    sessionId: z.string().optional(),
    version: z.string().optional(),
  })
  .optional();

const mcpProxyProcedure = authedProcedure
  .use(serverDatabase)
  .use(telemetry)
  .use(async ({ ctx, next }) => {
    if (!MCPProxyService.isEnabled()) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'MCP Proxy is not enabled. Set MCP_PROXY_ENABLED=1 to use this feature.',
      });
    }

    return next({
      ctx: {
        fileService: new FileService(ctx.serverDB, ctx.userId),
      },
    });
  });

export const mcpProxyRouter = router({
  // 检查 proxy 状态
  status: mcpProxyProcedure.query(() => {
    return mcpProxyService.getStatus();
  }),

  // 列出 MCP 工具
  listTools: mcpProxyProcedure.input(stdioParamsSchema).query(async ({ input }) => {
    return await mcpProxyService.listTools(input);
  }),

  // 获取 MCP manifest
  getManifest: mcpProxyProcedure.input(stdioParamsSchema).query(async ({ input }) => {
    return await mcpProxyService.getManifest(input);
  }),

  // 调用 MCP 工具
  callTool: mcpProxyProcedure
    .input(
      z.object({
        args: z.any(),
        meta: metaSchema,
        params: stdioParamsSchema,
        toolName: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const startTime = Date.now();
      let success = true;
      let errorCode: string | undefined;
      let errorMessage: string | undefined;
      let result: { content: string; state: any; success: boolean } | undefined;

      try {
        const toolResult = await mcpProxyService.callTool({
          args: input.args,
          clientParams: input.params,
          toolName: input.toolName,
        });

        // 处理内容块（上传图片等）
        const newContent = toolResult.isError
          ? toolResult.content
          : await processContentBlocks(toolResult.content, ctx.fileService);

        // 转为字符串
        const { contentBlocksToString } = await import(
          '@/server/services/mcp/contentProcessor'
        );
        const content = contentBlocksToString(newContent);
        const state = { ...toolResult, content: newContent };

        result = { content, state, success: !toolResult.isError };
        return result;
      } catch (error) {
        success = false;
        const err = error as Error;
        errorCode = 'CALL_FAILED';
        errorMessage = err.message;
        throw error;
      } finally {
        scheduleToolCallReport({
          errorCode,
          errorMessage,
          identifier: input.params.name,
          marketAccessToken: ctx.marketAccessToken,
          mcpType: 'mcpProxy',
          meta: input.meta,
          requestPayload: input.args,
          result,
          startTime,
          success,
          telemetryEnabled: ctx.telemetryEnabled,
          toolName: input.toolName,
        });
      }
    }),
});
