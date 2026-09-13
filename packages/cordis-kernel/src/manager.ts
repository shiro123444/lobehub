import type { CapabilityRegistry } from './capability';
import { Context } from './context';
import type { Fiber } from './fiber';
import type { ToolRegistry } from './tool';
import type { PermissionManifest, RuntimePluginKind, RuntimePluginManifest } from './types';

export type PluginRuntimeState =
  | 'installed'
  | 'pending'
  | 'active'
  | 'failed'
  | 'unloading'
  | 'disabled';

export interface PluginDescriptor {
  error?: unknown;
  id: string;
  inject?: string[];
  kind: RuntimePluginKind;
  permissions?: PermissionManifest;
  state: PluginRuntimeState;
  version: string;
}

export type PluginManagerErrorCode = 'PLUGIN_DUPLICATE' | 'PLUGIN_NOT_FOUND';

export class PluginManagerError extends Error {
  constructor(
    public readonly code: PluginManagerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PluginManagerError';
  }
}

interface ManagedPlugin {
  error?: unknown;
  fiber?: Fiber;
  readonly manifest: RuntimePluginManifest;
  state: PluginRuntimeState;
}

interface ActivationResult {
  record: ManagedPlugin;
  state: PluginRuntimeState;
}

const keyOf = (manifest: RuntimePluginManifest): string => `${manifest.id}@${manifest.version}`;

const stateOf = (fiber: Fiber): PluginRuntimeState => {
  switch (fiber.state) {
    case 'active': {
      return 'active';
    }
    case 'failed': {
      return 'failed';
    }
    case 'unloading': {
      return 'unloading';
    }
    case 'disposed': {
      return 'disabled';
    }
    default: {
      return 'pending';
    }
  }
};

export class PluginManager {
  public readonly context: Context;
  private readonly definitions = new Map<string, RuntimePluginManifest[]>();
  private readonly records = new Map<string, ManagedPlugin>();
  private readonly current = new Map<string, ManagedPlugin>();
  private readonly operations = new Map<string, Promise<PluginRuntimeState>>();
  private readonly lastErrors = new Map<string, unknown>();

  constructor(manifests: RuntimePluginManifest[] = [], context?: Context) {
    this.context = context ?? new Context();
    for (const manifest of manifests) {
      this.install(manifest);
    }
  }

  install(manifest: RuntimePluginManifest): void {
    const key = keyOf(manifest);
    if (this.records.has(key)) {
      throw new PluginManagerError('PLUGIN_DUPLICATE', `Duplicate plugin manifest: ${key}`);
    }

    const versions = this.definitions.get(manifest.id) ?? [];
    versions.push(manifest);
    this.definitions.set(manifest.id, versions);

    const record: ManagedPlugin = { manifest, state: 'installed' };
    this.records.set(key, record);
    if (!this.current.has(manifest.id)) this.current.set(manifest.id, record);
  }

  async uninstall(id: string): Promise<void> {
    await this.enqueue(id, async () => {
      const record = this.current.get(id);
      if (record) {
        await this.unmountInternal(id);
        this.current.delete(id);
      }
      const versions = this.definitions.get(id);
      if (versions) {
        for (const manifest of versions) {
          this.records.delete(keyOf(manifest));
        }
        this.definitions.delete(id);
      }
      this.lastErrors.delete(id);
      return 'disabled';
    });
  }

  has(id: string): boolean {
    return this.current.has(id);
  }

  async list(): Promise<PluginDescriptor[]> {
    for (const record of this.records.values()) this.refresh(record);

    return [...this.records.values()].map((record) => ({
      id: record.manifest.id,
      version: record.manifest.version,
      kind: record.manifest.kind,
      inject: record.manifest.inject,
      permissions: record.manifest.permissions,
      state: record.state,
      error: record.error ?? this.lastErrors.get(record.manifest.id),
    }));
  }

  getState(id: string): PluginRuntimeState | null {
    const record = this.current.get(id);
    if (!record) return null;
    this.refresh(record);
    return record.state;
  }

  getError(id: string): unknown {
    const record = this.current.get(id);
    if (record) this.refresh(record);
    return record?.error ?? this.lastErrors.get(id);
  }

  mount(id: string, config?: unknown): Promise<PluginRuntimeState> {
    return this.enqueue(id, () => this.mountInternal(id, config));
  }

  unmount(id: string): Promise<PluginRuntimeState> {
    return this.enqueue(id, () => this.unmountInternal(id));
  }

  reload(id: string, config?: unknown, targetVersion?: string): Promise<PluginRuntimeState> {
    return this.enqueue(id, () => this.reloadInternal(id, config, targetVersion));
  }

  private enqueue(
    id: string,
    operation: () => Promise<PluginRuntimeState>,
  ): Promise<PluginRuntimeState> {
    const existing = this.operations.get(id);
    const task = (existing ? existing.then(operation, operation) : operation()).finally(() => {
      if (this.operations.get(id) === task) this.operations.delete(id);
    });
    this.operations.set(id, task);
    return task;
  }

