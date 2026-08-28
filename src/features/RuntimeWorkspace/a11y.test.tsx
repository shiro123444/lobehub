import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { initialRuntimeState, useRuntimeStore } from '@/store/runtime';

import type { RunSnapshot } from '../../../packages/runtime-contracts/src/index';
import Header from './Header';
import RuntimeWorkspace from './index';
import PluginSlotHost, { pluginSlotRegistry } from './PluginSlotHost';
import RunComposer from './RunComposer';
import { RunItem } from './Sidebar/RunItem';

describe('RuntimeWorkspace Accessibility & Keyboard Interactions', () => {
  beforeEach(() => {
    pluginSlotRegistry.clear();
    useRuntimeStore.setState({
      ...initialRuntimeState,
    });
  });

  it('RunComposer inputs and buttons expose accessible labels, roles, and aria-disabled attributes', () => {
    render(<RunComposer />);

    const form = screen.getByRole('form', { name: /Run Composer/i });
    expect(form).toBeInTheDocument();

    const sessionInput = screen.getByLabelText('Session ID');
    expect(sessionInput).toHaveAttribute('aria-label', 'Session ID');

    const profileInput = screen.getByLabelText('Profile / Strategy ID');
    expect(profileInput).toHaveAttribute('aria-label', 'Profile / Strategy ID');

    const messageInput = screen.getByLabelText('User Message / Prompt');
    expect(messageInput).toHaveAttribute('aria-required', 'true');

    const resetBtn = screen.getByRole('button', { name: /Reset form/i });
    expect(resetBtn).toBeInTheDocument();

    const startBtn = screen.getByRole('button', { name: /Start Run/i });
    expect(startBtn).toHaveAttribute('aria-busy', 'false');
  });

  it('RunComposer Start Run button reflects aria-busy="true" during in-flight loading state', () => {
    useRuntimeStore.setState({
      startRun: vi.fn().mockReturnValue(new Promise(() => {})),
    });

    render(<RunComposer />);

    const messageInput = screen.getByLabelText('User Message / Prompt');
    fireEvent.change(messageInput, { target: { value: 'In-flight task' } });

    const startBtn = screen.getByRole('button', { name: /Start Run/i });
    fireEvent.click(startBtn);

    expect(startBtn).toHaveAttribute('aria-busy', 'true');
    expect(messageInput).toHaveAttribute('aria-disabled', 'true');
  });

  it('RunComposer error Alert has role="alert" for screen reader announcements', async () => {
    useRuntimeStore.setState({
      startRun: vi.fn().mockRejectedValue(new Error('Backend 503 Service Unavailable')),
    });

    render(<RunComposer />);

    fireEvent.change(screen.getByLabelText('User Message / Prompt'), {
      target: { value: 'Trigger error' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Start Run/i }));

    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert).toBeInTheDocument();
      expect(screen.getByText('Backend 503 Service Unavailable')).toBeInTheDocument();
    });
  });

  it('RunItem is keyboard focusable (tabIndex=0) and triggers selection on Enter and Space keydown', () => {
    const onSelectMock = vi.fn();
    const run: RunSnapshot = {
      createdAt: '2026-08-26T12:00:00Z',
      profileId: 'agent-chat',
      runId: 'run-kb-1',
      sessionId: 'session-1',
      state: 'running',
      updatedAt: '2026-08-26T12:00:00Z',
    };

    render(<RunItem isActive={false} run={run} onSelect={onSelectMock} />);

    const item = screen.getByRole('button', { name: /Run run-kb-1, state: running/i });
    expect(item).toBeInTheDocument();
    expect(item).toHaveAttribute('tabindex', '0');
    expect(item).toHaveAttribute('aria-pressed', 'false');

    // Press Enter
    fireEvent.keyDown(item, { key: 'Enter' });
    expect(onSelectMock).toHaveBeenCalledWith('run-kb-1');

    // Press Space
    fireEvent.keyDown(item, { key: ' ' });
    expect(onSelectMock).toHaveBeenCalledTimes(2);
  });

  it('RunItem reflects aria-pressed="true" matching active state', () => {
    const run: RunSnapshot = {
      createdAt: '2026-08-26T12:00:00Z',
      runId: 'run-pressed-1',
      sessionId: 'session-1',
      state: 'completed',
      updatedAt: '2026-08-26T12:00:00Z',
    };

    render(<RunItem isActive={true} run={run} onSelect={vi.fn()} />);

    const item = screen.getByRole('button', { name: /Run run-pressed-1/i });
    expect(item).toHaveAttribute('aria-pressed', 'true');
  });

  it('PluginSlotHost exposes role="region" and accessible aria-label', () => {
    render(<PluginSlotHost slotId="custom-slot-a11y" />);

    const region = screen.getByRole('region', { name: /Plugin Slot: custom-slot-a11y/i });
    expect(region).toBeInTheDocument();
  });

  it('PluginSlotHost error boundary exposes role="alert" for slot crashes', () => {
    const CrashingWidget = () => {
      throw new Error('Plugin slot failed unexpectedly');
    };

    pluginSlotRegistry.register({
      component: CrashingWidget,
      slotId: 'crashing-slot',
    });

    render(<PluginSlotHost slotId="crashing-slot" />);

    const alert = screen.getByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(screen.getByText('Plugin slot failed unexpectedly')).toBeInTheDocument();
  });

  it('Header component exposes role="banner" and accessible cancel action aria-label', () => {
    const cancelRunMock = vi.fn();
    const runningRun: RunSnapshot = {
      createdAt: '2026-08-26T12:00:00Z',
      runId: 'run-cancel-a11y',
      sessionId: 's-1',
      state: 'running',
      updatedAt: '2026-08-26T12:00:00Z',
    };

    useRuntimeStore.setState({
      activeRunId: 'run-cancel-a11y',
      cancelRun: cancelRunMock,
      runs: { 'run-cancel-a11y': runningRun },
    });

    render(<Header />);

    const banner = screen.getByRole('banner', { name: /Workspace Header/i });
    expect(banner).toBeInTheDocument();

    const cancelBtn = screen.getByRole('button', { name: /Cancel active run run-cancel-a11y/i });
    expect(cancelBtn).toBeInTheDocument();
  });

  it('EventStream renders events list in a live log region with role="log" and aria-live="polite"', () => {
    const activeRun: RunSnapshot = {
      createdAt: '2026-08-26T12:00:00Z',
      runId: 'run-log-test',
      sessionId: 's-1',
      state: 'running',
      updatedAt: '2026-08-26T12:00:00Z',
    };

    useRuntimeStore.setState({
      activeRunId: 'run-log-test',
      eventsByRun: {
        'run-log-test': [
          {
            data: { step: 1 },
            protocol_version: 'runtime.v1',
            run_id: 'run-log-test',
            seq: 1,
            session_id: 's-1',
            type: 'step',
          },
        ],
      },
      runs: { 'run-log-test': activeRun },
    });

    render(<RuntimeWorkspace />);

    const logRegion = screen.getByRole('log', { name: /Runtime Events Log/i });
    expect(logRegion).toBeInTheDocument();
    expect(logRegion).toHaveAttribute('aria-live', 'polite');
  });
});
