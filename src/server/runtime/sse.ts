import type { RuntimeEvent } from '../../../packages/cordis-kernel/src/run';
import type {
  RuntimeEventListener,
  RuntimeEventSubscription,
  RuntimeFacadePort,
  RuntimeHttpResponse,
} from './adapter';
import { RuntimeHttpAdapterError, runtimeHttpErrorResponse } from './adapter';
import type { RuntimeFacadeFactory, RuntimeFacadeScope } from './factory';
import { executeRuntimeRequest } from './route-handler';

export interface RuntimeSseOptions {
  readonly heartbeatIntervalMs?: number;
  readonly subscribe?: RuntimeSseSubscriber;
}

export type RuntimeSseSubscriber = (listener: RuntimeEventListener) => RuntimeEventSubscription;

export interface RuntimeSseStreamResponse {
  readonly body: ReadableStream<Uint8Array>;
  readonly headers: {
    readonly 'cache-control': 'no-cache, no-transform';
    readonly 'connection': 'keep-alive';
    readonly 'content-type': 'text/event-stream';
    readonly 'x-accel-buffering': 'no';
  };
  readonly status: 200;
}

export type RuntimeSseResponse = RuntimeSseStreamResponse | RuntimeHttpResponse;

const SSE_HEADERS = {
  'cache-control': 'no-cache, no-transform',
  'connection': 'keep-alive',
  'content-type': 'text/event-stream',
  'x-accel-buffering': 'no',
} as const;

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

const runtimePathSegments = (request: Request): string[] => {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  const runtimeIndex = segments.lastIndexOf('runtime');
  const versionIndex =
    runtimeIndex >= 0 && segments[runtimeIndex + 1] === 'v1' ? runtimeIndex + 1 : -1;
  return versionIndex >= 0 ? segments.slice(versionIndex + 1) : segments;
};

export const isRuntimeEventsRequest = (request: Request): boolean => {
  const segments = runtimePathSegments(request);
  return (
    request.method.toUpperCase() === 'GET' &&
    segments.length === 3 &&
    segments[0] === 'runs' &&
    Boolean(segments[1]) &&
    segments[2] === 'events'
  );
};

const runtimeSseError = (message: string, path?: string): RuntimeHttpAdapterError =>
  new RuntimeHttpAdapterError('RUNTIME_RESPONSE_INVALID', message, path);

const eventData = (event: RuntimeEvent, path: string): string => {
  if (!Number.isInteger(event.seq) || event.seq < 0) {
    throw runtimeSseError('event seq must be a non-negative integer', `${path}.seq`);
  }

  try {
    const serialized = JSON.stringify(event);
    if (serialized === undefined) throw new Error('event is not JSON serializable');
    return serialized;
  } catch (cause) {
    throw new RuntimeHttpAdapterError(
      'RUNTIME_RESPONSE_INVALID',
      'event must be JSON serializable',
      path,
      cause,
    );
  }
};

export const formatRuntimeSseEvent = (event: RuntimeEvent, path = 'event'): string =>
  `id: ${event.seq}\ndata: ${eventData(event, path)}\n\n`;

const streamFor = (
  eventFrames: readonly string[],
  initialSeq: number,
  signal: AbortSignal,
  options: RuntimeSseOptions,
): ReadableStream<Uint8Array> => {
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  if (!Number.isFinite(heartbeatIntervalMs) || heartbeatIntervalMs <= 0) {
    throw runtimeSseError(
      'heartbeatIntervalMs must be a positive finite number',
      'heartbeatIntervalMs',
    );
  }

  const encoder = new TextEncoder();
  let interval: ReturnType<typeof setInterval> | undefined;
  let abortListener: (() => void) | undefined;
  let subscription: RuntimeEventSubscription;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let lastSeq = initialSeq;
  let closed = false;

  const disposeSubscription = (): void => {
    const current = subscription;
    subscription = undefined;
    try {
      if (typeof current === 'function') current();
      else if (current && typeof current.dispose === 'function') current.dispose();
    } catch {
      // Disconnect cleanup must not turn into a second stream error.
    }
  };

  const cleanup = (): void => {
    if (interval !== undefined) clearInterval(interval);
    interval = undefined;
    disposeSubscription();
    if (abortListener) signal.removeEventListener('abort', abortListener);
    abortListener = undefined;
  };

  const enqueueLive = (event: RuntimeEvent): void => {
    if (closed || !Number.isInteger(event.seq) || event.seq <= lastSeq) return;

    try {
      const frame = formatRuntimeSseEvent(event, 'live.event');
      lastSeq = event.seq;
      streamController?.enqueue(encoder.encode(frame));
    } catch (error) {
      if (closed) return;
      closed = true;
      cleanup();
      streamController?.error(error);
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      const close = (): void => {
        if (closed) return;
        closed = true;
        cleanup();
        controller.close();
      };

      abortListener = close;
      signal.addEventListener('abort', close, { once: true });
      if (signal.aborted) {
        close();
        return;
      }

      for (const eventFrame of eventFrames) controller.enqueue(encoder.encode(eventFrame));

      if (options.subscribe) {
        try {
          subscription = options.subscribe(enqueueLive);
        } catch (error) {
          closed = true;
          cleanup();
          controller.error(error);
          return;
        }
      }

      interval = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          closed = true;
          cleanup();
        }
      }, heartbeatIntervalMs);
    },
    cancel() {
      closed = true;
      cleanup();
    },
  });
};

