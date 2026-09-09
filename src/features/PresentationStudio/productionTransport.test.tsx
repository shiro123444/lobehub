import { readFileSync } from 'node:fs';
import path from 'node:path';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type {
  ArtifactSnapshot,
  PresentationJob,
} from '../../../packages/runtime-contracts/src/index';
import { RuntimeClientImpl } from '../../services/runtime/client';
import PresentationStudio from './PresentationStudio';
import { createPresentationStudioStore } from './store/presentationStore';

const t0 = '2026-08-30T10:00:00.000Z';

const FIXTURE = 'src/features/PresentationStudio';

const queuedJob = (jobId: string): PresentationJob => ({
  createdAt: t0,
  jobId,
  state: 'queued',
  updatedAt: t0,
});

const artifact = (artifactId: string): ArtifactSnapshot => ({
  artifactId,
  createdAt: t0,
  status: 'ready',
  type: 'svg',
  updatedAt: t0,
});

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A real RuntimeClientImpl whose HTTP seam is the injected fetcher. */
const httpClient = (fetcher: ReturnType<typeof vi.fn>): RuntimeClientImpl =>
  new RuntimeClientImpl({ fetcher });

const typeTitle = (value: string) => {
  fireEvent.change(screen.getByLabelText('Presentation title'), { target: { value } });
};

