import { describe, expect, it } from 'vitest';

import { persistPresentationWorkerArtifacts } from './artifact-bridge';
import { InMemoryPresentationArtifactStore } from './artifact-store';

const scope = { userId: 'u', sessionId: 's' };
const result = {
  jobId: 'job-1',
  planId: 'plan-1',
  qualityReport: { passed: true },
  artifacts: [
    {
      bytes: new Uint8Array([1]),
      mimeType: 'x',
      name: 'a',
      type: 'pptx',
      metadata: { nested: { ok: true } },
    },
  ],
};

describe('C-55 artifact bridge', () => {
  it('persists stable ids and metadata with defensive copies/idempotence', async () => {
    const store = new InMemoryPresentationArtifactStore();
    const first = await persistPresentationWorkerArtifacts(scope, result, store);
    expect(first[0]).toMatchObject({
      artifactId: 'job-1:0',
      status: 'ready',
      metadata: { jobId: 'job-1', quality: { passed: true } },
    });
    (first[0]!.metadata!.quality as { passed: boolean }).passed = false;
    const second = await persistPresentationWorkerArtifacts(scope, result, store);
    expect(second[0]!.metadata!.quality).toEqual({ passed: true });
  });
  it('short-circuits invalid and conflicting artifacts', async () => {
    const store = new InMemoryPresentationArtifactStore();
    await expect(
      persistPresentationWorkerArtifacts(
        scope,
        {
          ...result,
          artifacts: [{ ...result.artifacts[0]!, artifactId: 'a', bytes: new Uint8Array() }],
        },
        store,
      ),
    ).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' });
    await persistPresentationWorkerArtifacts(
      scope,
      { ...result, artifacts: [{ ...result.artifacts[0]!, artifactId: 'a' }] },
      store,
    );
    await expect(
      persistPresentationWorkerArtifacts(
        scope,
        {
          ...result,
          artifacts: [{ ...result.artifacts[0]!, artifactId: 'a', bytes: new Uint8Array([2]) }],
        },
        store,
      ),
    ).rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' });
  });

  it('separately registers slide SVGs, image assets, and PPTX with stable metadata', async () => {
    const store = new InMemoryPresentationArtifactStore();
    const multiArtifactResult = {
      jobId: 'job-multi',
      planId: 'plan-multi',
      qualityReport: { passed: true, score: 99 },
      artifacts: [
        {
          artifactId: 'job-multi:deck.pptx',
          bytes: new Uint8Array([10, 20]),
          metadata: { jobId: 'job-multi' },
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          name: 'deck.pptx',
          type: 'pptx',
        },
        {
          artifactId: 'job-multi:slide-1.svg',
          bytes: new TextEncoder().encode('<svg>1</svg>'),
          metadata: { jobId: 'job-multi', slideId: 'slide-1' },
          mimeType: 'image/svg+xml',
          name: 'slide-1.svg',
          type: 'svg',
        },
        {
          artifactId: 'job-multi:hero.png',
          bytes: new Uint8Array([137, 80, 78, 71]),
          metadata: { jobId: 'job-multi', slideId: 'slide-1', slotId: 'hero' },
          mimeType: 'image/png',
          name: 'hero.png',
          type: 'image',
        },
      ],
    };

    const snapshots = await persistPresentationWorkerArtifacts(scope, multiArtifactResult, store);
    expect(snapshots).toHaveLength(3);

    // PPTX
    expect(snapshots[0]).toMatchObject({
      artifactId: 'job-multi:deck.pptx',
      metadata: {
        jobId: 'job-multi',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        status: 'ready',
        type: 'pptx',
        uri: '/api/runtime/presentation/artifacts/job-multi%3Adeck.pptx?raw=true',
      },
      status: 'ready',
      type: 'pptx',
    });

    // Slide 1 SVG
    expect(snapshots[1]).toMatchObject({
      artifactId: 'job-multi:slide-1.svg',
      metadata: {
        jobId: 'job-multi',
        mimeType: 'image/svg+xml',
        slideId: 'slide-1',
        status: 'ready',
        type: 'svg',
        uri: '/api/runtime/presentation/artifacts/job-multi%3Aslide-1.svg?raw=true',
      },
      status: 'ready',
      type: 'svg',
    });

    // Image asset
    expect(snapshots[2]).toMatchObject({
      artifactId: 'job-multi:hero.png',
      metadata: {
        jobId: 'job-multi',
        mimeType: 'image/png',
        slideId: 'slide-1',
        status: 'ready',
        type: 'image',
        uri: '/api/runtime/presentation/artifacts/job-multi%3Ahero.png?raw=true',
      },
      status: 'ready',
      type: 'image',
    });
  });
});
