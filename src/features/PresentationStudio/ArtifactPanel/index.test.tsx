import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ArtifactSnapshot } from '../../../../packages/runtime-contracts/src/index';
import ArtifactPanel from './index';

const artifact = (
  artifactId: string,
  status: ArtifactSnapshot['status'] = 'ready',
  type = 'svg',
): ArtifactSnapshot => ({
  artifactId,
  createdAt: '2026-08-30T10:01:00.000Z',
  mimeType: type === 'svg' ? 'image/svg+xml' : 'application/octet-stream',
  name: `${artifactId}.${type}`,
  sizeBytes: 4096,
  status,
  type,
  updatedAt: '2026-08-30T10:01:00.000Z',
  uri: status === 'ready' ? `data:${type},test` : undefined,
});

describe('ArtifactPanel', () => {
  it('lists every artifact, keeps failed ones visible and excludes them from selection', () => {
    const onSelect = vi.fn();
    render(
      <ArtifactPanel
        artifacts={[artifact('a-pptx', 'ready', 'pptx'), artifact('a-svg', 'failed', 'svg')]}
        jobState="completed"
        selectedArtifactId="a-pptx"
        onExport={vi.fn()}
        onSelect={onSelect}
      />,
    );

    expect(screen.getByTestId('artifact-card-a-pptx')).toBeInTheDocument();
    expect(screen.getByTestId('artifact-card-a-svg')).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();

    const failed = screen.getByTestId('artifact-card-a-svg');
    expect(failed).toHaveAttribute('aria-disabled', 'true');

    fireEvent.click(failed);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('selects ready artifacts via click and keyboard', () => {
    const onSelect = vi.fn();
    render(
      <ArtifactPanel
        artifacts={[artifact('a-1'), artifact('a-2')]}
        jobState="completed"
        selectedArtifactId="a-1"
        onExport={vi.fn()}
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByTestId('artifact-card-a-2'));
    expect(onSelect).toHaveBeenCalledWith('a-2');

    fireEvent.keyDown(screen.getByTestId('artifact-card-a-1'), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('a-1');
  });

  it('disables export when the job has not completed', () => {
    render(
      <ArtifactPanel
        artifacts={[artifact('a-1')]}
        jobState="running"
        selectedArtifactId="a-1"
        onExport={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    const exportButton = screen.getByRole('button', { name: /Export presentation artifact/i });
    expect(exportButton).toBeDisabled();
  });

  it('disables export for a failed selected artifact even on completed jobs', () => {
    render(
      <ArtifactPanel
        artifacts={[artifact('a-failed', 'failed')]}
        jobState="completed"
        selectedArtifactId="a-failed"
        onExport={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    const exportButton = screen.getByRole('button', { name: /Export presentation artifact/i });
    expect(exportButton).toBeDisabled();
    expect(screen.getByText(/No ready artifacts/i)).toBeInTheDocument();
  });

  it('exports the selected ready artifact in pptx format through the menu', async () => {
    const onExport = vi.fn();
    render(
      <ArtifactPanel
        artifacts={[artifact('a-1', 'ready', 'svg')]}
        jobState="completed"
        selectedArtifactId="a-1"
        onExport={onExport}
        onSelect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Export presentation artifact/i }));

    const menuItem = await screen.findByText('Export PowerPoint (.pptx)');
    fireEvent.click(menuItem.closest('li') ?? menuItem);

    await waitFor(() => expect(onExport).toHaveBeenCalledWith('a-1', 'pptx'));
  });

  it('renders the honest empty state before any artifact exists', () => {
    render(
      <ArtifactPanel
        artifacts={[]}
        jobState="queued"
        selectedArtifactId={null}
        onExport={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByTestId('artifact-panel-empty')).toHaveTextContent(
      'Artifacts will appear here',
    );
  });
});
