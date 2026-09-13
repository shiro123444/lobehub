import type { RuntimeEvent } from '../../../packages/cordis-kernel/src/run';

export const RUNTIME_PROTOCOL_VERSION = 'runtime.v1' as const;

export const RUNTIME_HTTP_COMMANDS = [
  'run.start',
  'run.get',
  'run.cancel',
  'run.resume',
  'run.events',
  'plugin.list',
  'plugin.mount',
  'plugin.unmount',
  'plugin.reload',
] as const;

export type RuntimeHttpCommand = (typeof RUNTIME_HTTP_COMMANDS)[number];

export interface RuntimeCommandEnvelope {
  readonly command: string;
  readonly payload: Record<string, unknown>;
  readonly protocol_version: typeof RUNTIME_PROTOCOL_VERSION;
  readonly [key: string]: unknown;
  readonly request_id: string;
}

export type RuntimeEventListener = (event: RuntimeEvent) => void;
export type RuntimeEventUnsubscribe = () => void;
export type RuntimeEventSubscription = RuntimeEventUnsubscribe | { dispose: () => void } | void;

export interface RuntimeFacadePort {
  handle: (envelope: RuntimeCommandEnvelope) => Promise<unknown> | unknown;
  onRunEvent?: (runId: string, listener: RuntimeEventListener) => RuntimeEventSubscription;
  subscribe?: (runId: string, listener: RuntimeEventListener) => RuntimeEventSubscription;
  subscribeRunEvents?: (runId: string, listener: RuntimeEventListener) => RuntimeEventSubscription;
}

export type RuntimeFacade = RuntimeFacadePort;

export interface RuntimeHttpRequest {
  readonly body: unknown;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface RuntimeHttpError {
  readonly code: string;
  readonly details?: JsonValue;
  readonly message: string;
  readonly path?: string;
}

export interface RuntimeHttpErrorBody {
  readonly error: RuntimeHttpError;
}

export interface RuntimeHttpResponse<T = JsonValue | RuntimeHttpErrorBody> {
  readonly body: T;
  readonly headers: {
    readonly 'content-type': 'application/json';
  };
  readonly status: number;
}

export type RuntimeHttpAdapterErrorCode =
  | 'PROTOCOL_INVALID'
  | 'COMMAND_NOT_FOUND'
  | 'REQUEST_ID_CONFLICT'
  | 'RUNTIME_RESPONSE_INVALID'
  | 'RUNTIME_INTERNAL_ERROR';

export class RuntimeHttpAdapterError extends Error {
  constructor(
    public readonly code: RuntimeHttpAdapterErrorCode | string,
    message: string,
    public readonly path?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'RuntimeHttpAdapterError';
  }
}

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const pathFor = (path: string, key: string | number): string =>
  typeof key === 'number' ? `${path}[${key}]` : `${path}.${key}`;

const assertJsonValue = (value: unknown, path: string, active: WeakSet<object>): void => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw new RuntimeHttpAdapterError('PROTOCOL_INVALID', 'must be a finite JSON number', path);
  }
  if (typeof value !== 'object') {
    throw new RuntimeHttpAdapterError('PROTOCOL_INVALID', 'must be JSON-compatible', path);
  }
  if (active.has(value)) {
    throw new RuntimeHttpAdapterError('PROTOCOL_INVALID', 'must not be cyclic', path);
  }

  active.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((item, index) => assertJsonValue(item, pathFor(path, index), active));
      return;
    }
    if (!isPlainObject(value)) {
      throw new RuntimeHttpAdapterError('PROTOCOL_INVALID', 'must be a plain JSON object', path);
    }
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) {
        throw new RuntimeHttpAdapterError(
          'PROTOCOL_INVALID',
          'must contain only data properties',
          pathFor(path, key),
        );
      }
      assertJsonValue(descriptor.value, pathFor(path, key), active);
    }
  } finally {
    active.delete(value);
  }
};

const invalid = (path: string, message: string): never => {
  throw new RuntimeHttpAdapterError('PROTOCOL_INVALID', message, path);
};

const decodeRequestBody = (input: unknown): unknown => {
  if (typeof input !== 'string') return input;
  try {
    return JSON.parse(input) as unknown;
  } catch (cause) {
    throw new RuntimeHttpAdapterError('PROTOCOL_INVALID', 'must be valid JSON', '$', cause);
  }
};

export const validateRuntimeEnvelope = (input: unknown): RuntimeCommandEnvelope => {
  const candidate = decodeRequestBody(input);
  assertJsonValue(candidate, '$', new WeakSet<object>());
  const record = isPlainObject(candidate) ? candidate : invalid('$', 'must be a plain object');

  if (record.protocol_version !== RUNTIME_PROTOCOL_VERSION) {
    invalid('protocol_version', `must equal ${RUNTIME_PROTOCOL_VERSION}`);
  }
  if (typeof record.request_id !== 'string' || !record.request_id.trim()) {
    invalid('request_id', 'must be a non-empty string');
  }
  if (typeof record.command !== 'string' || !record.command.trim()) {
    invalid('command', 'must be a non-empty string');
  }
  const payload = isPlainObject(record.payload)
    ? record.payload
    : invalid('payload', 'must be a plain object');

  if (record.command === 'run.events' && 'after_seq' in payload) {
    const afterSeq = payload.after_seq;
    if (typeof afterSeq !== 'number' || !Number.isInteger(afterSeq) || afterSeq < 0) {
      invalid('payload.after_seq', 'must be a non-negative integer');
    }
  }

  return record as RuntimeCommandEnvelope;
};

