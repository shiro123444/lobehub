import type {
  ArtifactSnapshot,
  PlannerContext,
  PresentationJobInput,
  PresentationPlan,
  RuntimeScope,
} from '../../../../packages/runtime-contracts/src';
import { persistPresentationWorkerArtifacts } from './artifact-bridge';
import type { PresentationArtifactStore } from './artifact-store';
import type {
  PresentationGenerationPipeline,
  PresentationGenerationResult,
  PresentationPipelineContext,
} from './pipeline';
import type { PresentationJobEventPublisherPort } from './publisher';
import type { PresentationWorkerResult } from './worker';

export interface PresentationGenerationCapabilityResult {
  artifacts: readonly ArtifactSnapshot[];
  plan: PresentationPlan;
  worker: PresentationWorkerResult;
}

export class PresentationGenerationCapabilityError extends Error {
  constructor(
    public readonly code: 'GENERATION_SCOPE_INVALID' | 'GENERATION_INPUT_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'PresentationGenerationCapabilityError';
  }
}

export interface PresentationGenerationCapabilityOptions {
  readonly eventPublisher?: PresentationJobEventPublisherPort;
  /** Short alias for callers wiring the publication seam explicitly. */
  readonly publisher?: PresentationJobEventPublisherPort;
}

const clone = <T>(value: T): T => {
  if (value instanceof Uint8Array) return new Uint8Array(value) as T;
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>))
      out[key] = clone(nested);
    return out as T;
  }
  return value;
};

const validScope = (scope: RuntimeScope): boolean =>
  typeof scope?.userId === 'string' &&
  scope.userId.trim().length > 0 &&
  typeof scope?.sessionId === 'string' &&
  scope.sessionId.trim().length > 0;

export class PresentationGenerationCapability {
  private readonly eventPublisher?: PresentationJobEventPublisherPort;
  private disposed = false;

  constructor(
    private readonly pipeline: PresentationGenerationPipeline,
    private readonly store: PresentationArtifactStore,
    options: PresentationGenerationCapabilityOptions = {},
  ) {
    this.eventPublisher = options.eventPublisher ?? options.publisher;
  }

  async plan(input: PresentationJobInput, context: PlannerContext): Promise<PresentationPlan> {
    if (!this.pipeline.plan)
      throw Object.assign(new Error('Revision planner is unavailable'), {
        code: 'PROVIDER_UNAVAILABLE',
      });
    return this.pipeline.plan(input, context);
  }

  async execute(
    scope: RuntimeScope,
    input: PresentationJobInput,
    context: PresentationPipelineContext,
  ): Promise<PresentationGenerationCapabilityResult> {
    if (this.disposed) {
      throw new PresentationGenerationCapabilityError(
        'GENERATION_SCOPE_INVALID',
        'Presentation generation capability has been disposed',
      );
    }
    if (!validScope(scope))
      throw new PresentationGenerationCapabilityError(
        'GENERATION_SCOPE_INVALID',
        'userId and sessionId must be non-empty',
      );
    if (
      !input ||
      typeof input !== 'object' ||
      !Array.isArray(input.sourceVersionIds) ||
      typeof input.title !== 'string' ||
      !input.title.trim()
    ) {
      throw new PresentationGenerationCapabilityError(
        'GENERATION_INPUT_INVALID',
        'Presentation input is invalid',
      );
    }
    const publisher = context.eventPublisher ?? context.publisher ?? this.eventPublisher;
    if (publisher) publisher.assertScope(scope);
    const generationContext = publisher
      ? {
          ...context,
          eventPublisher: publisher,
          eventScope: scope,
        }
      : context;
    const generated: PresentationGenerationResult = await this.pipeline.run(clone(input), {
      ...generationContext,
      plannerContext: { ...generationContext.plannerContext, scope },
      workerContext: { ...generationContext.workerContext, scope },
    });
    const artifacts = await persistPresentationWorkerArtifacts(scope, generated.worker, this.store);
    return clone({ plan: generated.plan, worker: generated.worker, artifacts });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.eventPublisher?.dispose();
    await this.pipeline.dispose?.();
  }
}

export const createPresentationGenerationCapability = (
  pipeline: PresentationGenerationPipeline,
  store: PresentationArtifactStore,
  options: PresentationGenerationCapabilityOptions = {},
) => new PresentationGenerationCapability(pipeline, store, options);
