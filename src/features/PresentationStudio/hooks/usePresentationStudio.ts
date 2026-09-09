import { useCallback, useEffect, useMemo } from 'react';

import type { PresentationStudioStoreHook } from '../store/presentationStore';
import { useJobPolling, type UseJobPollingOptions } from './useJobPolling';

export interface UsePresentationStudioOptions {
  /** Stream reconnect backoff tuning (C-64/66). */
  backoffBaseMs?: UseJobPollingOptions['backoffBaseMs'];
  /** Job ids persisted on the backend that should be restored on mount. */
  initialJobIds?: string[];
  maxReconnectAttempts?: UseJobPollingOptions['maxReconnectAttempts'];
  pollIntervalMs?: number;
  wait?: UseJobPollingOptions['wait'];
}

/**
 * Wires a PresentationStudio store into a mounted view: restores initial jobs
 * once, then keeps active jobs polled. The transport is the store's injectable
 * client — this hook never touches the network directly. It also keeps the
 * selected artifact anchored to the selected job's artifact list when the list
 * changes under us (e.g. after a poll reveals new artifacts).
 */
export const usePresentationStudio = (
  store: PresentationStudioStoreHook,
  { initialJobIds, pollIntervalMs = 2500, ...streamOptions }: UsePresentationStudioOptions = {},
) => {
  // C-112-04: Resolve jobIds from props, URL search param, or sessionStorage (for leave-and-return recovery)
  const effectiveJobIds = useMemo(() => {
    if (initialJobIds !== undefined) return initialJobIds;
    if (typeof window !== 'undefined') {
      try {
        const paramId = new URLSearchParams(window.location.search).get('jobId');
        if (paramId) return [paramId];
        const storedId = window.sessionStorage?.getItem('presentation_studio_active_job_id');
        if (storedId) return [storedId];
      } catch {}
    }
    return undefined;
  }, [initialJobIds]);

  const initialLoading = store((s) => s.initialLoading);

  useEffect(() => {
    if (!effectiveJobIds || effectiveJobIds.length === 0) {
      if (store.getState().initialLoading) {
        store.getState().setInitialLoading(false);
      }
      return;
    }

    let disposed = false;
    store.getState().setInitialLoading(true);
    const restore = async () => {
      for (const jobId of effectiveJobIds) {
        if (disposed) return;

        // C-112-04: Restore highest seq before streaming if available
        if (typeof window !== 'undefined' && window.sessionStorage) {
          try {
            const storedSeq = window.sessionStorage.getItem(
              `presentation_studio_last_seq_${jobId}`,
            );
            if (storedSeq && !store.getState().lastSeqByJob[jobId]) {
              store.setState((s) => ({
                lastSeqByJob: {
                  ...s.lastSeqByJob,
                  [jobId]: Math.max(Number(storedSeq), s.lastSeqByJob[jobId] ?? 0),
                },
              }));
            }
          } catch {}
        }

        await store.getState().refreshJob(jobId);
        // Select the first restored job when nothing is selected yet (C-80):
        // the artifact panel only renders for a selected job, so a restored
        // session must land with a usable selection without fabricating one.
        const state = store.getState();
        if (!state.selectedJobId && state.jobs[jobId]) {
          state.selectJob(jobId);
        }
        // Hydrate the restored job's artifacts immediately (C-80): completed
        // jobs expose artifactIds, and waiting for the first poll tick left the
        // artifact panel empty after a synchronous restore. Each snapshot is
        // fetched individually — a single failure never fabricates an artifact.
        await store.getState().refreshArtifacts(jobId);
      }
      if (!disposed) store.getState().setInitialLoading(false);
    };
    void restore();

    return () => {
      disposed = true;
      store.getState().setInitialLoading(false);
    };
  }, [effectiveJobIds, store]);

  // C-112-04: 先恢复状态再订阅增量事件 (only enable polling/streaming after initial loading completes)
  useJobPolling(store, { enabled: !initialLoading, pollIntervalMs, ...streamOptions });

  const selectArtifact = useCallback(store.getState().selectArtifact, [store]);

  useEffect(() => {
    const unsubscribe = store.subscribe((state) => {
      const job = state.selectedJobId ? state.jobs[state.selectedJobId] : undefined;
      const ids = job?.artifactIds ?? [];
      if (ids.length === 0 || ids.includes(state.selectedArtifactId ?? '')) return;
      selectArtifact(ids[0]);
    });
    return unsubscribe;
  }, [selectArtifact, store]);
};
