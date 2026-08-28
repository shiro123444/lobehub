import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { initialRuntimeState, useRuntimeStore } from '@/store/runtime';

import type { RunSnapshot, RuntimeEvent } from '../../../packages/runtime-contracts/src/index';
import RuntimeWorkspace from './index';

describe('RuntimeWorkspace Component', () => {
  beforeEach(() => {
    useRuntimeStore.setState({
      ...initialRuntimeState,
    });
  });

  it('renders empty workspace correctly', () => {
    render(<RuntimeWorkspace />);

    expect(screen.getByTestId('runtime-workspace')).toBeInTheDocument();
    expect(screen.getByTestId('decorative-layer')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-header')).toBeInTheDocument();
    expect(screen.getByText('Cordis Runtime Workspace')).toBeInTheDocument();
    expect(screen.getByText('No runs recorded')).toBeInTheDocument();
    expect(screen.getByText('No Active Run Selected')).toBeInTheDocument();
    expect(screen.getByText('No plugins mounted')).toBeInTheDocument();
  });

  it('renders active running run with cancel button', () => {
    const runningRun: RunSnapshot = {
      createdAt: '2026-08-26T12:00:00Z',
      profileId: 'agent-chat',
      runId: 'run-live-1',
      sessionId: 'session-1',
      state: 'running',
      updatedAt: '2026-08-26T12:00:01Z',
    };

    useRuntimeStore.setState({
      activeRunId: 'run-live-1',
      runs: { 'run-live-1': runningRun },
    });

    render(<RuntimeWorkspace />);

    expect(screen.getByText('(run-live-1)')).toBeInTheDocument();
    expect(screen.getByText('Cancel Run')).toBeInTheDocument();
    expect(screen.getByText('Streaming events')).toBeInTheDocument();
  });

  it('triggers cancelRun when Cancel button is clicked', () => {
    const cancelRunMock = vi.fn().mockResolvedValue(undefined);
    const runningRun: RunSnapshot = {
      createdAt: '2026-08-26T12:00:00Z',
      runId: 'run-cancel-1',
      sessionId: 'session-1',
      state: 'running',
      updatedAt: '2026-08-26T12:00:00Z',
    };

    useRuntimeStore.setState({
      activeRunId: 'run-cancel-1',
      cancelRun: cancelRunMock,
      runs: { 'run-cancel-1': runningRun },
    });

    render(<RuntimeWorkspace />);

    const cancelBtn = screen.getByText('Cancel Run');
    fireEvent.click(cancelBtn);

    expect(cancelRunMock).toHaveBeenCalledWith('run-cancel-1');
  });

  it('renders real error when run failed', () => {
    const failedRun: RunSnapshot = {
      createdAt: '2026-08-26T12:00:00Z',
      error: {
        code: 'EXECUTION_TIMEOUT',
        message: 'The model execution exceeded the 30s timeout threshold.',
      },
      runId: 'run-err-1',
      sessionId: 'session-1',
      state: 'failed',
      updatedAt: '2026-08-26T12:00:30Z',
    };

    useRuntimeStore.setState({
      activeRunId: 'run-err-1',
      runs: { 'run-err-1': failedRun },
    });

    render(<RuntimeWorkspace />);

    expect(screen.getByTestId('run-error-alert')).toBeInTheDocument();
    expect(screen.getByText('Run Error: EXECUTION_TIMEOUT')).toBeInTheDocument();
    expect(
      screen.getByText('The model execution exceeded the 30s timeout threshold.'),
    ).toBeInTheDocument();
  });

  it('renders events stream for active run', () => {
    const completedRun: RunSnapshot = {
      createdAt: '2026-08-26T12:00:00Z',
      runId: 'run-events-1',
      sessionId: 'session-1',
      state: 'completed',
      updatedAt: '2026-08-26T12:00:05Z',
    };

    const mockEvents: RuntimeEvent[] = [
      {
        data: { text: 'Hello from Cordis' },
        protocol_version: 'runtime.v1',
        run_id: 'run-events-1',
        seq: 1,
        session_id: 'session-1',
        type: 'text_chunk',
      },
      {
        data: { tool: 'calculator', result: 42 },
        protocol_version: 'runtime.v1',
        run_id: 'run-events-1',
        seq: 2,
        session_id: 'session-1',
        type: 'tool_result',
      },
    ];

    useRuntimeStore.setState({
      activeRunId: 'run-events-1',
      eventsByRun: { 'run-events-1': mockEvents },
      runs: { 'run-events-1': completedRun },
    });

    render(<RuntimeWorkspace />);

    expect(screen.getByTestId('event-item-1')).toBeInTheDocument();
    expect(screen.getByTestId('event-item-2')).toBeInTheDocument();
    expect(screen.getByText('#1')).toBeInTheDocument();
    expect(screen.getByText('#2')).toBeInTheDocument();
    expect(screen.getByText('text_chunk')).toBeInTheDocument();
    expect(screen.getByText('tool_result')).toBeInTheDocument();
  });

  it('allows switching active run by clicking sidebar run items', () => {
    const run1: RunSnapshot = {
      createdAt: '2026-08-26T12:00:00Z',
      runId: 'run-first',
      sessionId: 'session-1',
      state: 'completed',
      updatedAt: '2026-08-26T12:00:02Z',
    };
    const run2: RunSnapshot = {
      createdAt: '2026-08-26T12:01:00Z',
      runId: 'run-second',
      sessionId: 'session-2',
      state: 'running',
      updatedAt: '2026-08-26T12:01:05Z',
    };

    useRuntimeStore.setState({
      activeRunId: 'run-first',
      runs: {
        'run-first': run1,
        'run-second': run2,
      },
    });

    render(<RuntimeWorkspace />);

    expect(screen.getByText('(run-first)')).toBeInTheDocument();

    const run2Item = screen.getByTestId('run-item-run-second');
    fireEvent.click(run2Item);

    expect(useRuntimeStore.getState().activeRunId).toBe('run-second');
  });

  it('renders plugin states in the plugin panel', () => {
    useRuntimeStore.setState({
      pluginStates: {
        'agent-strategy': 'active',
        'mcp-weather': 'installed',
        'unsafe-plugin': 'failed',
      },
    });

    render(<RuntimeWorkspace />);

    expect(screen.getByTestId('plugin-item-agent-strategy')).toBeInTheDocument();
    expect(screen.getByTestId('plugin-item-mcp-weather')).toBeInTheDocument();
    expect(screen.getByTestId('plugin-item-unsafe-plugin')).toBeInTheDocument();
    expect(screen.getByText('agent-strategy')).toBeInTheDocument();
    expect(screen.getByText('mcp-weather')).toBeInTheDocument();
    expect(screen.getByText('unsafe-plugin')).toBeInTheDocument();
  });
});
