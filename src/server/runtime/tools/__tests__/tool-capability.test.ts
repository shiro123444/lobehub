import { describe, expect, it } from 'vitest';

import { Context } from '../../../../../packages/cordis-kernel/src/context';
import { ToolRegistry } from '../../../../../packages/cordis-kernel/src/tool';
import { createToolCapabilityPort } from '../tool-capability';

describe('ToolCapabilityPort', () => {
  it('exposes descriptor with capabilities and builtin source', () => {
    const registry = new ToolRegistry();
    const port = createToolCapabilityPort(registry);

    expect(port.id).toBe('tools.execution');
    expect(port.descriptor).toMatchObject({
      capabilities: ['execute', 'list'],
      id: 'tools.execution',
      source: 'builtin',
    });
  });

  it('lists registered tools through execute({ action: "list" })', async () => {
    const context = new Context();
    const registry = new ToolRegistry();
    registry.register(context, {
      description: 'Calculator',
      execute: (args: any) => args.a + args.b,
      inputSchema: {},
      name: 'calc:add',
    });

    const port = createToolCapabilityPort(registry);
    const result = (await port.execute({ action: 'list' }, {})) as any[];

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      description: 'Calculator',
      name: 'calc:add',
    });
  });

  it('executes tool through execute({ action: "execute", name, args })', async () => {
    const context = new Context();
    const registry = new ToolRegistry();
    registry.register(context, {
      description: 'Echo',
      execute: (args: any) => ({ echoed: args.text }),
      inputSchema: {},
      name: 'test:echo',
    });

    const port = createToolCapabilityPort(registry);
    const result = await port.execute(
      { action: 'execute', args: { text: 'hello' }, name: 'test:echo' },
      {},
    );

    expect(result).toEqual({ echoed: 'hello' });
  });

  it('throws on invalid command or missing tool name', async () => {
    const registry = new ToolRegistry();
    const port = createToolCapabilityPort(registry);

    await expect(port.execute(null, {})).rejects.toThrow(/must be an object/);
    await expect(port.execute({ action: 'execute' }, {})).rejects.toThrow(/non-empty tool name/);
    await expect(port.execute({ action: 'unknown' }, {})).rejects.toThrow(/Unsupported/);
  });
});
