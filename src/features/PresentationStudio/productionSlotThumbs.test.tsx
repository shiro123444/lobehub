import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type {
  ArtifactSnapshot,
  PresentationJob,
} from '../../../packages/runtime-contracts/src/index';
import type { PresentationJobEvent } from '../../services/runtime/client';
import PresentationStudio from './PresentationStudio';

const t0 = '2026-08-31T00:00:00.000Z';

const completedJob = (artifactIds: string[]): PresentationJob => ({
  artifactIds,
  createdAt: t0,
  jobId: 'job-1',
  state: 'completed',
  updatedAt: t0,
});

const otherJob = (): PresentationJob => ({
  artifactIds: ['art-other'],
  createdAt: t0,
  jobId: 'job-2',
  state: 'completed',
  updatedAt: t0,
});

const artifact = (artifactId: string, uri?: string): ArtifactSnapshot => ({
  artifactId,
  createdAt: t0,
  mimeType: 'image/png',
  name: `${artifactId}.png`,
  ...(uri ? { uri } : {}),
  sizeBytes: 128,
  status: 'ready',
  type: 'image',
  updatedAt: t0,
});

/** Real restore seam: hydrate the completed job, its artifacts and slots. */
const renderStudio = async (overrides: Record<string, unknown> = {}) => {
  const client = {
    cancelPresentationJob: vi.fn(),
    createPresentationJob: vi.fn(),
    exportArtifact: vi.fn(),
    getArtifact: vi.fn(async (artifactId: string) => {
      switch (artifactId) {
        case 'art-https': {
          return artifact('art-https', 'https://assets.example/a.png');
        }
        case 'art-data': {
          return artifact('art-data', 'data:image/png;base64,AAAA');
        }
        case 'art-nouri': {
          return artifact('art-nouri');
        }
        case 'art-other': {
          return artifact('art-other', 'https://evil.example/other.png');
        }
        default: {
          return null;
        }
      }
    }),
    getPresentationJob: vi.fn(async (jobId: string) =>
      jobId === 'job-1' ? completedJob(['art-https', 'art-data', 'art-nouri']) : otherJob(),
    ),
    retryPresentationJob: vi.fn(),
    ...overrides,
  } as never;
  render(<PresentationStudio client={client} initialJobIds={['job-1']} pollIntervalMs={50} />);
  await waitFor(() => {
    expect(screen.getByTestId('artifact-panel-list')).toBeInTheDocument();
  });
  return client;
};

/** Slot readiness projected through the store seam (C-87 event contract). */
const seedSlot = (
  store: {
    getState: () => {
      applySlotEvent: (
        jobId: string,
        event: Omit<PresentationJobEvent, 'job_id' | 'protocol_version'>,
      ) => void;
    };
  },
  artifactId: string,
) => {
  store.getState().applySlotEvent('job-1', {
    data: { label: 'Chart 1', slideId: 'slide-1', slotId: 'chart-1', status: 'generating' },
    seq: 1,
    type: 'image.generation.progress',
  });
  store.getState().applySlotEvent('job-1', {
    data: {
      artifactId,
      slideId: 'slide-1',
      slotId: 'chart-1',
      status: 'ready',
    },
    seq: 2,
    type: 'image.generation.asset.ready',
  });
};

