import { describe, expect, it, vi } from 'vitest';

import { InMemoryPresentationArtifactStore } from './artifact-store';
import { PresentationGenerationCapability } from './generation-capability';
import { PresentationJobEventJournal } from './job-event-journal';
import type { PresentationPipelineContext } from './pipeline';
import { PresentationJobEventPublisher } from './publisher';

const scope = { userId: 'u', sessionId: 's' };
const input = { notebookId: 'n', sourceVersionIds: ['v'], title: 'Deck' };
const generated = {
  plan: {
    planId: 'p',
    title: 'Deck',
    aspectRatio: '16:9',
    sourceVersionIds: ['v'],
    slides: [{ slideId: 's', order: 0, svg: '<svg />' }],
  },
  worker: {
    jobId: 'j',
    planId: 'p',
    qualityReport: { passed: true },
    artifacts: [{ bytes: new Uint8Array([1]), mimeType: 'x', name: 'a', type: 'pptx' }],
  },
};
const context = {
  plannerContext: {},
  workerContext: {
    jobId: 'j',
    workspace: { path: '/tmp', write: async () => undefined },
    qualityCheck: async () => ({ passed: true }),
    convert: async () => [],
  },
};
describe('C-56 generation capability', () => {
  it('calls pipeline then bridge and returns snapshots', async () => {
    const pipeline = { run: vi.fn(async () => generated) };
    const result = await new PresentationGenerationCapability(
      pipeline,
      new InMemoryPresentationArtifactStore(),
    ).execute(scope, input, context);
    expect(pipeline.run).toHaveBeenCalledOnce();
    expect(result.artifacts[0]).toMatchObject({ artifactId: 'j:0', status: 'ready' });
  });
  it('short-circuits invalid scope/input and pipeline errors', async () => {
    const pipeline = { run: vi.fn(async () => generated) };
    const capability = new PresentationGenerationCapability(
      pipeline,
      new InMemoryPresentationArtifactStore(),
    );
    await expect(
      capability.execute({ userId: '', sessionId: 's' }, input, context),
    ).rejects.toThrow();
    await expect(capability.execute(scope, { ...input, title: '' }, context)).rejects.toThrow();
    expect(pipeline.run).not.toHaveBeenCalled();
    const error = new Error('pipeline');
    const failing = new PresentationGenerationCapability(
      {
        run: vi.fn(async () => {
          throw error;
        }),
      },
      new InMemoryPresentationArtifactStore(),
    );
    await expect(failing.execute(scope, input, context)).rejects.toBe(error);
  });

  it('injects the publisher with the authenticated scope without creating a default journal', async () => {
    const journal = new PresentationJobEventJournal({ scope });
    const publisher = new PresentationJobEventPublisher({ journal, scope });
    const pipeline = {
      run: vi.fn(async (_value: unknown, received: PresentationPipelineContext) => {
        expect(received.eventPublisher).toBe(publisher);
        expect(received.eventScope).toEqual(scope);
        return generated;
      }),
    };
    const capability = new PresentationGenerationCapability(
      pipeline,
      new InMemoryPresentationArtifactStore(),
      { eventPublisher: publisher },
    );

    await capability.execute(scope, input, context);

    expect(journal.replay('j')).toEqual([]);
    expect(pipeline.run).toHaveBeenCalledOnce();
  });
});
