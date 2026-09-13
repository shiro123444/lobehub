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
  private readonly stagedTools = new Map<RuntimeContext['fiber'], Map<string, RegisteredTool>>();
  private readonly inFlight = new Map<RuntimeContext['fiber'], number>();
  private readonly inFlightDrainers = new Map<RuntimeContext['fiber'], Set<() => void>>();

  register(context: RuntimeContext, definition: ToolDefinition): Disposable {
    const isStaging = Boolean((context as any).isStaging);
    const fiber = context.fiber;

    if (isStaging) {
      let fiberStaged = this.stagedTools.get(fiber);
      if (!fiberStaged) {
        fiberStaged = new Map();
        this.stagedTools.set(fiber, fiberStaged);
      }
      if (fiberStaged.has(definition.name)) {
        throw new ToolRegistryError(
          'TOOL_DUPLICATE',
          `Tool is already registered in candidate staging: ${definition.name}`,
        );
      }

      const entry: RegisteredTool = {
        definition,
        owner: fiber,
        scope: scopeOf(context),
      };
      fiberStaged.set(definition.name, entry);

      const remove = () => {
        const staged = this.stagedTools.get(fiber);
        if (staged?.get(definition.name) === entry) {
          staged.delete(definition.name);
          if (staged.size === 0) this.stagedTools.delete(fiber);
        }
      };

      try {
        return fiber.collect(remove);
      } catch (error) {
        remove();
        throw error;
      }
    }

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

  commitStaging(fiber: RuntimeContext['fiber']): void {
    const fiberObj = fiber as any;
    if (typeof fiberObj?.getChildren === 'function') {
      for (const child of fiberObj.getChildren()) {
        this.commitStaging(child);
      }
    }
    const staged = this.stagedTools.get(fiber);
    if (!staged) return;

    for (const [name, entry] of staged) {
      this.tools.set(name, entry);
      const remove = () => {
        if (this.tools.get(name) === entry) this.tools.delete(name);
      };
      fiber.collect(remove);
    }
    this.stagedTools.delete(fiber);
  }

  discardStaging(fiber: RuntimeContext['fiber']): void {
    const fiberObj = fiber as any;
    if (typeof fiberObj?.getChildren === 'function') {
      for (const child of fiberObj.getChildren()) {
        this.discardStaging(child);
      }
    }
    this.stagedTools.delete(fiber);
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

    const owner = entry.owner;
    this.inFlight.set(owner, (this.inFlight.get(owner) ?? 0) + 1);

    try {
      return await entry.definition.execute(args, context);
    } finally {
      const current = (this.inFlight.get(owner) ?? 1) - 1;
      if (current <= 0) {
        this.inFlight.delete(owner);
        const drainers = this.inFlightDrainers.get(owner);
        if (drainers) {
          for (const drain of drainers) drain();
          this.inFlightDrainers.delete(owner);
        }
      } else {
        this.inFlight.set(owner, current);
      }
    }
  }

  async drainInFlight(fiber: RuntimeContext['fiber'], timeoutMs = 5000): Promise<void> {
    if ((this.inFlight.get(fiber) ?? 0) <= 0) return;

    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const drainer = () => {
        if (timer) clearTimeout(timer);
        resolve();
      };

      if (!this.inFlightDrainers.has(fiber)) {
        this.inFlightDrainers.set(fiber, new Set());
      }
      this.inFlightDrainers.get(fiber)!.add(drainer);

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.inFlightDrainers.get(fiber)?.delete(drainer);
          resolve();
        }, timeoutMs);
      }
    });
  }
}
