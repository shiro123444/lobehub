import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PresentationJobInput } from '../../../../packages/runtime-contracts/src/index';
import PresentationComposer from './index';

const buildInput = () =>
  expect.objectContaining({
    language: 'zh-CN',
    notebookId: 'studio',
    slideCount: 10,
    title: 'Q3 Report',
  });

describe('PresentationComposer', () => {
  it('renders labelled fields for a11y', () => {
    render(<PresentationComposer onCreate={vi.fn()} />);

    expect(screen.getByLabelText('Presentation title')).toBeInTheDocument();
    expect(screen.getByLabelText('Presentation prompt')).toBeInTheDocument();
    expect(screen.getByLabelText('Slide count')).toBeInTheDocument();
    expect(screen.getByLabelText('Aspect ratio')).toBeInTheDocument();
    expect(screen.getByLabelText('Output language')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create Job/i })).toBeInTheDocument();
  });

  it('blocks creation without a title and announces the validation error', async () => {
    const onCreate = vi.fn(async () => 'job-1');
    render(<PresentationComposer onCreate={onCreate} />);

    fireEvent.click(screen.getByRole('button', { name: /Create Job/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Title is required');
    });
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('submits a well-formed PresentationJobInput and clears the prompt afterwards', async () => {
    const onCreate = vi.fn(async (_input: PresentationJobInput) => 'job-1');
    render(<PresentationComposer onCreate={onCreate} />);

    fireEvent.change(screen.getByLabelText('Presentation title'), {
      target: { value: 'Q3 Report' },
    });
    fireEvent.change(screen.getByLabelText('Presentation prompt'), {
      target: { value: 'A quarterly overview' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Create Job/i }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(buildInput()));
    const input = onCreate.mock.calls[0][0] as PresentationJobInput;
    expect(input.prompt).toBe('A quarterly overview');
    expect(input.sourceVersionIds).toEqual([]);
    expect(screen.getByLabelText('Presentation prompt')).toHaveValue('');
  });

  it('keeps the title when the transport fails', async () => {
    const onCreate = vi.fn(async () => null);
    render(<PresentationComposer onCreate={onCreate} />);

    fireEvent.change(screen.getByLabelText('Presentation title'), {
      target: { value: 'Q3 Report' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create Job/i }));

    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(screen.getByLabelText('Presentation title')).toHaveValue('Q3 Report');
  });

  it('shows aria-busy while the create request is in flight', async () => {
    let resolveCreate: (jobId: string) => void = () => undefined;
    const onCreate = vi.fn(() => new Promise<string>((resolve) => (resolveCreate = resolve)));
    render(<PresentationComposer onCreate={onCreate} />);

    fireEvent.change(screen.getByLabelText('Presentation title'), {
      target: { value: 'Q3 Report' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create Job/i }));

    const button = screen.getByRole('button', { name: /Create Job/i });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toBeDisabled();

    await waitFor(() => resolveCreate('job-1'));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    await waitFor(() => expect(button).not.toBeDisabled());
  });
});
