import { describe, expect, it, vi } from 'vitest';

import { IMAGE_GENERATION_EVENT_TYPES } from './asset-events';
import { createPresentationImageGenerationEventPublisher } from './image-event-bridge';

describe('presentation image event bridge', () => {
  it('publishes a slot-ready event and a previewable presentation artifact', () => {
    let seq = 0;
    const publish = vi.fn((input: any) => ({
      data: input.data,
      job_id: input.jobId,
      protocol_version: 'runtime.v1' as const,
      seq: ++seq,
      type: input.type,
    }));
    const bridge = createPresentationImageGenerationEventPublisher({
      publisher: { assertScope: vi.fn(), dispose: vi.fn(), publish } as any,
      scope: { sessionId: 'session-a', userId: 'user-a' },
    });

    const event = bridge.publish({
      data: {
        asset: { ref: 'https://cdn.example.com/generated.png' },
        metadata: { createdAt: '2026-09-04T00:00:00.000Z', mimeType: 'image/png' },
        slideId: 'slide-2',
        slotId: 'hero-visual',
      },
      idempotencyKey: 'slot:slide-2:hero-visual:ready',
      jobId: 'job-a',
      scope: { sessionId: 'session-a', userId: 'user-a' },
      type: IMAGE_GENERATION_EVENT_TYPES.assetReady,
    });

    expect(event.type).toBe(IMAGE_GENERATION_EVENT_TYPES.assetReady);
    expect(publish).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          artifactId: 'https://cdn.example.com/generated.png',
          slideId: 'slide-2',
          slotId: 'hero-visual',
          status: 'ready',
        }),
        type: IMAGE_GENERATION_EVENT_TYPES.assetReady,
      }),
    );
    expect(publish).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          artifact: expect.objectContaining({
            artifactId: 'https://cdn.example.com/generated.png',
            status: 'ready',
            type: 'image',
            uri: 'https://cdn.example.com/generated.png',
          }),
        }),
        type: 'presentation.job.artifact.ready',
      }),
    );
  });
});
