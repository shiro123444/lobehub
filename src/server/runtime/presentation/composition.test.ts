import { describe, expect, it, vi } from 'vitest';

import type {
  ImageGenerationPort,
  PresentationJobInput,
  RuntimeScope,
} from '../../../../packages/runtime-contracts/src';
import type {
  PresentationAssetPutInput,
  PresentationAssetSnapshot,
  PresentationAssetStore,
} from './asset-store';
import { createPresentationRuntimeComposition } from './composition';
import type { PresentationJobEventJournalLoaderResult } from './event-journal-cache';
import { ScopedPresentationJobEventJournalCache } from './event-journal-cache';
import type { ImageGenerationCapability as ImageGenerationCapabilityType } from './image-generation-capability';
import { ImageGenerationCapability } from './image-generation-capability';
import { PresentationJobEventJournal } from './job-event-journal';
import type { PresentationPipelineContext } from './pipeline';

const scope: RuntimeScope = { sessionId: 'session-1', userId: 'user-1' };
const input: PresentationJobInput = {
  notebookId: 'notebook-1',
  sourceVersionIds: ['version-1'],
  title: 'Deck',
};
const context: PresentationPipelineContext = {
  plannerContext: {},
  workerContext: {
    convert: async () => [],
    jobId: 'job-1',
    qualityCheck: async () => ({ passed: true }),
    workspace: { path: '/tmp', write: async () => {} },
  },
};
const result = {
  artifacts: [
    {
      artifactId: 'artifact-1',
      createdAt: 'now',
      name: 'deck',
      status: 'ready',
      type: 'pptx',
    },
  ],
  plan: { aspectRatio: '16:9', planId: 'plan-1', slides: [], title: 'Deck' },
  worker: { jobId: 'job-1', planId: 'plan-1', qualityReport: { passed: true } },
};

const request = (): Request =>
  new Request('https://example.test/api/runtime/presentation/generation', {
    body: JSON.stringify(input),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });

const cacheFor = (
  load: (
    scope: { userId: string; sessionId: string },
    context?: unknown,
  ) => PresentationJobEventJournalLoaderResult | Promise<PresentationJobEventJournalLoaderResult>,
) => new ScopedPresentationJobEventJournalCache({ load });

