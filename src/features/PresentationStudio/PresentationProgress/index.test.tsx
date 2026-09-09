import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PresentationJob } from '../../../../packages/runtime-contracts/src/index';
import PresentationProgress from './index';

const job = (state: PresentationJob['state']): PresentationJob => ({
  createdAt: '2026-08-30T10:00:00.000Z',
  error:
    state === 'failed' ? { code: 'PPT_MASTER_FAILED', message: 'provider unavailable' } : undefined,
  jobId: 'job-a',
  state,
  updatedAt: '2026-08-30T10:05:00.000Z',
});

describe('PresentationProgress', () => {
  it('shows the queued announcement and a cancel action for queued jobs', () => {
    render(<PresentationProgress job={job('queued')} streamStatus="polling" />);

    expect(screen.getByRole('status')).toHaveTextContent('任务排队中');
    expect(screen.queryByText('轮询模式')).not.toBeInTheDocument();
    expect(screen.queryByText('polling')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cancel presentation job/i })).toBeInTheDocument();
  });

  it('shows running progress and a cancel action for running jobs', () => {
    render(<PresentationProgress job={job('running')} />);

    expect(screen.getByRole('status')).toHaveTextContent('正在生成幻灯片');
    expect(screen.getByRole('button', { name: /Cancel presentation job/i })).toBeInTheDocument();
  });

  it('completed jobs expose no cancel/retry and announce ready artifacts', () => {
    render(<PresentationProgress job={job('completed')} />);

    expect(screen.getByRole('status')).toHaveTextContent('已完成');
    expect(
      screen.queryByRole('button', { name: /Cancel presentation job/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Retry presentation job/i }),
    ).not.toBeInTheDocument();
  });

  it('failed jobs expose the honest error detail and a retry action', async () => {
    const onRetry = vi.fn();
    render(<PresentationProgress job={job('failed')} onRetry={onRetry} />);

    expect(screen.getByTestId('presentation-job-error')).toHaveTextContent('PPT_MASTER_FAILED');
    expect(screen.getByRole('button', { name: /Retry presentation job/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Retry presentation job/i }));
    expect(onRetry).toHaveBeenCalledWith('job-a');
  });

  it('cancelled jobs expose a retry action and no cancel', () => {
    render(<PresentationProgress job={job('cancelled')} />);

    expect(screen.getByRole('button', { name: /Retry presentation job/i })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Cancel presentation job/i }),
    ).not.toBeInTheDocument();
  });

  it('disables cancel while the cancel action is in flight', () => {
    render(<PresentationProgress busyState="cancel" job={job('running')} />);

    const cancel = screen.getByRole('button', { name: /Cancel presentation job/i });
    expect(cancel).toBeDisabled();
  });

  it('disables retry while the retry action is in flight', () => {
    render(<PresentationProgress busyState="retry" job={job('failed')} />);

    const retry = screen.getByRole('button', { name: /Retry presentation job/i });
    expect(retry).toBeDisabled();
  });
});
