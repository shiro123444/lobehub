import type {
  ArtifactSnapshot,
  ExportResult,
  PresentationJob,
  PresentationJobInput,
  PresentationPort,
  RuntimeScope,
} from '../../../../packages/runtime-contracts/src';
import type { PresentationArtifactStore, StoredArtifact } from './artifact-store';
import type { PresentationGenerationContextFactory } from './composition';
import type { PresentationGenerationCapability } from './generation-capability';
import type { PresentationGenerationEventPublisherFactory } from './generation-handler';
import type { ImageGenerationCapability } from './image-generation-capability';
import type { ImageGenerationSlot } from './image-generation-planner';

export interface PresentationGenerationPortScope extends RuntimeScope {
  readonly request: Request;
}

export interface PresentationGenerationPortOptions {
  readonly artifactStore: PresentationArtifactStore;
  readonly capability: PresentationGenerationCapability;
  readonly contextFactory: PresentationGenerationContextFactory;
  readonly eventPublisherFactory?: PresentationGenerationEventPublisherFactory;
  readonly idFactory?: () => string;
  readonly imageGenerationCapability?: ImageGenerationCapability;
  readonly now?: () => string;
}

const clone = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      output[key] = clone(nested);
    }
    return output as T;
  }
  return value;
};

const normalizeInput = (value: PresentationJobInput): PresentationJobInput | undefined => {
  if (!value || typeof value !== 'object') return;
  const input = value as PresentationJobInput & { options?: Record<string, unknown> };
  const notebookId =
    input.notebookId === undefined || input.notebookId === ''
      ? 'studio'
      : typeof input.notebookId === 'string' && input.notebookId.trim()
        ? input.notebookId.trim()
        : undefined;
  const prompt =
    typeof input.prompt === 'string' && input.prompt.trim()
      ? input.prompt.trim()
      : typeof input.options?.prompt === 'string' && input.options.prompt.trim()
        ? input.options.prompt.trim()
        : undefined;
  const title =
    input.title === undefined || input.title === ''
      ? prompt?.split(/\r?\n/, 1)[0]?.trim().slice(0, 120) || '智能演示文稿'
      : typeof input.title === 'string' && input.title.trim()
        ? input.title.trim()
        : undefined;
  const sourceVersionIds =
    input.sourceVersionIds === undefined
      ? []
      : Array.isArray(input.sourceVersionIds) &&
          input.sourceVersionIds.every((id) => typeof id === 'string' && id.trim())
        ? input.sourceVersionIds.map((id) => id.trim())
        : undefined;
  if (!notebookId || !title || !sourceVersionIds) return;
  return {
    ...input,
    notebookId,
    title,
    sourceVersionIds,
    ...(prompt ? { prompt } : {}),
  };
};

const errorSnapshot = (error: unknown): PresentationJob['error'] => ({
  code:
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'PRESENTATION_INTERNAL_ERROR',
  message: error instanceof Error ? error.message : 'Presentation generation failed',
});

/**
 * Bridges the asynchronous generation pipeline to the legacy PresentationPort
 * surface used by `/jobs`. Creation returns a queued job immediately; the
 * planner, image capability and ppt-master worker continue in the background.
 */
export class PresentationGenerationPort implements PresentationPort {
  private readonly jobs = new Map<
    string,
    {
      input: PresentationJobInput;
      job: PresentationJob;
      controller: AbortController;
      task: Promise<void>;
    }
  >();
  private sequence = 0;
  private disposed = false;
  private readonly now: () => string;
  private readonly idFactory: () => string;

  constructor(
    private readonly options: PresentationGenerationPortOptions,
    private readonly scope: PresentationGenerationPortScope,
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? (() => `presentation-${Date.now()}-${++this.sequence}`);
  }

