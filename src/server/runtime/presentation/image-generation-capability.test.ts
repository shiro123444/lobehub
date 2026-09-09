import { describe, expect, it, vi } from 'vitest';

import type {
  AssetMetadata,
  ImageGenerationPort,
  ImageGenerationResult,
  RuntimeScope,
} from '../../../../packages/runtime-contracts/src';
import type { ImageGenerationEvent, ImageGenerationEventPublisherPort } from './asset-events';
import type { PresentationAssetSnapshot, PresentationAssetStore } from './asset-store';
import {
  createImageGenerationCapability,
  type ImageGenerationEventPublisherFactory,
} from './image-generation-capability';

const scope: RuntimeScope = { sessionId: 'session-1', userId: 'user-1' };
const otherScope: RuntimeScope = { sessionId: 'session-2', userId: 'user-1' };
const metadata: AssetMetadata = { createdAt: '2026-08-31T00:00:00.000Z', mimeType: 'image/png' };

const assetStore: PresentationAssetStore = {
  find: async () => null,
  get: async (_scope, ref) => ({ asset: { ref }, metadata }),
  getSnapshot: async (_scope, ref) => ({ asset: { ref }, metadata }),
  put: async (_scope, input): Promise<PresentationAssetSnapshot> => ({
    asset: input.asset,
    metadata: { ...metadata, ...input.metadata },
  }),
  remove: async () => {},
};

const imageResult = (scopeValue: RuntimeScope, index = 0): ImageGenerationResult => ({
  asset: {
    metadata: {
      apiKey: 'hidden-api-key',
      prompt: 'hidden prompt',
      referrer: 'safe',
    },
    ref: `asset://${scopeValue.sessionId}/${index}`,
  },
  index,
  metadata,
});

const imagePort = (
  generate: ImageGenerationPort['generate'] = async (_request, context) => [
    imageResult(context.scope),
  ],
) =>
  ({
    generate: vi.fn(generate),
    manifest: {
      displayName: 'fake',
      providerId: 'fake.image',
      supportedMimeTypes: ['image/png'],
      supportsIdempotency: true,
    },
    providerId: 'fake.image',
    resolveAsset: async () => null,
  }) satisfies ImageGenerationPort;

const publisher = (scopeValue: RuntimeScope): ImageGenerationEventPublisherPort => {
  let seq = 0;
  return {
    assertScope: vi.fn((received?: RuntimeScope) => {
      if (received?.userId !== scopeValue.userId || received?.sessionId !== scopeValue.sessionId) {
        throw Object.assign(new Error('scope mismatch'), { code: 'ASSET_SCOPE_MISMATCH' });
      }
    }),
    dispose: vi.fn(),
    publish: vi.fn(
      (input): ImageGenerationEvent => ({
        data: input.data as Record<string, unknown>,
        idempotencyKey: input.idempotencyKey ?? `event-${++seq}`,
        jobId: input.jobId,
        protocol_version: 'runtime.v1',
        scope: input.scope ?? scopeValue,
        seq: ++seq,
        type: input.type as ImageGenerationEvent['type'],
      }),
    ),
    scope: scopeValue,
  };
};

const factoryFor = (
  created: ImageGenerationEventPublisherPort[],
): ImageGenerationEventPublisherFactory =>
  vi.fn(async (scopeValue: RuntimeScope) => {
    const value = publisher(scopeValue);
    created.push(value);
    return value;
  });

