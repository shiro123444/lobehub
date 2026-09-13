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

const effectInertia = new WeakMap<Disposable, () => void | Promise<void>>();

function runDisposable(dispose: Disposable): void | Promise<void> {
  const result = dispose();
  return effectInertia.get(dispose)?.() ?? result;
}

/** Preserve synchronous cleanup and LIFO order, joining every async disposer. */
function disposeAll(disposers: Disposable[]): void | Promise<void> {
  let index = 0;
  let failed = false;
  let firstError: unknown;
  const record = (error: unknown) => {
    if (!failed) {
      failed = true;
      firstError = error;
    }
  };
  const next = (): void | Promise<void> => {
    while (index < disposers.length) {
      try {
        const result = runDisposable(disposers[index++]);
        if (isPromiseLike(result))
          return Promise.resolve(result).then(next, (error) => {
            record(error);
            return next();
          });
      } catch (error) {
        record(error);
      }
    }
    if (failed) throw firstError;
  };
  return next();
}

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

  getChildren(): readonly Fiber[] {
    return this.children;
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

    return this.trackDisposer(disposer);
  }

  /** Internal setup results can arrive during unload; all owners share this wrapper. */
  private trackDisposer(disposer: Disposer): Disposable {
    const existing = this.disposerMap.get(disposer);
    if (existing) return existing;

    let active = true;
    let inFlight: Promise<void> | undefined;

    const removeWrapper = () => {
      const index = this.disposers.indexOf(wrapped);
      if (index >= 0) this.disposers.splice(index, 1);
    };

    const wrapped: Disposable = () => {
      if (!active) return;
      active = false;
      this.disposerMap.delete(disposer);
      this.disposerMap.delete(wrapped);

      let result: void | Promise<void>;
      try {
        result = disposer();
      } catch (error) {
        removeWrapper();
        throw error;
      }

      if (isPromiseLike(result)) {
        const pending = Promise.resolve(result).finally(() => {
          removeWrapper();
          if (inFlight === pending) inFlight = undefined;
        });
        inFlight = pending;
        return pending;
      }

      removeWrapper();
      return result;
    };

    effectInertia.set(wrapped, () => inFlight);
    this.disposerMap.set(disposer, wrapped);
    this.disposerMap.set(wrapped, wrapped);
    this.disposers.push(wrapped);
    return wrapped;
  }

  effect(factory: () => Effect | void): Disposable {
    const owned: Disposable[] = [];
    let setupFinished = false;
    let finishSetup!: () => void;
    const setup = new Promise<void>((resolve) => {
      finishSetup = resolve;
    });

    const cleanup = () => disposeAll(owned.splice(0).reverse());
    // Register the owner before executing setup. Only the setup result may
    // attach late disposers; public collect/provide still reject during unload.
    const dispose = this.collect(() => (setupFinished ? cleanup() : setup.then(cleanup)));
    const attach = (value: unknown) => {
      if (typeof value !== 'function')
        throw new TypeError(`Invalid effect returned by plugin "${this.name}"`);
      owned.push(this.trackDisposer(value as Disposable));
    };
    const materialize = (value: unknown): void | Promise<void> => {
      if (value === undefined || value === null) return;
      if (typeof value === 'function') return attach(value);
      if (isPromiseLike(value)) return Promise.resolve(value).then(materialize);
      if (isAsyncIterable(value))
        return (async () => {
          for await (const disposer of value) attach(disposer);
        })();
      if (isIterable(value)) {
        for (const disposer of value) attach(disposer);
        return;
      }
      throw new TypeError(`Invalid effect returned by plugin "${this.name}"`);
    };
    const finished = () => {
      setupFinished = true;
      finishSetup();
    };
    const failed = (error: unknown) => {
      // Asynchronous setup has no awaiting caller; retain its diagnostic on
      // the fiber and observe rollback, while the owner can still join it.
      this.error ??= error;
      finished();
      try {
        const rollback = runDisposable(dispose);
        if (isPromiseLike(rollback)) void Promise.resolve(rollback).catch(() => undefined);
      } catch {
        // Preserve the setup error while the other owner resources remain reachable.
      }
    };
    try {
      const result = materialize(factory());
      if (isPromiseLike(result)) void Promise.resolve(result).then(finished, failed);
      else finished();
    } catch (error) {
      failed(error);
      throw error;
    }
    return dispose;
  }

  collectEffect(effect: Effect | void): Disposable {
    if (effect === undefined || effect === null) return noop;
    return this.effect(() => effect);
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

    await this.ctx._disposeDependents(this);

    for (const child of [...this.children].reverse()) await child.dispose();
    this.children.length = 0;

    while (this.disposers.length > 0) {
      const disposer = this.disposers.pop();
      if (!disposer) continue;
      try {
        await runDisposable(disposer);
      } catch {
        // One failed disposer must not prevent the remaining LIFO cleanup.
      }
    }
  }

  private detach(): void {
    this.ctx._detachFiber(this);
  }
}
