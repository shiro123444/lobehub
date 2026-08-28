import { Context } from './context';
import type { Fiber } from './fiber';
import type { RuntimePluginManifest } from './types';

export type HostState = 'created' | 'starting' | 'active' | 'disposing' | 'disposed';

export interface RuntimeSnapshot {
  activePlugins: string[];
  state: HostState;
}

export type RuntimeHostErrorCode =
  | 'PLUGIN_DUPLICATE'
  | 'PLUGIN_DEPENDENCY_MISSING'
  | 'PLUGIN_START_FAILED'
  | 'HOST_ALREADY_DISPOSED';

export class RuntimeHostError extends Error {
  constructor(
    public readonly code: RuntimeHostErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RuntimeHostError';
  }
}

const pluginKey = (plugin: RuntimePluginManifest): string => `${plugin.id}@${plugin.version}`;

export class RuntimeHost {
  public state: HostState = 'created';

  private readonly manifests: RuntimePluginManifest[];
  private readonly fibers = new Map<string, Fiber>();
  private context?: Context;
  private startPromise?: Promise<RuntimeSnapshot>;
  private disposePromise?: Promise<void>;
  private disposeRequested = false;

  constructor(manifests: RuntimePluginManifest[]) {
    const seen = new Set<string>();
    for (const manifest of manifests) {
      const key = pluginKey(manifest);
      if (seen.has(key)) {
        throw new RuntimeHostError('PLUGIN_DUPLICATE', `Duplicate plugin manifest: ${key}`);
      }
      seen.add(key);
    }
    this.manifests = [...manifests];
  }

  start(): Promise<RuntimeSnapshot> {
    if (this.state === 'disposed' || this.state === 'disposing' || this.disposeRequested) {
      return Promise.reject(
        new RuntimeHostError('HOST_ALREADY_DISPOSED', 'RuntimeHost has already been disposed'),
      );
    }
    if (this.state === 'active') return Promise.resolve(this.snapshot());
    if (this.startPromise) return this.startPromise;

    this.state = 'starting';
    const task = this.startInternal();
    this.startPromise = task;
    void task.then(
      () => {
        if (this.startPromise === task) this.startPromise = undefined;
      },
      () => {
        if (this.startPromise === task) this.startPromise = undefined;
      },
    );
    return task;
  }

  snapshot(): RuntimeSnapshot {
    return {
      state: this.state,
      activePlugins: this.manifests
        .filter((manifest) => this.fibers.get(pluginKey(manifest))?.state === 'active')
        .map((manifest) => manifest.id),
    };
  }

  dispose(): Promise<void> {
    if (this.state === 'disposed') return Promise.resolve();
    if (this.disposePromise) return this.disposePromise;

    this.disposeRequested = true;
    if (this.state !== 'starting') this.state = 'disposing';
    const startPromise = this.startPromise;
    const task = (async () => {
      if (startPromise) {
        try {
          await startPromise;
        } catch {
          // Startup failure already rolled back its Context.
        }
      }

      if (this.state === 'disposed') return;
      this.state = 'disposing';
      await this.context?.dispose();
      this.context = undefined;
      this.fibers.clear();
      this.state = 'disposed';
    })();

    this.disposePromise = task;
    return task;
  }

  private async startInternal(): Promise<RuntimeSnapshot> {
    const context = new Context();
    this.context = context;
    this.fibers.clear();

    try {
      for (const manifest of this.manifests) {
        try {
          const fiber = await context.plugin(manifest);
          this.fibers.set(pluginKey(manifest), fiber);
        } catch (error) {
          throw new RuntimeHostError(
            'PLUGIN_START_FAILED',
            `Plugin ${pluginKey(manifest)} failed to start`,
            error,
          );
        }
      }

      await context.flushPending();

      const pending = [...this.fibers.values()].filter((fiber) => fiber.state === 'pending');
      if (pending.length > 0) {
        const missing = pending.flatMap((fiber) =>
          fiber.inject.filter((dependency) => !context.has(dependency)),
        );
        throw new RuntimeHostError(
          'PLUGIN_DEPENDENCY_MISSING',
          `Plugin dependencies are not available: ${[...new Set(missing)].join(', ') || 'unknown'}`,
        );
      }

      const failed = [...this.fibers.values()].find((fiber) => fiber.state === 'failed');
      if (failed) {
        throw new RuntimeHostError(
          'PLUGIN_START_FAILED',
          `Plugin ${failed.name} failed to start`,
          failed.error,
        );
      }

      if (this.disposeRequested) {
        await context.dispose();
        this.context = undefined;
        this.fibers.clear();
        this.state = 'disposed';
        return this.snapshot();
      }

      this.state = 'active';
      return this.snapshot();
    } catch (error) {
      await this.rollback(context);
      this.state = this.disposeRequested ? 'disposed' : 'created';
      if (error instanceof RuntimeHostError) throw error;
      throw new RuntimeHostError('PLUGIN_START_FAILED', 'RuntimeHost startup failed', error);
    }
  }

  private async rollback(context: Context): Promise<void> {
    try {
      await context.dispose();
    } finally {
      this.context = undefined;
      this.fibers.clear();
    }
  }
}
