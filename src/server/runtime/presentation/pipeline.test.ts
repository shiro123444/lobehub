import { describe, expect, it, vi } from 'vitest';

import type {
  PresentationPlan,
  PresentationPlanner,
} from '../../../../packages/runtime-contracts/src';
import { PresentationJobEventJournal } from './job-event-journal';
import { PresentationGenerationPipelineImpl } from './pipeline';
import { PRESENTATION_JOB_EVENT_TYPES, PresentationJobEventPublisher } from './publisher';

const plan: PresentationPlan = {
  planId: 'p',
  title: 'Deck',
  aspectRatio: '16:9',
  sourceVersionIds: ['v'],
  slides: [{ slideId: 's', order: 0, svg: '<svg />', metadata: { nested: { ok: true } } }],
};
const input = { notebookId: 'n', sourceVersionIds: ['v'], title: 'Deck' };
const workerResult = {
  jobId: 'job-1',
  planId: 'p',
  qualityReport: { passed: true, details: { score: 1 } },
  artifacts: [
    {
      artifactId: 'a',
      bytes: new Uint8Array([1]),
      mimeType: 'x',
      name: 'a',
      type: 'pptx',
      metadata: { nested: { ok: true } },
    },
  ],
};
const context = {
  plannerContext: {},
  workerContext: {
    jobId: 'job-1',
    workspace: { path: '/tmp', write: async () => undefined },
    qualityCheck: async () => ({ passed: true }),
    convert: async () => [],
  },
};

describe('C-54 generation pipeline', () => {
  it('runs planner then worker with same plan and clones boundaries', async () => {
    let planned: PresentationPlan | undefined;
    const planner: PresentationPlanner = {
      plan: vi.fn(async () => {
        planned = plan;
        return plan;
      }),
    };
    const worker = {
      run: vi.fn(async (value: PresentationPlan) => {
        expect(value).toBe(planned);
        return workerResult;
      }),
    };
    const result = await new PresentationGenerationPipelineImpl(planner, worker).run(
      input,
      context,
    );
    expect(planner.plan).toHaveBeenCalledBefore(worker.run);
    result.plan.slides[0]!.metadata!.nested = { ok: false };
    result.worker.artifacts[0]!.bytes[0] = 9;
    expect(plan.slides[0]!.metadata).toEqual({ nested: { ok: true } });
    expect(workerResult.artifacts[0]!.bytes).toEqual(new Uint8Array([1]));
  });
  it('short-circuits invalid plan and preserves planner/worker errors', async () => {
    const worker = { run: vi.fn(async () => workerResult) };
    const planner = { plan: vi.fn(async () => ({ ...plan, slides: [] })) } as PresentationPlanner;
    await expect(
      new PresentationGenerationPipelineImpl(planner, worker).run(input, context),
    ).rejects.toMatchObject({ code: 'PLAN_INVALID' });
    expect(worker.run).not.toHaveBeenCalled();
    const error = new Error('planner');
    const failing = {
      plan: vi.fn(async () => {
        throw error;
      }),
    } as PresentationPlanner;
    await expect(
      new PresentationGenerationPipelineImpl(failing, worker).run(input, context),
    ).rejects.toBe(error);
  });
  it('validates job id and forwards cancellation signal', async () => {
    await expect(
      new PresentationGenerationPipelineImpl(
        { plan: vi.fn(async () => plan) },
        { run: vi.fn(async () => workerResult) },
      ).run(input, { ...context, workerContext: { ...context.workerContext, jobId: ' ' } }),
    ).rejects.toThrow();
    const controller = new AbortController();
    const planner = {
      plan: vi.fn(async (_input, ctx) => {
        expect(ctx.abortSignal).toBe(controller.signal);
        return plan;
      }),
    } as PresentationPlanner;
    await new PresentationGenerationPipelineImpl(planner, {
      run: vi.fn(async () => workerResult),
    }).run(input, {
      ...context,
      workerContext: { ...context.workerContext, abortSignal: controller.signal },
    });
  });

  it('publishes accepted, phase, artifact-ready, and completed snapshots in order', async () => {
    const journal = new PresentationJobEventJournal({
      scope: { userId: 'user-1', sessionId: 'session-1' },
    });
    const publisher = new PresentationJobEventPublisher({
      journal,
      scope: { userId: 'user-1', sessionId: 'session-1' },
      now: () => '2026-08-30T00:00:00.000Z',
    });
    const pipeline = new PresentationGenerationPipelineImpl(
      { plan: vi.fn(async () => plan) },
      { run: vi.fn(async () => workerResult) },
      { eventPublisher: publisher, scope: { userId: 'user-1', sessionId: 'session-1' } },
    );

    await pipeline.run(input, context);

    const events = journal.replay('job-1');
    expect(events.map(({ type, seq }) => [type, seq])).toEqual([
      [PRESENTATION_JOB_EVENT_TYPES.accepted, 1],
      [PRESENTATION_JOB_EVENT_TYPES.queued, 2],
      [PRESENTATION_JOB_EVENT_TYPES.plannerStarted, 3],
      [PRESENTATION_JOB_EVENT_TYPES.workerStarted, 4],
      [PRESENTATION_JOB_EVENT_TYPES.artifactReady, 5],
      [PRESENTATION_JOB_EVENT_TYPES.completed, 6],
    ]);
    expect(events.at(-1)?.data).toMatchObject({ job: { state: 'completed' } });
    expect(
      events.find(({ type }) => type === PRESENTATION_JOB_EVENT_TYPES.artifactReady)?.data,
    ).toEqual(
      expect.objectContaining({
        artifact: expect.objectContaining({ artifactId: 'a', status: 'ready', sizeBytes: 1 }),
      }),
    );
    expect(JSON.stringify(events)).not.toContain('bytes');
  });

  it('publishes a failed terminal snapshot while preserving the planner error', async () => {
    const journal = new PresentationJobEventJournal();
    const publisher = new PresentationJobEventPublisher(journal);
    const plannerError = new Error('planner exploded');
    const pipeline = new PresentationGenerationPipelineImpl(
      {
        plan: vi.fn(async () => {
          throw plannerError;
        }),
      },
      { run: vi.fn(async () => workerResult) },
      { eventPublisher: publisher },
    );

    await expect(pipeline.run(input, context)).rejects.toBe(plannerError);

    const events = journal.replay('job-1');
    expect(events.at(-1)).toMatchObject({ type: PRESENTATION_JOB_EVENT_TYPES.failed });
    expect(events.at(-1)?.data).toMatchObject({
      job: { state: 'failed', error: { message: 'planner exploded' } },
    });
  });
});
