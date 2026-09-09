import { describe, expect, it, vi } from 'vitest';

import type {
  AssetMetadata,
  AssetRef,
  ImageGenerationPort,
  ImageGenerationResult,
  RuntimeScope,
  SlideScene,
} from '../../../../packages/runtime-contracts/src';
import {
  IMAGE_GENERATION_EVENT_TYPES,
  type ImageGenerationEvent,
  ImageGenerationEventPublisher,
  type ImageGenerationEventPublisherPort,
  type ImageGenerationEventPublishInput,
  InMemoryImageGenerationEventJournal,
} from './asset-events';
import { InMemoryPresentationAssetStore } from './asset-store';
import {
  createImageGenerationCapability,
  type ImageGenerationCapability,
  type ImageGenerationEventPublisherFactory,
} from './image-generation-capability';
import { type PresentationJobEvent, PresentationJobEventJournal } from './job-event-journal';
import { createSceneRenderer } from './scene-renderer';
import { createPresentationJobEventSseResponse } from './sse';

const now = '2026-09-01T00:00:00.000Z';
const scopeA: RuntimeScope = { sessionId: 'session-a', userId: 'user-a' };
const scopeB: RuntimeScope = { sessionId: 'session-b', userId: 'user-b' };

const scopeKey = (scope: RuntimeScope): string => `${scope.userId}:${scope.sessionId}`;

const slot = (slideId = 'slide-1', slotId = 'hero', prompt = 'private image prompt') => ({
  prompt,
  slideId,
  slotId,
});

const sceneFor = (asset: AssetRef): SlideScene => ({
  canvas: { height: 1080, width: 1920 },
  nodes: [
    {
      asset,
      id: 'generated-image',
      kind: 'image',
      rect: { height: 400, width: 600, x: 100, y: 100 },
      zIndex: 0,
    },
  ],
  sceneId: 'slide-1',
});

const readSse = async (events: readonly PresentationJobEvent[], afterSeq = -1): Promise<string> => {
  const controller = new AbortController();
  const response = createPresentationJobEventSseResponse(
    events,
    controller.signal,
    { heartbeatIntervalMs: 60_000 },
    afterSeq,
  );
  const reader = response.body.getReader();
  const expected = events.filter((event) => event.seq > afterSeq).length;
  const chunks: string[] = [];
  for (let index = 0; index < expected; index += 1) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(new TextDecoder().decode(result.value));
  }
  controller.abort();
  await reader.cancel();
  return chunks.join('');
};

interface ImageGenerationIntegrationHarness {
  readonly assetStore: InMemoryPresentationAssetStore;
  readonly capability: ImageGenerationCapability;
  readonly eventPublisherFactory: ImageGenerationEventPublisherFactory;
  readonly imageJournals: Map<string, InMemoryImageGenerationEventJournal>;
  readonly imagePort: ImageGenerationPort & {
    readonly generate: ReturnType<typeof vi.fn>;
  };
  readonly jobJournals: Map<string, PresentationJobEventJournal>;
  readonly publishers: ImageGenerationEventPublisherPort[];
}

