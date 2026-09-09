import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import PresentationStudioRoute from './index';

describe('Presentation Route', () => {
  it('renders the PresentationStudio feature component (thin shell)', () => {
    render(<PresentationStudioRoute />);
    expect(screen.getByTestId('presentation-studio')).toBeInTheDocument();
    expect(screen.getByTestId('studio-empty-state')).toBeInTheDocument();
  });
});
