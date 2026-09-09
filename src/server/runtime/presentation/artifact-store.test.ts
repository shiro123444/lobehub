import { describe, expect, it } from 'vitest';

import {
  InMemoryPresentationArtifactStore,
  PresentationArtifactStoreError,
} from './artifact-store';

const scope = { userId: 'user-1', sessionId: 'session-1' } as const;
const otherScope = { userId: 'user-2', sessionId: 'session-1' } as const;

const artifact = () => ({
  artifactId: 'artifact-1',
  bytes: new Uint8Array([0, 1, 2]),
  metadata: { source: { jobId: 'job-1', labels: ['slides'] } },
  mimeType: 'application/pdf',
  name: 'deck.pdf',
  type: 'pdf',
});

const expectError = async (operation: Promise<unknown>, code: string) => {
  await expect(operation).rejects.toMatchObject({ code, name: 'PresentationArtifactStoreError' });
};

describe('C-49 presentation artifact store', () => {
  it('stores and reads a ready artifact with size and metadata', async () => {
    const store = new InMemoryPresentationArtifactStore(() => '2026-08-29T00:00:00.000Z');
    const snapshot = await store.put(scope, artifact());

    expect(snapshot).toMatchObject({
      artifactId: 'artifact-1',
      mimeType: 'application/pdf',
      name: 'deck.pdf',
      sizeBytes: 3,
      status: 'ready',
      type: 'pdf',
    });
    expect(snapshot).not.toHaveProperty('bytes');
    await expect(store.get(scope, 'artifact-1')).resolves.toMatchObject({
      artifactId: 'artifact-1',
      bytes: new Uint8Array([0, 1, 2]),
    });
  });

  it('rejects duplicate ids, empty bytes, and invalid required fields', async () => {
    const store = new InMemoryPresentationArtifactStore();
    await store.put(scope, artifact());
    await expectError(store.put(scope, artifact()), 'ARTIFACT_DUPLICATE');
    await expectError(
      store.put(scope, { ...artifact(), artifactId: 'empty', bytes: new Uint8Array() }),
      'ARTIFACT_INVALID',
    );
    await expectError(
      store.put(scope, { ...artifact(), artifactId: 'bad-type', type: ' ' }),
      'ARTIFACT_INVALID',
    );
    await expectError(
      store.put(scope, { ...artifact(), artifactId: 'bad-mime', mimeType: '' }),
      'ARTIFACT_INVALID',
    );
    await expectError(
      store.put(scope, { ...artifact(), artifactId: 'bad-name', name: ' ' }),
      'ARTIFACT_INVALID',
    );
  });

  it('isolates reads by user and session scope', async () => {
    const store = new InMemoryPresentationArtifactStore();
    await store.put(scope, artifact());
    await expectError(store.get(otherScope, 'artifact-1'), 'ARTIFACT_SCOPE_MISMATCH');
    await expectError(store.remove(otherScope, 'artifact-1'), 'ARTIFACT_SCOPE_MISMATCH');
    await expect(store.get(otherScope, 'missing')).resolves.toBeNull();
  });

  it('returns defensive copies for bytes and nested metadata', async () => {
    const store = new InMemoryPresentationArtifactStore();
    await store.put(scope, artifact());
    const returned = await store.get(scope, 'artifact-1');
    if (!returned?.bytes) throw new Error('artifact bytes were not stored');
    returned.bytes[0] = 99;
    (returned.metadata?.source as { labels: string[] }).labels.push('mutated');

    await expect(store.get(scope, 'artifact-1')).resolves.toMatchObject({
      bytes: new Uint8Array([0, 1, 2]),
      metadata: { source: { jobId: 'job-1', labels: ['slides'] } },
    });
  });

  it('removes artifacts idempotently and exposes a stable error class', async () => {
    const store = new InMemoryPresentationArtifactStore();
    await store.put(scope, artifact());
    await expect(store.remove(scope, 'artifact-1')).resolves.toBeUndefined();
    await expect(store.remove(scope, 'artifact-1')).resolves.toBeUndefined();
    await expect(store.get(scope, 'artifact-1')).resolves.toBeNull();
    expect(PresentationArtifactStoreError).toBeDefined();
  });

  it('supports R3-A slide-level artifacts with stable metadata and listByJob query', async () => {
    const store = new InMemoryPresentationArtifactStore(() => '2026-09-03T12:00:00.000Z');

    // Register slide 1 SVG
    const slide1 = await store.put(scope, {
      artifactId: 'job-100:slide-1:svg',
      bytes: new TextEncoder().encode('<svg>slide 1</svg>'),
      metadata: { jobId: 'job-100', slideId: 'slide-1', type: 'svg' },
      mimeType: 'image/svg+xml',
      name: 'slide-1.svg',
      type: 'svg',
    });

    expect(slide1).toMatchObject({
      artifactId: 'job-100:slide-1:svg',
      metadata: {
        jobId: 'job-100',
        mimeType: 'image/svg+xml',
        slideId: 'slide-1',
        status: 'ready',
        type: 'svg',
        uri: '/api/runtime/presentation/artifacts/job-100%3Aslide-1%3Asvg',
      },
      mimeType: 'image/svg+xml',
      status: 'ready',
      type: 'svg',
      uri: '/api/runtime/presentation/artifacts/job-100%3Aslide-1%3Asvg',
    });

    // Register pending slide 2
    const slide2 = await store.put(scope, {
      artifactId: 'job-100:slide-2:svg',
      metadata: { jobId: 'job-100', slideId: 'slide-2', type: 'svg' },
      mimeType: 'image/svg+xml',
      name: 'slide-2.svg',
      status: 'pending',
      type: 'svg',
    });

    expect(slide2.status).toBe('pending');

    // Register PPTX
    await store.put(scope, {
      artifactId: 'job-100:deck:pptx',
      bytes: new Uint8Array([50, 44, 33]),
      metadata: { jobId: 'job-100', type: 'pptx' },
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      name: 'deck.pptx',
      type: 'pptx',
    });

    // Query by job
    const jobArtifacts = await store.listByJob(scope, 'job-100');
    expect(jobArtifacts).toHaveLength(3);
    expect(jobArtifacts.map((a) => a.artifactId)).toEqual([
      'job-100:slide-1:svg',
      'job-100:slide-2:svg',
      'job-100:deck:pptx',
    ]);
  });
});
