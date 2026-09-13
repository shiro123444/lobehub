import type {
  PlannerContext,
  PresentationJobInput,
  PresentationJobState,
  PresentationPlan,
  PresentationPlanner,
} from '../../../../packages/runtime-contracts/src';
import { validatePresentationPlan } from './planner';
import {
  createPresentationArtifactSnapshot,
  createPresentationJobSnapshot,
  PRESENTATION_JOB_EVENT_TYPES,
  type PresentationEventScope,
  PresentationJobEventPublisherError,
  type PresentationJobEventPublisherPort,
} from './publisher';
import type {
  InMemoryPresentationPlanWorker,
  PresentationWorkerContext,
  PresentationWorkerResult,
} from './worker';

export interface PresentationPipelineContext {
  readonly eventPublisher?: PresentationJobEventPublisherPort;
  readonly eventScope?: PresentationEventScope;
  readonly initialPlan?: PresentationPlan;
  plannerContext: PlannerContext;
  readonly preparePlan?: (plan: PresentationPlan) => Promise<PresentationPlan>;
  /** Short alias for callers constructing a context by hand. */
  readonly publisher?: PresentationJobEventPublisherPort;
  /** Short alias for callers constructing a context by hand. */
  readonly scope?: PresentationEventScope;
  workerContext: PresentationWorkerContext;
}

export interface PresentationGenerationResult {
  plan: PresentationPlan;
  worker: PresentationWorkerResult;
}

export interface PresentationGenerationPipeline {
  dispose?: () => void | Promise<void>;
  plan?: (input: PresentationJobInput, context: PlannerContext) => Promise<PresentationPlan>;
  run: (
    input: PresentationJobInput,
    context: PresentationPipelineContext,
  ) => Promise<PresentationGenerationResult>;
}

export interface PresentationGenerationPipelineOptions {
  readonly eventPublisher?: PresentationJobEventPublisherPort;
  readonly now?: () => string;
  readonly publisher?: PresentationJobEventPublisherPort;
  readonly scope?: PresentationEventScope;
}

const clone = <T>(value: T): T => {
  if (value instanceof Uint8Array) return new Uint8Array(value) as T;
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      const out: Record<string, unknown> = Object.create(prototype) as Record<string, unknown>;
      for (const [key, nested] of Object.entries(value as Record<string, unknown>))
        out[key] = clone(nested);
      return out as T;
    }
  }
  return value;
};

export class PresentationGenerationPipelineImpl implements PresentationGenerationPipeline {
  private readonly eventPublisher?: PresentationJobEventPublisherPort;
  private readonly now: () => string;
  private readonly scope?: PresentationEventScope;
  private disposed = false;

  constructor(
    private readonly planner: PresentationPlanner,
    private readonly worker: Pick<InMemoryPresentationPlanWorker, 'run'>,
    options: PresentationGenerationPipelineOptions | PresentationJobEventPublisherPort = {},
  ) {
    const resolvedOptions: PresentationGenerationPipelineOptions =
      'publish' in options && typeof options.publish === 'function'
        ? { eventPublisher: options }
        : options;
    this.eventPublisher = resolvedOptions.eventPublisher ?? resolvedOptions.publisher;
    this.now = resolvedOptions.now ?? (() => new Date().toISOString());
    this.scope = resolvedOptions.scope;
  }

  plan(input: PresentationJobInput, context: PlannerContext): Promise<PresentationPlan> {
    return this.planner.plan(input, context);
  }

