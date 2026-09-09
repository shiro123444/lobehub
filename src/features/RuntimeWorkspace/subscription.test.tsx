import { act, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { initialRuntimeState, useRuntimeStore } from '@/store/runtime';

import type { RunSnapshot } from '../../../packages/runtime-contracts/src/index';
import RuntimeWorkspace from './index';

describe('RuntimeWorkspace SSE Subscription Lifecycle', () => {
  beforeEach(() => {
    useRuntimeStore.setState({
      ...initialRuntimeState,
    });
  });

  it('initiates subscribeRun on mount when an active running run exists', async () => {
    const subscribeRunMock = vi.fn().mockImplementation(() => new Promise(() => {}));
    const runningRun: RunSnapshot = {
      createdAt: '2026-08-26T12:00:00Z',
      profileId: 'agent-1',
      runId: 'run-live-10',
      sessionId: 'session-10',
      state: 'running',
      updatedAt: '2026-08-26T12:00:00Z',
    };

    useRuntimeStore.setState({
      activeRunId: 'run-live-10',
      runs: { 'run-live-10': runningRun },
      subscribeRun: subscribeRunMock,
    });

    render(<RuntimeWorkspace />);

    await waitFor(() => {
      expect(subscribeRunMock).toHaveBeenCalledWith(
        'run-live-10',
        undefined,
        expect.any(AbortSignal),
      );
    });
  });

  it('does not initiate subscribeRun when no activeRunId exists', () => {
    const subscribeRunMock = vi.fn();

    useRuntimeStore.setState({
      activeRunId: null,
      subscribeRun: subscribeRunMock,
    });

    render(<RuntimeWorkspace />);

    expect(subscribeRunMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('subscription-error-alert')).not.toBeInTheDocument();
  });

  it('aborts prior subscription and subscribes to new run when activeRunId changes', async () => {
    const signals: AbortSignal[] = [];
    const subscribeRunMock = vi.fn().mockImplementation((_runId, _afterSeq, signal) => {
      if (signal) signals.push(signal);
      return new Promise(() => {});
    });

    const run1: RunSnapshot = {
      createdAt: '2026-08-26T12:00:00Z',
      runId: 'run-switch-1',
      sessionId: 's-1',
      state: 'running',
      updatedAt: '2026-08-26T12:00:00Z',
    };
    const run2: RunSnapshot = {
      createdAt: '2026-08-26T12:01:00Z',
      runId: 'run-switch-2',
      sessionId: 's-2',
      state: 'running',
      updatedAt: '2026-08-26T12:01:00Z',
    };

    useRuntimeStore.setState({
      activeRunId: 'run-switch-1',
      runs: {
        'run-switch-1': run1,
        'run-switch-2': run2,
      },
      subscribeRun: subscribeRunMock,
    });

    const { rerender } = render(<RuntimeWorkspace />);

    expect(subscribeRunMock).toHaveBeenCalledWith(
      'run-switch-1',
      undefined,
      expect.any(AbortSignal),
    );
    expect(signals.length).toBe(1);
    expect(signals[0].aborted).toBe(false);

    // Switch active run to run-switch-2
    act(() => {
      useRuntimeStore.setState({ activeRunId: 'run-switch-2' });
    });

    rerender(<RuntimeWorkspace />);

    await waitFor(() => {
      expect(signals[0].aborted).toBe(true);
      expect(subscribeRunMock).toHaveBeenCalledWith(
        'run-switch-2',
        undefined,
        expect.any(AbortSignal),
      );
      expect(signals.length).toBe(2);
      expect(signals[1].aborted).toBe(false);
    });
  });

  it('aborts active subscription on component unmount cleanup', async () => {
    let capturedSignal: AbortSignal | undefined;
    const subscribeRunMock = vi.fn().mockImplementation((_runId, _afterSeq, signal) => {
      capturedSignal = signal;
      return new Promise(() => {});
    });

    const run1: RunSnapshot = {
      createdAt: '2026-08-26T12:00:00Z',
      runId: 'run-unmount-test',
      sessionId: 's-1',
      state: 'running',
      updatedAt: '2026-08-26T12:00:00Z',
    };

    useRuntimeStore.setState({
      activeRunId: 'run-unmount-test',
      runs: { 'run-unmount-test': run1 },
      subscribeRun: subscribeRunMock,
    });

    const { unmount } = render(<RuntimeWorkspace />);

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);

    unmount();

    expect(capturedSignal?.aborted).toBe(true);
  });

  it('resumes with after_seq when store already contains events for active run', async () => {
    let subscribedAfterSeq: number | undefined;
    const subscribeRunMock = vi.fn().mockImplementation((runId, afterSeq, signal) => {
      // Store subscribeRun defaults afterSeq from last seq in eventsByRun
      const existing = useRuntimeStore.getState().eventsByRun[runId] ?? [];
      const effectiveSeq = afterSeq ?? (existing.length > 0 ? existing.at(-1)?.seq : undefined);
      subscribedAfterSeq = effectiveSeq;
      return Promise.resolve();
    });

    const runResume: RunSnapshot = {
      createdAt: '2026-08-26T12:00:00Z',
      runId: 'run-seq-resume',
      sessionId: 's-resume',
      state: 'running',
      updatedAt: '2026-08-26T12:00:00Z',
    };

    useRuntimeStore.setState({
      activeRunId: 'run-seq-resume',
      eventsByRun: {
        'run-seq-resume': [
          {
            data: 'chunk 1',
            protocol_version: 'runtime.v1',
            run_id: 'run-seq-resume',
            seq: 1,
            session_id: 's-resume',
            type: 'text',
          },
          {
            data: 'chunk 2',
            protocol_version: 'runtime.v1',
            run_id: 'run-seq-resume',
            seq: 5,
            session_id: 's-resume',
            type: 'text',
          },
        ],
      },
      runs: { 'run-seq-resume': runResume },
      subscribeRun: subscribeRunMock,
    });

    render(<RuntimeWorkspace />);

    await waitFor(() => {
      expect(subscribeRunMock).toHaveBeenCalledWith(
        'run-seq-resume',
        undefined,
        expect.any(AbortSignal),
      );
      expect(subscribedAfterSeq).toBe(5);
    });
  });

  it('renders non-fatal error alert on subscription stream failure without faking completion', async () => {
    const subscribeRunMock = vi
      .fn()
      .mockRejectedValue(new Error('SSE connection broken by upstream (502)'));

    const runFail: RunSnapshot = {
      createdAt: '2026-08-26T12:00:00Z',
      profileId: 'agent-1',
      runId: 'run-stream-fail',
      sessionId: 's-fail',
      state: 'running',
      updatedAt: '2026-08-26T12:00:00Z',
    };

    useRuntimeStore.setState({
      activeRunId: 'run-stream-fail',
      runs: { 'run-stream-fail': runFail },
      subscribeRun: subscribeRunMock,
    });

    render(<RuntimeWorkspace />);

    await waitFor(() => {
      expect(screen.getByTestId('subscription-error-alert')).toBeInTheDocument();
      expect(screen.getByText('Live Event Stream Error')).toBeInTheDocument();
      expect(screen.getByText('SSE connection broken by upstream (502)')).toBeInTheDocument();
    });

    // Verify run state in store was not faked as completed
    expect(useRuntimeStore.getState().runs['run-stream-fail']?.state).toBe('running');
  });

  it('skips subscription when active run is already completed or cancelled', () => {
    const subscribeRunMock = vi.fn();

    const terminalRun: RunSnapshot = {
      createdAt: '2026-08-26T12:00:00Z',
      runId: 'run-done',
      sessionId: 's-done',
      state: 'completed',
      updatedAt: '2026-08-26T12:00:05Z',
    };

    useRuntimeStore.setState({
      activeRunId: 'run-done',
      runs: { 'run-done': terminalRun },
      subscribeRun: subscribeRunMock,
    });

    render(<RuntimeWorkspace />);

    expect(subscribeRunMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('subscription-error-alert')).not.toBeInTheDocument();
  });
});
