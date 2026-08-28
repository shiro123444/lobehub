export type FiberState = 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | 'disposed';

export interface Disposer {
  (): void | Promise<void>;
}

export type Disposable = Disposer;

export type Effect =
  | Disposable
  | Iterable<Disposable>
  | AsyncIterable<Disposable>
  | Promise<Effect | void>;

export type ScopeKey = string | symbol;

export type Listener = (...args: unknown[]) => unknown;

export type RuntimePluginKind = 'kernel' | 'capability' | 'agent-strategy' | 'ui';

export interface Fiber {
  collect: (disposer: Disposer) => Disposable;
  dispose: () => Promise<void>;
  readonly name: string;
  readonly state: FiberState;
}

export interface PermissionManifest {
  device?: string[];
  filesystem?: string[];
  network?: string[];
  tools?: string[];
  uiSlots?: string[];
}

export interface RuntimeContext {
  dispose: () => Promise<void>;
  effect: (factory: () => Effect | void) => Disposable;
  readonly fiber: Fiber;
  on: (event: string, listener: Listener) => Disposable;
  plugin: (plugin: RuntimePluginManifest, config?: unknown) => Promise<Fiber>;
  provide: <T>(name: string, service: T) => Disposable;
  readonly root: RuntimeContext;
  withScope: (scope: ScopeKey) => RuntimeContext;
}

export interface RuntimePluginManifest {
  apply: (ctx: RuntimeContext, config?: unknown) => Effect | Promise<Effect | void> | void;
  id: string;
  inject?: string[];
  kind: RuntimePluginKind;
  permissions?: PermissionManifest;
  version: string;
}
