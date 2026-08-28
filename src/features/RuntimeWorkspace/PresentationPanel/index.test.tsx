import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type {
  ArtifactSnapshot,
  PresentationJob,
} from '../../../../packages/runtime-contracts/src/index';
import PresentationPanel from './index';

describe('PresentationPanel Component', () => {
  it('renders empty placeholder when no job is provided', () => {
    render(<PresentationPanel />);

    expect(screen.getByTestId('presentation-panel-empty')).toBeInTheDocument();
    expect(screen.getByText('No Active Presentation Job')).toBeInTheDocument();
  });

  it('renders queued job state with enabled cancel button and disabled retry/export', () => {
    const job: PresentationJob = {
      createdAt: '2026-08-27T10:00:00Z',
      jobId: 'job-queued-1',
      state: 'queued',
      updatedAt: '2026-08-27T10:00:00Z',
    };

    render(<PresentationPanel job={job} />);

    expect(screen.getByTestId('presentation-panel')).toBeInTheDocument();
    expect(screen.getByText('(job-queued-1)')).toBeInTheDocument();
    expect(screen.getByText('queued')).toBeInTheDocument();
    expect(screen.getByText('Job queued in runner queue...')).toBeInTheDocument();

    const cancelBtn = screen.getByRole('button', { name: /Cancel Presentation Job/i });
    expect(cancelBtn).toBeInTheDocument();
    expect(cancelBtn).not.toBeDisabled();

    expect(
      screen.queryByRole('button', { name: /Retry Presentation Job/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Export Presentation Artifact/i }),
    ).not.toBeInTheDocument();
  });

  it('renders running job state with progress indicator and cancel button', () => {
    const job: PresentationJob = {
      createdAt: '2026-08-27T10:00:00Z',
      jobId: 'job-running-1',
      state: 'running',
      updatedAt: '2026-08-27T10:00:05Z',
    };

    render(<PresentationPanel job={job} />);

    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByText('Generating presentation slides...')).toBeInTheDocument();

    const cancelBtn = screen.getByRole('button', { name: /Cancel Presentation Job/i });
    expect(cancelBtn).toBeInTheDocument();
    expect(cancelBtn).not.toBeDisabled();
  });

  it('triggers onCancel callback with jobId when Cancel Job button is clicked', () => {
    const onCancelMock = vi.fn();
    const job: PresentationJob = {
      createdAt: '2026-08-27T10:00:00Z',
      jobId: 'job-cancel-test',
      state: 'running',
      updatedAt: '2026-08-27T10:00:05Z',
    };

    render(<PresentationPanel job={job} onCancel={onCancelMock} />);

    const cancelBtn = screen.getByRole('button', { name: /Cancel Presentation Job/i });
    fireEvent.click(cancelBtn);

    expect(onCancelMock).toHaveBeenCalledWith('job-cancel-test');
  });

  it('renders completed job state with ready artifact and enables export button', () => {
    const job: PresentationJob = {
      artifactIds: ['art-1'],
      createdAt: '2026-08-27T10:00:00Z',
      jobId: 'job-comp-1',
      state: 'completed',
      updatedAt: '2026-08-27T10:00:20Z',
    };

    const artifact: ArtifactSnapshot = {
      artifactId: 'art-1',
      createdAt: '2026-08-27T10:00:20Z',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      name: 'PitchDeck.pptx',
      sizeBytes: 2097152,
      status: 'ready',
      type: 'presentation',
    };

    render(<PresentationPanel artifact={artifact} job={job} />);

    expect(screen.getByText('completed')).toBeInTheDocument();
    expect(screen.getByTestId('presentation-artifact-art-1')).toBeInTheDocument();
    expect(screen.getByText('PitchDeck.pptx')).toBeInTheDocument();
    expect(screen.getByText('ready')).toBeInTheDocument();
    expect(screen.getByText('Size: 2.0 MB')).toBeInTheDocument();

    const exportBtn = screen.getByRole('button', { name: /Export Presentation Artifact/i });
    expect(exportBtn).toBeInTheDocument();
    expect(exportBtn).not.toBeDisabled();
  });

  it('renders failed job state with real error alert and enables retry button', () => {
    const job: PresentationJob = {
      createdAt: '2026-08-27T10:00:00Z',
      error: {
        code: 'PROVIDER_UNAVAILABLE',
        message: 'PPT Master rendering worker is unreachable',
      },
      jobId: 'job-failed-1',
      state: 'failed',
      updatedAt: '2026-08-27T10:00:15Z',
    };

    render(<PresentationPanel job={job} />);

    expect(screen.getByText('failed')).toBeInTheDocument();
    expect(screen.getByTestId('presentation-error-alert')).toBeInTheDocument();
    expect(screen.getByText('Presentation Error: PROVIDER_UNAVAILABLE')).toBeInTheDocument();
    expect(screen.getByText('PPT Master rendering worker is unreachable')).toBeInTheDocument();

    const retryBtn = screen.getByRole('button', { name: /Retry Presentation Job/i });
    expect(retryBtn).toBeInTheDocument();
    expect(retryBtn).not.toBeDisabled();

    expect(
      screen.queryByRole('button', { name: /Cancel Presentation Job/i }),
    ).not.toBeInTheDocument();
  });

  it('triggers onRetry callback with jobId when Retry Job button is clicked', () => {
    const onRetryMock = vi.fn();
    const job: PresentationJob = {
      createdAt: '2026-08-27T10:00:00Z',
      jobId: 'job-retry-test',
      state: 'failed',
      updatedAt: '2026-08-27T10:00:15Z',
    };

    render(<PresentationPanel job={job} onRetry={onRetryMock} />);

    const retryBtn = screen.getByRole('button', { name: /Retry Presentation Job/i });
    fireEvent.click(retryBtn);

    expect(onRetryMock).toHaveBeenCalledWith('job-retry-test');
  });

  it('renders cancelled job state without faking ready and enables retry', () => {
    const job: PresentationJob = {
      createdAt: '2026-08-27T10:00:00Z',
      jobId: 'job-cancelled-1',
      state: 'cancelled',
      updatedAt: '2026-08-27T10:00:08Z',
    };

    render(<PresentationPanel job={job} />);

    expect(screen.getByText('cancelled')).toBeInTheDocument();

    const retryBtn = screen.getByRole('button', { name: /Retry Presentation Job/i });
    expect(retryBtn).toBeInTheDocument();
    expect(retryBtn).not.toBeDisabled();

    expect(
      screen.queryByRole('button', { name: /Cancel Presentation Job/i }),
    ).not.toBeInTheDocument();
  });

  it('supports multi-artifact list rendering and controlled selectedArtifactId', () => {
    const job: PresentationJob = {
      createdAt: '2026-08-27T10:00:00Z',
      jobId: 'job-multi-1',
      state: 'completed',
      updatedAt: '2026-08-27T10:00:10Z',
    };

    const artifacts: ArtifactSnapshot[] = [
      {
        artifactId: 'art-deck-v1',
        createdAt: '2026-08-27T10:00:05Z',
        name: 'Draft Deck.pptx',
        status: 'ready',
        type: 'presentation',
      },
      {
        artifactId: 'art-deck-v2',
        createdAt: '2026-08-27T10:00:10Z',
        name: 'Final Deck.pptx',
        status: 'ready',
        type: 'presentation',
      },
      {
        artifactId: 'art-deck-fail',
        createdAt: '2026-08-27T10:00:12Z',
        name: 'Corrupted Slide.pptx',
        status: 'failed',
        type: 'presentation',
      },
    ];

    render(<PresentationPanel artifacts={artifacts} job={job} selectedArtifactId="art-deck-v2" />);

    expect(screen.getByText('Artifacts: 3')).toBeInTheDocument();
    expect(screen.getByTestId('presentation-artifact-art-deck-v1')).toBeInTheDocument();
    expect(screen.getByTestId('presentation-artifact-art-deck-v2')).toBeInTheDocument();
    expect(screen.getByTestId('presentation-artifact-art-deck-fail')).toBeInTheDocument();

    const v2El = screen.getByTestId('presentation-artifact-art-deck-v2');
    expect(v2El).toHaveAttribute('data-selected', 'true');
    expect(v2El).toHaveAttribute('aria-checked', 'true');

    const v1El = screen.getByTestId('presentation-artifact-art-deck-v1');
    expect(v1El).toHaveAttribute('data-selected', 'false');
    expect(v1El).toHaveAttribute('aria-checked', 'false');
  });

  it('allows user to click and keyboard-select an artifact and triggers onArtifactSelect', () => {
    const onSelectMock = vi.fn();
    const job: PresentationJob = {
      createdAt: '2026-08-27T10:00:00Z',
      jobId: 'job-select-test',
      state: 'completed',
      updatedAt: '2026-08-27T10:00:10Z',
    };

    const artifacts: ArtifactSnapshot[] = [
      {
        artifactId: 'art-a',
        createdAt: '2026-08-27T10:00:05Z',
        name: 'Slide A',
        status: 'ready',
        type: 'presentation',
      },
      {
        artifactId: 'art-b',
        createdAt: '2026-08-27T10:00:10Z',
        name: 'Slide B',
        status: 'ready',
        type: 'presentation',
      },
    ];

    render(<PresentationPanel artifacts={artifacts} job={job} onArtifactSelect={onSelectMock} />);

    const artB = screen.getByTestId('presentation-artifact-art-b');

    // Click selection
    fireEvent.click(artB);
    expect(onSelectMock).toHaveBeenCalledWith('art-b');

    // Keyboard selection (Enter)
    const artA = screen.getByTestId('presentation-artifact-art-a');
    fireEvent.keyDown(artA, { key: 'Enter' });
    expect(onSelectMock).toHaveBeenCalledWith('art-a');

    // Keyboard selection (Space)
    fireEvent.keyDown(artB, { key: ' ' });
    expect(onSelectMock).toHaveBeenCalledTimes(3);
  });

  it('disables export button when currently selected artifact is pending or failed', () => {
    const job: PresentationJob = {
      createdAt: '2026-08-27T10:00:00Z',
      jobId: 'job-mixed-art',
      state: 'completed',
      updatedAt: '2026-08-27T10:00:10Z',
    };

    const artifacts: ArtifactSnapshot[] = [
      {
        artifactId: 'art-good',
        createdAt: '2026-08-27T10:00:05Z',
        name: 'Ready Deck.pptx',
        status: 'ready',
        type: 'presentation',
      },
      {
        artifactId: 'art-bad',
        createdAt: '2026-08-27T10:00:10Z',
        name: 'Broken Deck.pptx',
        status: 'failed',
        type: 'presentation',
      },
    ];

    const { rerender } = render(
      <PresentationPanel artifacts={artifacts} job={job} selectedArtifactId="art-good" />,
    );

    const exportBtn = screen.getByRole('button', { name: /Export Presentation Artifact/i });
    expect(exportBtn).not.toBeDisabled();

    // Switch selection to failed artifact
    rerender(<PresentationPanel artifacts={artifacts} job={job} selectedArtifactId="art-bad" />);

    expect(exportBtn).toBeDisabled();
  });

  it('disables action buttons when in-flight loading flags (cancelling, retrying, exporting) are true', () => {
    const runningJob: PresentationJob = {
      createdAt: '2026-08-27T10:00:00Z',
      jobId: 'job-load-1',
      state: 'running',
      updatedAt: '2026-08-27T10:00:05Z',
    };

    const { rerender } = render(<PresentationPanel cancelling job={runningJob} />);
    const cancelBtn = screen.getByRole('button', { name: /Cancel Presentation Job/i });
    expect(cancelBtn).toBeDisabled();

    const failedJob: PresentationJob = {
      createdAt: '2026-08-27T10:00:00Z',
      jobId: 'job-load-2',
      state: 'failed',
      updatedAt: '2026-08-27T10:00:10Z',
    };

    rerender(<PresentationPanel retrying job={failedJob} />);
    const retryBtn = screen.getByRole('button', { name: /Retry Presentation Job/i });
    expect(retryBtn).toBeDisabled();
  });

  it('supports accessibility region, radiogroup, aria-busy, and accessible names', () => {
    const runningJob: PresentationJob = {
      createdAt: '2026-08-27T10:00:00Z',
      jobId: 'job-a11y-1',
      state: 'running',
      updatedAt: '2026-08-27T10:00:05Z',
    };

    render(<PresentationPanel job={runningJob} />);

    const region = screen.getByRole('region', { name: /Presentation Status Panel/i });
    expect(region).toBeInTheDocument();
    expect(region).toHaveAttribute('aria-busy', 'true');
  });
});
