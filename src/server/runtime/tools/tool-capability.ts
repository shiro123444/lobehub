import type {
  CapabilityContext,
  CapabilityPort,
} from '../../../../packages/cordis-kernel/src/capability';
import type { ToolRegistry } from '../../../../packages/cordis-kernel/src/tool';

export interface ToolCapabilityOptions {
  description?: string;
  id?: string;
}

export const createToolCapabilityPort = (
  toolRegistry: ToolRegistry,
  options: ToolCapabilityOptions = {},
): CapabilityPort => {
  const id = options.id ?? 'tools.execution';
  return {
    descriptor: {
      capabilities: ['execute', 'list'],
      description: options.description ?? 'Cordis Native Tool Execution Capability',
      id,
      source: 'builtin',
    },
    execute: async (command: unknown, context: CapabilityContext): Promise<unknown> => {
      if (typeof command !== 'object' || command === null) {
        throw new Error('Tool capability command must be an object');
      }
      const record = command as Record<string, unknown>;
      const action = record.action ?? 'execute';

      if (action === 'list') {
        return toolRegistry.list(record.scope as any);
      }

      if (action === 'execute') {
        const name = record.name;
        if (typeof name !== 'string' || !name.trim()) {
          throw new Error('Tool execution requires a non-empty tool name');
        }
        const args = record.args ?? record.arguments;
        return await toolRegistry.execute(name, args, context as any);
      }

      throw new Error(`Unsupported tool capability action: ${String(action)}`);
    },
    id,
  };
};