describe('C-89 scope-safe image-generation capability', () => {
  it('creates a per-call planner, asserts scope, disposes publisher and redacts output', async () => {
    const created: ImageGenerationEventPublisherPort[] = [];
    const factory = factoryFor(created);
    const capability = createImageGenerationCapability({
      assetStore,
      eventPublisherFactory: factory,
      imagePort: imagePort(),
      now: () => '2026-08-31T00:00:00.000Z',
    });

    const output = await capability.generate(scope, [
      { prompt: 'private prompt', slideId: 'slide-1', slotId: 'hero' },
    ]);

    expect(factory).toHaveBeenCalledWith(scope, expect.stringMatching(/^image-generation:/));
    expect(created).toHaveLength(1);
    expect(created[0]?.assertScope).toHaveBeenCalledWith(scope);
    expect(created[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(output)).not.toContain('private prompt');
    expect(JSON.stringify(output)).not.toContain('hidden-api-key');
    expect(JSON.stringify(output)).not.toContain('bytes');
    expect(output.slots[0]?.assetRefs).toEqual([
      { metadata: { referrer: 'safe' }, ref: 'asset://session-1/0' },
    ]);
  });

  it('keeps planner and publisher state isolated across authenticated scopes', async () => {
    const created: ImageGenerationEventPublisherPort[] = [];
    const generate = vi.fn<ImageGenerationPort['generate']>(async (_request, context) => [
      imageResult(context.scope),
    ]);
    const capability = createImageGenerationCapability({
      assetStore,
      eventPublisherFactory: factoryFor(created),
      imagePort: imagePort(generate),
    });

    const first = await capability.generate(scope, [
      { prompt: 'same', slideId: 'slide-1', slotId: 'slot-1' },
    ]);
    const second = await capability.generate(otherScope, [
      { prompt: 'same', slideId: 'slide-1', slotId: 'slot-1' },
    ]);

    expect(generate).toHaveBeenCalledTimes(2);
    expect(first.scope).toEqual(scope);
    expect(second.scope).toEqual(otherScope);
    expect(first.slots[0]?.assetRefs[0]?.ref).toContain('session-1');
    expect(second.slots[0]?.assetRefs[0]?.ref).toContain('session-2');
    expect(created.every((value) => vi.mocked(value.dispose).mock.calls.length === 1)).toBe(true);
  });

  it('returns planner failures as IMAGE_UNAVAILABLE and still disposes the publisher', async () => {
    const created: ImageGenerationEventPublisherPort[] = [];
    const failingPort = imagePort(async () => {
      throw new Error('provider secret should not escape');
    });
    const capability = createImageGenerationCapability({
      assetStore,
      eventPublisherFactory: factoryFor(created),
      imagePort: failingPort,
      limits: { maxRetries: 0 },
    });

    const output = await capability.generate(scope, [
      { prompt: 'private prompt', slideId: 'slide-1', slotId: 'slot-1' },
    ]);

    expect(output.slots[0]?.state).toBe('failed');
    expect(output.slots[0]?.error?.code).toBe('IMAGE_UNAVAILABLE');
    expect(created[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(output)).not.toContain('provider secret');
  });

  it('returns cancelled slots for an already aborted signal and releases the publisher', async () => {
    const created: ImageGenerationEventPublisherPort[] = [];
    const controller = new AbortController();
    controller.abort();
    const capability = createImageGenerationCapability({
      assetStore,
      eventPublisherFactory: factoryFor(created),
      imagePort: imagePort(),
    });

    const output = await capability.generate(
      scope,
      [{ prompt: 'private prompt', slideId: 'slide-1', slotId: 'slot-1' }],
      { signal: controller.signal },
    );

    expect(output.slots[0]?.state).toBe('cancelled');
    expect(output.slots[0]?.error?.code).toBe('IMAGE_CANCELLED');
    expect(created[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('maps total image budget failure and releases the publisher', async () => {
    const created: ImageGenerationEventPublisherPort[] = [];
    const capability = createImageGenerationCapability({
      assetStore,
      eventPublisherFactory: factoryFor(created),
      imagePort: imagePort(),
      limits: { maxImages: 1 },
    });

    await expect(
      capability.generate(scope, [
        { count: 2, prompt: 'private prompt', slideId: 'slide-1', slotId: 'slot-1' },
      ]),
    ).rejects.toMatchObject({ code: 'IMAGE_BUDGET_EXCEEDED' });
    expect(created[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('rejects incomplete scope before creating a publisher', async () => {
    const factory = vi.fn<ImageGenerationEventPublisherFactory>();
    const capability = createImageGenerationCapability({
      assetStore,
      eventPublisherFactory: factory,
      imagePort: imagePort(),
    });

    await expect(
      capability.generate({ userId: 'user-1', sessionId: '' }, []),
    ).rejects.toMatchObject({ code: 'IMAGE_PLAN_INVALID', path: 'scope' });
    expect(factory).not.toHaveBeenCalled();
  });

  it('maps publisher scope failure to a stable plan error and disposes it', async () => {
    const created = publisher(otherScope);
    const factory = vi.fn<ImageGenerationEventPublisherFactory>(async () => created);
    const capability = createImageGenerationCapability({
      assetStore,
      eventPublisherFactory: factory,
      imagePort: imagePort(),
    });

    await expect(
      capability.generate(scope, [
        { prompt: 'private prompt', slideId: 'slide-1', slotId: 'slot-1' },
      ]),
    ).rejects.toMatchObject({ code: 'IMAGE_PLAN_INVALID' });
    expect(created.dispose).toHaveBeenCalledTimes(1);
  });

  it('passes an explicit jobId to the publisher factory and planner output', async () => {
    const created: ImageGenerationEventPublisherPort[] = [];
    const factory = factoryFor(created);
    const capability = createImageGenerationCapability({
      assetStore,
      eventPublisherFactory: factory,
      imagePort: imagePort(),
    });

    const output = await capability.generate(
      scope,
      [{ prompt: 'private prompt', slideId: 'slide-1', slotId: 'slot-1' }],
      { jobId: 'job-explicit-1' },
    );

    expect(factory).toHaveBeenCalledWith(scope, 'job-explicit-1');
    expect(output.jobId).toBe('job-explicit-1');
  });
});
