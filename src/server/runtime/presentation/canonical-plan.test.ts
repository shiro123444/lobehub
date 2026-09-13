import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  PlannerContext,
  PresentationJobInput,
  PresentationMessageInput,
  PresentationPlan,
} from '../../../../packages/runtime-contracts/src';
import { FilePresentationStorage } from './file-storage';
import { PresentationGenerationCapability } from './generation-capability';
import { PresentationGenerationPort } from './generation-port';
import { PresentationGenerationPipelineImpl } from './pipeline';
import { InMemoryPresentationPlanWorker } from './worker';

const scope = { sessionId: 'session-a', userId: 'alice', request: new Request('http://localhost') };
const otherScope = { ...scope, sessionId: 'session-b', userId: 'bob' };
const png = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1kAAAAASUVORK5CYII=',
    'base64',
  ),
);
const dataUri = `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
const ownedId = 'image-owned';
const ownedUrl = `/api/runtime/presentation/artifacts/${ownedId}?raw=true`;
const bannerId = 'image-banner';
const bannerUrl = `/api/runtime/presentation/artifacts/${bannerId}?raw=true`;
const sourceSvg = (
  href: string,
) => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 960 540">
  <rect width="960" height="540" fill="#fff"/>
  <text x="40" y="70" font-size="32">Original &amp; editable</text>
  <image  xlink:href = '${href}' x="500" y="120" width="320" height="300" preserveAspectRatio="xMidYMid slice" />
</svg>`;
const sourcePlan: PresentationPlan = {
  aspectRatio: '16:9',
  planId: 'canonical-source',
  slides: [
    {
      order: 1,
      slideId: 'first',
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><text x="40" y="60">Keep first page</text><image href="${bannerUrl}" x="700" y="50" width="100" height="80"/></svg>`,
    },
    { order: 2, slideId: 'second', svg: sourceSvg(ownedUrl) },
  ],
  sourceVersionIds: [],
  title: 'Canonical images',
};
const input: PresentationJobInput = {
  notebookId: 'studio',
  slideCount: 2,
  sourceVersionIds: [],
  title: 'Canonical images',
};
const roots: string[] = [];
const ports: PresentationGenerationPort[] = [];
afterEach(async () => {
  await Promise.all(ports.splice(0).map((port) => port.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const harness = async () => {
  const root = await mkdtemp(join(tmpdir(), 'ppt-canonical-'));
  roots.push(root);
  const storage = new FilePresentationStorage(root);
  await storage.put(scope, {
    artifactId: ownedId,
    bytes: png,
    metadata: { jobId: 'canonical-job' },
    mimeType: 'image/png',
    name: 'owned.png',
    type: 'image',
  });
  // This image is only present on the untouched page, so it must not be passed to a page-two edit.
  await storage.put(scope, {
    artifactId: bannerId,
    bytes: new Uint8Array([...png, 1]),
    metadata: { jobId: 'canonical-job' },
    mimeType: 'image/png',
    name: 'banner.png',
    type: 'image',
  });
  const plannerCalls: Array<{ basePlan?: PresentationPlan; trustedImages?: unknown }> = [];
  const planner = {
    plan: vi.fn(
      async (_input: PresentationJobInput, context: PlannerContext): Promise<PresentationPlan> => {
        plannerCalls.push({
          basePlan: context.basePlan
            ? structuredClone(context.basePlan as PresentationPlan)
            : undefined,
          trustedImages: structuredClone(context.trustedImages),
        });
        if (!context.basePlan) return structuredClone(sourcePlan);
        const base = context.basePlan as PresentationPlan;
        return {
          ...base,
          slides: base.slides.map((slide) =>
            slide.slideId === 'second'
              ? {
                  ...slide,
                  svg: slide.svg.replace('Original &amp; editable', 'Revised &amp; editable'),
                }
              : slide,
          ),
        };
      },
    ),
  };
  const rendered: PresentationPlan[] = [];
  const worker = new InMemoryPresentationPlanWorker();
  const pipeline = new PresentationGenerationPipelineImpl(planner, {
    run: async (plan, context) => {
      rendered.push(structuredClone(plan));
      return worker.run(plan, context);
    },
  });
  const createPort = (currentScope = scope) => {
    const port = new PresentationGenerationPort(
      {
        artifactStore: storage,
        capability: new PresentationGenerationCapability(pipeline, storage),
        contextFactory: () => ({
          plannerContext: {},
          workerContext: {
            convert: async () => [
              {
                bytes: new Uint8Array([80, 75, 1]),
                mimeType:
                  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                name: 'deck.pptx',
                type: 'pptx',
              },
            ],
            jobId: 'placeholder',
            qualityCheck: async () => ({ passed: true }),
            workspace: { path: root, write: async () => {} },
          },
        }),
        idFactory: () => 'canonical-job',
        repository: storage,
      },
      currentScope,
    );
    ports.push(port);
    return port;
  };
  const complete = async () =>
    vi.waitFor(async () =>
      expect((await storage.getJob(scope, 'canonical-job'))?.job.state).toBe('completed'),
    );
  const edit: PresentationMessageInput = {
    content: 'Rename the second page heading.',
    requestId: 'edit-page-two',
    target: { type: 'slide', slideNumber: 2 },
  };
  return { complete, createPort, edit, planner, plannerCalls, rendered, storage };
};

describe('Canonical presentation image references', () => {
  it('embeds images only in rendered copies while persisted pages and later planner inputs keep canonical URLs', async () => {
    const { complete, createPort, edit, plannerCalls, rendered, storage } = await harness();
    const port = createPort();
    await port.createJob(input);
    await complete();
    const saved = (await storage.getJob(scope, 'canonical-job'))!;
    expect(saved.plan).toEqual(sourcePlan);
    expect((await port.readPlan('canonical-job')).plan).toEqual(sourcePlan);
    expect(JSON.stringify(saved.plan)).not.toContain('base64,');
    expect(rendered[0].slides[1].svg).toBe(sourceSvg(dataUri));
    const slideId = saved.job.artifactIds!.find((id) => id.endsWith(':slide:second'))!;
    expect(new TextDecoder().decode((await storage.get(scope, slideId))!.bytes)).toBe(
      sourceSvg(dataUri),
    );

    await port.sendMessage('canonical-job', edit);
    await complete();
    expect(plannerCalls[1].basePlan).toEqual(sourcePlan);
    expect(JSON.stringify(plannerCalls[1].basePlan)).not.toContain('base64,');
    expect(JSON.stringify(plannerCalls[1].basePlan).length).toBeLessThan(2000);
    expect(plannerCalls[1].trustedImages).toEqual([
      { ref: ownedId, mimeType: 'image/png', base64: Buffer.from(png).toString('base64') },
    ]);
    expect(rendered[1].slides[1].svg).toContain(dataUri);
    const revised = (await storage.getJob(scope, 'canonical-job'))!.plan!;
    expect(revised.slides[0]).toEqual(sourcePlan.slides[0]);
    expect(revised.slides[1].svg).toBe(
      sourceSvg(ownedUrl).replace('Original &amp; editable', 'Revised &amp; editable'),
    );
    expect(JSON.stringify(revised)).not.toContain('base64,');
  });

  it('restores legacy embedded images by exact owned bytes, preserves SVG formatting and supplies only the edited page’s trusted image', async () => {
    const { complete, createPort, edit, plannerCalls, rendered, storage } = await harness();
    const foreignId = 'image-foreign';
    await storage.put(otherScope, {
      artifactId: foreignId,
      bytes: png,
      metadata: { jobId: 'canonical-job' },
      mimeType: 'image/png',
      name: 'foreign.png',
      type: 'image',
    });
    const legacy = {
      input,
      initialAssetsComplete: true,
      job: {
        jobId: 'canonical-job',
        state: 'completed' as const,
        createdAt: '2026-09-12T00:00:00.000Z',
        updatedAt: '2026-09-12T00:00:00.000Z',
        versionId: 'legacy-version',
        artifactIds: [ownedId, foreignId, bannerId],
      },
      plan: {
        ...sourcePlan,
        slides: [sourcePlan.slides[0], { ...sourcePlan.slides[1], svg: sourceSvg(dataUri) }],
      },
    };
    await storage.saveJob(scope, legacy);
    const port = createPort();
    const restored = (await port.readPlan('canonical-job')).plan;
    expect(restored.slides[0]).toEqual(sourcePlan.slides[0]);
    expect(restored.slides[1].svg).toBe(sourceSvg(ownedUrl));
    expect(restored.slides[1].metadata?.generatedAssetRefs).toEqual([ownedId]);
    expect(JSON.stringify(restored)).not.toContain('base64,');
    expect(restored.slides[1].svg).not.toContain(foreignId);
    expect((await storage.getJob(scope, 'canonical-job'))!.plan).toEqual(restored);

    await port.sendMessage('canonical-job', edit);
    await complete();
    expect(plannerCalls[0].basePlan).toEqual(restored);
    expect(JSON.stringify(plannerCalls[0].basePlan).length).toBeLessThan(2000);
    expect(plannerCalls[0].trustedImages).toEqual([
      { ref: ownedId, mimeType: 'image/png', base64: Buffer.from(png).toString('base64') },
    ]);
    expect(rendered[0].slides[1].svg).toContain(dataUri);
    expect(JSON.stringify((await storage.getJob(scope, 'canonical-job'))!.plan)).not.toContain(
      'base64,',
    );

    // A matching id in another scope cannot restore bytes the current scope does not own.
    await storage.saveJob(otherScope, {
      ...legacy,
      job: { ...legacy.job, artifactIds: [ownedId] },
      plan: {
        ...sourcePlan,
        slides: [{ ...sourcePlan.slides[1], order: 1, svg: sourceSvg(dataUri) }],
      },
    });
    const foreignPort = createPort(otherScope);
    expect((await foreignPort.readPlan('canonical-job')).plan.slides[0].svg).toBe(
      sourceSvg(dataUri),
    );
  });
});
