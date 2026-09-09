import type { Disposable, RuntimeContext } from './types';

export interface CapabilityDescriptor {
  readonly capabilities?: readonly string[];
  readonly description?: string;
  readonly id: string;
  readonly source?: 'builtin' | 'process' | 'http' | 'mcp' | 'worker';
  readonly version?: string;
}

export interface CapabilityContext {
  readonly scope?: string | symbol;
  readonly [key: string]: unknown;
}

/** The only seam an external project exposes to the Cordis kernel. */
export interface CapabilityPort {
  readonly descriptor?: CapabilityDescriptor;
  readonly id: string;
  readonly dispose?: () => void | Promise<void>;
  execute(command: unknown, context: CapabilityContext): Promise<unknown>;
}

export type CapabilityRegistryErrorCode =
  | 'CAPABILITY_DUPLICATE'
  | 'CAPABILITY_NOT_FOUND'
  | 'CAPABILITY_INVALID_COMMAND';

export class CapabilityRegistryError extends Error {
  constructor(
    public readonly code: CapabilityRegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CapabilityRegistryError';
  }
}

interface RegisteredCapability {
  disposer: Disposable;
  readonly owner: RuntimeContext['fiber'];
  readonly port: CapabilityPort;
}

const descriptorFor = (port: CapabilityPort): CapabilityDescriptor => ({
  id: port.descriptor?.id ?? port.id,
  capabilities: port.descriptor?.capabilities,
  description: port.descriptor?.description,
  source: port.descriptor?.source,
  version: port.descriptor?.version,
});

const validId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const validPort = (value: unknown): value is CapabilityPort =>
  typeof value === 'object' &&
  value !== null &&
  validId((value as CapabilityPort).id) &&
  typeof (value as CapabilityPort).execute === 'function';

const validCommand = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export class CapabilityRegistry {
  private readonly capabilities = new Map<string, RegisteredCapability>();

  register(context: RuntimeContext, port: CapabilityPort): Disposable {
    if (!validPort(port)) {
      throw new CapabilityRegistryError(
        'CAPABILITY_INVALID_COMMAND',
        'Capability port must provide an id and execute(command, context)',
      );
    }
    if (port.descriptor?.id !== undefined && port.descriptor.id !== port.id) {
      throw new CapabilityRegistryError(
        'CAPABILITY_INVALID_COMMAND',
        `Capability descriptor id must match port id: ${port.descriptor.id} !== ${port.id}`,
      );
    }
    if (this.capabilities.has(port.id)) {
      throw new CapabilityRegistryError(
        'CAPABILITY_DUPLICATE',
        `Capability is already registered: ${port.id}`,
      );
    }

    const entry = {
      port,
      owner: context.fiber,
    } as RegisteredCapability;
    const remove = async (): Promise<void> => {
      if (this.capabilities.get(port.id) !== entry) return;
      this.capabilities.delete(port.id);
      await port.dispose?.();
    };
    try {
      entry.disposer = context.fiber.collect(remove);
    } catch (error) {
      remove();
      throw error;
    }
    this.capabilities.set(port.id, entry);
    return entry.disposer;
  }

  async unregister(id: string): Promise<void> {
    const entry = this.capabilities.get(id);
    if (!entry) throw this.notFound(id);
    await entry.disposer();
  }

  get(id: string): CapabilityPort {
    const entry = this.capabilities.get(id);
    if (!entry) throw this.notFound(id);
    return entry.port;
  }

  list(): CapabilityDescriptor[] {
    return [...this.capabilities.values()].map(({ port }) => descriptorFor(port));
  }

  async execute(id: string, command: unknown, context: CapabilityContext): Promise<unknown> {
    if (!validCommand(command)) {
      throw new CapabilityRegistryError(
        'CAPABILITY_INVALID_COMMAND',
        `Capability command must be a structured object: ${id}`,
      );
    }
    const port = this.get(id);
    return port.execute(command, context);
  }

  private notFound(id: string): CapabilityRegistryError {
    return new CapabilityRegistryError(
      'CAPABILITY_NOT_FOUND',
      `Capability is not registered: ${id}`,
    );
  }
}
