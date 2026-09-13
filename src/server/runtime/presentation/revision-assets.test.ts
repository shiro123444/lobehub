import { describe, expect, it, vi } from 'vitest';

import type {
  ImageGenerationPort,
  PresentationPlan,
} from '../../../../packages/runtime-contracts/src';
import { ImageGenerationEventPublisher, InMemoryImageGenerationEventJournal } from './asset-events';
import { InMemoryPresentationAssetStore } from './asset-store';
import { createImageGenerationCapability } from './image-generation-capability';
import type { GLMChatResult, GLMMultimodalChatPort } from './multimodal-chat-provider-glm';
import {
  boundPresentationPromptText,
  createRevisionAssetPlanner,
  type PresentationRevisionAssetInput,
  type RevisionAssetIntent,
} from './revision-assets';

const scope = { sessionId: 'session-1', userId: 'user-1' };
const svg = (text: string, image = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><text x="32" y="100">${text}</text>${image}</svg>`;
const oldImage =
  '<image href="/api/runtime/presentation/artifacts/old-image" x="500" y="140" width="400" height="300"/>';
const basePlan: PresentationPlan = {
  aspectRatio: '16:9',
  planId: 'base-version',
  slides: [
    { order: 1, slideId: 'cover', svg: svg('Cover') },
    { order: 2, slideId: 'product', svg: svg('Product', oldImage) },
    { order: 3, slideId: 'summary', svg: svg('Summary') },
  ],
  sourceVersionIds: [],
  title: 'Product',
};
const input: PresentationRevisionAssetInput = {
  basePlan,
  jobId: 'job-1',
  jobInput: { notebookId: 'notebook', slideCount: 3, sourceVersionIds: [], title: 'Product' },
  revision: {
    content: 'Use a new photo of the product on the right and move its description to the left.',
    requestId: 'edit-1',
    target: { slideNumber: 2, type: 'slide' },
  },
  scope,
};
const replaceIntent: RevisionAssetIntent = {
  action: 'replace',
  layout: { fit: 'contain', height: 0.6, width: 0.42, x: 0.53, y: 0.25 },
  prompt: 'Studio photograph of a minimalist teal portable speaker, white background, no text.',
  ref: '/api/runtime/presentation/artifacts/old-image',
  size: '1024x1536',
  slideId: 'product',
  slotId: 'product-photo',
};

const response = (intents: unknown): GLMChatResult => ({
  choices: [{ index: 0, message: { content: JSON.stringify({ intents }), role: 'assistant' } }],
  created: 1,
  id: 'analysis',
  model: 'test',
});
const chatPort = (intents: unknown = [replaceIntent]): GLMMultimodalChatPort => ({
  chat: vi.fn(async () => response(intents)),
  manifest: {
    displayName: 'test',
    model: 'test',
    providerId: 'test',
    supportsIdempotency: true,
    supportsVision: true,
  },
  providerId: 'test',
});

const imageCapability = () => {
  const store = new InMemoryPresentationAssetStore();
  const port: ImageGenerationPort = {
    generate: vi.fn(async (_request, context) => [
      {
        asset: { ref: `image:${context.scope.sessionId}:speaker` },
        index: 0,
        metadata: { createdAt: '2026-09-12T00:00:00.000Z', mimeType: 'image/png' },
      },
    ]),
    manifest: {
      displayName: 'Test images',
      providerId: 'images',
      supportedMimeTypes: ['image/png'],
      supportsIdempotency: true,
    },
    providerId: 'images',
    resolveAsset: async () => null,
  };
  return {
    capability: createImageGenerationCapability({
      assetStore: store,
      eventPublisherFactory: (scope) =>
        new ImageGenerationEventPublisher({
          journal: new InMemoryImageGenerationEventJournal({ scope }),
          scope,
        }),
      imagePort: port,
    }),
    port,
    store,
  };
};

describe('presentation revision assets', () => {
  it('keeps large inline image payloads out of the semantic-analysis text request, including wrapped base64', async () => {
    const payload = `${'A'.repeat(800_000)}\n${'B'.repeat(800_000)}`;
    const embedded = `data:image/png;base64,${payload}`;
    const chat = chatPort([]);
    const inlinePlan: PresentationPlan = {
      ...basePlan,
      slides: basePlan.slides.map((slide) =>
        slide.slideId === 'product'
          ? {
              ...slide,
              svg: svg('Product', `<image href="${embedded}" width="400" height="300"/>`),
            }
          : slide,
      ),
    };
    await createRevisionAssetPlanner({ chatPort: chat }).prepare({
      ...input,
      basePlan: inlinePlan,
    });
    const text = JSON.stringify(vi.mocked(chat.chat).mock.calls[0][0].messages);
    expect(text.length).toBeLessThan(12_000);
    expect(text).not.toContain('data:image');
    expect(text).not.toContain('A'.repeat(256));
    expect(text).not.toContain('B'.repeat(256));
    expect(inlinePlan.slides[1].svg).toContain(embedded);
  });

  it('summarizes encoded inline SVG and rejects remaining oversized text before a provider call', () => {
    expect(
      boundPresentationPromptText(`<image href="data:image/svg+xml,${'%20'.repeat(80_000)}"/>`),
    ).toBe('<image href="[embedded image data omitted; use the verified asset reference]"/>');
    expect(() => boundPresentationPromptText('Native vector context '.repeat(10_000))).toThrow(
      'text context is too large',
    );
  });

  it('uses semantic intent to replace only the selected page image through the image capability', async () => {
    const { capability, port, store } = imageCapability();
    const chat = chatPort();
    const planner = createRevisionAssetPlanner({
      chatPort: chat,
      imageGenerationCapability: capability,
    });
    const result = await planner.prepare(input);

    expect(port.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        count: 1,
        prompt: replaceIntent.prompt,
        size: '1024x1536',
        idempotencyKey: expect.any(String),
      }),
      expect.objectContaining({ scope }),
    );
    expect(result.assetArtifactIds).toEqual(['image:session-1:speaker']);
    expect(result.input.options?.generatedImageSlots).toEqual([
      expect.objectContaining({
        assetRefs: [{ ref: 'image:session-1:speaker' }],
        layout: replaceIntent.layout,
        size: '1024x1536',
        slideId: 'product',
        state: 'ready',
      }),
    ]);
    expect(result.input.options?.revisionAssetIntents).toEqual([replaceIntent]);
    expect(await store.find(scope, 'image:session-1:speaker')).not.toBeNull();
    const prompt = vi.mocked(chat.chat).mock.calls[0][0].messages[1].content as string;
    expect(prompt).toContain('Product');
    expect(prompt).not.toContain('Summary');
    expect(input.basePlan).toEqual(basePlan);
  });

  it('does not generate assets for a wording edit, even when the text mentions an image', async () => {
    const { capability, port } = imageCapability();
    const result = await createRevisionAssetPlanner({
      chatPort: chatPort([]),
      imageGenerationCapability: capability,
    }).prepare({
      ...input,
      revision: { ...input.revision, content: '把标题改成「AI 生成图像」，现有产品照片保持原样' },
    });
    expect(port.generate).not.toHaveBeenCalled();
    expect(result.assetArtifactIds).toEqual([]);
    expect(result.input.options?.generatedImageSlots).toEqual([]);
  });

  it('deduplicates concurrent attempts and isolates idempotency by authenticated scope', async () => {
    const { capability, port } = imageCapability();
    const chat = chatPort();
    const planner = createRevisionAssetPlanner({
      chatPort: chat,
      imageGenerationCapability: capability,
    });
    const [first, second] = await Promise.all([planner.prepare(input), planner.prepare(input)]);
    expect(first).toEqual(second);
    expect(chat.chat).toHaveBeenCalledTimes(1);
    expect(port.generate).toHaveBeenCalledTimes(1);
    await planner.prepare({
      ...input,
      jobInput: {
        ...input.jobInput,
        options: {
          generatedImageSlots: [{ ref: 'transient-previous-image' }],
          revisionAssetIntents: [{ action: 'reuse' }],
        },
      },
    });
    expect(port.generate).toHaveBeenCalledTimes(1);
    await planner.prepare({ ...input, scope: { ...scope, sessionId: 'session-2' } });
    expect(port.generate).toHaveBeenCalledTimes(2);
    const requests = vi.mocked(port.generate).mock.calls;
    expect(requests[0][0].idempotencyKey).not.toBe(requests[1][0].idempotencyKey);
    await expect(
      planner.prepare({ ...input, revision: { ...input.revision, content: 'Another edit' } }),
    ).rejects.toMatchObject({ code: 'IMAGE_PLAN_INVALID' });
  });

  it('fails before calling a provider for out-of-scope slides, missing providers and exceeded budgets', async () => {
    await expect(
      createRevisionAssetPlanner({
        chatPort: chatPort([{ ...replaceIntent, slideId: 'cover' }]),
      }).prepare(input),
    ).rejects.toMatchObject({ code: 'IMAGE_PLAN_INVALID' });
    await expect(
      createRevisionAssetPlanner({ chatPort: chatPort() }).prepare(input),
    ).rejects.toMatchObject({ code: 'IMAGE_UNAVAILABLE' });
    await expect(
      createRevisionAssetPlanner({ chatPort: chatPort(), maxGeneratedSlots: 0 }).prepare(input),
    ).rejects.toMatchObject({ code: 'IMAGE_BUDGET_EXCEEDED' });
    await expect(
      createRevisionAssetPlanner({ chatPort: chatPort() }).prepare({
        ...input,
        scope: { sessionId: '', userId: '' },
      }),
    ).rejects.toMatchObject({ code: 'IMAGE_PLAN_INVALID' });
  });

  it('cancels before analysis and between analysis and image generation', async () => {
    const controller = new AbortController();
    const chat = chatPort();
    const { capability, port } = imageCapability();
    const planner = createRevisionAssetPlanner({
      chatPort: chat,
      imageGenerationCapability: capability,
    });
    controller.abort();
    await expect(planner.prepare({ ...input, signal: controller.signal })).rejects.toMatchObject({
      code: 'IMAGE_CANCELLED',
    });
    expect(chat.chat).not.toHaveBeenCalled();

    const during = new AbortController();
    vi.mocked(chat.chat).mockImplementationOnce(async () => {
      during.abort();
      return response([replaceIntent]);
    });
    await expect(planner.prepare({ ...input, signal: during.signal })).rejects.toMatchObject({
      code: 'IMAGE_CANCELLED',
    });
    expect(port.generate).not.toHaveBeenCalled();
  });

  it('does not pass failed image slots to the SVG planner as though they were real assets', async () => {
    const generate = vi.fn(async () => ({
      jobId: input.jobId,
      scope,
      slots: [
        {
          assetRefs: [],
          slideId: 'product',
          slotId: 'edit-1:product-photo',
          state: 'failed' as const,
        },
      ],
    }));
    await expect(
      createRevisionAssetPlanner({
        chatPort: chatPort(),
        imageGenerationCapability: { generate },
      }).prepare(input),
    ).rejects.toMatchObject({ code: 'IMAGE_UNAVAILABLE' });
  });

  it('rejects image placements outside the canvas and invented existing references', async () => {
    await expect(
      createRevisionAssetPlanner({
        chatPort: chatPort([{ ...replaceIntent, layout: { ...replaceIntent.layout, width: 1 } }]),
      }).prepare(input),
    ).rejects.toMatchObject({ code: 'IMAGE_PLAN_INVALID' });
    await expect(
      createRevisionAssetPlanner({
        chatPort: chatPort([{ ...replaceIntent, ref: 'not-an-existing-image' }]),
      }).prepare(input),
    ).rejects.toMatchObject({ code: 'IMAGE_PLAN_INVALID' });
  });
});

it('composes processing tools for a selected image without invoking image generation', async () => {
  const processing = [
    { id: 'cutout', operation: 'assets.removeBackground', input: { ref: replaceIntent.ref } },
    {
      id: 'fade',
      operation: 'assets.transform',
      input: { ref: { $ref: 'cutout.ref' }, opacity: 0.8 },
    },
  ];
  const processAssets = vi.fn().mockResolvedValue({ ref: 'processed-owned' });
  const generate = vi.fn();
  const planner = createRevisionAssetPlanner({
    chatPort: chatPort([
      {
        action: 'process',
        slideId: 'product',
        slotId: 'cutout',
        ref: replaceIntent.ref,
        layout: replaceIntent.layout,
        processing,
      },
    ]),
    processAssets,
    imageGenerationCapability: { generate },
  });
  const result = await planner.prepare(input);
  expect(generate).not.toHaveBeenCalled();
  expect(processAssets).toHaveBeenCalledWith(processing, input);
  expect(result.assetArtifactIds).toEqual(['processed-owned']);
  expect(result.intents[0]).toMatchObject({
    action: 'replace',
    ref: replaceIntent.ref,
    processing,
  });
});

it('runs cutout after generating a new transparent asset and passes the real source ref', async () => {
  const capability = imageCapability();
  const processAssets = vi.fn().mockResolvedValue({ ref: 'transparent-owned' });
  const planner = createRevisionAssetPlanner({
    chatPort: chatPort([
      {
        ...replaceIntent,
        processing: [
          { id: 'cutout', operation: 'assets.removeBackground', input: { ref: '$source' } },
        ],
      },
    ]),
    imageGenerationCapability: capability.capability,
    processAssets,
  });
  const result = await planner.prepare(input);
  expect(processAssets.mock.calls[0][0][0].input.ref).toMatch(/^image:/);
  expect(result.assetArtifactIds).toEqual(['transparent-owned']);
});

it('places an owned asset made during intake without generating it again, and rejects unknown refs', async () => {
  const intents = [
    {
      action: 'reuse',
      ref: 'intake-watercolor',
      slideId: 'cover',
      slotId: 'illustration',
      layout: { x: 0.55, y: 0.2, width: 0.4, height: 0.6, fit: 'contain' },
    },
  ];
  const chat = chatPort(intents);
  const generate = vi.fn();
  const reuse = vi.fn(async () => [{ ref: 'intake-watercolor', name: '水彩书本' }]);
  const request = {
    ...input,
    revision: {
      content: 'Reuse the watercolor book',
      requestId: 'initial-assets',
      target: { type: 'deck' as const },
    },
    jobInput: { ...input.jobInput, options: { availableAssetRefs: ['intake-watercolor'] } },
  };
  const result = await createRevisionAssetPlanner({
    chatPort: chat,
    imageGenerationCapability: { generate },
    readReusableAssets: reuse,
  }).prepare(request);
  expect(result.assetArtifactIds).toEqual(['intake-watercolor']);
  expect(result.input.options?.generatedImageSlots).toEqual([
    expect.objectContaining({
      slideId: 'cover',
      layout: intents[0].layout,
      assetRefs: [{ ref: 'intake-watercolor' }],
    }),
  ]);
  expect(generate).not.toHaveBeenCalled();
  await expect(
    createRevisionAssetPlanner({ chatPort: chat, readReusableAssets: async () => [] }).prepare(
      request,
    ),
  ).rejects.toThrow('belonging to the selected slide');
});
