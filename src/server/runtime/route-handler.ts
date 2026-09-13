import type { RuntimeFacadePort, RuntimeHttpResponse } from './adapter';
import { RUNTIME_PROTOCOL_VERSION, RuntimeHttpAdapter, runtimeHttpErrorResponse } from './adapter';
import type { RuntimeFacadeBinding, RuntimeFacadeFactory, RuntimeFacadeScope } from './factory';

export type { RuntimeCommandEnvelope, RuntimeFacadePort } from './adapter';
export type { RuntimeFacadeBinding, RuntimeFacadeFactory, RuntimeFacadeScope } from './factory';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasEnvelopeField = (value: Record<string, unknown>): boolean =>
  'protocol_version' in value || 'request_id' in value || 'command' in value || 'payload' in value;

let generatedGetRequestSequence = 0;

const generatedGetRequestId = (): string => {
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId) return `runtime-get-${randomId}`;
  generatedGetRequestSequence += 1;
  return `runtime-get-${Date.now().toString(36)}-${generatedGetRequestSequence.toString(36)}`;
};

const pathSegments = (request: Request): string[] => {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  const runtimeIndex = segments.lastIndexOf('runtime');
  const versionIndex =
    runtimeIndex >= 0 && segments[runtimeIndex + 1] === 'v1' ? runtimeIndex + 1 : -1;
  return versionIndex >= 0 ? segments.slice(versionIndex + 1) : segments;
};

const requestIdFrom = (request: Request, body: unknown): string => {
  const headerId = request.headers.get('x-request-id');
  if (headerId) return headerId;
  const queryId = new URL(request.url).searchParams.get('request_id');
  if (queryId) return queryId;
  if (isRecord(body) && typeof body.request_id === 'string') return body.request_id;
  return request.method.toUpperCase() === 'GET' ? generatedGetRequestId() : '';
};

const commandFor = (request: Request, segments: string[]): string => {
  const method = request.method.toUpperCase();
  if (segments[0] === 'runs') {
    if (segments.length === 1 && method === 'POST') return 'run.start';
    if (segments.length === 2 && method === 'GET') return 'run.get';
    if (segments.length === 3 && method === 'POST' && segments[2] === 'cancel') {
      return 'run.cancel';
    }
    if (segments.length === 3 && method === 'POST' && segments[2] === 'resume') {
      return 'run.resume';
    }
    if (segments.length === 3 && method === 'GET' && segments[2] === 'events') {
      return 'run.events';
    }
  }
  if (segments[0] === 'plugins') {
    if (segments.length === 1 && method === 'GET') return 'plugin.list';
    if (segments.length === 3 && method === 'POST' && segments[2] === 'mount') {
      return 'plugin.mount';
    }
    if (segments.length === 3 && method === 'POST' && segments[2] === 'unmount') {
      return 'plugin.unmount';
    }
    if (segments.length === 3 && method === 'POST' && segments[2] === 'reload') {
      return 'plugin.reload';
    }
  }
  return 'runtime.route.not_found';
};

const afterSeqFrom = (request: Request): unknown => {
  const raw = new URL(request.url).searchParams.get('after_seq');
  if (raw === null) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
};

const pathPayload = (
  request: Request,
  segments: string[],
  command: string,
): Record<string, unknown> => {
  if (command === 'run.get' || command === 'run.cancel' || command === 'run.resume') {
    return { runId: segments[1] };
  }
  if (command === 'run.events') {
    const afterSeq = afterSeqFrom(request);
    return {
      runId: segments[1],
      ...(afterSeq === undefined ? {} : { after_seq: afterSeq }),
    };
  }
  if (command === 'plugin.mount' || command === 'plugin.unmount' || command === 'plugin.reload') {
    return { id: segments[1] };
  }
  return {};
};

const readBody = async (request: Request): Promise<unknown> => {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

const envelopeFor = async (request: Request): Promise<unknown> => {
  const segments = pathSegments(request);
  const command = commandFor(request, segments);
  if (request.method.toUpperCase() === 'GET') {
    return {
      protocol_version: RUNTIME_PROTOCOL_VERSION,
      request_id: requestIdFrom(request, undefined),
      command,
      payload: pathPayload(request, segments, command),
    };
  }

  const body = await readBody(request);
  if (isRecord(body) && hasEnvelopeField(body)) return body;
  const pathValues = pathPayload(request, segments, command);
  return {
    protocol_version: RUNTIME_PROTOCOL_VERSION,
    request_id: requestIdFrom(request, body),
    command,
    payload: isRecord(body) ? { ...pathValues, ...body } : body,
  };
};

const isBinding = (
  value: RuntimeFacadePort | RuntimeFacadeBinding,
): value is RuntimeFacadeBinding =>
  isRecord(value) && isRecord(value.facade) && typeof value.facade.handle === 'function';

type ScopedAdapterCache = Map<string, Map<unknown, RuntimeHttpAdapter>>;

const facadeAdapterCache = new WeakMap<RuntimeFacadePort, ScopedAdapterCache>();

const cachedAdapterFor = (
  facade: RuntimeFacadePort,
  scope: Omit<RuntimeFacadeScope, 'request'>,
): RuntimeHttpAdapter => {
  let userCache = facadeAdapterCache.get(facade);
  if (!userCache) {
    userCache = new Map();
    facadeAdapterCache.set(facade, userCache);
  }

  let scopeCache = userCache.get(scope.userId);
  if (!scopeCache) {
    scopeCache = new Map();
    userCache.set(scope.userId, scopeCache);
  }

  let adapter = scopeCache.get(scope.serverDB);
  if (!adapter) {
    adapter = new RuntimeHttpAdapter(facade);
    scopeCache.set(scope.serverDB, adapter);
  }
  return adapter;
};

const adapterFor = (
  result: RuntimeFacadePort | RuntimeFacadeBinding,
  scope: Omit<RuntimeFacadeScope, 'request'>,
): RuntimeHttpAdapter =>
  isBinding(result)
    ? (result.adapter ?? cachedAdapterFor(result.facade, scope))
    : cachedAdapterFor(result, scope);

export interface RuntimeRequestExecution {
  readonly facade?: RuntimeFacadePort;
  readonly response: RuntimeHttpResponse;
}

export const executeRuntimeRequest = async (
  request: Request,
  scope: Omit<RuntimeFacadeScope, 'request'>,
  facadeFactory: RuntimeFacadeFactory,
): Promise<RuntimeRequestExecution> => {
  try {
    const result = await facadeFactory({ ...scope, request });
    const facade = isBinding(result) ? result.facade : result;
    const response = await adapterFor(result, scope).handle(await envelopeFor(request));
    return { response, facade };
  } catch (error) {
    return { response: runtimeHttpErrorResponse(error) };
  }
};

export const handleRuntimeRequest = async (
  request: Request,
  scope: Omit<RuntimeFacadeScope, 'request'>,
  facadeFactory: RuntimeFacadeFactory,
): Promise<RuntimeHttpResponse> =>
  (await executeRuntimeRequest(request, scope, facadeFactory)).response;
