import type { RuntimeFacadePort, RuntimeHttpAdapter } from './adapter';
import { RuntimeHttpAdapterError } from './adapter';

export interface RuntimeFacadeScope {
  readonly request: Request;
  readonly serverDB: unknown;
  /** Present when a caller explicitly wires the facade to a session scope. */
  readonly sessionId?: string;
  readonly userId: string;
}

export interface RuntimeFacadeBinding {
  readonly adapter?: RuntimeHttpAdapter;
  readonly dispose?: () => void | Promise<void>;
  readonly facade: RuntimeFacadePort;
}

export type RuntimeFacadeFactoryResult = RuntimeFacadePort | RuntimeFacadeBinding;

export type RuntimeFacadeFactory = (
  scope: RuntimeFacadeScope,
) => RuntimeFacadeFactoryResult | Promise<RuntimeFacadeFactoryResult>;

let configuredFactory: RuntimeFacadeFactory | undefined;

const unavailableFactory: RuntimeFacadeFactory = () => {
  throw new RuntimeHttpAdapterError(
    'RUNTIME_FACADE_UNAVAILABLE',
    'No scoped RuntimeFacade factory has been configured',
  );
};

export const getRuntimeFacadeFactory = (): RuntimeFacadeFactory =>
  configuredFactory ?? unavailableFactory;

/** Configure only the factory; every call still receives its authenticated request scope. */
export const configureRuntimeFacadeFactory = (factory: RuntimeFacadeFactory): void => {
  configuredFactory = factory;
};

export const resetRuntimeFacadeFactory = (): void => {
  configuredFactory = undefined;
};
