import type { Context } from './context';
import type {
  Disposable,
  Disposer,
  Effect,
  Fiber as FiberContract,
  FiberState,
  RuntimePluginManifest,
} from './types';

const noop: Disposable = () => {};

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === 'object' && value !== null && 'then' in value;

const isAsyncIterable = (value: unknown): value is AsyncIterable<Disposable> =>
  typeof value === 'object' && value !== null && Symbol.asyncIterator in value;

const isIterable = (value: unknown): value is Iterable<Disposable> =>
  typeof value === 'object' && value !== null && Symbol.iterator in value;

export class Fiber implements FiberContract {
  private _state: FiberState;
  public readonly inject: string[];
  public readonly plugin?: RuntimePluginManifest;
  public readonly config?: unknown;
  public readonly parent: Fiber | null;
  public error?: unknown;

  private context?: Context;
  private readonly children: Fiber[] = [];
  private readonly disposers: Disposable[] = [];
  private readonly disposerMap = new WeakMap<Disposable, Disposable>();
  private startPromise?: Promise<void>;
  private disposePromise?: Promise<void>;
  private disposeRequested = false;
  private resourcesDisposed = false;

  constructor(
    public readonly name: string,
    plugin?: RuntimePluginManifest,
    config?: unknown,
    parent: Fiber | null = null,
    initialState: FiberState = 'pending',
  ) {
    this._state = initialState;
    this.plugin = plugin;
    this.config = config;
    this.parent = parent;
    this.inject = plugin?.inject ? [...plugin.inject] : [];
  }

  get state(): FiberState {
    return this._state;
  }

  get ctx(): Context {
    if (!this.context) throw new Error(`Fiber "${this.name}" is not attached to a Context`);
    return this.context;
  }

  attachContext(context: Context): void {
    if (this.context && this.context !== context) {
      throw new Error(`Fiber "${this.name}" is already attached to a Context`);
    }
    this.context = context;
  }

  addChild(child: Fiber): void {
    this.children.push(child);
  }

  removeChild(child: Fiber): void {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
  }

  assertMountable(): void {
    if (this.state === 'unloading' || this.state === 'disposed') {
      throw new Error(`Cannot mount a plugin from inactive fiber "${this.name}"`);
    }
  }

  collect(disposer: Disposer): Disposable {
    if (this.state === 'unloading' || this.state === 'disposed') {
      throw new Error(`Cannot register an effect on inactive fiber "${this.name}"`);
    }

    const existing = this.disposerMap.get(disposer);
    if (existing) return existing;

    let active = true;
    const wrapped: Disposable = () => {
      if (!active) return;
      active = false;
      this.disposerMap.delete(disposer);
      this.disposerMap.delete(wrapped);

      const index = this.disposers.indexOf(wrapped);
      if (index >= 0) this.disposers.splice(index, 1);
      return disposer();
    };

    this.disposerMap.set(disposer, wrapped);
    this.disposerMap.set(wrapped, wrapped);
    this.disposers.push(wrapped);
    return wrapped;
  }

  collectEffect(effect: Effect | void): Disposable {
    if (effect === undefined || effect === null) return noop;
    if (typeof effect === 'function') return this.collect(effect);

    if (isIterable(effect)) {
      const collected = [...effect].map((disposer) => this.collect(disposer));
      return async () => {
        for (const disposer of collected.reverse()) await disposer();
      };
    }

    if (isPromiseLike(effect) || isAsyncIterable(effect)) {
      let cancelled = false;
      let collected: Disposable | undefined;
      const pending = (async () => {
        const resolved = isPromiseLike(effect)
          ? ((await (effect as PromiseLike<unknown>)) as Effect | void)
          : effect;
        if (cancelled) return;
        if (isAsyncIterable(resolved)) {
          const disposers: Disposable[] = [];
          for await (const disposer of resolved) disposers.push(this.collect(disposer));
          collected = async () => {
            for (const disposer of disposers.reverse()) await disposer();
          };
          return;
        }
        collected = this.collectEffect(resolved);
      })();

      return this.collect(async () => {
        cancelled = true;
        await pending;
        await collected?.();
      });
    }

    throw new TypeError(`Invalid effect returned by plugin "${this.name}"`);
  }

  async start(): Promise<void> {
    if (this.state === 'active' || this.state === 'disposed' || this.state === 'failed') return;
    if (this.state === 'unloading' || this.disposeRequested) return;
    if (this.startPromise) return this.startPromise;

    if (!this.ctx._dependenciesReady(this)) {
      this._state = 'pending';
      this.ctx._markPending(this);
      return;
    }

    this.ctx._unmarkPending(this);
    this._state = 'loading';
    const task = this.runStart();
    this.startPromise = task;

    try {
      await task;
    } finally {
      if (this.startPromise === task) this.startPromise = undefined;
    }
  }

  async dispose(): Promise<void> {
    if (this.state === 'disposed') return;
    if (this.disposePromise) return this.disposePromise;

    this.disposeRequested = true;
    const task = (async () => {
      if (this.startPromise) {
        try {
          await this.startPromise;
        } catch {
          // Startup already rolled back its resources.
        }
      }

      await this.disposeResources();
      this._state = 'disposed';
      this.ctx._onFiberStateChange(this);
      this.detach();
    })();

    this.disposePromise = task;
    return task;
  }

  private async runStart(): Promise<void> {
    try {
      const result = this.plugin?.apply(this.ctx, this.config);
      const effect = isPromiseLike(result)
        ? ((await (result as PromiseLike<unknown>)) as Effect | void)
        : result;
      await this.collectStartupEffect(effect);

      if (this.disposeRequested) {
        await this.disposeResources();
        this._state = 'disposed';
        this.ctx._onFiberStateChange(this);
        this.detach();
        return;
      }

      this._state = 'active';
      this.ctx._onFiberStateChange(this);
    } catch (error) {
      this.error = error;
      await this.disposeResources();
      this._state = this.disposeRequested ? 'disposed' : 'failed';
      this.ctx._onFiberStateChange(this);
      if (this.state === 'disposed') this.detach();
      throw error;
    }
  }

  private async collectStartupEffect(effect: Effect | void): Promise<void> {
    if (effect === undefined || effect === null) return;
    if (typeof effect === 'function') {
      this.collect(effect);
      return;
    }
    if (isPromiseLike(effect)) {
      const resolved = (await (effect as PromiseLike<unknown>)) as Effect | void;
      await this.collectStartupEffect(resolved);
      return;
    }
    if (isAsyncIterable(effect)) {
      for await (const disposer of effect) this.collect(disposer);
      return;
    }
    if (isIterable(effect)) {
      for (const disposer of effect) this.collect(disposer);
      return;
    }
    throw new TypeError(`Invalid effect returned by plugin "${this.name}"`);
  }

  private async disposeResources(): Promise<void> {
    if (this.resourcesDisposed) return;
    this.resourcesDisposed = true;
    this._state = 'unloading';

    for (const child of [...this.children].reverse()) await child.dispose();
    this.children.length = 0;

    while (this.disposers.length > 0) {
      const disposer = this.disposers.pop();
      if (!disposer) continue;
      try {
        await disposer();
      } catch {
        // One failed disposer must not prevent the remaining LIFO cleanup.
      }
    }
  }

  private detach(): void {
    this.ctx._detachFiber(this);
  }
}