const errorResponse = (error: unknown): RuntimeHttpResponse => runtimeHttpErrorResponse(error);

const asRuntimeEvents = (value: unknown): RuntimeEvent[] => {
  if (!Array.isArray(value)) {
    throw runtimeSseError('run.events must return an array of RuntimeEvent', 'body');
  }
  return value as RuntimeEvent[];
};

export const isRuntimeSseStreamResponse = (
  response: RuntimeSseResponse,
): response is RuntimeSseStreamResponse => response.headers['content-type'] === 'text/event-stream';

const serializedEventFrames = (events: readonly RuntimeEvent[]): string[] => {
  let previousSeq = -1;
  return events.map((event, index) => {
    if (event.seq <= previousSeq) {
      throw runtimeSseError('event sequences must be strictly increasing', `events[${index}].seq`);
    }
    previousSeq = event.seq;
    return formatRuntimeSseEvent(event, `events[${index}]`);
  });
};

const lastSequence = (events: readonly RuntimeEvent[], afterSeq: number): number =>
  Math.max(afterSeq, events.at(-1)?.seq ?? -1);

export const createRuntimeSseResponse = (
  events: readonly RuntimeEvent[],
  signal: AbortSignal,
  options: RuntimeSseOptions = {},
  afterSeq = -1,
): RuntimeSseStreamResponse => ({
  status: 200,
  headers: SSE_HEADERS,
  body: streamFor(serializedEventFrames(events), lastSequence(events, afterSeq), signal, options),
});

const afterSeqFromRequest = (request: Request): number => {
  const raw = new URL(request.url).searchParams.get('after_seq');
  return raw !== null && /^\d+$/.test(raw) ? Number(raw) : -1;
};

const subscriberFor = (
  facade: RuntimeFacadePort,
  runId: string,
): RuntimeSseSubscriber | undefined => {
  const candidate = facade as RuntimeFacadePort;
  const subscribe =
    candidate.subscribeRunEvents?.bind(candidate) ??
    candidate.subscribe?.bind(candidate) ??
    (candidate.onRunEvent as RuntimeFacadePort['subscribe'] | undefined)?.bind(candidate);
  return subscribe ? (listener) => subscribe(runId, listener) : undefined;
};

export const handleRuntimeSseRequest = async (
  request: Request,
  scope: Omit<RuntimeFacadeScope, 'request'>,
  facadeFactory: RuntimeFacadeFactory,
  options: RuntimeSseOptions = {},
): Promise<RuntimeSseResponse> => {
  if (!isRuntimeEventsRequest(request)) {
    return errorResponse(
      new RuntimeHttpAdapterError(
        'COMMAND_NOT_FOUND',
        'Runtime SSE transport only handles GET /runs/:runId/events',
        'path',
      ),
    );
  }

  const execution = await executeRuntimeRequest(request, scope, facadeFactory);
  const response = execution.response;
  if (response.status !== 200) return response;

  try {
    const events = asRuntimeEvents(response.body);
    const runId = runtimePathSegments(request)[1]!;
    const subscribe =
      (execution.facade && subscriberFor(execution.facade, runId)) ?? options.subscribe;
    return createRuntimeSseResponse(
      events,
      request.signal,
      { ...options, subscribe },
      afterSeqFromRequest(request),
    );
  } catch (error) {
    return errorResponse(error);
  }
};

export type RuntimeSseFacade = RuntimeFacadePort;

export { DEFAULT_HEARTBEAT_INTERVAL_MS };