  async run(
    input: PresentationJobInput,
    context: PresentationPipelineContext,
  ): Promise<PresentationGenerationResult> {
    if (this.disposed) {
      throw Object.assign(new Error('Presentation generation pipeline has been disposed'), {
        code: 'PRESENTATION_PIPELINE_DISPOSED',
      });
    }
    const jobId = context?.workerContext?.jobId;
    if (typeof jobId !== 'string' || jobId.trim().length === 0) {
      throw new Error('workerContext.jobId must be non-empty');
    }
    const publisher =
      context.eventPublisher ?? context.publisher ?? this.eventPublisher ?? undefined;
    const eventScope = context.eventScope ?? context.scope ?? this.scope;
    const createdAt = publisher ? this.now() : undefined;
    const publish = (
      type: string,
      state: PresentationJobState,
      idempotencyKey: string,
      extra: Record<string, unknown> = {},
      error?: unknown,
    ): void => {
      if (!publisher) return;
      publisher.assertScope(eventScope);
      const job = createPresentationJobSnapshot(jobId, state, {
        artifactIds: extra.artifactIds as readonly string[] | undefined,
        createdAt,
        error,
        now: this.now,
      });
      const { artifactIds: _artifactIds, ...eventExtra } = extra;
      publisher.publish({
        data: { job, ...eventExtra },
        idempotencyKey,
        jobId,
        type,
        ...(eventScope ? { scope: eventScope } : {}),
      });
    };
    const plannerInput = clone(input);
    const signal = context.workerContext.abortSignal;
    const plannerContext = signal
      ? { ...context.plannerContext, abortSignal: signal }
      : context.plannerContext;
    try {
      publish(PRESENTATION_JOB_EVENT_TYPES.accepted, 'queued', 'state:accepted', {
        activity: '正在接收创作需求',
        phase: 'accepted',
      });
      publish(PRESENTATION_JOB_EVENT_TYPES.queued, 'queued', 'state:queued', {
        activity: '正在准备创作环境',
        phase: 'queued',
      });
      publish(PRESENTATION_JOB_EVENT_TYPES.plannerStarted, 'running', 'phase:planner', {
        activity: '正在梳理内容与页面结构',
        phase: 'planner',
        ...(input.slideCount ? { totalSlides: input.slideCount } : {}),
      });

      let plan = context.initialPlan ?? (await this.planner.plan(plannerInput, plannerContext));
      if (context.preparePlan) plan = await context.preparePlan(plan);
      validatePresentationPlan(plan);
      publish(PRESENTATION_JOB_EVENT_TYPES.workerStarted, 'running', 'phase:worker', {
        activity: '正在生成页面与视觉素材',
        currentSlide: 1,
        phase: 'worker',
        totalSlides: plan.slides.length,
      });
      const workerContext = publisher
        ? {
            ...context.workerContext,
            eventPublisher: publisher,
            ...(eventScope ? { eventScope } : {}),
          }
        : context.workerContext;
      const worker = await this.worker.run(plan, workerContext);
      if (worker.jobId !== jobId) throw new Error('worker result jobId mismatch');

      const artifacts = worker.artifacts.map((artifact, index) =>
        createPresentationArtifactSnapshot(
          jobId,
          {
            ...artifact,
            artifactId: artifact.artifactId ?? `${jobId}:artifact:${index}`,
          },
          { now: this.now },
        ),
      );
      for (const [index, artifact] of artifacts.entries()) {
        publish(
          PRESENTATION_JOB_EVENT_TYPES.artifactReady,
          'running',
          `artifact-ready:${artifact.artifactId}`,
          {
            artifact,
            artifactIds: artifacts.slice(0, index + 1).map(({ artifactId }) => artifactId),
          },
        );
      }
      publish(PRESENTATION_JOB_EVENT_TYPES.completed, 'completed', 'terminal:completed', {
        artifactIds: artifacts.map(({ artifactId }) => artifactId),
        artifacts,
      });
      return { plan: clone(plan), worker: clone(worker) };
    } catch (error) {
      if (error instanceof PresentationJobEventPublisherError) throw error;
      const errorCode =
        error && typeof error === 'object' && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined;
      const cancelled = signal?.aborted || errorCode === 'PRESENTATION_WORKER_CANCELLED';
      const qualityFailed = errorCode === 'PRESENTATION_QUALITY_FAILED';
      try {
        publish(
          cancelled
            ? PRESENTATION_JOB_EVENT_TYPES.cancelled
            : qualityFailed
              ? PRESENTATION_JOB_EVENT_TYPES.qualityFailed
              : PRESENTATION_JOB_EVENT_TYPES.failed,
          cancelled ? 'cancelled' : 'failed',
          cancelled
            ? 'terminal:cancelled'
            : qualityFailed
              ? 'terminal:quality-failed'
              : 'terminal:failed',
          {},
          error,
        );
      } catch {
        // Preserve the planner/worker error when journal publication fails.
      }
      throw error;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.eventPublisher?.dispose();
  }
}

export const createPresentationGenerationPipeline = (
  planner: PresentationPlanner,
  worker: Pick<InMemoryPresentationPlanWorker, 'run'>,
  options: PresentationGenerationPipelineOptions | PresentationJobEventPublisherPort = {},
): PresentationGenerationPipeline =>
  new PresentationGenerationPipelineImpl(planner, worker, options);
