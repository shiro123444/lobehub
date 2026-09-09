import { describe, expect, it, vi } from 'vitest';

import type { RuntimeScope } from '../../../../packages/runtime-contracts/src';
import type { ImageGenerationCapability } from './image-generation-capability';
import {
  handleImageGenerationRequest,
  type ImageGenerationHttpResponse,
} from './image-generation-handler';
import type { ImageGenerationPlanOutput } from './image-generation-planner';

const scope: RuntimeScope = { sessionId: 'server-session', userId: 'server-user' };

const input = {
  jobId: 'image-job-1',
  slots: [
    {
      prompt: 'private prompt',
      quality: 'high',
      size: '1024x1024',
      slideId: 'slide-1',
      slotId: 'hero',
    },
  ],
};

const output = {
  jobId: 'image-job-1',
  scope,
  slots: [
    {
      assetRefs: [
        {
          metadata: {
            apiKey: 'secret-key',
            mimeType: 'image/png',
            prompt: 'private prompt',
            workspace: { path: '/private/workspace' },
          },
          ref: 'asset://server-session/image-1',
        },
      ],
      error: undefined,
      path: '/private/result',
      slideId: 'slide-1',
      slotId: 'hero',
      state: 'ready',
      bytes: new Uint8Array([1, 2]),
    },
  ],
} as unknown as ImageGenerationPlanOutput;

const requestFor = (body: unknown = input, init: RequestInit = {}): Request => {
  const method = (init.method ?? 'POST').toString().toUpperCase();
  return new Request('https://example.test/api/runtime/presentation/image-generation', {
    ...init,
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
    headers: { 'content-type': 'application/json', ...init.headers },
    method,
  });
};

const rawRequest = (body: BodyInit | null, init: RequestInit = {}): Request =>
  new Request('https://example.test/api/runtime/presentation/image-generation', {
    ...init,
    body,
    headers: { 'content-type': 'application/json', ...init.headers },
    method: 'POST',
  });

const capabilityFor = (
  generate: (
    ...args: Parameters<ImageGenerationCapability['generate']>
  ) => ReturnType<ImageGenerationCapability['generate']>,
): ImageGenerationCapability =>
  ({ generate: vi.fn(generate) }) as unknown as ImageGenerationCapability;

const json = async (response: ImageGenerationHttpResponse): Promise<Record<string, unknown>> =>
  response.body as Record<string, unknown>;

describe('C-91 image-generation HTTP handler', () => {
  it('passes only normalized slots, authenticated scope and the request signal', async () => {
    const received: {
      scope?: RuntimeScope;
      slots?: unknown;
      options?: unknown;
    } = {};
    const controller = new AbortController();
    const capability = capabilityFor(async (receivedScope, receivedSlots, options) => {
      received.scope = receivedScope;
      received.slots = receivedSlots;
      received.options = options;
      return output;
    });

    const response = await handleImageGenerationRequest(
      requestFor(
        {
          ...input,
          ignored: { apiKey: 'secret' },
          slots: [{ ...input.slots[0], ignored: 'drop-me' }],
        },
        { signal: controller.signal },
      ),
      scope,
      capability,
    );

    expect(response.status).toBe(200);
    expect(received.scope).toEqual(scope);
    expect(received.slots).toEqual(input.slots);
    expect(received.options).toEqual({ jobId: 'image-job-1', signal: controller.signal });
  });

  it('projects only scope-safe output and never returns prompt, bytes or paths', async () => {
    const capability = capabilityFor(async () => output);

    const response = await handleImageGenerationRequest(requestFor(), scope, capability);
    const body = await json(response);
    const text = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body).toEqual({
      jobId: 'image-job-1',
      scope,
      slots: [
        {
          assetRefs: [
            { metadata: { mimeType: 'image/png' }, ref: 'asset://server-session/image-1' },
          ],
          slideId: 'slide-1',
          slotId: 'hero',
          state: 'ready',
        },
      ],
    });
    expect(text).not.toContain('private prompt');
    expect(text).not.toContain('secret-key');
    expect(text).not.toContain('bytes');
    expect(text).not.toContain('workspace');
    expect(text).not.toContain('/private/result');
  });

  it.each([
    ['GET', requestFor(input, { method: 'GET' })],
    ['malformed JSON', rawRequest('{')],
    ['empty slots', requestFor({ slots: [] })],
    ['missing prompt', requestFor({ slots: [{ slideId: 'slide-1', slotId: 'hero' }] })],
    ['invalid count', requestFor({ slots: [{ ...input.slots[0], count: 0 }] })],
  ])('returns IMAGE_PLAN_INVALID for %s without capability execution', async (_name, request) => {
    const generate = vi.fn(async () => output);
    const response = await handleImageGenerationRequest(request, scope, capabilityFor(generate));

    expect(response.status).toBe(400);
    await expect(json(response)).resolves.toEqual({
      error: { code: 'IMAGE_PLAN_INVALID', message: 'Image generation request is invalid.' },
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it.each([
    ['IMAGE_PLAN_INVALID', 400],
    ['IMAGE_BUDGET_EXCEEDED', 429],
    ['IMAGE_CANCELLED', 499],
    ['IMAGE_UNAVAILABLE', 503],
  ] as const)('maps %s to HTTP %s without exposing the provider message', async (code, status) => {
    const capability = capabilityFor(async () => {
      throw Object.assign(new Error('private prompt must not escape'), { code });
    });

    const response = await handleImageGenerationRequest(requestFor(), scope, capability);
    const body = await json(response);

    expect(response.status).toBe(status);
    expect(body).toEqual({ error: { code, message: expect.any(String) } });
    expect(JSON.stringify(body)).not.toContain('private prompt');
  });

  it('returns PROVIDER_UNAVAILABLE when the capability is not configured', async () => {
    const response = await handleImageGenerationRequest(requestFor(), scope);

    expect(response.status).toBe(503);
    await expect(json(response)).resolves.toEqual({
      error: {
        code: 'PROVIDER_UNAVAILABLE',
        message: 'Image generation provider is not configured.',
      },
    });
  });

  it('fails closed when a capability result belongs to another scope', async () => {
    const capability = capabilityFor(async () => ({
      ...output,
      scope: { sessionId: 'other-session', userId: 'other-user' },
    }));

    const response = await handleImageGenerationRequest(requestFor(), scope, capability);

    expect(response.status).toBe(400);
    await expect(json(response)).resolves.toEqual({
      error: { code: 'IMAGE_PLAN_INVALID', message: 'Image generation request is invalid.' },
    });
  });

  it('forwards an already aborted request without creating a local cancellation side effect', async () => {
    const controller = new AbortController();
    controller.abort();
    const generate = vi.fn(async (_scope, _slots, options) => {
      expect(options.signal).toBe(controller.signal);
      return output;
    });

    const response = await handleImageGenerationRequest(
      requestFor(input, { signal: controller.signal }),
      scope,
      capabilityFor(generate),
    );

    expect(response.status).toBe(200);
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