const createHarness = (
  providerGenerate?: ImageGenerationPort['generate'],
): ImageGenerationIntegrationHarness => {
  let assetIndex = 0;
  const defaultGenerate = async (
    _request: Parameters<ImageGenerationPort['generate']>[0],
    context: Parameters<ImageGenerationPort['generate']>[1],
  ): Promise<ImageGenerationResult[]> => {
    assetIndex += 1;
    const assetId = `${context.scope.userId}-${context.scope.sessionId}-${assetIndex}`;
    const metadata: AssetMetadata = {
      assetId,
      createdAt: now,
      mimeType: 'image/png',
      providerMetadata: { apiKey: 'must-not-escape', model: 'fake.image' },
      sizeBytes: 3,
    };
    return [
      {
        asset: { ref: `asset://generated/${assetId}` },
        index: 0,
        metadata,
      },
    ];
  };

  const imagePort = {
    generate: vi.fn(providerGenerate ?? defaultGenerate),
    manifest: {
      displayName: 'Fake image provider',
      providerId: 'fake.image',
      supportedMimeTypes: ['image/png'],
      supportsIdempotency: true,
    },
    providerId: 'fake.image',
    resolveAsset: async () => null,
  } satisfies ImageGenerationPort;
  const assetStore = new InMemoryPresentationAssetStore({ now: () => now });
  const imageJournals = new Map<string, InMemoryImageGenerationEventJournal>();
  const jobJournals = new Map<string, PresentationJobEventJournal>();
  const publishers: ImageGenerationEventPublisherPort[] = [];

  const eventPublisherFactory = vi.fn<ImageGenerationEventPublisherFactory>(
    async (scope, jobId) => {
      const key = scopeKey(scope);
      const imageJournal =
        imageJournals.get(key) ?? new InMemoryImageGenerationEventJournal({ scope });
      imageJournals.set(key, imageJournal);
      const jobJournal = jobJournals.get(key) ?? new PresentationJobEventJournal({ scope });
      jobJournals.set(key, jobJournal);
      const basePublisher = new ImageGenerationEventPublisher({
        journal: imageJournal,
        scope,
      });
      const publish = vi.fn((input: ImageGenerationEventPublishInput): ImageGenerationEvent => {
        const event = basePublisher.publish(input);
        jobJournal.append(jobId, {
          data: event.data,
          job_id: event.jobId,
          protocol_version: event.protocol_version,
          seq: event.seq,
          type: event.type,
        });
        return event;
      });
      const dispose = vi.fn(() => basePublisher.dispose());
      const publisher: ImageGenerationEventPublisherPort = {
        assertScope: basePublisher.assertScope.bind(basePublisher),
        dispose,
        publish,
        scope,
      };
      publishers.push(publisher);
      return publisher;
    },
  );

  const capability = createImageGenerationCapability({
    assetStore,
    eventPublisherFactory,
    imagePort,
    limits: { maxRetries: 0 },
    now: () => now,
  });

  return {
    assetStore,
    capability,
    eventPublisherFactory,
    imageJournals,
    imagePort,
    jobJournals,
    publishers,
  };
};

const imageEventsFor = (
  harness: ImageGenerationIntegrationHarness,
  scope: RuntimeScope,
  jobId: string,
): ImageGenerationEvent[] => harness.imageJournals.get(scopeKey(scope))!.replay(jobId);

const jobEventsFor = (
  harness: ImageGenerationIntegrationHarness,
  scope: RuntimeScope,
  jobId: string,
): PresentationJobEvent[] => harness.jobJournals.get(scopeKey(scope))!.replay(jobId);

