import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import RuntimeRoute from './index';

describe('Runtime Route', () => {
  it('renders RuntimeWorkspace feature component', () => {
    render(<RuntimeRoute />);
    expect(screen.getByTestId('runtime-workspace')).toBeInTheDocument();
  });
});
