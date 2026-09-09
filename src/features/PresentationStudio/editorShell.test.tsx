import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type {
  ArtifactSnapshot,
  PresentationJob,
} from '../../../packages/runtime-contracts/src/index';
import PresentationStudio from './PresentationStudio';

const t0 = '2026-08-30T10:00:00.000Z';

const completedJob = (artifactIds: string[]): PresentationJob => ({
  artifactIds,
  createdAt: t0,
  jobId: 'job-done',
  state: 'completed',
  updatedAt: t0,
});

const slide = (artifactId: string, n: number): ArtifactSnapshot => ({
  artifactId,
  createdAt: t0,
  metadata: { slideNumber: n },
  mimeType: 'image/svg+xml',
  name: `Slide ${n}.svg`,
  sizeBytes: 256,
  status: 'ready',
  type: 'svg',
  updatedAt: t0,
  uri: `data:image/svg+xml,sample-${n}`,
});

describe('PresentationStudio completed editor shell (C-106)', () => {
  it('renders the top Chinese toolbar with AI iteration, regenerate, and quick export when completed', async () => {
    const retryPresentationJob = vi.fn();
    const exportArtifact = vi.fn(async () => ({
      artifactId: 'slide-1',
      format: 'pptx',
      uri: 'blob:https://studio/export-pptx',
    }));

    const client = {
      cancelPresentationJob: vi.fn(),
      createPresentationJob: vi.fn(),
      exportArtifact,
      getArtifact: vi.fn(async (artifactId: string) =>
        artifactId === 'slide-1' ? slide('slide-1', 1) : slide('slide-2', 2),
      ),
      getPresentationJob: vi.fn(async (jobId: string) =>
        jobId === 'job-done' ? completedJob(['slide-1', 'slide-2']) : null,
      ),
      retryPresentationJob,
      subscribePresentationJob: vi.fn(),
    };

    render(
      <PresentationStudio
        client={client as never}
        initialJobIds={['job-done']}
        pollIntervalMs={50}
      />,
    );

    // Toolbar appears for completed job
    await waitFor(() => {
      expect(screen.getByTestId('presentation-editor-toolbar')).toBeInTheDocument();
    });

    expect(screen.getByTestId('presentation-completed-tag')).toHaveTextContent('已完成');
    expect(screen.getByRole('button', { name: /Continue prompting AI/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry presentation job/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Quick export presentation/i })).toBeInTheDocument();

    // Slide canvas & preview are present with real SVG
    expect(screen.getByTestId('slide-preview-image')).toHaveAttribute(
      'src',
      'data:image/svg+xml,sample-1',
    );
    expect(screen.getByTestId('slide-navigator-grid')).toBeInTheDocument();
    expect(screen.getByTestId('artifact-panel-list')).toBeInTheDocument();

    // Trigger regenerate from editor toolbar
    fireEvent.click(screen.getByRole('button', { name: /Retry presentation job/i }));
    expect(retryPresentationJob).toHaveBeenCalledWith('job-done');

    // Trigger quick export
    fireEvent.click(screen.getByRole('button', { name: /Quick export presentation/i }));
    await waitFor(() => {
      expect(exportArtifact).toHaveBeenCalledWith('slide-1', 'pptx');
    });
  }, 15000);

  it('supports AI modification prompt input in the popover', async () => {
    const createPresentationJob = vi.fn(async () => completedJob([]));
    const client = {
      cancelPresentationJob: vi.fn(),
      createPresentationJob,
      exportArtifact: vi.fn(),
      getArtifact: vi.fn(async () => slide('slide-1', 1)),
      getPresentationJob: vi.fn(async (jobId: string) =>
        jobId === 'job-done' ? completedJob(['slide-1']) : null,
      ),
      retryPresentationJob: vi.fn(),
      subscribePresentationJob: vi.fn(),
    };

    render(
      <PresentationStudio
        client={client as never}
        initialJobIds={['job-done']}
        pollIntervalMs={50}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('presentation-editor-toolbar')).toBeInTheDocument();
    });

    // Open AI modify popover
    fireEvent.click(screen.getByRole('button', { name: /Continue prompting AI/i }));
    expect(screen.getByPlaceholderText(/请输入修改要求/)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/请输入修改要求/), {
      target: { value: '配色调整为科技蓝，精简第二页' },
    });

    fireEvent.click(screen.getByRole('button', { name: /提交修改/ }));
    await waitFor(() => {
      expect(createPresentationJob).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('配色调整为科技蓝'),
        }),
      );
    });
  }, 15000);
});
