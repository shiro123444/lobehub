import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { initialRuntimeState, useRuntimeStore } from '@/store/runtime';

import type { RunSnapshot } from '../../../../packages/runtime-contracts/src/index';
import RunComposer from './index';

describe('RunComposer Component', () => {
  beforeEach(() => {
    useRuntimeStore.setState({
      ...initialRuntimeState,
    });
  });

  it('renders initial form inputs and buttons in idle state', () => {
    render(<RunComposer />);

    expect(screen.getByTestId('run-composer')).toBeInTheDocument();
    expect(screen.getByLabelText('Session ID')).toBeInTheDocument();
    expect(screen.getByLabelText('Profile / Strategy ID')).toBeInTheDocument();
    expect(screen.getByLabelText('User Message / Prompt')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reset/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Start Run/i })).toBeInTheDocument();
  });

  it('allows typing into session, profile, and message fields', () => {
    render(<RunComposer />);

    const sessionInput = screen.getByLabelText('Session ID');
    const profileInput = screen.getByLabelText('Profile / Strategy ID');
    const messageInput = screen.getByLabelText('User Message / Prompt');

    fireEvent.change(sessionInput, { target: { value: 'session-42' } });
    fireEvent.change(profileInput, { target: { value: 'agent-pro' } });
    fireEvent.change(messageInput, { target: { value: 'Analyze codebase' } });

    expect(sessionInput).toHaveValue('session-42');
    expect(profileInput).toHaveValue('agent-pro');
    expect(messageInput).toHaveValue('Analyze codebase');
  });

  it('calls startRun and onRunStarted callback upon clicking Start Run', async () => {
    const mockSnapshot: RunSnapshot = {
      createdAt: '2026-08-26T12:00:00Z',
      profileId: 'agent-pro',
      runId: 'run-new-1',
      sessionId: 'session-42',
      state: 'queued',
      updatedAt: '2026-08-26T12:00:00Z',
    };

    const startRunMock = vi.fn().mockResolvedValue(mockSnapshot);
    const onRunStartedMock = vi.fn();

    useRuntimeStore.setState({
      startRun: startRunMock,
    });

    render(<RunComposer onRunStarted={onRunStartedMock} />);

    fireEvent.change(screen.getByLabelText('Session ID'), { target: { value: 'session-42' } });
    fireEvent.change(screen.getByLabelText('Profile / Strategy ID'), {
      target: { value: 'agent-pro' },
    });
    fireEvent.change(screen.getByLabelText('User Message / Prompt'), {
      target: { value: 'Hello Cordis' },
    });

    const startBtn = screen.getByRole('button', { name: /Start Run/i });
    fireEvent.click(startBtn);

    await waitFor(() => {
      expect(startRunMock).toHaveBeenCalledWith({
        profileId: 'agent-pro',
        sessionId: 'session-42',
        userMessage: 'Hello Cordis',
      });
      expect(onRunStartedMock).toHaveBeenCalledWith('run-new-1');
      expect(screen.getByLabelText('User Message / Prompt')).toHaveValue('');
    });
  });

  it('disables inputs during loading state', async () => {
    let resolveRun: (snap: RunSnapshot) => void = () => {};
    const pendingPromise = new Promise<RunSnapshot>((resolve) => {
      resolveRun = resolve;
    });

    useRuntimeStore.setState({
      startRun: vi.fn().mockReturnValue(pendingPromise),
    });

    render(<RunComposer />);

    fireEvent.change(screen.getByLabelText('User Message / Prompt'), {
      target: { value: 'In-flight task' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Start Run/i }));

    expect(screen.getByLabelText('User Message / Prompt')).toBeDisabled();
    expect(screen.getByLabelText('Session ID')).toBeDisabled();
    expect(screen.getByLabelText('Profile / Strategy ID')).toBeDisabled();

    // Resolve promise
    resolveRun({
      createdAt: '2026-08-26T12:00:00Z',
      runId: 'run-done',
      sessionId: 'session-1',
      state: 'queued',
      updatedAt: '2026-08-26T12:00:00Z',
    });

    await waitFor(() => {
      expect(screen.getByLabelText('User Message / Prompt')).not.toBeDisabled();
    });
  });

  it('displays real error alert when startRun rejects without faking completed', async () => {
    useRuntimeStore.setState({
      startRun: vi.fn().mockRejectedValue(new Error('Network connection refused (503)')),
    });

    render(<RunComposer />);

    fireEvent.change(screen.getByLabelText('User Message / Prompt'), {
      target: { value: 'Trigger fail' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Start Run/i }));

    await waitFor(() => {
      expect(screen.getByTestId('composer-error-alert')).toBeInTheDocument();
      expect(screen.getByText('Start Run Error')).toBeInTheDocument();
      expect(screen.getByText('Network connection refused (503)')).toBeInTheDocument();
    });
  });

  it('resets inputs and clears error when Reset button is clicked', async () => {
    render(<RunComposer defaultProfileId="default-profile" defaultSessionId="default-session" />);

    const sessionInput = screen.getByLabelText('Session ID');
    const messageInput = screen.getByLabelText('User Message / Prompt');

    fireEvent.change(sessionInput, { target: { value: 'temporary-session' } });
    fireEvent.change(messageInput, { target: { value: 'temporary message' } });

    const resetBtn = screen.getByRole('button', { name: /Reset/i });
    fireEvent.click(resetBtn);

    expect(sessionInput).toHaveValue('default-session');
    expect(messageInput).toHaveValue('');
  });

  it('supports Cmd+Enter shortcut in textarea to trigger run creation', async () => {
    const startRunMock = vi.fn().mockResolvedValue({
      createdAt: '2026-08-26T12:00:00Z',
      runId: 'run-shortcut',
      sessionId: 's-1',
      state: 'queued',
      updatedAt: '2026-08-26T12:00:00Z',
    });

    useRuntimeStore.setState({
      startRun: startRunMock,
    });

    render(<RunComposer />);

    const messageInput = screen.getByLabelText('User Message / Prompt');
    fireEvent.change(messageInput, { target: { value: 'Shortcut message' } });

    fireEvent.keyDown(messageInput, { ctrlKey: true, key: 'Enter' });

    await waitFor(() => {
      expect(startRunMock).toHaveBeenCalledWith({
        profileId: '',
        sessionId: '',
        userMessage: 'Shortcut message',
      });
    });
  });
});