const isSupportedCommand = (command: string): command is RuntimeHttpCommand =>
  (RUNTIME_HTTP_COMMANDS as readonly string[]).includes(command);

const canonicalize = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key]!)]),
  );
};

const fingerprint = (envelope: RuntimeCommandEnvelope): string =>
  JSON.stringify(canonicalize(envelope as unknown as JsonValue));

const cloneJsonValue = (value: unknown, path: string): JsonValue => {
  assertJsonValue(value, path, new WeakSet<object>());
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return value;
  if (Array.isArray(value))
    return value.map((item, index) => cloneJsonValue(item, pathFor(path, index)));
  if (!isPlainObject(value)) {
    throw new RuntimeHttpAdapterError(
      'RUNTIME_RESPONSE_INVALID',
      'must be a plain JSON object',
      path,
    );
  }
  return Object.fromEntries(
    Object.keys(value).map((key) => [key, cloneJsonValue(value[key], pathFor(path, key))]),
  );
};

const ownStringProperty = (value: unknown, key: string): string | undefined => {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
    ? descriptor.value
    : undefined;
};

const errorCode = (error: unknown): string => {
  if (error instanceof RuntimeHttpAdapterError) return error.code;
  const code = ownStringProperty(error, 'code');
  return code?.trim() ? code : 'RUNTIME_INTERNAL_ERROR';
};

const errorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  const message = ownStringProperty(error, 'message');
  if (message) return message;
  return 'Runtime request failed';
};

const errorPath = (error: unknown): string | undefined => ownStringProperty(error, 'path');

const errorDetails = (error: unknown): JsonValue | undefined => {
  if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'details');
  if (!descriptor || !('value' in descriptor) || descriptor.value === undefined) return;
  try {
    return cloneJsonValue(descriptor.value, 'details');
  } catch {
    return;
  }
};

const statusForCode = (code: string): number => {
  if (code === 'PROTOCOL_INVALID' || code === 'COMMAND_INVALID') return 400;
  if (code === 'COMMAND_NOT_FOUND' || code.endsWith('_NOT_FOUND')) return 404;
  if (code === 'REQUEST_ID_CONFLICT' || code.includes('DUPLICATE') || code.includes('ALREADY')) {
    return 409;
  }
  if (code.endsWith('_TIMEOUT') || code === 'TIMEOUT') return 504;
  if (code.endsWith('_UNAVAILABLE') || code === 'PROVIDER_UNAVAILABLE') return 503;
  return 500;
};

export const runtimeHttpErrorResponse = (
  error: unknown,
): RuntimeHttpResponse<RuntimeHttpErrorBody> => {
  const code = errorCode(error);
  const details = errorDetails(error);
  const stableError: RuntimeHttpError = {
    code,
    message: errorMessage(error),
    ...(errorPath(error) ? { path: errorPath(error) } : {}),
    ...(details === undefined ? {} : { details }),
  };
  return {
    status: statusForCode(code),
    headers: JSON_HEADERS,
    body: { error: stableError },
  };
};

interface CachedResponse {
  readonly fingerprint: string;
  readonly response: Promise<RuntimeHttpResponse>;
}

export class RuntimeHttpAdapter {
  private readonly requests = new Map<string, CachedResponse>();

  constructor(private readonly facade: RuntimeFacadePort) {}

  handle(input: unknown): Promise<RuntimeHttpResponse> {
    let envelope: RuntimeCommandEnvelope;
    try {
      envelope = validateRuntimeEnvelope(input);
    } catch (error) {
      return Promise.resolve(this.errorResponse(error));
    }

    const requestFingerprint = fingerprint(envelope);
    const cached = this.requests.get(envelope.request_id);
    if (cached) {
      if (cached.fingerprint === requestFingerprint) return cached.response;
      return Promise.resolve(
        this.errorResponse(
          new RuntimeHttpAdapterError(
            'REQUEST_ID_CONFLICT',
            'request_id was already used for a different envelope',
            'request_id',
          ),
        ),
      );
    }

    const response = Promise.resolve()
      .then(() => this.dispatch(envelope))
      .then(
        (value) => this.successResponse(value),
        (error) => this.errorResponse(error),
      );
    this.requests.set(envelope.request_id, { fingerprint: requestFingerprint, response });
    return response;
  }

  handleRequest(request: RuntimeHttpRequest): Promise<RuntimeHttpResponse> {
    return this.handle(request.body);
  }

  private async dispatch(envelope: RuntimeCommandEnvelope): Promise<unknown> {
    if (!isSupportedCommand(envelope.command)) {
      throw new RuntimeHttpAdapterError(
        'COMMAND_NOT_FOUND',
        `Runtime command is not supported: ${envelope.command}`,
        'command',
      );
    }
    return this.facade.handle(envelope);
  }

  private successResponse(value: unknown): RuntimeHttpResponse {
    try {
      return {
        status: 200,
        headers: JSON_HEADERS,
        body: cloneJsonValue(value, 'body'),
      };
    } catch (error) {
      return this.errorResponse(
        new RuntimeHttpAdapterError(
          'RUNTIME_RESPONSE_INVALID',
          'RuntimeFacade returned a non-JSON-safe response',
          'body',
          error,
        ),
      );
    }
  }

  private errorResponse(error: unknown): RuntimeHttpResponse<RuntimeHttpErrorBody> {
    return runtimeHttpErrorResponse(error);
  }
}

export const createRuntimeHttpAdapter = (facade: RuntimeFacadePort): RuntimeHttpAdapter =>
  new RuntimeHttpAdapter(facade);

export { RuntimeHttpAdapter as RuntimeRequestAdapter };
