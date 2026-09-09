import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React, { type FC } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ArtifactSnapshot,
  PresentationJob,
  RunSnapshot,
  RuntimeEvent,
} from '../../../packages/runtime-contracts/src/index';
import { initialRuntimeState, useRuntimeStore } from '@/store/runtime';

import RuntimeWorkspace from './index';
import {
  type PluginSlotProps,
  RUNTIME_SLOT_IDS,
  pluginSlotRegistry,
} from './PluginSlotHost/registry';

describe('RuntimeWorkspace Final Acceptance Guardrails (C-36)', () => {
  beforeEach(() => {
    pluginSlotRegistry.clear();
    useRuntimeStore.setState({
      ...initialRuntimeState,
    });
    vi.restoreAllMocks();
  });

  // --- Guardrail 1: Viewport Rendering Stability ---
  it('renders stable workspace layout at 1440x900 (desktop) viewport', () => {
    window.innerWidth = 1440;
    window.innerHeight = 900;
    window.dispatchEvent(new Event('resize'));

    render(<RuntimeWorkspace />);

    expect(screen.getByTestId('runtime-workspace')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-header')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-main-content')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-plugin-panel')).toBeInTheDocument();
    expect(screen.getByTestId('decorative-layer')).toBeInTheDocument();
    expect(screen.getByTestId('run-composer')).toBeInTheDocument();
    expect(screen.getByTestId('event-stream-empty')).toBeInTheDocument();
  });

  it('renders mobile-adaptive layout at 390x844 (mobile) viewport', () => {
    window.innerWidth = 390;
    window.innerHeight = 844;
    window.dispatchEvent(new Event('resize'));

    render(<RuntimeWorkspace />);

    const workspace = screen.getByTestId('runtime-workspace');
    expect(workspace).toBeInTheDocument();
    expect(screen.getByTestId('workspace-header')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-main-content')).toBeInTheDocument();
    expect(screen.getByTestId('run-composer')).toBeInTheDocument();
  });

  // --- Guardrail 2: Presentation & Plugin Slot Optional Injection ---
  it('supports caller-injected presentation prop and slot without breaking standard layout', () => {
    const job: PresentationJob = {
      createdAt: '2026-08-28T12:00:00Z',
      jobId: 'pres-c36-job',
      state: 'running',
      updatedAt: '2026-08-28T12:00:05Z',
    };

    const CustomSlotWidget: FC<PluginSlotProps> = () => (
      <div data-testid="custom-sidebar-widget">Sidebar Extension</div>
    );

    pluginSlotRegistry.register({
      component: CustomSlotWidget,
      slotId: RUNTIME_SLOT_IDS.sidebar,
      title: 'Sidebar Extension',
    });

    render(
      <RuntimeWorkspace
        presentation={{
          job,
        }}
      />,
    );

    // Presentation slot rendered
    expect(screen.getByTestId('workspace-presentation-slot')).toBeInTheDocument();
    expect(screen.getByTestId('presentation-panel')).toBeInTheDocument();
    expect(screen.getByText('(pres-c36-job)')).toBeInTheDocument();

    // Plugin slot rendered
    expect(screen.getByTestId('custom-sidebar-widget')).toBeInTheDocument();

    // Standard workspace features remain intact
    expect(screen.getByTestId('workspace-header')).toBeInTheDocument();
    expect(screen.getByTestId('run-composer')).toBeInTheDocument();
  });

  it('leaves default layout clean with zero empty slot placeholders when no slots or presentation prop are provided', () => {
    render(<RuntimeWorkspace />);

    expect(screen.queryByTestId('workspace-presentation-slot')).not.toBeInTheDocument();
    expect(screen.queryByTestId('presentation-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('slot-empty-state')).not.toBeInTheDocument();
  });

  // --- Guardrail 3: SSE Subscription Lifecycle & Non-Fatal Error ---
  it('manages SSE active subscription lifecycle and displays non-fatal warning on stream error without faking completed', async () => {
    const activeRun: RunSnapshot = {
      createdAt: '2026-08-28T12:00:00Z',
      profileId: 'agent-1',
      runId: 'run-sse-c36',
      sessionId: 'session-1',
      state: 'running',
      updatedAt: '2026-08-28T12:00:00Z',
    };

    const subscribeRunMock = vi.fn().mockRejectedValue(new Error('SSE Stream Disconnected'));

    useRuntimeStore.setState({
      activeRunId: 'run-sse-c36',
      runs: { 'run-sse-c36': activeRun },
      subscribeRun: subscribeRunMock,
    });

    render(<RuntimeWorkspace />);

    expect(subscribeRunMock).toHaveBeenCalledWith(
      'run-sse-c36',
      undefined,
      expect.any(AbortSignal),
    );

    await waitFor(() => {
      expect(screen.getByTestId('subscription-error-alert')).toBeInTheDocument();
    });

    expect(screen.getByText('Live Event Stream Error')).toBeInTheDocument();
    expect(screen.getByText('SSE Stream Disconnected')).toBeInTheDocument();

    // Run remains running, never faked as completed
    expect(useRuntimeStore.getState().runs['run-sse-c36']?.state).toBe('running');
  });

  it('aborts active subscription on component unmount cleanup', () => {
    let capturedSignal: AbortSignal | undefined;

    const subscribeRunMock = vi.fn().mockImplementation((_runId, _seq, signal) => {
      capturedSignal = signal;
      return new Promise(() => {});
    });

    useRuntimeStore.setState({
      activeRunId: 'run-cleanup-c36',
      runs: {
        'run-cleanup-c36': {
          createdAt: '2026-08-28T12:00:00Z',
          runId: 'run-cleanup-c36',
          sessionId: 's-1',
          state: 'running',
          updatedAt: '2026-08-28T12:00:00Z',
        },
      },
      subscribeRun: subscribeRunMock,
    });

    const { unmount } = render(<RuntimeWorkspace />);
    expect(capturedSignal?.aborted).toBe(false);

    unmount();
    expect(capturedSignal?.aborted).toBe(true);
  });

  // --- Guardrail 4: DecorativeLayer Independence & Reduced-Motion ---
  it('ensures DecorativeLayer renders only as static decorative visual layer without carrying runtime state', () => {
    render(<RuntimeWorkspace />);

    const decLayer = screen.getByTestId('decorative-layer');
    expect(decLayer).toBeInTheDocument();
    expect(decLayer).toHaveAttribute('aria-hidden', 'true');
    expect(decLayer).toHaveAttribute('data-asset-id', 'default-static-overlay');
  });

  // --- Guardrail 5: Presentation Multi-Artifact Selection & Controlled Export ---
  it('allows selecting ready artifact in presentation panel and disables export for pending/failed artifact without faking ready', () => {
    const onExportMock = vi.fn();
    const onSelectMock = vi.fn();

    const job: PresentationJob = {
      createdAt: '2026-08-28T12:00:00Z',
      jobId: 'job-multi-c36',
      state: 'completed',
      updatedAt: '2026-08-28T12:00:20Z',
    };

    const artifacts: ArtifactSnapshot[] = [
      {
        artifactId: 'art-ready-1',
        createdAt: '2026-08-28T12:00:15Z',
        name: 'Ready Deck.pptx',
        status: 'ready',
        type: 'presentation',
      },
      {
        artifactId: 'art-failed-1',
        createdAt: '2026-08-28T12:00:18Z',
        name: 'Broken Slide.pptx',
        status: 'failed',
        type: 'presentation',
      },
    ];

    const { rerender } = render(
      <RuntimeWorkspace
        presentation={{
          artifacts,
          job,
          onArtifactSelect: onSelectMock,
          onExport: onExportMock,
          selectedArtifactId: 'art-ready-1',
        }}
      />,
    );

    expect(screen.getByText('Ready Deck.pptx')).toBeInTheDocument();
    expect(screen.getByText('Broken Slide.pptx')).toBeInTheDocument();

    const exportBtn = screen.getByRole('button', { name: /Export Presentation Artifact/i });
    expect(exportBtn).not.toBeDisabled();

    // Select failed artifact
    rerender(
      <RuntimeWorkspace
        presentation={{
          artifacts,
          job,
          onArtifactSelect: onSelectMock,
          onExport: onExportMock,
          selectedArtifactId: 'art-failed-1',
        }}
      />,
    );

    expect(exportBtn).toBeDisabled();
  });

  // --- Guardrail 6: Slot Error Boundary Isolation ---
  it('isolates crashing slot components via SlotErrorBoundary without crashing workspace', () => {
    const CrashingComponent: FC<PluginSlotProps> = () => {
      throw new Error('Crashing slot component error');
    };

    pluginSlotRegistry.register({
      component: CrashingComponent,
      slotId: RUNTIME_SLOT_IDS.main,
    });

    render(<RuntimeWorkspace />);

    expect(screen.getByTestId('slot-error-boundary')).toBeInTheDocument();
    expect(screen.getByText('Plugin Slot Error: runtime.main')).toBeInTheDocument();
    expect(screen.getByText('Crashing slot component error')).toBeInTheDocument();

    // Core workspace remains operational
    expect(screen.getByTestId('workspace-header')).toBeInTheDocument();
    expect(screen.getByTestId('run-composer')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-sidebar')).toBeInTheDocument();
  });

  // --- Guardrail 7: A11y Landmarks and Keyboard Focus Contract ---
  it('fulfills A11y landmark and keyboard accessibility contract across components', () => {
    const testRun: RunSnapshot = {
      createdAt: '2026-08-28T12:00:00Z',
      profileId: 'agent-1',
      runId: 'run-a11y-c36',
      sessionId: 's-1',
      state: 'running',
      updatedAt: '2026-08-28T12:00:00Z',
    };

    const testEvent: RuntimeEvent = {
      data: { text: 'Test event chunk' },
      protocol_version: 'runtime.v1',
      run_id: 'run-a11y-c36',
      seq: 1,
      session_id: 's-1',
      type: 'text_delta',
    };

    useRuntimeStore.setState({
      activeRunId: 'run-a11y-c36',
      eventsByRun: { 'run-a11y-c36': [testEvent] },
      runs: { 'run-a11y-c36': testRun },
    });

    render(<RuntimeWorkspace />);

    // Header banner landmark
    expect(screen.getByRole('banner', { name: /Workspace Header/i })).toBeInTheDocument();

    // EventStream log live region
    expect(screen.getByRole('log', { name: /Runtime Events Log/i })).toBeInTheDocument();

    // RunComposer accessible form
    expect(screen.getByRole('form', { name: /Run Composer/i })).toBeInTheDocument();

    // RunItem focusable and keyboard selectable
    const runItem = screen.getByTestId('run-item-run-a11y-c36');
    expect(runItem).toHaveAttribute('tabIndex', '0');
    expect(runItem).toHaveAttribute('aria-pressed', 'true');
    expect(runItem).toHaveAttribute('role', 'button');
  });
});
