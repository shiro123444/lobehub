import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ArtifactSnapshot } from '../../../../packages/runtime-contracts/src/index';
import SlidePreview from './index';

const artifact = (status: ArtifactSnapshot['status'], withUri = true): ArtifactSnapshot => ({
  artifactId: 's-1',
  createdAt: '2026-08-30T10:01:00.000Z',
  mimeType: 'image/svg+xml',
  name: 'Slide 1.svg',
  sizeBytes: 100,
  status,
  type: 'svg',
  updatedAt: '2026-08-30T10:01:00.000Z',
  uri: withUri ? 'data:image/svg+xml,test' : undefined,
});

describe('SlidePreview', () => {
  it('renders the ready SVG through an image with the artifact uri', () => {
    render(<SlidePreview artifact={artifact('ready')} />);

    expect(screen.getByTestId('slide-preview-image')).toHaveAttribute(
      'src',
      'data:image/svg+xml,test',
    );
  });

  it('shows an honest empty state for failed artifacts — no fake preview', () => {
    render(<SlidePreview artifact={artifact('failed', false)} />);

    expect(screen.getByTestId('slide-preview-empty')).toHaveTextContent('Artifact is failed');
    expect(screen.queryByTestId('slide-preview-image')).not.toBeInTheDocument();
  });

  it('shows an empty state when nothing is selected', () => {
    render(<SlidePreview artifact={null} />);

    expect(screen.getByTestId('slide-preview-empty')).toHaveTextContent('Select a ready slide');
  });
});