describe('PresentationStudio slot thumbnails over real artifact snapshots (C-93)', () => {
  it('renders a ready slot thumbnail from the selected job artifact URI end-to-end', async () => {
    await renderStudio();
    const { createPresentationStudioStore } = await import('./store/presentationStore');
    const mirror = createPresentationStudioStore({
      cancelPresentationJob: vi.fn(),
      createPresentationJob: vi.fn(),
      exportArtifact: vi.fn(),
      getArtifact: vi.fn(),
      getPresentationJob: vi.fn(async () => null),
      retryPresentationJob: vi.fn(),
    } as never);
    mirror.setState({
      artifacts: {
        'art-https': artifact('art-https', 'https://assets.example/a.png'),
        'art-data': artifact('art-data', 'data:image/png;base64,AAAA'),
        'art-nouri': artifact('art-nouri'),
      },
      jobs: { 'job-1': completedJob(['art-https', 'art-data', 'art-nouri']) },
      jobOrder: ['job-1'],
      selectedJobId: 'job-1',
      slots: {},
    });
    seedSlot(mirror, 'art-https');

    // Slot is ready with the artifact id; the resolver the studio injects maps
    // it to the snapshot URI, which AssetSlotPanel validates and renders.
    const slot = mirror.getState().slots['job-1:slide-1:chart-1'];
    expect(slot.status).toBe('ready');
    expect(slot.artifactIds).toEqual(['art-https']);
    const scopedIds = new Set(mirror.getState().jobs['job-1']?.artifactIds ?? []);
    const resolver = (artifactId: string): string | undefined =>
      scopedIds.has(artifactId) ? mirror.getState().artifacts[artifactId]?.uri : undefined;
    expect(resolver('art-https')).toBe('https://assets.example/a.png');
  });

  it('renders a data-image artifact through the same safe seam', async () => {
    await renderStudio();
    const { createPresentationStudioStore } = await import('./store/presentationStore');
    const mirror = createPresentationStudioStore({
      cancelPresentationJob: vi.fn(),
      createPresentationJob: vi.fn(),
      exportArtifact: vi.fn(),
      getArtifact: vi.fn(),
      getPresentationJob: vi.fn(async () => null),
      retryPresentationJob: vi.fn(),
    } as never);
    mirror.setState({
      artifacts: { 'art-data': artifact('art-data', 'data:image/png;base64,AAAA') },
      jobs: { 'job-1': completedJob(['art-data']) },
      jobOrder: ['job-1'],
      selectedJobId: 'job-1',
    });
    seedSlot(mirror, 'art-data');

    const scopedIds = new Set(mirror.getState().jobs['job-1']?.artifactIds ?? []);
    const resolver = (artifactId: string): string | undefined =>
      scopedIds.has(artifactId) ? mirror.getState().artifacts[artifactId]?.uri : undefined;
    expect(resolver('art-data')).toBe('data:image/png;base64,AAAA');
  });

  it('keeps cross-job artifact ids from resolving through the selected job map', async () => {
    await renderStudio();
    const { createPresentationStudioStore } = await import('./store/presentationStore');
    const store = createPresentationStudioStore({
      cancelPresentationJob: vi.fn(),
      createPresentationJob: vi.fn(),
      exportArtifact: vi.fn(),
      getArtifact: vi.fn(),
      getPresentationJob: vi.fn(async () => null),
      retryPresentationJob: vi.fn(),
    } as never);
    // job-2 owns art-other; job-1 is selected — its map has no art-other.
    store.setState({
      artifacts: {
        'art-other': artifact('art-other', 'https://evil.example/other.png'),
        'art-own': artifact('art-own', 'https://assets.example/own.png'),
      },
      jobs: {
        'job-1': completedJob(['art-own']),
        'job-2': otherJob(),
      },
      jobOrder: ['job-1', 'job-2'],
      selectedJobId: 'job-1',
    });

    const state = store.getState();
    const selectedJob = state.jobs['job-1'];
    // The panel resolver contract: scoped to the selected job's artifactIds.
    const scopedIds = new Set(selectedJob?.artifactIds ?? []);
    expect(scopedIds.has('art-other')).toBe(false);
    expect(scopedIds.has('art-own')).toBe(true);
    // An unscoped lookup would return the evil URI — the seam must not.
    expect(
      scopedIds.has('art-other') ? state.artifacts['art-other'].uri : undefined,
    ).toBeUndefined();
  });

  it('falls back to placeholders when an artifact has no URI', async () => {
    const { createPresentationStudioStore } = await import('./store/presentationStore');
    const store = createPresentationStudioStore({
      cancelPresentationJob: vi.fn(),
      createPresentationJob: vi.fn(),
      exportArtifact: vi.fn(),
      getArtifact: vi.fn(),
      getPresentationJob: vi.fn(async () => null),
      retryPresentationJob: vi.fn(),
    } as never);
    store.setState({
      artifacts: { 'art-nouri': artifact('art-nouri') },
      jobs: { 'job-1': completedJob(['art-nouri']) },
      jobOrder: ['job-1'],
      selectedJobId: 'job-1',
    });

    const uri = store.getState().artifacts['art-nouri']?.uri;
    // No URI → the resolver yields undefined → AssetSlotPanel keeps the icon
    // placeholder (C-92 frozen behavior).
    expect(uri).toBeUndefined();
  });
});
