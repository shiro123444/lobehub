import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import QingzhouBrandLoading from './index';

describe('QingzhouBrandLoading', () => {
  it('should render loading status with accessible role and label', () => {
    render(<QingzhouBrandLoading />);
    const loadingEl = screen.getByRole('status');
    expect(loadingEl).toBeInTheDocument();
    expect(loadingEl).toHaveAttribute('aria-label', 'Qingzhou loading');
  });

  it('should render caption when provided', () => {
    render(<QingzhouBrandLoading caption="INITIALIZING..." />);
    expect(screen.getByText('INITIALIZING...')).toBeInTheDocument();
  });

  it('should support hero and compact variants', () => {
    const { rerender } = render(<QingzhouBrandLoading variant="hero" />);
    expect(screen.getByRole('status')).toBeInTheDocument();

    rerender(<QingzhouBrandLoading variant="compact" />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('should render the SVG wordmark path', () => {
    const { container } = render(<QingzhouBrandLoading />);
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute('viewBox', '0 0 795.18 135.055');
  });
});
