import type { RuntimeEvent } from './run';

export interface RunContext {
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly runId: string;
  readonly sessionId: string;
}

export interface StrategyInput {
  readonly input?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly runId: string;
  readonly userMessage?: string;
}

export interface RunDriver {
  execute: (input: StrategyInput) => AsyncIterable<RuntimeEvent>;
}

export interface AgentStrategyPlugin {
  createDriver: (context: RunContext) => RunDriver;
  readonly id: string;
}

export type StrategyRegistryErrorCode = 'STRATEGY_DUPLICATE' | 'STRATEGY_NOT_FOUND';

export class StrategyRegistryError extends Error {
  constructor(
    public readonly code: StrategyRegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StrategyRegistryError';
  }
}

export class AgentStrategyRegistry {
  private readonly plugins = new Map<string, AgentStrategyPlugin>();

  register(plugin: AgentStrategyPlugin): void {
    if (this.plugins.has(plugin.id)) {
      throw new StrategyRegistryError(
        'STRATEGY_DUPLICATE',
        `Strategy plugin is already registered: ${plugin.id}`,
      );
    }
    this.plugins.set(plugin.id, plugin);
  }

  get(id: string): AgentStrategyPlugin | undefined {
    return this.plugins.get(id);
  }

  list(): string[] {
    return [...this.plugins.keys()];
  }

  createDriver(strategyPluginId: string, context: RunContext): RunDriver {
    const plugin = this.plugins.get(strategyPluginId);
    if (!plugin) {
      throw new StrategyRegistryError(
        'STRATEGY_NOT_FOUND',
        `Strategy plugin is not registered: ${strategyPluginId}`,
      );
    }
    return plugin.createDriver(context);
  }

  execute(
    strategyPluginId: string,
    context: RunContext,
    input: StrategyInput,
  ): AsyncIterable<RuntimeEvent> {
    return this.createDriver(strategyPluginId, context).execute(input);
  }
}

export { StrategyRegistryError as AgentStrategyRegistryError };
