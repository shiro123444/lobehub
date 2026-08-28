export interface ModelMessage {
  readonly content?: unknown;
  readonly [key: string]: unknown;
  readonly role?: string;
}

export interface ModelRequest {
  readonly input?: unknown;
  readonly messages?: readonly ModelMessage[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly model?: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

export interface ModelResponse {
  readonly content?: unknown;
  readonly finishReason?: string;
  readonly id?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly [key: string]: unknown;
  readonly usage?: Readonly<Record<string, unknown>>;
}

export interface ModelStreamChunk {
  readonly content?: unknown;
  readonly delta?: unknown;
  readonly [key: string]: unknown;
  readonly type?: string;
}

export type ModelStream = AsyncIterable<ModelStreamChunk>;

export interface ModelAdapter {
  execute: (request: ModelRequest) => ModelResponse | PromiseLike<ModelResponse>;
  readonly id: string;
  stream: (request: ModelRequest) => ModelStream | PromiseLike<ModelStream>;
}

export interface ModelGateway {
  execute: (providerId: string, request: ModelRequest) => Promise<ModelResponse>;
  stream: (providerId: string, request: ModelRequest) => ModelStream;
}

export type ModelGatewayErrorCode = 'MODEL_DUPLICATE' | 'MODEL_NOT_FOUND' | 'MODEL_PROVIDER_ERROR';

export class ModelGatewayError extends Error {
  constructor(
    public readonly code: ModelGatewayErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ModelGatewayError';
  }
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export class ModelAdapterRegistry implements ModelGateway {
  private readonly adapters = new Map<string, ModelAdapter>();

  register(adapter: ModelAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new ModelGatewayError(
        'MODEL_DUPLICATE',
        `Model adapter is already registered: ${adapter.id}`,
      );
    }
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): ModelAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): ModelAdapter[] {
    return [...this.adapters.values()];
  }

  async execute(providerId: string, request: ModelRequest): Promise<ModelResponse> {
    const adapter = this.require(providerId);
    try {
      return await adapter.execute(request);
    } catch (cause) {
      throw new ModelGatewayError(
        'MODEL_PROVIDER_ERROR',
        `Model provider ${providerId} failed during execute: ${messageOf(cause)}`,
        cause,
      );
    }
  }

  stream(providerId: string, request: ModelRequest): ModelStream {
    const adapter = this.require(providerId);
    return this.wrapStream(providerId, adapter, request);
  }

  private async *wrapStream(
    providerId: string,
    adapter: ModelAdapter,
    request: ModelRequest,
  ): ModelStream {
    try {
      const source = await adapter.stream(request);
      for await (const chunk of source) yield chunk;
    } catch (cause) {
      throw new ModelGatewayError(
        'MODEL_PROVIDER_ERROR',
        `Model provider ${providerId} failed during stream: ${messageOf(cause)}`,
        cause,
      );
    }
  }

  private require(id: string): ModelAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new ModelGatewayError('MODEL_NOT_FOUND', `Model adapter is not registered: ${id}`);
    }
    return adapter;
  }
}

export { ModelGatewayError as ModelAdapterRegistryError };