describe('PresentationStudio production transport regression (C-78)', () => {
  it('shows the honest Runtime HTTP badge and no demo badge while streaming errors occur', () => {
    const fetcher = vi.fn(async () => jsonResponse(503, {}));
    render(<PresentationStudio client={httpClient(fetcher)} />);

    const badge = screen.getByTestId('presentation-transport-badge');
    expect(badge).toHaveTextContent('Runtime HTTP transport');
    // Demo data is never presented for the real transport seam.
    expect(screen.queryByTestId('presentation-demo-badge')).not.toBeInTheDocument();
  });

  it('surfaces provider unavailable from a real HTTP 503 JSON body without faking success', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === '/api/runtime/presentation/jobs' && init?.method === 'POST') {
        return jsonResponse(503, {
          error: { code: 'PROVIDER_UNAVAILABLE', message: 'PPT Master is not configured' },
        });
      }
      return jsonResponse(404, {});
    });
    render(<PresentationStudio client={httpClient(fetcher)} />);

    typeTitle('HTTP deck');
    fireEvent.click(screen.getByRole('button', { name: /Create Job/i }));

    const hint = await screen.findByTestId('presentation-provider-unavailable');
    expect(hint).toHaveTextContent('Presentation generation is currently unavailable');
    expect(hint).toHaveTextContent('not configured');
    expect(hint).toHaveTextContent('administrator');
    // The badge keeps telling the truth about the transport during failure.
    expect(screen.getByTestId('presentation-transport-badge')).toHaveTextContent(
      'Runtime HTTP transport',
    );
    // No fabricated progress and no fabricated job.
    expect(screen.getByTestId('studio-empty-state')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    // Recovery entry exists only because a draft exists.
    expect(screen.getByTestId('presentation-provider-resubmit')).toBeInTheDocument();
  });

  it('keeps the plain error alert for a real network failure (no provider hint)', async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    render(<PresentationStudio client={httpClient(fetcher)} />);

    typeTitle('Offline deck');
    fireEvent.click(screen.getByRole('button', { name: /Create Job/i }));

    const errorBox = await screen.findByTestId('presentation-client-error');
    expect(errorBox).toHaveTextContent('Presentation runtime error: RUNTIME_ERROR');
    expect(errorBox).toHaveTextContent('Failed to fetch');
    expect(screen.queryByTestId('presentation-provider-unavailable')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Resubmit the last presentation request/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('presentation-transport-badge')).toHaveTextContent(
      'Runtime HTTP transport',
    );
  });

  it('recovers through the real HTTP seam and dismisses the hint only on success', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(503, {
          error: { code: 'PROVIDER_UNAVAILABLE', message: 'PPT Master is not configured' },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, queuedJob('job-http-recovered')));
    render(<PresentationStudio client={httpClient(fetcher)} />);

    typeTitle('HTTP recovery deck');
    fireEvent.click(screen.getByRole('button', { name: /Create Job/i }));
    await screen.findByTestId('presentation-provider-unavailable');

    fireEvent.click(screen.getByTestId('presentation-provider-resubmit'));

    await waitFor(() => {
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByTestId('presentation-job-job-http-recovered')).toBeInTheDocument();
    });
    // Success clears the hint; the job is real HTTP data, not fabricated.
    expect(screen.queryByTestId('presentation-provider-unavailable')).not.toBeInTheDocument();
    expect(screen.getByTestId('presentation-transport-badge')).toHaveTextContent(
      'Runtime HTTP transport',
    );
  });

  it('keeps the hint and the draft when the recovery request fails over HTTP again', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === '/api/runtime/presentation/jobs' && init?.method === 'POST') {
        return jsonResponse(503, {
          error: { code: 'PROVIDER_UNAVAILABLE', message: 'still not configured' },
        });
      }
      return jsonResponse(404, {});
    });
    render(<PresentationStudio client={httpClient(fetcher)} />);

    typeTitle('HTTP retry deck');
    fireEvent.click(screen.getByRole('button', { name: /Create Job/i }));
    await screen.findByTestId('presentation-provider-unavailable');

    fireEvent.click(screen.getByTestId('presentation-provider-resubmit'));
    await waitFor(() => {
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    expect(screen.getByTestId('presentation-provider-unavailable')).toBeInTheDocument();
    expect(screen.getByLabelText('Presentation title')).toHaveValue('HTTP retry deck');
    expect(screen.getByTestId('studio-empty-state')).toBeInTheDocument();
  });

  it('shows no recovery entry without a draft and never fires the create endpoint', () => {
    const fetcher = vi.fn(async () => jsonResponse(200, {}));
    render(<PresentationStudio client={httpClient(fetcher)} />);

    expect(screen.queryByTestId('presentation-provider-resubmit')).not.toBeInTheDocument();
    expect(screen.queryByTestId('presentation-provider-unavailable')).not.toBeInTheDocument();
    // No accidental POST went out and the empty state stays honest.
    expect(fetcher).not.toHaveBeenCalled();
    expect(screen.getByTestId('studio-empty-state')).toBeInTheDocument();
  });

  it('preserves jobs, artifacts and lastSeq through a real-HTTP provider failure', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === '/api/runtime/presentation/jobs' && init?.method === 'POST') {
        return jsonResponse(503, {
          error: { code: 'PROVIDER_UNAVAILABLE', message: 'not configured' },
        });
      }
      return jsonResponse(404, {});
    });
    const store = createPresentationStudioStore(httpClient(fetcher));
    store.setState({
      artifacts: { 'art-keep': artifact('art-keep') },
      jobs: { 'job-keep': queuedJob('job-keep') },
      jobOrder: ['job-keep'],
      lastSeqByJob: { 'job-keep': 7 },
      selectedJobId: 'job-keep',
    });

    const jobId = await store.getState().createJob({
      notebookId: 'studio',
      sourceVersionIds: ['src-1'],
      title: 'Preserved deck',
    });

    expect(jobId).toBeNull();
    const state = store.getState();
    expect(state.clientError?.code).toBe('PROVIDER_UNAVAILABLE');
    expect(state.jobs['job-keep'].state).toBe('queued');
    expect(state.artifacts['art-keep'].status).toBe('ready');
    expect(state.lastSeqByJob['job-keep']).toBe(7);
    expect(state.jobOrder).toEqual(['job-keep']);
    expect(state.selectedJobId).toBe('job-keep');
  });

  it('keeps the reduced-motion styling contract alongside the production hint', () => {
    const styles = readFileSync(path.join(process.cwd(), FIXTURE, 'style.ts'), 'utf8');
    expect(styles).toContain('prefers-reduced-motion: reduce');
  });
});
