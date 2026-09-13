import { randomUUID } from 'node:crypto';

import { z, type ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import {
  Context,
  PluginManager,
  type RuntimeContext,
  ToolRegistry,
} from '../../../packages/cordis-kernel/src';
import type { RuntimeScope } from '../../../packages/runtime-contracts/src';

export interface AtomicInvocation {
  readonly jobId?: string;
  readonly onEvent?: (event: AtomicOperationEvent) => void;
  readonly scope: RuntimeScope;
  readonly services?: Record<string, unknown>;
  readonly signal?: AbortSignal;
}
export interface AtomicOperationEvent {
  errorCode?: string;
  jobId?: string;
  name: string;
  operationId: string;
  pluginVersion: string;
  state: 'started' | 'completed' | 'failed';
  timestamp: string;
}
export interface AtomicOperation {
  /** Trusted plugin opt-in to agent discovery; never accepted from user input. */
  agent?: { contexts: string[]; maxCalls?: number };
  description: string;
  execute: (input: any, invocation: AtomicInvocation) => unknown | Promise<unknown>;
  input: ZodTypeAny;
  name: string;
  output?: ZodTypeAny;
}
export interface AtomicPlugin {
  id: string;
  operations: AtomicOperation[];
  version: string;
}
const fail = (code: string, message: string) => Object.assign(new Error(message), { code });
const scopeSchema = z.object({
  userId: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
});

/** Generic plugin host. Trusted invocation context is never accepted in tool arguments. */
export class AtomicRuntime {
  private readonly context = new Context();
  private readonly registry = new ToolRegistry();
  private readonly manager = new PluginManager([], this.context);
  private readonly plugins = new Map<string, AtomicPlugin>();
  private readonly leases = new Map<string, number>();
  private readonly changing = new Set<string>();
  private readonly events = new Map<string, AtomicOperationEvent[]>();
  private readonly controllers = new Set<AbortController>();
  private pending: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(plugins: AtomicPlugin[] = []) {
    this.context.provide('cordis.tools', this.registry);
    for (const plugin of plugins) this.pending = this.pending.then(() => this.install(plugin));
  }

  private manifest(plugin: AtomicPlugin) {
    const names = new Set<string>();
    for (const operation of plugin.operations) {
      if (!operation.name.startsWith(`${plugin.id}.`) || names.has(operation.name))
        throw fail(
          'PLUGIN_INVALID',
          'Operations must have unique names inside their plugin namespace',
        );
      names.add(operation.name);
    }
    return {
      id: plugin.id,
      version: plugin.version,
      kind: 'capability' as const,
      permissions: { tools: [...names] },
      apply: (ctx: RuntimeContext) => {
        for (const operation of plugin.operations)
          this.registry.register(ctx, {
            name: operation.name,
            description: operation.description,
            inputSchema: zodToJsonSchema(operation.input, { $refStrategy: 'none' }),
            execute: async (raw, executionContext) => {
              const invocation = (executionContext as unknown as { invocation: AtomicInvocation })
                .invocation;
              const parsed = operation.input.safeParse(raw);
              if (!parsed.success)
                throw fail(
                  'PRESENTATION_INVALID',
                  parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
                );
              if (invocation.signal?.aborted)
                throw fail('PRESENTATION_WORKER_CANCELLED', 'Operation cancelled');
              const value = await operation.execute(parsed.data, invocation);
              if (invocation.signal?.aborted)
                throw fail('PRESENTATION_WORKER_CANCELLED', 'Operation cancelled');
              return operation.output ? operation.output.parse(value) : value;
            },
          });
      },
    };
  }

  private async install(plugin: AtomicPlugin) {
    this.manager.install(this.manifest(plugin));
    if ((await this.manager.mount(plugin.id)) !== 'active')
      throw fail('PLUGIN_START_FAILED', `Cannot mount ${plugin.id}`);
    this.plugins.set(plugin.id, plugin);
  }

  async add(plugin: AtomicPlugin) {
    await this.pending;
    if (this.disposed || this.plugins.has(plugin.id) || this.changing.has(plugin.id))
      throw fail('PLUGIN_BUSY', 'Plugin is already installed or changing');
    this.changing.add(plugin.id);
    try {
      await this.install(plugin);
    } finally {
      this.changing.delete(plugin.id);
    }
  }
  async remove(pluginId: string) {
    await this.pending;
    if (this.changing.has(pluginId) || (this.leases.get(pluginId) ?? 0) > 0)
      throw fail('PLUGIN_BUSY', 'Finish or cancel active jobs before unloading this plugin');
    this.changing.add(pluginId);
    try {
      await this.manager.uninstall(pluginId);
      this.plugins.delete(pluginId);
    } finally {
      this.changing.delete(pluginId);
    }
  }

  async withPlugins<T>(pluginIds: string[], operation: () => Promise<T>): Promise<T> {
    const release: (() => void)[] = [];
    try {
      for (const id of [...new Set(pluginIds)].sort()) release.push(await this.acquire(id));
      return await operation();
    } finally {
      for (const done of release.reverse()) done();
    }
  }

  async acquire(pluginId: string): Promise<() => void> {
    await this.pending;
    if (this.disposed || this.changing.has(pluginId) || !this.plugins.has(pluginId))
      throw fail('PROVIDER_UNAVAILABLE', `Plugin ${pluginId} is unavailable`);
    this.leases.set(pluginId, (this.leases.get(pluginId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.leases.set(pluginId, (this.leases.get(pluginId) ?? 1) - 1);
    };
  }

  async invoke<T = unknown>(
    name: string,
    input: unknown,
    invocation: AtomicInvocation,
  ): Promise<T> {
    scopeSchema.parse(invocation.scope);
    const pluginId = name.split('.')[0];
    const release = await this.acquire(pluginId);
    const controller = new AbortController();
    this.controllers.add(controller);
    const signal = invocation.signal
      ? AbortSignal.any([invocation.signal, controller.signal])
      : controller.signal;
    const scopeKey = JSON.stringify([invocation.scope.userId, invocation.scope.sessionId]);
    const event = {
      name,
      jobId: invocation.jobId,
      operationId: randomUUID(),
      pluginVersion: this.plugins.get(pluginId)!.version,
    };
    const publish = (state: AtomicOperationEvent['state'], errorCode?: string) => {
      const item = { ...event, state, errorCode, timestamp: new Date().toISOString() };
      const history = this.events.get(scopeKey) ?? [];
      history.push(item);
      this.events.set(scopeKey, history.slice(-200));
      invocation.onEvent?.(item);
    };
    try {
      publish('started');
      const ctx = Object.assign(this.context.withScope(scopeKey), {
        invocation: { ...invocation, signal },
      });
      const result = await this.registry.execute(name, input, ctx);
      publish('completed');
      return result as T;
    } catch (error) {
      publish('failed', (error as { code?: string })?.code ?? 'OPERATION_FAILED');
      throw error;
    } finally {
      this.controllers.delete(controller);
      release();
    }
  }

  async catalog() {
    await this.pending;
    return this.registry.list().map((tool) => ({
      ...tool,
      agent: this.plugins
        .get(tool.name.split('.')[0])
        ?.operations.find((op) => op.name === tool.name)?.agent,
      pluginVersion: this.plugins.get(tool.name.split('.')[0])?.version,
    }));
  }
  async snapshot(scope: RuntimeScope) {
    scopeSchema.parse(scope);
    await this.pending;
    return {
      plugins: await this.manager.list(),
      operations: this.events.get(JSON.stringify([scope.userId, scope.sessionId])) ?? [],
    };
  }

  /** A whole job holds a lease: replacement never mixes implementation versions mid-job. */
  async replace(plugin: AtomicPlugin) {
    await this.pending;
    if (this.disposed || this.changing.has(plugin.id) || (this.leases.get(plugin.id) ?? 0) > 0)
      throw fail('PLUGIN_BUSY', 'Finish or cancel active jobs before replacing this plugin');
    this.changing.add(plugin.id);
    try {
      this.manager.install(this.manifest(plugin));
      const state = await this.manager.reload(plugin.id, undefined, plugin.version);
      if (state !== 'active' || this.manager.getError(plugin.id))
        throw fail('PLUGIN_START_FAILED', `Cannot replace ${plugin.id}`);
      this.plugins.set(plugin.id, plugin);
    } finally {
      this.changing.delete(plugin.id);
    }
  }
  async dispose() {
    this.disposed = true;
    for (const controller of this.controllers) controller.abort();
    await this.pending.catch(() => undefined);
    await this.context.dispose();
    this.events.clear();
  }
}
