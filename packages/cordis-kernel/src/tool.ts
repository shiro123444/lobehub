import type { Disposable, RuntimeContext, ScopeKey } from './types';

export type ToolResult = unknown;

export type ToolPolicyHook = (
  name: string,
  args: unknown,
  context: ToolExecutionContext,
) => void | Promise<void>;

export interface ToolExecutionContext extends RuntimeContext {
  readonly policy?: ToolPolicyHook;
}

export interface ToolDefinition {
  readonly description: string;
  readonly execute: (
    args: unknown,
    context: ToolExecutionContext,
  ) => ToolResult | PromiseLike<ToolResult>;
  readonly inputSchema: unknown;
  readonly name: string;
}

export interface ToolDescriptor {
  readonly description: string;
  readonly inputSchema: unknown;
  readonly name: string;
  readonly scope?: ScopeKey;
}

export type ToolRegistryErrorCode = 'TOOL_DUPLICATE' | 'TOOL_NOT_FOUND';

export class ToolRegistryError extends Error {
  constructor(
    public readonly code: ToolRegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ToolRegistryError';
  }
}

interface RegisteredTool {
  readonly definition: ToolDefinition;
  readonly owner: RuntimeContext['fiber'];
  readonly scope?: ScopeKey;
}

type ScopedContext = RuntimeContext & { readonly scope?: ScopeKey };

const scopeOf = (context: RuntimeContext): ScopeKey | undefined => (context as ScopedContext).scope;

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(context: RuntimeContext, definition: ToolDefinition): Disposable {
    if (this.tools.has(definition.name)) {
      throw new ToolRegistryError(
        'TOOL_DUPLICATE',
        `Tool is already registered: ${definition.name}`,
      );
    }

    const entry: RegisteredTool = {
      definition,
      owner: context.fiber,
      scope: scopeOf(context),
    };
    this.tools.set(definition.name, entry);

    const remove = () => {
      if (this.tools.get(definition.name) === entry) this.tools.delete(definition.name);
    };

    try {
      return context.fiber.collect(remove);
    } catch (error) {
      remove();
      throw error;
    }
  }

  list(scope?: ScopeKey): ToolDescriptor[] {
    return [...this.tools.values()]
      .filter((entry) => scope === undefined || entry.scope === scope)
      .map(({ definition, scope }) => ({
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
        scope,
      }));
  }

  async execute(name: string, args: unknown, context: ToolExecutionContext): Promise<ToolResult> {
    const entry = this.tools.get(name);
    if (!entry) {
      throw new ToolRegistryError('TOOL_NOT_FOUND', `Tool is not registered: ${name}`);
    }

    await context.policy?.(name, args, context);
    return entry.definition.execute(args, context);
  }
}