describe('C-95 fake image-generation full-chain integration', () => {
  it('runs provider → capability → events → SSE replay → slot output → scene renderer', async () => {
    const harness = createHarness();
    const output = await harness.capability.generate(scopeA, [slot()], { jobId: 'job-a' });
    const generated = output.slots[0]!;
    const imageEvents = imageEventsFor(harness, scopeA, 'job-a');

    expect(generated).toMatchObject({ slideId: 'slide-1', slotId: 'hero', state: 'ready' });
    expect(generated.assetRefs).toHaveLength(1);
    expect(imageEvents.map((event) => event.type)).toEqual([
      IMAGE_GENERATION_EVENT_TYPES.accepted,
      IMAGE_GENERATION_EVENT_TYPES.started,
      IMAGE_GENERATION_EVENT_TYPES.progress,
      IMAGE_GENERATION_EVENT_TYPES.assetReady,
    ]);
    expect(imageEvents.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(imageEvents.every((event) => scopeKey(event.scope) === scopeKey(scopeA))).toBe(true);

    const sse = await readSse(jobEventsFor(harness, scopeA, 'job-a'), 1);
    expect(sse).toContain('id: 2');
    expect(sse).toContain('id: 4');
    expect(sse).toContain('image.generation.asset.ready');
    expect(sse).not.toContain('private image prompt');
    expect(sse).not.toContain('must-not-escape');

    const asset = generated.assetRefs[0]!;
    const resolveAssetUri = vi.fn(async (receivedScope: RuntimeScope, ref: AssetRef) => {
      const stored = await harness.assetStore.getSnapshot(receivedScope, ref.ref);
      return `https://assets.test/${encodeURIComponent(stored.asset.ref)}`;
    });
    const renderer = createSceneRenderer({ resolveAssetUri });
    const svg = await renderer.renderSvg(sceneFor(asset), { scope: scopeA });

    expect(svg).toContain('<image');
    expect(svg).toContain('https://assets.test/asset%3A%2F%2Fgenerated%2F');
    expect(resolveAssetUri).toHaveBeenCalledWith(scopeA, asset);
    expect(harness.publishers[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('replays after_seq and filters duplicate or stale event sequences', async () => {
    const harness = createHarness();
    await harness.capability.generate(scopeA, [slot()], { jobId: 'job-seq' });
    const journal = harness.imageJournals.get(scopeKey(scopeA))!;
    const events = imageEventsFor(harness, scopeA, 'job-seq');
    const second = events[1]!;

    expect(journal.append({ ...second })).toEqual(second);
    expect(journal.append({ ...second, idempotencyKey: 'stale-copy' })).toBeUndefined();
    expect(journal.replay('job-seq').map((event) => event.seq)).toEqual([1, 2, 3, 4]);

    const sse = await readSse(jobEventsFor(harness, scopeA, 'job-seq'), 2);
    expect(sse).not.toContain('id: 1');
    expect(sse).not.toContain('id: 2');
    expect(sse).toContain('id: 3');
    expect(sse).toContain('id: 4');
  });

  it('isolates concurrent authenticated scopes and their asset/event journals', async () => {
    const harness = createHarness();
    const [first, second] = await Promise.all([
      harness.capability.generate(scopeA, [slot()], { jobId: 'job-a' }),
      harness.capability.generate(scopeB, [slot()], { jobId: 'job-b' }),
    ]);
    const firstRef = first.slots[0]!.assetRefs[0]!.ref;
    const secondRef = second.slots[0]!.assetRefs[0]!.ref;

    expect(first.scope).toEqual(scopeA);
    expect(second.scope).toEqual(scopeB);
    expect(firstRef).not.toBe(secondRef);
    expect(harness.imageJournals.get(scopeKey(scopeA))).not.toBe(
      harness.imageJournals.get(scopeKey(scopeB)),
    );
    expect(jobEventsFor(harness, scopeA, 'job-a').every((event) => event.job_id === 'job-a')).toBe(
      true,
    );
    expect(jobEventsFor(harness, scopeB, 'job-b').every((event) => event.job_id === 'job-b')).toBe(
      true,
    );
    await expect(harness.assetStore.get(scopeB, firstRef)).rejects.toMatchObject({
      code: 'ASSET_SCOPE_MISMATCH',
    });
    await expect(harness.assetStore.get(scopeA, secondRef)).rejects.toMatchObject({
      code: 'ASSET_SCOPE_MISMATCH',
    });
  });

  it('keeps provider failure as a failed slot and publishes no ready event', async () => {
    const harness = createHarness(async () => {
      throw Object.assign(new Error('provider secret must stay private'), {
        code: 'IMAGE_UNAVAILABLE',
      });
    });
    const output = await harness.capability.generate(scopeA, [slot()], { jobId: 'job-failed' });
    const imageEvents = imageEventsFor(harness, scopeA, 'job-failed');
    const sse = await readSse(jobEventsFor(harness, scopeA, 'job-failed'));

    expect(output.slots[0]).toMatchObject({
      assetRefs: [],
      error: { code: 'IMAGE_UNAVAILABLE' },
      state: 'failed',
    });
    expect(imageEvents.map((event) => event.type)).toEqual([
      IMAGE_GENERATION_EVENT_TYPES.accepted,
      IMAGE_GENERATION_EVENT_TYPES.started,
      IMAGE_GENERATION_EVENT_TYPES.failed,
    ]);
    expect(
      imageEvents.some((event) => event.type === IMAGE_GENERATION_EVENT_TYPES.assetReady),
    ).toBe(false);
    expect(JSON.stringify(output)).not.toContain('provider secret must stay private');
    expect(sse).not.toContain('provider secret must stay private');
  });

  it('returns cancelled slot state without invoking the fake provider', async () => {
    const harness = createHarness();
    const controller = new AbortController();
    controller.abort();

    const output = await harness.capability.generate(scopeA, [slot()], {
      jobId: 'job-cancelled',
      signal: controller.signal,
    });
    const imageEvents = imageEventsFor(harness, scopeA, 'job-cancelled');

    expect(output.slots[0]).toMatchObject({
      assetRefs: [],
      error: { code: 'IMAGE_CANCELLED' },
      state: 'cancelled',
    });
    expect(harness.imagePort.generate).not.toHaveBeenCalled();
    expect(imageEvents.map((event) => event.type)).toEqual([
      IMAGE_GENERATION_EVENT_TYPES.accepted,
      IMAGE_GENERATION_EVENT_TYPES.cancelled,
    ]);
    expect(harness.publishers[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('creates and disposes one publisher per capability invocation', async () => {
    const harness = createHarness();

    await harness.capability.generate(scopeA, [slot()], { jobId: 'job-first' });
    await harness.capability.generate(scopeA, [slot('slide-2', 'background')], {
      jobId: 'job-second',
    });

    expect(harness.eventPublisherFactory).toHaveBeenCalledTimes(2);
    expect(harness.publishers).toHaveLength(2);
    expect(harness.publishers[0]).not.toBe(harness.publishers[1]);
    expect(
      harness.publishers.every((publisher) => vi.mocked(publisher.dispose).mock.calls.length === 1),
    ).toBe(true);
  });

  it('passes the authenticated scope to asset resolution and rejects cross-scope rendering', async () => {
    const harness = createHarness();
    const output = await harness.capability.generate(scopeA, [slot()], { jobId: 'job-render' });
    const asset = output.slots[0]!.assetRefs[0]!;
    const resolveAssetUri = vi.fn(async (receivedScope: RuntimeScope, ref: AssetRef) => {
      const stored = await harness.assetStore.getSnapshot(receivedScope, ref.ref);
      return `https://assets.test/${encodeURIComponent(stored.asset.ref)}`;
    });
    const renderer = createSceneRenderer({ resolveAssetUri });

    await expect(renderer.renderSvg(sceneFor(asset), { scope: scopeB })).rejects.toMatchObject({
      code: 'ASSET_SCOPE_MISMATCH',
    });
    expect(resolveAssetUri).toHaveBeenCalledWith(scopeB, asset);
  });

  it('keeps mixed slot outcomes sorted and truthful in both output and event streams', async () => {
    const harness = createHarness(async (request, context) => {
      if (request.prompt === 'fail this slot') {
        throw Object.assign(new Error('fake provider unavailable'), { code: 'IMAGE_UNAVAILABLE' });
      }
      const assetId = `${context.scope.userId}-success`;
      return [
        {
          asset: { ref: `asset://generated/${assetId}` },
          index: 0,
          metadata: {
            assetId,
            createdAt: now,
            mimeType: 'image/png',
          },
        },
      ];
    });
    const output = await harness.capability.generate(
      scopeA,
      [slot('slide-2', 'failed', 'fail this slot'), slot('slide-1', 'ready', 'safe prompt')],
      { jobId: 'job-mixed' },
    );
    const events = imageEventsFor(harness, scopeA, 'job-mixed');

    expect(output.slots.map((item) => `${item.slideId}/${item.state}`)).toEqual([
      'slide-1/ready',
      'slide-2/failed',
    ]);
    expect(events.findLast((event) => event.data.slotId === 'failed')?.type).toBe(
      IMAGE_GENERATION_EVENT_TYPES.failed,
    );
    expect(events.findLast((event) => event.data.slotId === 'ready')?.type).toBe(
      IMAGE_GENERATION_EVENT_TYPES.assetReady,
    );
    expect(JSON.stringify(output)).not.toContain('safe prompt');
  });
});
