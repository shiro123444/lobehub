import { RUNTIME_PROTOCOL_VERSION } from '../../../../packages/runtime-contracts/src';
import {
  type PresentationJobEvent,
  type PresentationJobEventDisposer,
  type PresentationJobEventListener,
  validatePresentationJobEvent,
} from './job-event-journal';

export type PresentationJobEventSerializer = (event: PresentationJobEvent) => string;

export type PresentationJobEventSubscriber = (
  listener: PresentationJobEventListener,
  options?: { readonly signal?: AbortSignal },
) => PresentationJobEventDisposer | { dispose: () => void };

export interface PresentationJobEventSseOptions {
  readonly heartbeatIntervalMs?: number;
  readonly serializer?: PresentationJobEventSerializer;
  readonly subscribe?: PresentationJobEventSubscriber;
}

export interface PresentationJobEventSseResponse {
  readonly body: ReadableStream<Uint8Array>;
  readonly headers: {
    readonly 'cache-control': 'no-cache, no-transform';
    readonly 'connection': 'keep-alive';
    readonly 'content-type': 'text/event-stream';
    readonly 'x-accel-buffering': 'no';
  };
  readonly status: 200;
}

export type PresentationJobEventSseErrorCode = 'PRESENTATION_EVENT_INVALID';

export class PresentationJobEventSseError extends Error {
  constructor(
    public readonly code: PresentationJobEventSseErrorCode,
    message: string,
    public readonly path?: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PresentationJobEventSseError';
  }
}

const SSE_HEADERS = {
  'cache-control': 'no-cache, no-transform',
  'connection': 'keep-alive',
  'content-type': 'text/event-stream',
  'x-accel-buffering': 'no',
} as const;

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

const normalizeEvent = (event: PresentationJobEvent): PresentationJobEvent => {
  validatePresentationJobEvent(event.job_id, event);
  return {
    protocol_version: RUNTIME_PROTOCOL_VERSION,
    type: event.type,
    job_id: event.job_id,
    seq: event.seq,
    data: event.data,
  };
};

export const serializePresentationJobEvent = (event: PresentationJobEvent): string => {
  const normalized = normalizeEvent(event);
  try {
    const data = JSON.stringify(normalized);
    if (data === undefined) throw new Error('event is not JSON serializable');
    return `id: ${normalized.seq}\ndata: ${data}\n\n`;
  } catch (cause) {
    throw new PresentationJobEventSseError(
      'PRESENTATION_EVENT_INVALID',
      'presentation event must be JSON serializable',
      'event',
      cause,
    );
  }
};

const serializeFrame = (
  serializer: PresentationJobEventSerializer,
  event: PresentationJobEvent,
): string => {
  const frame = serializer(normalizeEvent(event));
  if (typeof frame !== 'string') {
    throw new PresentationJobEventSseError(
      'PRESENTATION_EVENT_INVALID',
      'presentation event serializer must return a string',
      'serializer',
    );
  }
  return frame;
};

const disposer = (
  subscription: PresentationJobEventDisposer | { dispose: () => void } | undefined,
): void => {
  try {
    if (typeof subscription === 'function') subscription();
    else subscription?.dispose();
  } catch {
    // Stream teardown is idempotent and must not surface cleanup errors.
  }
};

const streamFor = (
  replay: readonly PresentationJobEvent[],
  replayFrames: readonly string[],
  signal: AbortSignal,
  options: PresentationJobEventSseOptions,
  afterSeq: number,
): ReadableStream<Uint8Array> => {
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  if (!Number.isFinite(heartbeatIntervalMs) || heartbeatIntervalMs <= 0) {
    throw new PresentationJobEventSseError(
      'PRESENTATION_EVENT_INVALID',
      'heartbeatIntervalMs must be a positive finite number',
      'heartbeatIntervalMs',
    );
  }

  const serializer = options.serializer ?? serializePresentationJobEvent;
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let subscription: PresentationJobEventDisposer | { dispose: () => void } | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let abortListener: (() => void) | undefined;
  let closed = false;
  let replaying = true;
  let lastSeq = afterSeq;
  const pending = new Map<number, PresentationJobEvent>();

  const cleanup = (): void => {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    heartbeat = undefined;
    disposer(subscription);
    subscription = undefined;
    if (abortListener) signal.removeEventListener('abort', abortListener);
    abortListener = undefined;
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    cleanup();
    controller?.close();
  };

  const emit = (event: PresentationJobEvent): void => {
    if (closed || event.seq <= lastSeq) return;
    const frame = serializeFrame(serializer, event);
    lastSeq = event.seq;
    controller?.enqueue(encoder.encode(frame));
  };

  const fail = (error: unknown): void => {
    if (closed) return;
    closed = true;
    cleanup();
    controller?.error(error);
  };

  return new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      abortListener = close;
      signal.addEventListener('abort', close, { once: true });
      if (signal.aborted) {
        close();
        return;
      }

      try {
        if (options.subscribe) {
          subscription = options.subscribe(
            (event) => {
              if (replaying) {
                if (event.seq > lastSeq && !pending.has(event.seq)) pending.set(event.seq, event);
                return;
              }
              emit(event);
            },
            { signal },
          );
          if (closed) disposer(subscription);
        }

        for (const [index, event] of replay.entries()) {
          if (closed || event.seq <= lastSeq) continue;
          controller.enqueue(encoder.encode(replayFrames[index]!));
          lastSeq = event.seq;
        }
        replaying = false;
        for (const event of [...pending.values()].sort((left, right) => left.seq - right.seq)) {
          emit(event);
        }
        pending.clear();
        heartbeat = setInterval(() => {
          if (!closed) controller?.enqueue(encoder.encode(': heartbeat\n\n'));
        }, heartbeatIntervalMs);
      } catch (error) {
        fail(error);
      }
    },
    cancel() {
      closed = true;
      cleanup();
    },
  });
};

const validateAfterSeq = (afterSeq: number): void => {
  if (!Number.isSafeInteger(afterSeq) || afterSeq < -1) {
    throw new PresentationJobEventSseError(
      'PRESENTATION_EVENT_INVALID',
      'afterSeq must be a safe integer greater than or equal to -1',
      'after_seq',
    );
  }
};

export const createPresentationJobEventSseResponse = (
  events: readonly PresentationJobEvent[],
  signal: AbortSignal,
  options: PresentationJobEventSseOptions = {},
  afterSeq = -1,
): PresentationJobEventSseResponse => {
  validateAfterSeq(afterSeq);
  let previousSeq = afterSeq;
  const replay: PresentationJobEvent[] = [];
  events.forEach((event, index) => {
    validatePresentationJobEvent(event.job_id, event);
    if (event.seq <= afterSeq) return;
    if (event.seq <= previousSeq) {
      throw new PresentationJobEventSseError(
        'PRESENTATION_EVENT_INVALID',
        'presentation event sequences must be strictly increasing',
        `events[${index}].seq`,
      );
    }
    previousSeq = event.seq;
    replay.push(event);
  });
  const serializer = options.serializer ?? serializePresentationJobEvent;
  const replayFrames = replay.map((event) => serializeFrame(serializer, event));
  return {
    body: streamFor(replay, replayFrames, signal, { ...options, serializer }, afterSeq),
    headers: SSE_HEADERS,
    status: 200,
  };
};

export { DEFAULT_HEARTBEAT_INTERVAL_MS };
