import { subscribeWithSelector } from 'zustand/middleware';
import { shallow } from 'zustand/shallow';
import { createWithEqualityFn } from 'zustand/traditional';
import { type StateCreator } from 'zustand/vanilla';

import type {
  PluginDescriptor,
  PluginRuntimeState,
  RunSnapshot,
  RuntimeEvent,
  StartRunInput,
} from '../../../packages/runtime-contracts/src/index';
import {
  type RuntimeClient,
  runtimeClient as defaultRuntimeClient,
} from '../../services/runtime/client';

export interface RuntimeStoreState {
  activeRunId: string | null;
  eventsByRun: Record<string, RuntimeEvent[]>;
  pluginStates: Record<string, PluginRuntimeState>;
  runs: Record<string, RunSnapshot>;
}

export interface SubscribeRunOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxRetries?: number;
  signal?: AbortSignal;
}

export interface RuntimeStoreActions {
  cancelRun: (runId: string) => Promise<void>;
  clearRun: (runId: string) => void;
  getRun: (runId: string) => Promise<RunSnapshot | null>;
  handleRuntimeEvent: (event: RuntimeEvent) => void;
  listPlugins: () => Promise<PluginDescriptor[]>;
  mountPlugin: (id: string, config?: unknown) => Promise<PluginRuntimeState>;
  setActiveRunId: (runId: string | null) => void;
  startRun: (input: StartRunInput) => Promise<RunSnapshot>;
  subscribeRun: (
    runId: string,
    afterSeq?: number,
    signalOrOptions?: AbortSignal | SubscribeRunOptions,
  ) => Promise<void>;
}

export type RuntimeStore = RuntimeStoreState & RuntimeStoreActions;

