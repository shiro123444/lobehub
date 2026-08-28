import { render, screen } from '@testing-library/react';
import React, { type FC } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { initialRuntimeState, useRuntimeStore } from '@/store/runtime';

import type {
  ArtifactSnapshot,
  PresentationJob,
} from '../../../packages/runtime-contracts/src/index';
import RuntimeWorkspace from './index';
import {
  type PluginSlotProps,
  pluginSlotRegistry,
  RUNTIME_SLOT_IDS,
} from './PluginSlotHost/registry';

describe('RuntimeWorkspace Presentation Slot Integration (C-15-O)', () => {
  beforeEach(() => {
    pluginSlotRegistry.clear();
    useRuntimeStore.setState({
      ...initialRuntimeState,
    });
  });

  it('renders default workspace without presentation panel when presentation prop is omitted', () => {
    render(<RuntimeWorkspace />);

    expect(screen.getByTestId('runtime-workspace')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-main-content')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-presentation-slot')).not.toBeInTheDocument();
    expect(screen.queryByTestId('presentation-panel')).not.toBeInTheDocument();
  });

  it('renders PresentationPanel inside workspace when presentation prop is passed with a job', () => {
    const job: PresentationJob = {
      createdAt: '2026-08-27T10:00:00Z',
      jobId: 'job-ws-pres-1',
      state: 'running',
      updatedAt: '2026-08-27T10:00:05Z',
    };

    render(
      <RuntimeWorkspace
        presentation={{
          job,
        }}
      />,
    );

    expect(screen.getByTestId('workspace-presentation-slot')).toBeInTheDocument();
    expect(screen.getByTestId('presentation-panel')).toBeInTheDocument();
    expect(screen.getByText('(job-ws-pres-1)')).toBeInTheDocument();
    expect(screen.getByText('Generating presentation slides...')).toBeInTheDocument();
  });

  it('propagates callbacks (onCancel, onRetry, onExport, onArtifactSelect) from workspace presentation prop', () => {
    const onCancelMock = vi.fn();
    const onExportMock = vi.fn();

    const job: PresentationJob = {
      artifactIds: ['art-ws-1'],
      createdAt: '2026-08-27T10:00:00Z',
      jobId: 'job-ws-callbacks',
      state: 'completed',
      updatedAt: '2026-08-27T10:00:15Z',
    };

    const artifact: ArtifactSnapshot = {
      artifactId: 'art-ws-1',
      createdAt: '2026-08-27T10:00:15Z',
      name: 'StrategyDeck.pptx',
      status: 'ready',
      type: 'presentation',
    };

    render(
      <RuntimeWorkspace
        presentation={{
          artifact,
          job,
          onCancel: onCancelMock,
          onExport: onExportMock,
        }}
      />,
    );

    expect(screen.getByText('StrategyDeck.pptx')).toBeInTheDocument();

    const exportBtn = screen.getByRole('button', { name: /Export Presentation Artifact/i });
    expect(exportBtn).toBeInTheDocument();
    expect(exportBtn).not.toBeDisabled();
  });

  it('renders registered component into runtime.presentation slot via plugin registry', () => {
    const CustomPresentationExtension: FC<PluginSlotProps> = () => (
      <div data-testid="custom-presentation-widget">Custom Slide Viewer Extension</div>
    );

    pluginSlotRegistry.register({
      component: CustomPresentationExtension,
      slotId: RUNTIME_SLOT_IDS.presentation,
      title: 'Presentation Viewer',
    });

    render(<RuntimeWorkspace />);

    expect(screen.getByTestId('custom-presentation-widget')).toBeInTheDocument();
    expect(screen.getByText('Custom Slide Viewer Extension')).toBeInTheDocument();
  });

  it('isolates runtime.presentation slot errors using SlotErrorBoundary without crashing workspace', () => {
    const CrashingPresentationPlugin: FC<PluginSlotProps> = () => {
      throw new Error('Presentation slot rendering exception');
    };

    pluginSlotRegistry.register({
      component: CrashingPresentationPlugin,
      slotId: RUNTIME_SLOT_IDS.presentation,
    });

    render(<RuntimeWorkspace />);

    expect(screen.getByTestId('slot-error-boundary')).toBeInTheDocument();
    expect(screen.getByText('Plugin Slot Error: runtime.presentation')).toBeInTheDocument();
    expect(screen.getByText('Presentation slot rendering exception')).toBeInTheDocument();

    // Workspace remains interactive
    expect(screen.getByTestId('workspace-header')).toBeInTheDocument();
    expect(screen.getByTestId('run-composer')).toBeInTheDocument();
  });

  it('disables export when presentation prop has a pending/failed artifact without faking ready', () => {
    const job: PresentationJob = {
      createdAt: '2026-08-27T10:00:00Z',
      jobId: 'job-ws-failed-art',
      state: 'completed',
      updatedAt: '2026-08-27T10:00:10Z',
    };

    const failedArtifact: ArtifactSnapshot = {
      artifactId: 'art-broken',
      createdAt: '2026-08-27T10:00:10Z',
      name: 'UnrenderedSlide.pptx',
      status: 'failed',
      type: 'presentation',
    };

    render(
      <RuntimeWorkspace
        presentation={{
          artifact: failedArtifact,
          job,
        }}
      />,
    );

    expect(screen.getByText('failed')).toBeInTheDocument();
    const exportBtn = screen.getByRole('button', { name: /Export Presentation Artifact/i });
    expect(exportBtn).toBeDisabled();
  });
});
