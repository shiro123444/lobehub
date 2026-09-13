import { type ChatToolPayload } from '@lobechat/types';
import { detectTruncatedJSON, safeParseJSON } from '@lobechat/utils';
import debug from 'debug';

import type {
  ToolExecutionContext,
  ToolExecutionResult,
} from '@/server/services/toolExecution/types';

import type { ToolRegistry } from '../../../../packages/cordis-kernel/src/tool';
import type { CordisToolBridgeDeps } from './types';

const log = debug('lobe-server:cordis-tool-bridge');

export class CordisToolBridge {
  private readonly toolRegistry: ToolRegistry;
  private readonly fallbackExecutor?: CordisToolBridgeDeps['fallbackExecutor'];

  constructor(deps: CordisToolBridgeDeps) {
    this.toolRegistry = deps.toolRegistry;
    this.fallbackExecutor = deps.fallbackExecutor;
  }

  hasTool(identifier: string, apiName: string): boolean {
    const tools = this.toolRegistry.list();
    if (identifier) {
      const canonicalName = `${identifier}:${apiName}`;
      return tools.some((t) => t.name === canonicalName);
    }
    return tools.some((t) => t.name === apiName);
  }

  async execute(
    payload: ChatToolPayload,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const { identifier, apiName, arguments: argsStr } = payload;
    const parsed = safeParseJSON(argsStr);

    // Validate JSON arguments and preserve truncation diagnostics
    if (parsed === undefined && argsStr) {
      const truncationReason = detectTruncatedJSON(argsStr);
      const explanation = truncationReason
        ? `The tool call arguments JSON appears to be truncated (${truncationReason}), ` +
          `likely because the model's max_tokens budget was exhausted ` +
          `(possibly by extended-thinking tokens). ` +
          `Either reduce the size of the content you are about to write, ` +
          `or ask the user to increase the model's max_tokens ` +
          `(and/or disable extended thinking or set a separate thinking budget). ` +
          `Do not retry with the same payload.`
        : `The tool call arguments string is not valid JSON and could not be parsed, ` +
          `so the tool was not invoked. Fix the JSON syntax and try again.`;
      const content = `${explanation}\n\nThe received arguments string was:\n${argsStr}`;
      const code = truncationReason ? 'TRUNCATED_ARGUMENTS' : 'INVALID_JSON_ARGUMENTS';
      log('Rejected invalid arguments for %s:%s (%s): %s', identifier, apiName, code, argsStr);
      return {
        content,
        error: { code, message: explanation },
        success: false,
      };
    }

    const args = parsed || {};

    const registeredTools = this.toolRegistry.list();
    let resolvedName: string | null = null;
    if (identifier) {
      const canonicalName = `${identifier}:${apiName}`;
      if (registeredTools.some((t) => t.name === canonicalName)) {
        resolvedName = canonicalName;
      }
    } else {
      if (registeredTools.some((t) => t.name === apiName)) {
        resolvedName = apiName;
      }
    }

    if (!resolvedName) {
      const requestedName = identifier ? `${identifier}:${apiName}` : apiName;
      if (this.fallbackExecutor) {
        log('Tool %s not found in Cordis registry, delegating to fallback executor', requestedName);
        return await this.fallbackExecutor(payload, context);
      }

      return {
        content: `Tool "${requestedName}" is not registered in Cordis kernel`,
        error: {
          code: 'TOOL_NOT_FOUND',
          message: `Tool "${requestedName}" is not registered in Cordis kernel`,
        },
        success: false,
      };
    }

    try {
      log('Executing tool %s through Cordis kernel', resolvedName);
      const rawResult = await this.toolRegistry.execute(resolvedName, args, context as any);

      if (rawResult && typeof rawResult === 'object') {
        const record = rawResult as Record<string, any>;
        if ('success' in record && typeof record.success === 'boolean') {
          return rawResult as ToolExecutionResult;
        }

        // Handle MCP result format: { content: Array<{ type: 'text', text: string }>, isError?: boolean }
        if (record.isError === true) {
          let errorText = '';
          if (Array.isArray(record.content)) {
            errorText = record.content
              .map((c: any) =>
                c?.type === 'text' && typeof c?.text === 'string' ? c.text : JSON.stringify(c),
              )
              .join('\n');
          } else if (typeof record.content === 'string') {
            errorText = record.content;
          }
          const message = errorText || 'MCP tool reported an error';
          return {
            content: message,
            error: {
              code: 'MCP_TOOL_ERROR',
              message,
            },
            state: record,
            success: false,
          };
        }

        if (Array.isArray(record.content)) {
          const text = record.content
            .map((c: any) =>
              c?.type === 'text' && typeof c?.text === 'string' ? c.text : JSON.stringify(c),
            )
            .join('\n');
          return {
            content: text,
            state: record,
            success: true,
          };
        }
      }

      const content =
        typeof rawResult === 'string'
          ? rawResult
          : rawResult === undefined
            ? 'ok'
            : JSON.stringify(rawResult);

      return {
        content,
        state: typeof rawResult === 'object' && rawResult !== null ? (rawResult as any) : undefined,
        success: true,
      };
    } catch (e) {
      const error = e as Error;
      log('Error executing tool %s through Cordis kernel: %O', resolvedName, error);
      return {
        content: error.message || 'Tool execution failed',
        error,
        success: false,
      };
    }
  }
}