  async createJob(input: PresentationJobInput): Promise<PresentationJob> {
    if (this.disposed)
      throw Object.assign(new Error('Presentation generation port is disposed'), {
        code: 'PROVIDER_UNAVAILABLE',
      });
    const normalizedInput = normalizeInput(input);
    if (!normalizedInput)
      throw Object.assign(new Error('notebookId, title and sourceVersionIds are required'), {
        code: 'PRESENTATION_INVALID',
      });
    const jobId = this.idFactory();
    const timestamp = this.now();
    const controller = new AbortController();
    const job: PresentationJob = {
      jobId,
      state: 'queued',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const task = this.run(jobId, normalizedInput, controller);
    this.jobs.set(jobId, { controller, input: clone(normalizedInput), job, task });
    return clone(job);
  }

  async getJob(jobId: string): Promise<PresentationJob | null> {
    const entry = this.jobs.get(jobId);
    if (!entry) return null;
    let artifactIds = entry.job.artifactIds;
    if (this.options.artifactStore.listByJob && (!artifactIds || artifactIds.length === 0)) {
      try {
        const stored = await this.options.artifactStore.listByJob(this.scope, jobId);
        if (stored.length > 0) {
          artifactIds = stored.map((s) => s.artifactId);
        }
      } catch {
        // Non-fatal if listByJob fails
      }
    }
    return clone({
      ...entry.job,
      ...(artifactIds && artifactIds.length > 0 ? { artifactIds } : {}),
    });
  }

  async cancelJob(jobId: string): Promise<PresentationJob> {
    const entry = this.jobs.get(jobId);
    if (!entry)
      throw Object.assign(new Error(`Presentation job does not exist: ${jobId}`), {
        code: 'PRESENTATION_NOT_FOUND',
      });
    if (entry.job.state === 'queued' || entry.job.state === 'running') {
      entry.controller.abort();
      entry.job = { ...entry.job, state: 'cancelled', updatedAt: this.now() };
    }
    return clone(entry.job);
  }

  async retryJob(jobId: string): Promise<PresentationJob> {
    const entry = this.jobs.get(jobId);
    if (!entry)
      throw Object.assign(new Error(`Presentation job does not exist: ${jobId}`), {
        code: 'PRESENTATION_NOT_FOUND',
      });
    if (entry.job.state === 'running' || entry.job.state === 'queued') return clone(entry.job);
    return this.createJob(entry.input);
  }

  async getArtifact(artifactId: string): Promise<ArtifactSnapshot | null> {
    try {
      const stored = await this.options.artifactStore.get(this.scope, artifactId);
      if (!stored) return null;
      const { bytes: _bytes, ...snapshot } = stored;
      return {
        ...snapshot,
        status: snapshot.status ?? 'ready',
        uri:
          snapshot.uri ?? `/api/runtime/presentation/artifacts/${encodeURIComponent(artifactId)}`,
      };
    } catch {
      // Single-artifact read failure is isolated to this artifact
      return null;
    }
  }

  async getRawArtifact(artifactId: string): Promise<StoredArtifact | null> {
    try {
      return await this.options.artifactStore.get(this.scope, artifactId);
    } catch {
      return null;
    }
  }

  async exportArtifact(
    artifactId: string,
    format: 'pptx' | 'svg' | 'pdf' | 'quality-report',
  ): Promise<ExportResult> {
    const artifact = await this.getArtifact(artifactId);
    if (!artifact)
      throw Object.assign(new Error(`Artifact does not exist: ${artifactId}`), {
        code: 'PRESENTATION_NOT_FOUND',
      });
    if (format !== 'pptx' && format !== 'svg' && format !== 'pdf' && format !== 'quality-report')
      throw Object.assign(new Error(`Unsupported export format: ${format}`), {
        code: 'PRESENTATION_INVALID',
      });
    const uri =
      artifact.uri ?? `/api/runtime/presentation/artifacts/${encodeURIComponent(artifactId)}`;
    if (!uri || !uri.trim()) {
      throw Object.assign(new Error(`Artifact URI is unavailable for export: ${artifactId}`), {
        code: 'PRESENTATION_NOT_FOUND',
      });
    }
    return {
      artifactId,
      format,
      mimeType:
        artifact.mimeType ??
        (format === 'pptx'
          ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
          : format === 'svg'
            ? 'image/svg+xml'
            : 'application/pdf'),
      uri,
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.jobs.values()) entry.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map(({ task }) => task));
  }

