import { EventBus } from './events';
import { Fiber } from './fiber';
import type {
  Disposable,
  Effect,
  Fiber as FiberContract,
  Listener,
  RuntimeContext,
  RuntimePluginManifest,
  ScopeKey,
} from './types';

interface ServiceRecord {
  readonly provider: Fiber;
  readonly value: unknown;
}

export class Context implements RuntimeContext {
  public readonly root: Context;
  public readonly fiber: Fiber;
  public readonly events: EventBus;
  public readonly scope?: ScopeKey;

  private readonly services: Map<string, ServiceRecord>;
  private readonly fibers: Set<Fiber>;
  private readonly pendingFibers: Set<Fiber>;
  private pendingRequested = false;
  private pendingFlush?: Promise<void>;

  constructor(root?: Context, fiber?: Fiber, scope?: ScopeKey) {
    if (root) {
      this.root = root.root;
      this.events = this.root.events;
      this.services = this.root.services;
      this.fibers = this.root.fibers;
      this.pendingFibers = this.root.pendingFibers;
      this.fiber = fiber!;
      this.scope = scope;
      return;
    }

    this.root = this;
    this.events = new EventBus();
    this.services = new Map();
    this.fibers = new Set();
    this.pendingFibers = new Set();

    const activeRootFiber = new Fiber('root', undefined, undefined, null, 'active');
    activeRootFiber.attachContext(this);
    this.fiber = activeRootFiber;
    this.fibers.add(activeRootFiber);
  }

  async plugin(plugin: RuntimePluginManifest, config?: unknown): Promise<Fiber> {
    this.fiber.assertMountable();

    const fiber = new Fiber(plugin.id, plugin, config, this.fiber);
    const childContext = new Context(this.root, fiber, this.scope);
    fiber.attachContext(childContext);
    this.fiber.addChild(fiber);
    this.root.fibers.add(fiber);

    await fiber.start();
    return fiber;
  }

  provide<T>(name: string, service: T): Disposable {
    this.fiber.assertMountable();
    const root = this.root;
    const record: ServiceRecord = { value: service, provider: this.fiber };
    root.services.set(name, record);

    const remove = () => {
      if (root.services.get(name) !== record) return;
      root.services.delete(name);
      root._schedulePending();
    };

    const disposer = this.fiber.collect(remove);
    root._schedulePending();
    return disposer;
  }

  get<T>(name: string): T | undefined {
    return this.root.services.get(name)?.value as T | undefined;
  }

  has(name: string): boolean {
    return this.root.services.has(name);
  }

  withScope(scope: ScopeKey): Context {
    return new Context(this.root, this.fiber, scope);
  }

  on(event: string, listener: Listener): Disposable {
    return this.fiber.collect(this.root.events.on(event, listener));
  }

  effect(factory: () => Effect | void): Disposable {
    return this.fiber.collectEffect(factory());
  }

  async dispose(): Promise<void> {
    await this.fiber.dispose();
  }

  async flushPending(): Promise<void> {
    const root = this.root;
    root._schedulePending();
    while (root.pendingFlush) {
      await root.pendingFlush;
      if (root.pendingRequested) root._schedulePending();
    }
  }

  getFibers(): Fiber[] {
    return [...this.root.fibers];
  }

  _dependenciesReady(fiber: Fiber): boolean {
    const root = this.root;
    return fiber.inject.every((name) => {
      const record = root.services.get(name);
      return record !== undefined && record.provider.state === 'active';
    });
  }

  _markPending(fiber: Fiber): void {
    this.root.pendingFibers.add(fiber);
  }

  _unmarkPending(fiber: Fiber): void {
    this.root.pendingFibers.delete(fiber);
  }

  _onFiberStateChange(fiber: FiberContract): void {
    const root = this.root;
    if (fiber.state !== 'pending') root.pendingFibers.delete(fiber as Fiber);
    if (fiber.state === 'active' || fiber.state === 'failed' || fiber.state === 'disposed') {
      root._schedulePending();
    }
  }

  _detachFiber(fiber: Fiber): void {
    const root = this.root;
    root.pendingFibers.delete(fiber);
    root.fibers.delete(fiber);
    fiber.parent?.removeChild(fiber);
  }

  private _schedulePending(): void {
    const root = this.root;
    if (root.fiber.state === 'unloading' || root.fiber.state === 'disposed') return;

    root.pendingRequested = true;
    if (root.pendingFlush) return;

    root.pendingFlush = root._drainPending().finally(() => {
      root.pendingFlush = undefined;
      if (root.pendingRequested) root._schedulePending();
    });
  }

  private async _drainPending(): Promise<void> {
    const root = this.root;
    while (root.pendingRequested) {
      root.pendingRequested = false;
      for (const fiber of root.pendingFibers) {
        if (fiber.state !== 'pending') {
          root.pendingFibers.delete(fiber);
          continue;
        }
        if (!root._dependenciesReady(fiber)) continue;

        root.pendingFibers.delete(fiber);
        try {
          await fiber.start();
        } catch {
          // The Fiber records FAILED and has already rolled back its effects.
        }
      }
    }
  }
}