  private async mountInternal(id: string, config?: unknown): Promise<PluginRuntimeState> {
    const record = this.current.get(id);
    if (!record) throw new PluginManagerError('PLUGIN_NOT_FOUND', `Plugin is not installed: ${id}`);

    this.refresh(record);
    if (
      record.state === 'active' ||
      record.state === 'pending' ||
      record.state === 'unloading' ||
      record.state === 'failed'
    ) {
      return record.state;
    }

    const result = await this.activate(record.manifest, config);
    record.state = result.state;
    record.fiber = result.record.fiber;
    record.error = result.record.error;
    if (result.state === 'active' || result.state === 'pending') {
      this.lastErrors.delete(id);
    } else if (result.record.error) {
      this.lastErrors.set(id, result.record.error);
    }
    return result.state;
  }

  private async unmountInternal(id: string): Promise<PluginRuntimeState> {
    const record = this.current.get(id);
    if (!record) throw new PluginManagerError('PLUGIN_NOT_FOUND', `Plugin is not installed: ${id}`);

    this.refresh(record);
    if (record.state === 'disabled' || record.state === 'installed') {
      record.state = 'disabled';
      return record.state;
    }
    if (record.state === 'failed' && !record.fiber) {
      record.state = 'disabled';
      return record.state;
    }

    record.state = 'unloading';
    await record.fiber?.dispose();
    record.state = 'disabled';
    return record.state;
  }

  private async reloadInternal(
    id: string,
    config?: unknown,
    targetVersion?: string,
  ): Promise<PluginRuntimeState> {
    const oldRecord = this.current.get(id);
    if (!oldRecord)
      throw new PluginManagerError('PLUGIN_NOT_FOUND', `Plugin is not installed: ${id}`);

    this.refresh(oldRecord);
    if (oldRecord.state !== 'active') return this.mountInternal(id, config);

    const candidateManifest = this.resolveCandidateManifest(id, oldRecord.manifest, targetVersion);
    const result = await this.activate(candidateManifest, config, true);
    const candidateKey = keyOf(candidateManifest);

    if (result.state !== 'active') {
      this.lastErrors.set(
        id,
        result.record.error ?? new Error('Plugin reload did not become active'),
      );
      if (result.record.fiber) {
        result.record.fiber.ctx.discardStaged();
        const tools = this.context.get<ToolRegistry>('cordis.tools');
        tools?.discardStaging(result.record.fiber);
        const capabilities = this.context.get<CapabilityRegistry>('cordis.capabilities');
        capabilities?.discardStaging(result.record.fiber);
        await result.record.fiber.dispose();
      }
      if (candidateKey !== keyOf(oldRecord.manifest)) this.records.set(candidateKey, result.record);
      return 'active';
    }

    const candidateFiber = result.record.fiber;
    if (candidateFiber) {
      candidateFiber.ctx.commitStaged();
      const tools = this.context.get<ToolRegistry>('cordis.tools');
      tools?.commitStaging(candidateFiber);
      const capabilities = this.context.get<CapabilityRegistry>('cordis.capabilities');
      capabilities?.commitStaging(candidateFiber);
    }

    const newRecord = result.record;
    this.records.set(candidateKey, newRecord);
    this.current.set(id, newRecord);

    if (oldRecord.fiber) {
      oldRecord.state = 'unloading';
      const tools = this.context.get<ToolRegistry>('cordis.tools');
      await tools?.drainInFlight(oldRecord.fiber, 5000);
      await oldRecord.fiber.dispose();
      oldRecord.state = 'disabled';
    }
    this.lastErrors.delete(id);
    return 'active';
  }

  private async activate(
    manifest: RuntimePluginManifest,
    config?: unknown,
    isStaging = false,
  ): Promise<ActivationResult> {
    const record: ManagedPlugin = { manifest, state: 'pending' };
    const before = new Set(this.context.getFibers());

    try {
      const fiber = await this.context.plugin(manifest, config, isStaging);
      record.fiber = fiber;
      await this.context.flushPending();
      this.refresh(record);

      if (record.state === 'failed') {
        await this.disposeNewFibers(before, manifest.id);
      }
      return { record, state: record.state };
    } catch (error) {
      record.state = 'failed';
      record.error = error;
      await this.disposeNewFibers(before, manifest.id);
      return { record, state: 'failed' };
    }
  }

  private async disposeNewFibers(before: Set<Fiber>, name: string): Promise<void> {
    const newFibers = this.context
      .getFibers()
      .filter((fiber) => !before.has(fiber) && fiber.name === name);
    for (const fiber of newFibers) await fiber.dispose();
  }

  private resolveCandidateManifest(
    id: string,
    current: RuntimePluginManifest,
    targetVersion?: string,
  ): RuntimePluginManifest {
    const versions = this.definitions.get(id) ?? [];
    if (targetVersion !== undefined) {
      const match = versions.find((manifest) => manifest.version === targetVersion);
      if (!match) {
        throw new PluginManagerError(
          'PLUGIN_NOT_FOUND',
          `Version ${targetVersion} not found for plugin: ${id}`,
        );
      }
      return match;
    }

    return versions.at(-1) ?? current;
  }

  private refresh(record: ManagedPlugin): void {
    if (!record.fiber) return;
    record.state = stateOf(record.fiber);
    if (record.state === 'failed') record.error ??= record.fiber.error;
  }
}