  private async run(
    jobId: string,
    input: PresentationJobInput,
    controller: AbortController,
  ): Promise<void> {
    const update = (patch: Partial<PresentationJob>): void => {
      const entry = this.jobs.get(jobId);
      if (!entry) return;
      if (entry.job.state === 'cancelled' && patch.state !== 'cancelled') return;
      if (controller.signal.aborted && patch.state !== 'cancelled') return;
      entry.job = { ...entry.job, ...patch, updatedAt: this.now() };
    };
    // Defer one turn so createJob can return the queued snapshot first.
    await Promise.resolve();
    if (controller.signal.aborted) {
      update({ state: 'cancelled' });
      return;
    }
    update({ state: 'running' });
    try {
      const context = this.options.contextFactory(jobId);
      const publisher = this.options.eventPublisherFactory
        ? await this.options.eventPublisherFactory(this.scope, jobId, this.scope.request)
        : undefined;
      try {
        let generationInput = clone(input);
        const slots = (generationInput.options as { imageSlots?: unknown[] } | undefined)
          ?.imageSlots;
        let imageArtifactIds: string[] = [];
        if (Array.isArray(slots) && slots.length > 0) {
          if (controller.signal.aborted) return;
          if (!this.options.imageGenerationCapability) {
            throw Object.assign(new Error('Image generation provider is not configured'), {
              code: 'PROVIDER_UNAVAILABLE',
            });
          }
          const validatedSlots: ImageGenerationSlot[] = slots.map((rawSlot, index) => {
            if (!rawSlot || typeof rawSlot !== 'object') {
              throw Object.assign(new Error(`imageSlots[${index}] must be an object`), {
                code: 'PRESENTATION_INVALID',
                path: `options.imageSlots[${index}]`,
              });
            }
            const slot = rawSlot as Record<string, unknown>;
            const slotId =
              typeof slot.slotId === 'string' && slot.slotId.trim()
                ? slot.slotId.trim()
                : `slot-${index + 1}`;
            const slideId =
              typeof slot.slideId === 'string' && slot.slideId.trim()
                ? slot.slideId.trim()
                : `slide-${index + 1}`;
            const prompt =
              typeof slot.prompt === 'string' && slot.prompt.trim()
                ? slot.prompt.trim()
                : undefined;
            if (!prompt) {
              throw Object.assign(new Error(`imageSlots[${index}].prompt is required`), {
                code: 'PRESENTATION_INVALID',
                path: `options.imageSlots[${index}].prompt`,
              });
            }
            const idempotencyKey =
              typeof slot.idempotencyKey === 'string' && slot.idempotencyKey.trim()
                ? slot.idempotencyKey.trim()
                : `${jobId}:${slideId}:${slotId}`;
            return {
              ...slot,
              idempotencyKey,
              prompt,
              slideId,
              slotId,
            } as ImageGenerationSlot;
          });

          const images = await this.options.imageGenerationCapability.generate(
            this.scope,
            validatedSlots,
            { jobId, signal: controller.signal },
          );
          imageArtifactIds = (images.slots ?? []).flatMap((slot) =>
            (slot.assetRefs ?? []).map((ref) => ref.ref.trim()),
          );
          generationInput = {
            ...generationInput,
            options: {
              ...generationInput.options,
              generatedImageSlots: images.slots,
              imageSlots: validatedSlots,
            },
          };
        }
        if (controller.signal.aborted) return;
        const produced = await this.options.capability.execute(this.scope, generationInput, {
          ...context,
          plannerContext: {
            ...context.plannerContext,
            abortSignal: controller.signal,
            scope: this.scope,
          },
          workerContext: { ...context.workerContext, abortSignal: controller.signal },
          ...(publisher ? { eventPublisher: publisher, eventScope: this.scope } : {}),
        });
        if (controller.signal.aborted) return;
        const allArtifactIds = [
          ...imageArtifactIds,
          ...produced.artifacts.map((artifact) => artifact.artifactId),
        ];
        update({
          state: 'completed',
          artifactIds: [...new Set(allArtifactIds)],
        });
      } finally {
        publisher?.dispose();
      }
    } catch (error) {
      update({
        state: controller.signal.aborted ? 'cancelled' : 'failed',
        error: controller.signal.aborted ? undefined : errorSnapshot(error),
      });
    }
  }
}

export const createPresentationGenerationPort = (
  options: PresentationGenerationPortOptions,
  scope: PresentationGenerationPortScope,
): PresentationGenerationPort => new PresentationGenerationPort(options, scope);