export const initialRuntimeState: RuntimeStoreState = {
  activeRunId: null,
  eventsByRun: {},
  pluginStates: {},
  runs: {},
};

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new DOMException('Aborted', 'AbortError'));
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export const createRuntimeStore =
  (client: RuntimeClient = defaultRuntimeClient): StateCreator<RuntimeStore> =>
  (set, get) => ({
    ...initialRuntimeState,

    cancelRun: async (runId: string) => {
      await client.cancelRun(runId);
      const existing = get().runs[runId];
      if (existing) {
        set((state) => ({
          runs: {
            ...state.runs,
            [runId]: {
              ...existing,
              state: 'cancelled',
              updatedAt: new Date().toISOString(),
            },
          },
        }));
      }
    },

    clearRun: (runId: string) => {
      set((state) => {
        const newRuns = { ...state.runs };
        delete newRuns[runId];
        const newEvents = { ...state.eventsByRun };
        delete newEvents[runId];

        return {
          activeRunId: state.activeRunId === runId ? null : state.activeRunId,
          eventsByRun: newEvents,
          runs: newRuns,
        };
      });
    },

    getRun: async (runId: string) => {
      const snapshot = await client.getRun(runId);
      if (snapshot) {
        set((state) => ({
          runs: {
            ...state.runs,
            [runId]: snapshot,
          },
        }));
      }
      return snapshot;
    },

    handleRuntimeEvent: (event: RuntimeEvent) => {
      const runId = event.run_id;
      if (!runId) return;

      set((state) => {
        const existingEvents = state.eventsByRun[runId] ?? [];
        const existingIndex = existingEvents.findIndex((e) => e.seq === event.seq);

        let updatedEvents: RuntimeEvent[];
        if (existingIndex >= 0) {
          // If already recorded with same seq and data, ignore duplicate to maintain idempotency
          if (JSON.stringify(existingEvents[existingIndex]) === JSON.stringify(event)) {
            return state;
          }
          // If updated payload, replace in-place
          updatedEvents = [...existingEvents];
          updatedEvents[existingIndex] = event;
        } else {
          // Append and maintain strictly monotonic ascending order by seq
          updatedEvents = [...existingEvents, event].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
        }

        let updatedRuns = state.runs;
        const currentRun = state.runs[runId];

        if (
          currentRun &&
          event.type === 'run_state' &&
          typeof event.data === 'object' &&
          event.data !== null
        ) {
          const data = event.data as Record<string, unknown>;
          if (typeof data.state === 'string') {
            updatedRuns = {
              ...state.runs,
              [runId]: {
                ...currentRun,
                state: data.state as any,
                updatedAt: new Date().toISOString(),
              },
            };
          }
        }

        return {
          eventsByRun: {
            ...state.eventsByRun,
            [runId]: updatedEvents,
          },
          runs: updatedRuns,
        };
      });
    },

    listPlugins: async () => {
      const plugins = await client.listPlugins();
      const newStates: Record<string, PluginRuntimeState> = {};
      for (const p of plugins) {
        if (p.state) {
          newStates[p.id] = p.state;
        }
      }

      set((state) => ({
        pluginStates: {
          ...state.pluginStates,
          ...newStates,
        },
      }));

      return plugins;
    },

    mountPlugin: async (id: string, config?: unknown) => {
      const stateResult = await client.mountPlugin(id, config);
      set((state) => ({
        pluginStates: {
          ...state.pluginStates,
          [id]: stateResult,
        },
      }));
      return stateResult;
    },

    setActiveRunId: (runId: string | null) => {
      set({ activeRunId: runId });
    },

    startRun: async (input: StartRunInput) => {
      const snapshot = await client.startRun(input);
      set((state) => ({
        activeRunId: snapshot.runId,
        eventsByRun: {
          ...state.eventsByRun,
          [snapshot.runId]: state.eventsByRun[snapshot.runId] ?? [],
        },
        runs: {
          ...state.runs,
          [snapshot.runId]: snapshot,
        },
      }));
      return snapshot;
    },

    subscribeRun: async (
      runId: string,
      afterSeq?: number,
      signalOrOptions?: AbortSignal | SubscribeRunOptions,
    ) => {
      let signal: AbortSignal | undefined;
      let maxRetries = 3;
      let initialDelayMs = 20;
      let maxDelayMs = 500;

      if (signalOrOptions) {
        if ('aborted' in signalOrOptions) {
          signal = signalOrOptions as AbortSignal;
        } else {
          const opts = signalOrOptions as SubscribeRunOptions;
          signal = opts.signal;
          if (typeof opts.maxRetries === 'number') maxRetries = opts.maxRetries;
          if (typeof opts.initialDelayMs === 'number') initialDelayMs = opts.initialDelayMs;
          if (typeof opts.maxDelayMs === 'number') maxDelayMs = opts.maxDelayMs;
        }
      }

      let lastError: unknown = null;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (signal?.aborted) {
          return;
        }

        const currentRun = get().runs[runId];
        if (
          currentRun?.state === 'completed' ||
          currentRun?.state === 'failed' ||
          currentRun?.state === 'cancelled'
        ) {
          return;
        }

        // Determine effective afterSeq from highest stored event seq
        let effectiveAfterSeq = afterSeq;
        const storedEvents = get().eventsByRun[runId] ?? [];
        if (storedEvents.length > 0) {
          const highestSeq = Math.max(
            ...storedEvents.map((e) => (typeof e.seq === 'number' ? e.seq : -1)),
          );
          if (highestSeq >= 0) {
            effectiveAfterSeq =
              typeof effectiveAfterSeq === 'number'
                ? Math.max(effectiveAfterSeq, highestSeq)
                : highestSeq;
          }
        }

        try {
          lastError = null;
          for await (const event of client.subscribe(runId, effectiveAfterSeq, { signal })) {
            get().handleRuntimeEvent(event);

            const updatedRun = get().runs[runId];
            if (
              updatedRun?.state === 'completed' ||
              updatedRun?.state === 'failed' ||
              updatedRun?.state === 'cancelled'
            ) {
              return;
            }
          }

          // If stream ended normally without throwing:
          const finalRun = get().runs[runId];
          if (
            finalRun?.state === 'completed' ||
            finalRun?.state === 'failed' ||
            finalRun?.state === 'cancelled'
          ) {
            return;
          }

          // If stream ended cleanly but run is still active, retry with backoff
          if (attempt < maxRetries) {
            const delay = Math.min(initialDelayMs * Math.pow(2, attempt), maxDelayMs);
            await sleep(delay, signal).catch(() => {});
            if (signal?.aborted) return;
            continue;
          }
        } catch (err: unknown) {
          if (signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
            return;
          }
          lastError = err;

          const runAfterErr = get().runs[runId];
          if (
            runAfterErr?.state === 'completed' ||
            runAfterErr?.state === 'failed' ||
            runAfterErr?.state === 'cancelled'
          ) {
            return;
          }

          if (attempt < maxRetries) {
            const delay = Math.min(initialDelayMs * Math.pow(2, attempt), maxDelayMs);
            await sleep(delay, signal).catch(() => {});
            if (signal?.aborted) return;
            continue;
          }
        }
      }

      if (lastError) {
        throw lastError;
      }
    },
  });

export const useRuntimeStore = createWithEqualityFn<RuntimeStore>()(
  subscribeWithSelector(createRuntimeStore()),
  shallow,
);

export const runtimeSelectors = {
  activeEvents: (s: RuntimeStoreState): RuntimeEvent[] =>
    s.activeRunId ? (s.eventsByRun[s.activeRunId] ?? []) : [],
  activeLastSeq: (s: RuntimeStoreState): number | undefined => {
    if (!s.activeRunId) return undefined;
    const events = s.eventsByRun[s.activeRunId];
    if (!events || events.length === 0) return undefined;
    return events.at(-1)?.seq;
  },
  activeRun: (s: RuntimeStoreState): RunSnapshot | null =>
    s.activeRunId ? (s.runs[s.activeRunId] ?? null) : null,
  getEventsByRunId:
    (runId: string) =>
    (s: RuntimeStoreState): RuntimeEvent[] =>
      s.eventsByRun[runId] ?? [],
  getLastSeqByRunId:
    (runId: string) =>
    (s: RuntimeStoreState): number | undefined => {
      const events = s.eventsByRun[runId];
      if (!events || events.length === 0) return undefined;
      return events.at(-1)?.seq;
    },
  getPluginState:
    (id: string) =>
    (s: RuntimeStoreState): PluginRuntimeState | undefined =>
      s.pluginStates[id],
  getRunById:
    (runId: string) =>
    (s: RuntimeStoreState): RunSnapshot | undefined =>
      s.runs[runId],
};
