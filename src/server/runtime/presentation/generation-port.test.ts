import { InMemoryPresentationArtifactStore } from './artifact-store';
import type { PresentationGenerationCapability } from './generation-capability';
import { PresentationGenerationPort } from './generation-port';
import type { ImageGenerationCapability } from './image-generation-capability';

const scope = { request: new Request('https://example.test'), userId: 'u1', sessionId: 's1' };
const input = { notebookId: 'n1', title: '演示', sourceVersionIds: ['v1'] };

describe('PresentationGenerationPort', () => {
  it('returns queued immediately and completes through the generation capability', async () => {
    const store = new InMemoryPresentationArtifactStore(() => '2026-01-01T00:00:00.000Z');
    const capability = {
      execute: vi.fn(async () => ({
        artifacts: [
          {
            artifactId: 'a1',
            createdAt: '2026-01-01T00:00:00.000Z',
            mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            name: 'deck.pptx',
            sizeBytes: 3,
            status: 'ready' as const,
            type: 'pptx',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      })),
    } as unknown as PresentationGenerationCapability;
    const port = new PresentationGenerationPort(
      {
        artifactStore: store,
        capability,
        contextFactory: () => ({
          plannerContext: {},
          workerContext: {
            convert: vi.fn(),
            jobId: 'ignored',
            qualityCheck: vi.fn(),
            workspace: { path: '/tmp', write: vi.fn() },
          },
        }),
        idFactory: () => 'job-1',
      },
      scope,
    );

    const queued = await port.createJob(input);
    expect(queued).toMatchObject({ jobId: 'job-1', state: 'queued' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(port.getJob('job-1')).resolves.toMatchObject({
      state: 'completed',
      artifactIds: ['a1'],
    });
    expect(capability.execute).toHaveBeenCalledWith(
      scope,
      input,
      expect.objectContaining({ plannerContext: expect.objectContaining({ scope }) }),
    );
  });

  it('accepts prompt-only presentations when no source versions are attached', async () => {
    const capability = {
      execute: vi.fn(async () => ({ artifacts: [] })),
    } as unknown as PresentationGenerationCapability;
    const port = new PresentationGenerationPort(
      {
        artifactStore: new InMemoryPresentationArtifactStore(),
        capability,
        contextFactory: () => ({
          plannerContext: {},
          workerContext: {
            convert: vi.fn(),
            jobId: 'ignored',
            qualityCheck: vi.fn(),
            workspace: { path: '/tmp', write: vi.fn() },
          },
        }),
        idFactory: () => 'job-prompt-only',
      },
      scope,
    );

    await expect(
      port.createJob({ notebookId: 'studio', sourceVersionIds: [], title: '仅提示词演示' }),
    ).resolves.toMatchObject({ jobId: 'job-prompt-only', state: 'queued' });
  });

  it('runs requested image slots before planning so assets can be referenced by the planner', async () => {
    const imageGenerationCapability = {
      generate: vi.fn(async () => ({ slots: [{ slotId: 'hero', state: 'ready' }] })),
    } as unknown as ImageGenerationCapability;
    const capability = {
      execute: vi.fn(async (_scope: unknown, receivedInput: typeof input) => ({
        artifacts: [],
        input: receivedInput,
      })),
    } as unknown as PresentationGenerationCapability;
    const port = new PresentationGenerationPort(
      {
        artifactStore: new InMemoryPresentationArtifactStore(),
        capability,
        contextFactory: () => ({
          plannerContext: {},
          workerContext: {
            convert: vi.fn(),
            jobId: 'ignored',
            qualityCheck: vi.fn(),
            workspace: { path: '/tmp', write: vi.fn() },
          },
        }),
        idFactory: () => 'job-images',
        imageGenerationCapability,
      },
      scope,
    );
    await port.createJob({
      ...input,
      options: { imageSlots: [{ slideId: 's1', slotId: 'hero', prompt: '封面' }] },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(imageGenerationCapability.generate).toHaveBeenCalledWith(
      scope,
      [
        expect.objectContaining({
          idempotencyKey: 'job-images:s1:hero',
          prompt: '封面',
          slideId: 's1',
          slotId: 'hero',
        }),
      ],
      expect.objectContaining({ jobId: 'job-images' }),
    );
    expect(capability.execute).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        options: expect.objectContaining({
          generatedImageSlots: [{ slotId: 'hero', state: 'ready' }],
        }),
      }),
      expect.anything(),
    );
  });

  it('cancels an in-flight generation without fabricating an artifact', async () => {
    let release!: () => void;
    const capability = {
      execute: vi.fn(
        () =>
          new Promise<never>((_, reject) => {
            release = () =>
              reject(
                Object.assign(new Error('cancelled'), { code: 'PRESENTATION_WORKER_CANCELLED' }),
              );
          }),
      ),
    } as unknown as PresentationGenerationCapability;
    const port = new PresentationGenerationPort(
      {
        artifactStore: new InMemoryPresentationArtifactStore(),
        capability,
        contextFactory: () => ({
          plannerContext: {},
          workerContext: {
            convert: vi.fn(),
            jobId: 'x',
            qualityCheck: vi.fn(),
            workspace: { path: '/tmp', write: vi.fn() },
          },
        }),
        idFactory: () => 'job-cancel',
      },
      scope,
    );
    await port.createJob(input);
    const cancelled = await port.cancelJob('job-cancel');
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelled.state).toBe('cancelled');
    await expect(port.getJob('job-cancel')).resolves.toMatchObject({ state: 'cancelled' });
  });

  it('handles cancellation idempotently across repeated cancels and terminal states', async () => {
    let idSeq = 0;
    const store = new InMemoryPresentationArtifactStore();
    const capability = {
      execute: vi.fn(async () => ({
        artifacts: [
          {
            artifactId: 'art-1',
            createdAt: '2026-01-01T00:00:00.000Z',
            mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            name: 'deck.pptx',
            sizeBytes: 10,
            status: 'ready' as const,
            type: 'pptx',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      })),
    } as never;
    const port = new PresentationGenerationPort(
      {
        artifactStore: store,
        capability,
        contextFactory: () => ({
          plannerContext: {},
          workerContext: {
            convert: vi.fn(),
            jobId: 'x',
            qualityCheck: vi.fn(),
            workspace: { path: '/tmp', write: vi.fn() },
          },
        }),
        idFactory: () => `job-${++idSeq}`,
      },
      scope,
    );

    // 1. Unknown job throws PRESENTATION_NOT_FOUND
    await expect(port.cancelJob('non-existent')).rejects.toMatchObject({
      code: 'PRESENTATION_NOT_FOUND',
    });

    // 2. Cancel in queued/running state
    const job1 = await port.createJob(input);
    const cancel1 = await port.cancelJob(job1.jobId);
    expect(cancel1.state).toBe('cancelled');

    // 3. Repeated cancellation returns stable cancelled state
    const cancel1Repeat = await port.cancelJob(job1.jobId);
    expect(cancel1Repeat.state).toBe('cancelled');

    // 4. Completed job cancellation returns stable completed state
    const job2 = await port.createJob(input);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await port.getJob(job2.jobId))?.state).toBe('completed');
    const cancel2 = await port.cancelJob(job2.jobId);
    expect(cancel2.state).toBe('completed');
  });

  it('retries a failed or cancelled job by creating a new job and preserving original terminal state', async () => {
    let idSeq = 0;
    const store = new InMemoryPresentationArtifactStore();
    let shouldFail = true;
    const capability = {
      execute: vi.fn(async () => {
        if (shouldFail) {
          throw Object.assign(new Error('Generation failed'), { code: 'PRESENTATION_FAILED' });
        }
        return {
          artifacts: [
            {
              artifactId: 'art-success',
              createdAt: '2026-01-01T00:00:00.000Z',
              mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
              name: 'deck.pptx',
              sizeBytes: 10,
              status: 'ready' as const,
              type: 'pptx',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        };
      }),
    } as never;
    const port = new PresentationGenerationPort(
      {
        artifactStore: store,
        capability,
        contextFactory: () => ({
          plannerContext: {},
          workerContext: {
            convert: vi.fn(),
            jobId: 'x',
            qualityCheck: vi.fn(),
            workspace: { path: '/tmp', write: vi.fn() },
          },
        }),
        idFactory: () => `job-${++idSeq}`,
      },
      scope,
    );

    const initialJob = await port.createJob(input);
    expect(initialJob.jobId).toBe('job-1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Verify initial job failed
    const failedJob = await port.getJob('job-1');
    expect(failedJob?.state).toBe('failed');

    // Retry should create job-2
    shouldFail = false;
    const retriedJob = await port.retryJob('job-1');
    expect(retriedJob.jobId).toBe('job-2');
    expect(retriedJob.state).toBe('queued');

    await new Promise((resolve) => setTimeout(resolve, 0));

    // Original job remains failed
    const originalAfterRetry = await port.getJob('job-1');
    expect(originalAfterRetry?.state).toBe('failed');

    // New job succeeds
    const completedRetriedJob = await port.getJob('job-2');
    expect(completedRetriedJob?.state).toBe('completed');
    expect(completedRetriedJob?.artifactIds).toEqual(['art-success']);
  });

  describe('R4-A Acceptance: 4-phase cancellation & failure persistence', () => {
    it('cancels during planner phase and maintains terminal cancelled state', async () => {
      const store = new InMemoryPresentationArtifactStore();
      let plannerAbortSignal: AbortSignal | undefined;

      const capability = {
        execute: vi.fn(async (_scope, _input, context) => {
          plannerAbortSignal = context.plannerContext.abortSignal;
          // Simulate long running planner
          return new Promise((_, reject) => {
            context.plannerContext.abortSignal?.addEventListener('abort', () => {
              reject(
                Object.assign(new Error('Planner aborted'), {
                  code: 'PRESENTATION_WORKER_CANCELLED',
                }),
              );
            });
          });
        }),
      } as unknown as PresentationGenerationCapability;

      const port = new PresentationGenerationPort(
        {
          artifactStore: store,
          capability,
          contextFactory: () => ({
            plannerContext: {},
            workerContext: {
              convert: vi.fn(),
              jobId: 'x',
              qualityCheck: vi.fn(),
              workspace: { path: '/tmp', write: vi.fn() },
            },
          }),
          idFactory: () => 'job-cancel-planner',
        },
        scope,
      );

      await port.createJob(input);
      await new Promise((resolve) => setTimeout(resolve, 5));

      const cancelled = await port.cancelJob('job-cancel-planner');
      expect(cancelled.state).toBe('cancelled');
      expect(plannerAbortSignal?.aborted).toBe(true);

      // Repeat cancel is idempotent
      const repeat = await port.cancelJob('job-cancel-planner');
      expect(repeat.state).toBe('cancelled');
    });

    it('cancels during image generation phase and aborts image provider call', async () => {
      const store = new InMemoryPresentationArtifactStore();
      let imageAbortSignal: AbortSignal | undefined;

      const imageGenerationCapability = {
        generate: vi.fn(async (_scope, _slots, options) => {
          imageAbortSignal = options.signal;
          return new Promise((_, reject) => {
            options.signal?.addEventListener('abort', () => {
              reject(
                Object.assign(new Error('Image generation aborted'), { code: 'IMAGE_CANCELLED' }),
              );
            });
          });
        }),
      } as unknown as ImageGenerationCapability;

      const port = new PresentationGenerationPort(
        {
          artifactStore: store,
          capability: { execute: vi.fn() } as unknown as PresentationGenerationCapability,
          contextFactory: () => ({
            plannerContext: {},
            workerContext: {
              convert: vi.fn(),
              jobId: 'x',
              qualityCheck: vi.fn(),
              workspace: { path: '/tmp', write: vi.fn() },
            },
          }),
          idFactory: () => 'job-cancel-img',
          imageGenerationCapability,
        },
        scope,
      );

      await port.createJob({
        ...input,
        options: { imageSlots: [{ prompt: 'img', slideId: 's1', slotId: 'hero' }] },
      });
      await new Promise((resolve) => setTimeout(resolve, 5));

      const cancelled = await port.cancelJob('job-cancel-img');
      expect(cancelled.state).toBe('cancelled');
      expect(imageAbortSignal?.aborted).toBe(true);

      const queried = await port.getJob('job-cancel-img');
      expect(queried?.state).toBe('cancelled');
    });

    it('cancels during worker page rendering / export phase', async () => {
      const store = new InMemoryPresentationArtifactStore();
      let workerAbortSignal: AbortSignal | undefined;

      const capability = {
        execute: vi.fn(async (_scope, _input, context) => {
          workerAbortSignal = context.workerContext.abortSignal;
          return new Promise((_, reject) => {
            context.workerContext.abortSignal?.addEventListener('abort', () => {
              reject(
                Object.assign(new Error('Worker cancelled'), {
                  code: 'PRESENTATION_WORKER_CANCELLED',
                }),
              );
            });
          });
        }),
      } as unknown as PresentationGenerationCapability;

      const port = new PresentationGenerationPort(
        {
          artifactStore: store,
          capability,
          contextFactory: () => ({
            plannerContext: {},
            workerContext: {
              convert: vi.fn(),
              jobId: 'x',
              qualityCheck: vi.fn(),
              workspace: { path: '/tmp', write: vi.fn() },
            },
          }),
          idFactory: () => 'job-cancel-worker',
        },
        scope,
      );

      await port.createJob(input);
      await new Promise((resolve) => setTimeout(resolve, 5));

      const cancelled = await port.cancelJob('job-cancel-worker');
      expect(cancelled.state).toBe('cancelled');
      expect(workerAbortSignal?.aborted).toBe(true);
    });

    it('persists specific error codes for IMAGE_BUDGET_EXCEEDED, PRESENTATION_QUALITY_FAILED, and WORKER_FAILED', async () => {
      const store = new InMemoryPresentationArtifactStore();

      // 1. IMAGE_BUDGET_EXCEEDED
      const imageBudgetCap = {
        generate: vi.fn(async () => {
          throw Object.assign(new Error('Budget exceeded'), { code: 'IMAGE_BUDGET_EXCEEDED' });
        }),
      } as unknown as ImageGenerationCapability;

      const portImg = new PresentationGenerationPort(
        {
          artifactStore: store,
          capability: { execute: vi.fn() } as unknown as PresentationGenerationCapability,
          contextFactory: () => ({
            plannerContext: {},
            workerContext: {
              convert: vi.fn(),
              jobId: 'x',
              qualityCheck: vi.fn(),
              workspace: { path: '/tmp', write: vi.fn() },
            },
          }),
          idFactory: () => 'job-err-budget',
          imageGenerationCapability: imageBudgetCap,
        },
        scope,
      );

      await portImg.createJob({
        ...input,
        options: { imageSlots: [{ prompt: 'exceed', slideId: 's1', slotId: 'img' }] },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const budgetFailedJob = await portImg.getJob('job-err-budget');
      expect(budgetFailedJob).toMatchObject({
        error: expect.objectContaining({ code: 'IMAGE_BUDGET_EXCEEDED' }),
        state: 'failed',
      });

      // 2. PRESENTATION_QUALITY_FAILED
      const qualityFailedCap = {
        execute: vi.fn(async () => {
          throw Object.assign(new Error('Quality score too low'), {
            code: 'PRESENTATION_QUALITY_FAILED',
          });
        }),
      } as unknown as PresentationGenerationCapability;

      const portQuality = new PresentationGenerationPort(
        {
          artifactStore: store,
          capability: qualityFailedCap,
          contextFactory: () => ({
            plannerContext: {},
            workerContext: {
              convert: vi.fn(),
              jobId: 'x',
              qualityCheck: vi.fn(),
              workspace: { path: '/tmp', write: vi.fn() },
            },
          }),
          idFactory: () => 'job-err-quality',
        },
        scope,
      );

      await portQuality.createJob(input);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const qualityFailedJob = await portQuality.getJob('job-err-quality');
      expect(qualityFailedJob).toMatchObject({
        error: expect.objectContaining({ code: 'PRESENTATION_QUALITY_FAILED' }),
        state: 'failed',
      });

      // 3. PRESENTATION_WORKER_FAILED
      const workerFailedCap = {
        execute: vi.fn(async () => {
          throw Object.assign(new Error('PPTX generation failed'), {
            code: 'PRESENTATION_WORKER_FAILED',
          });
        }),
      } as unknown as PresentationGenerationCapability;

      const portWorker = new PresentationGenerationPort(
        {
          artifactStore: store,
          capability: workerFailedCap,
          contextFactory: () => ({
            plannerContext: {},
            workerContext: {
              convert: vi.fn(),
              jobId: 'x',
              qualityCheck: vi.fn(),
              workspace: { path: '/tmp', write: vi.fn() },
            },
          }),
          idFactory: () => 'job-err-worker',
        },
        scope,
      );

      await portWorker.createJob(input);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const workerFailedJob = await portWorker.getJob('job-err-worker');
      expect(workerFailedJob).toMatchObject({
        error: expect.objectContaining({ code: 'PRESENTATION_WORKER_FAILED' }),
        state: 'failed',
      });
    });
  });
});