describe('createPresentationRuntimeComposition', () => {
  it('requires exactly an explicit journal cache or loader', () => {
    expect(() => createPresentationRuntimeComposition({})).toThrowError(
      expect.objectContaining({
        code: 'PRESENTATION_COMPOSITION_DEPENDENCY_MISSING',
        path: 'journalCache',
      }),
    );

    const cache = cacheFor(() => new PresentationJobEventJournal());
    expect(() =>
      createPresentationRuntimeComposition({
        journalCache: cache,
        journalLoader: () => new PresentationJobEventJournal(),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'PRESENTATION_COMPOSITION_OPTIONS_INVALID',
      }),
    );
  });

  it('validates injected capability, contextFactory, portFactory, and now', () => {
    const cache = cacheFor(() => new PresentationJobEventJournal());

    expect(() =>
      createPresentationRuntimeComposition({ journalCache: cache, capability: {} as never }),
    ).toThrowError(expect.objectContaining({ path: 'capability' }));
    expect(() =>
      createPresentationRuntimeComposition({ journalCache: cache, contextFactory: 'bad' as never }),
    ).toThrowError(expect.objectContaining({ path: 'contextFactory' }));
    expect(() =>
      createPresentationRuntimeComposition({ journalCache: cache, portFactory: {} as never }),
    ).toThrowError(expect.objectContaining({ path: 'portFactory' }));
    expect(() =>
      createPresentationRuntimeComposition({ journalCache: cache, now: 'bad' as never }),
    ).toThrowError(expect.objectContaining({ path: 'now' }));
    expect(() =>
      createPresentationRuntimeComposition({
        imageGenerationCapability: {} as never,
        journalCache: cache,
      }),
    ).toThrowError(expect.objectContaining({ path: 'imageGenerationCapability' }));
  });

  it('exposes the injected image capability by identity without invoking or caching it', () => {
    const imageGenerationCapability = {
      generate: vi.fn(),
    } as unknown as ImageGenerationCapabilityType;
    const composition = createPresentationRuntimeComposition({
      imageGenerationCapability,
      journalLoader: async () => new PresentationJobEventJournal(),
    });

    expect(composition.imageGenerationCapability).toBe(imageGenerationCapability);
    expect(imageGenerationCapability.generate).not.toHaveBeenCalled();
  });

  it('creates the C-89 image capability from all explicit image dependencies', () => {
    const imagePort = {
      generate: vi.fn(),
    } as unknown as ImageGenerationPort;
    const imageGenerationAssetStore = {
      put: vi.fn(),
    } as unknown as PresentationAssetStore;
    const imageGenerationEventPublisherFactory = vi.fn();

    const composition = createPresentationRuntimeComposition({
      imageGenerationAssetStore,
      imageGenerationEventPublisherFactory,
      imageGenerationPort: imagePort,
      journalLoader: async () => new PresentationJobEventJournal(),
    });

    expect(composition.imageGenerationCapability).toBeInstanceOf(ImageGenerationCapability);
    expect(imagePort.generate).not.toHaveBeenCalled();
    expect(imageGenerationAssetStore.put).not.toHaveBeenCalled();
    expect(imageGenerationEventPublisherFactory).not.toHaveBeenCalled();
  });

  it('wires caller scope through the internally created image capability', async () => {
    const receivedScopes: RuntimeScope[] = [];
    const imagePort = {
      generate: vi.fn(async (_request: unknown, context: { scope: RuntimeScope }) => {
        receivedScopes.push(context.scope);
        return [
          {
            asset: { ref: 'asset://generated/1' },
            index: 0,
            metadata: { createdAt: '2026-09-01T00:00:00.000Z', mimeType: 'image/png' },
          },
        ];
      }),
    } as unknown as ImageGenerationPort;
    const imageGenerationAssetStore = {
      put: vi.fn(
        async (
          _receivedScope: RuntimeScope,
          input: PresentationAssetPutInput,
        ): Promise<PresentationAssetSnapshot> => ({
          asset: input.asset,
          metadata: {
            createdAt: input.metadata.createdAt ?? '2026-09-01T00:00:00.000Z',
            mimeType: input.metadata.mimeType,
          },
        }),
      ),
    } as unknown as PresentationAssetStore;
    const publisher = {
      assertScope: vi.fn(),
      dispose: vi.fn(),
      publish: vi.fn(),
    };
    const imageGenerationEventPublisherFactory = vi.fn(
      async (receivedScope: RuntimeScope, jobId: string) => {
        expect(receivedScope).toEqual(scope);
        expect(jobId).toBe('image-job-1');
        return publisher;
      },
    );
    const composition = createPresentationRuntimeComposition({
      imageGenerationAssetStore,
      imageGenerationEventPublisherFactory,
      imageGenerationPort: imagePort,
      journalLoader: async () => new PresentationJobEventJournal(),
    });

    const output = await composition.imageGenerationCapability!.generate(
      scope,
      [{ prompt: 'safe prompt', slideId: 'slide-1', slotId: 'slot-1' }],
      { jobId: 'image-job-1' },
    );

    expect(output.slots[0]).toMatchObject({ state: 'ready', slideId: 'slide-1' });
    expect(receivedScopes).toEqual([scope]);
    expect(publisher.assertScope).toHaveBeenCalledWith(scope);
    expect(publisher.dispose).toHaveBeenCalledOnce();
  });

  it('keeps a partial image dependency set on the honest unavailable path', () => {
    const composition = createPresentationRuntimeComposition({
      imageGenerationPort: { generate: vi.fn() } as unknown as ImageGenerationPort,
      journalLoader: async () => new PresentationJobEventJournal(),
    });

    expect(composition.imageGenerationCapability).toBeUndefined();
  });

  it('rejects direct capability and image dependency injection together', () => {
    const directCapability = { generate: vi.fn() } as unknown as ImageGenerationCapabilityType;

    expect(() =>
      createPresentationRuntimeComposition({
        imageGenerationAssetStore: { put: vi.fn() } as unknown as PresentationAssetStore,
        imageGenerationCapability: directCapability,
        imageGenerationEventPublisherFactory: vi.fn(),
        imageGenerationPort: { generate: vi.fn() } as unknown as ImageGenerationPort,
        journalLoader: async () => new PresentationJobEventJournal(),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'PRESENTATION_COMPOSITION_OPTIONS_INVALID',
        path: 'imageGenerationCapability',
      }),
    );
  });

  it('disposes a directly injected image capability together with the journal', async () => {
    const dispose = vi.fn();
    const directCapability = {
      dispose,
      generate: vi.fn(),
    } as unknown as ImageGenerationCapabilityType;
    const composition = createPresentationRuntimeComposition({
      imageGenerationCapability: directCapability,
      journalLoader: async () => new PresentationJobEventJournal(),
    });

    await composition.dispose();

    expect(dispose).toHaveBeenCalledOnce();
    await expect(composition.dispose()).resolves.toBeUndefined();
  });

  it('composes C-69 factories and shares same-scope publisher replay', async () => {
    const load = vi.fn(
      async (value: { userId: string; sessionId: string }) =>
        new PresentationJobEventJournal({ scope: value }),
    );
    const composition = createPresentationRuntimeComposition({
      journalLoader: load,
      now: () => '2026-08-31T00:00:00.000Z',
    });
    const currentRequest = request();
    const publisher = await composition.generationEventPublisherFactory(
      scope,
      'job-1',
      currentRequest,
    );
    const journal = await composition.jobEventJournalFactory(scope, { currentRequest });

    publisher.publish('job-1', 'presentation.job.accepted', { state: 'queued' });

    expect(journal).toBeDefined();
    expect(journal.replay('job-1')).toHaveLength(1);
    expect(load).toHaveBeenCalledWith(scope, { jobId: 'job-1', request: currentRequest });
  });

  it('keeps the composed journal isolated by user and session', async () => {
    const composition = createPresentationRuntimeComposition({
      journalLoader: async (value) => new PresentationJobEventJournal({ scope: value }),
    });
    const firstScope = { sessionId: 'session-1', userId: 'user-1' };
    const secondScope = { sessionId: 'session-2', userId: 'user-1' };
    const publisher = await composition.generationEventPublisherFactory(
      firstScope,
      'job-1',
      new Request('https://example.test'),
    );
    const secondJournal = await composition.jobEventJournalFactory(secondScope);

    publisher.publish('job-1', 'presentation.job.accepted', { state: 'queued' });

    expect(secondJournal.replay('job-1')).toEqual([]);
  });

  it('passes server scope and publisher into the generation handler', async () => {
    const execute = vi.fn(async (receivedScope, _receivedInput, receivedContext) => {
      expect(receivedScope).toEqual(scope);
      expect(receivedContext.workerContext.eventScope).toEqual(scope);
      expect(receivedContext.workerContext.eventPublisher).toBeDefined();
      return result;
    });
    const capability = { execute } as never;
    const contextFactory = vi.fn(() => context);
    const composition = createPresentationRuntimeComposition({
      capability,
      contextFactory,
      journalLoader: async (value) => new PresentationJobEventJournal({ scope: value }),
    });

    const response = await composition.generationHandler(request(), scope);

    expect(response.status).toBe(200);
    expect(contextFactory).toHaveBeenCalledWith(expect.stringMatching(/^generation-/));
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('returns honest PROVIDER_UNAVAILABLE when capability/context are omitted', async () => {
    const load = vi.fn(async () => new PresentationJobEventJournal());
    const composition = createPresentationRuntimeComposition({ journalLoader: load });

    const response = await composition.generationHandler(request(), scope);

    expect(response).toMatchObject({
      body: { error: { code: 'PROVIDER_UNAVAILABLE' } },
      status: 503,
    });
    expect(load).not.toHaveBeenCalled();
  });

  it('forwards injected portFactory without falling back to a global factory', () => {
    const portFactory = vi.fn();
    const composition = createPresentationRuntimeComposition({
      journalLoader: async () => new PresentationJobEventJournal(),
      portFactory,
    });

    expect(composition.portFactory).toBe(portFactory);
  });

  it('resets and disposes idempotently while preserving cache lifecycle errors', async () => {
    const composition = createPresentationRuntimeComposition({
      journalLoader: async (value) => new PresentationJobEventJournal({ scope: value }),
    });
    const publisher = await composition.generationEventPublisherFactory(
      scope,
      'job-1',
      new Request('https://example.test'),
    );
    const journal = await composition.jobEventJournalFactory(scope);

    expect(composition.reset(scope)).toBe(1);
    expect(composition.reset(scope)).toBe(0);
    expect(() => publisher.publish('job-1', 'presentation.job.accepted', {})).toThrow(
      expect.objectContaining({ code: 'PRESENTATION_EVENT_JOURNAL_CACHE_RESET' }),
    );
    await expect(composition.dispose()).resolves.toBeUndefined();
    await expect(composition.dispose()).resolves.toBeUndefined();
    await expect(composition.jobEventJournalFactory(scope)).rejects.toMatchObject({
      code: 'PRESENTATION_EVENT_JOURNAL_CACHE_DISPOSED',
    });
    expect(() => journal.replay('job-1')).toThrow(
      expect.objectContaining({ code: 'PRESENTATION_EVENT_JOURNAL_CACHE_RESET' }),
    );
  });

  it('exposes injected multimodalChatPort when provided and validates its interface', () => {
    const chatPort = {
      chat: vi.fn(),
      manifest: {
        displayName: 'GLM',
        model: 'glm-5.3-flash',
        providerId: 'glm',
        supportsIdempotency: true,
        supportsVision: true,
      },
      providerId: 'glm',
    };

    const composition = createPresentationRuntimeComposition({
      journalLoader: async () => new PresentationJobEventJournal(),
      multimodalChatPort: chatPort,
    });

    expect(composition.multimodalChatPort).toBe(chatPort);

    expect(() =>
      createPresentationRuntimeComposition({
        journalLoader: async () => new PresentationJobEventJournal(),
        multimodalChatPort: {} as any,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'PRESENTATION_COMPOSITION_OPTIONS_INVALID',
        path: 'multimodalChatPort',
      }),
    );
  });
});
