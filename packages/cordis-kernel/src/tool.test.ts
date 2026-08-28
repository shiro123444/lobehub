import { describe, expect, it } from 'vitest';

import { Context, ToolRegistry } from './index';
import type { ToolDefinition, ToolExecutionContext } from './tool';
import type { RuntimeContext } from './types';

const definition = (
  name: string,
  execute: ToolDefinition['execute'] = async () => ({ ok: true }),
): ToolDefinition => ({
  name,
  description: `${name} description`,
  inputSchema: { type: 'object' },
  execute,
});

const makeContext = () => new Context();

describe('@lobechat/cordis-kernel ToolRegistry', () => {
  it('registers a definition and lists its descriptor', () => {
    const context = makeContext();
    const registry = new ToolRegistry();
    const disposer = registry.register(context, definition('search'));

    expect(registry.list()).toEqual([
      {
        name: 'search',
        description: 'search description',
        inputSchema: { type: 'object' },
        scope: undefined,
      },
    ]);
    expect(typeof disposer).toBe('function');
    disposer();
  });

  it('rejects duplicate names with TOOL_DUPLICATE', () => {
    const context = makeContext();
    const registry = new ToolRegistry();
    registry.register(context, definition('duplicate'));

    expect(() => registry.register(context, definition('duplicate'))).toThrow(
      expect.objectContaining({ code: 'TOOL_DUPLICATE' }),
    );
  });

  it('filters descriptors by runtime scope', () => {
    const context = makeContext();
    const registry = new ToolRegistry();
    const scopedA = context.withScope('scope-a');
    const scopedB = context.withScope('scope-b');
    registry.register(scopedA, definition('a-tool'));
    registry.register(scopedB, definition('b-tool'));

    expect(registry.list('scope-a').map(({ name }) => name)).toEqual(['a-tool']);
    expect(registry.list('scope-b').map(({ name }) => name)).toEqual(['b-tool']);
    expect(registry.list().map(({ name }) => name)).toEqual(['a-tool', 'b-tool']);
  });

  it('executes a registered tool with args and its execution context', async () => {
    const context = makeContext();
    const registry = new ToolRegistry();
    const args = { query: 'cordis' };
    let receivedContext: ToolExecutionContext | undefined;
    registry.register(
      context,
      definition('execute', (receivedArgs, received) => {
        expect(receivedArgs).toBe(args);
        receivedContext = received;
        return { count: 1 };
      }),
    );

    const result = await registry.execute('execute', args, context);

    expect(result).toEqual({ count: 1 });
    expect(receivedContext).toBe(context);
  });

  it('passes the optional policy hook without implementing policy decisions', async () => {
    const context = makeContext();
    const registry = new ToolRegistry();
    const calls: string[] = [];
    const executionContext = Object.assign(context, {
      policy: async (name: string) => {
        calls.push(name);
      },
    }) as ToolExecutionContext;
    registry.register(context, definition('policy-aware'));

    await registry.execute('policy-aware', {}, executionContext);

    expect(calls).toEqual(['policy-aware']);
  });

  it('reports TOOL_NOT_FOUND for an unknown tool', async () => {
    const context = makeContext();
    const registry = new ToolRegistry();

    await expect(registry.execute('missing', {}, context)).rejects.toMatchObject({
      code: 'TOOL_NOT_FOUND',
    });
  });

  it('preserves the original tool execution error', async () => {
    const context = makeContext();
    const failure = new Error('tool failed');
    const registry = new ToolRegistry();
    registry.register(
      context,
      definition('broken', () => Promise.reject(failure)),
    );

    await expect(registry.execute('broken', {}, context)).rejects.toBe(failure);
  });

  it('removes a tool when its owning Fiber is disposed', async () => {
    const context = makeContext();
    const registry = new ToolRegistry();
    const owner = await context.plugin({
      id: 'tool-owner',
      version: '1.0.0',
      kind: 'capability',
      apply: (pluginContext: RuntimeContext) => {
        registry.register(pluginContext, definition('owned'));
      },
    });

    expect(registry.list().map(({ name }) => name)).toEqual(['owned']);
    await owner.dispose();

    expect(registry.list()).toEqual([]);
    await context.dispose();
  });

  it('manual disposal removes only the registered tool', () => {
    const context = makeContext();
    const registry = new ToolRegistry();
    const first = registry.register(context, definition('first'));
    registry.register(context, definition('second'));

    first();

    expect(registry.list().map(({ name }) => name)).toEqual(['second']);
  });
});
