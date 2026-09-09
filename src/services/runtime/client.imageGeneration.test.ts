import { describe, expect, it, vi } from 'vitest';

import type { CreateImageGenerationInput } from './client';
import { RuntimeClientImpl } from './client';
import { createImageGenerationEndpointContract } from './client.imageGeneration.test-utils';

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const acceptedBody = {
  jobId: 'job-1',
  slots: [{ slideId: 'slide-1', slotId: 'chart-1', status: 'accepted' }],
};

const input = (): CreateImageGenerationInput => ({
  jobId: 'job-1',
  slots: [
    {
      idempotencyKey: 'job-1:slide-1:chart-1',
      slideId: 'slide-1',
      slotId: 'chart-1',
    },
  ],
});

describe('RuntimeClientImpl.createImageGeneration (C-96)', () => {
  it('POSTs job/slot identifiers to the image-generation endpoint and echoes acceptance', async () => {
    const fetcher = vi.fn(async () => jsonResponse(202, acceptedBody));
    const client = new RuntimeClientImpl({ fetcher });

    const result = await client.createImageGeneration(input());

    expect(fetcher).toHaveBeenCalledWith(
      '/api/runtime/presentation/image-generation?jobId=job-1',
      expect.objectContaining({ method: 'POST' }),
    );
    // The wire body carries only job/slot identifiers — no scope fields.
    const call = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(call[1].body));
    expect(body).toEqual(input());
    expect(Object.keys(body)).toEqual(['jobId', 'slots']);
    expect(result.jobId).toBe('job-1');
    expect(result.slots[0].status).toBe('accepted');
    expect(createImageGenerationEndpointContract).toContain('image-generation');
  });

  it('maps 401/4xx/503 to structured prompt-free errors', async () => {
    for (const status of [400, 401, 403, 503]) {
      const fetcher = vi.fn(async () =>
        jsonResponse(status, {
          error: { code: 'IMAGE_PROVIDER_REJECTED', message: 'down' },
        }),
      );
      const client = new RuntimeClientImpl({ fetcher });
      await expect(client.createImageGeneration(input())).rejects.toThrow(
        `Failed to create image generation (${status}`,
      );
      const message = await client
        .createImageGeneration(input())
        .catch((err: Error) => err.message);
      expect(message).not.toContain('prompt');
      expect(message).toContain('IMAGE_PROVIDER_REJECTED');
    }
  });

  it('forwards an AbortSignal to the underlying fetch', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return jsonResponse(202, acceptedBody);
    });
    const client = new RuntimeClientImpl({ fetcher });
    const controller = new AbortController();
    await client.createImageGeneration(input(), { signal: controller.signal });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('encodes the jobId into the query string safely', async () => {
    const fetcher = vi.fn(async () => jsonResponse(202, acceptedBody));
    const client = new RuntimeClientImpl({ fetcher });
    await client.createImageGeneration({ jobId: 'job id/with spaces', slots: [] });
    expect(fetcher).toHaveBeenCalledWith(
      '/api/runtime/presentation/image-generation?jobId=job%20id%2Fwith%20spaces',
      expect.anything(),
    );
  });
});
