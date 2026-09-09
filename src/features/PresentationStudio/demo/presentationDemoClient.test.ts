import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PresentationJobInput } from '../../../../packages/runtime-contracts/src/index';
import { createPresentationDemoClient } from './presentationDemoClient';

const input = (): PresentationJobInput => ({
  notebookId: 'studio',
  slideCount: 3,
  sourceVersionIds: ['src-1'],
  title: 'Demo Deck',
});

describe('PresentationDemoClient (fake transport)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-30T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('walks queued → running → completed with honest states', async () => {
    const client = createPresentationDemoClient({ queuedMs: 100, runningMs: 100 });
    const job = await client.createPresentationJob(input());
    expect(job.state).toBe('queued');

    vi.advanceTimersByTime(150);
    let current = await client.getPresentationJob(job.jobId);
    expect(current?.state).toBe('running');

    vi.advanceTimersByTime(150);
    current = await client.getPresentationJob(job.jobId);
    expect(current?.state).toBe('completed');
    expect(current?.artifactIds?.length).toBe(3);
  });

  it('exposes ready SVG artifacts with data URIs and no bytes', async () => {
    const client = createPresentationDemoClient({ queuedMs: 0, runningMs: 0 });
    const job = await client.createPresentationJob(input());
    const completed = await client.getPresentationJob(job.jobId);

    const artifact = await client.getArtifact(completed?.artifactIds?.[0] ?? '');
    expect(artifact?.status).toBe('ready');
    expect(artifact?.type).toBe('svg');
    expect(artifact?.uri).toMatch(/^data:image\/svg\+xml/);
    expect(artifact?.metadata?.slideNumber).toBe(1);
  });

  it('fails honestly with a stable error and no artifacts', async () => {
    const client = createPresentationDemoClient({ fail: true, queuedMs: 0, runningMs: 0 });
    const job = await client.createPresentationJob(input());
    const failed = await client.getPresentationJob(job.jobId);

    expect(failed?.state).toBe('failed');
    expect(failed?.error?.code).toBe('PPT_MASTER_FAILED');
    expect(failed?.artifactIds).toBeUndefined();
  });

  it('cancel during running stays cancelled and is idempotent', async () => {
    const client = createPresentationDemoClient({ queuedMs: 100, runningMs: 100 });
    const job = await client.createPresentationJob(input());

    vi.advanceTimersByTime(150);
    const cancelled = await client.cancelPresentationJob(job.jobId);
    expect(cancelled.state).toBe('cancelled');

    // re-cancel keeps it cancelled, does not throw
    const again = await client.cancelPresentationJob(job.jobId);
    expect(again.state).toBe('cancelled');
  });

  it('refuses to cancel a terminal job like the real seam would', async () => {
    const client = createPresentationDemoClient({ queuedMs: 0, runningMs: 0 });
    const job = await client.createPresentationJob(input());

    await expect(client.cancelPresentationJob(job.jobId)).rejects.toThrow('INVALID_TRANSITION');
  });

  it('retry on a cancelled job restarts it, retry while running is rejected', async () => {
    const client = createPresentationDemoClient({ queuedMs: 100, runningMs: 100 });
    const job = await client.createPresentationJob(input());

    vi.advanceTimersByTime(150);
    await client.cancelPresentationJob(job.jobId);

    vi.advanceTimersByTime(50);
    const retried = await client.retryPresentationJob(job.jobId);
    expect(retried.state).toBe('queued');

    // While the retried job is running, another retry is rejected
    vi.advanceTimersByTime(150);
    await expect(client.retryPresentationJob(job.jobId)).rejects.toThrow('INVALID_TRANSITION');
  });

  it('exportArtifact refuses non-ready artifacts and returns a wire result for ready ones', async () => {
    const client = createPresentationDemoClient({ queuedMs: 0, runningMs: 0 });
    const job = await client.createPresentationJob(input());
    const completed = await client.getPresentationJob(job.jobId);
    const artifact = await client.getArtifact(completed?.artifactIds?.[0] ?? '');

    const exported = await client.exportArtifact(artifact?.artifactId ?? '', 'pptx');
    expect(exported.format).toBe('pptx');
    expect(decodeURIComponent(exported.uri ?? '')).toContain('[demo pptx]');

    await expect(client.exportArtifact('missing-artifact', 'pdf')).rejects.toThrow(
      'ARTIFACT_UNAVAILABLE',
    );
  });
});
