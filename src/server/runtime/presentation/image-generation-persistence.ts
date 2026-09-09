/**
 * C-102 server-only image-generation plan persistence seam.
 *
 * Prompts are retained only in this private persistence shape. Callers that
 * cross an SSE/UI boundary must use `toWire()`, whose projection deliberately
 * omits prompts, bytes, paths and workspaces. The repository is asynchronous
 * so a durable adapter can replace the in-memory implementation later.
 */

import type { AssetRef, RuntimeScope } from '../../../../packages/runtime-contracts/src';
import type { PresentationAssetSnapshot } from './asset-store';

export type ImageGenerationPersistedState =
  | 'accepted'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'queued'
  | 'running';

export type ImageGenerationPersistedSlotState =
  | 'cancelled'
  | 'failed'
  | 'pending'
  | 'ready'
  | 'running';

export interface ImageGenerationSlotPlan {
  readonly count?: number;
  readonly idempotencyKey?: string;
  readonly prompt: string;
  readonly quality?: string;
  readonly size?: string;
  readonly slideId: string;
  readonly slotId: string;
}

export interface ImageGenerationPersistedSlot extends ImageGenerationSlotPlan {
  readonly artifactSnapshots?: readonly PresentationAssetSnapshot[];
  readonly assetRefs?: readonly AssetRef[];
  readonly error?: ImageGenerationPersistedError;
  readonly state: ImageGenerationPersistedSlotState;
}

export interface ImageGenerationPersistedError {
  readonly code: string;
  readonly message: string;
}

export interface ImageGenerationPersistedJob {
  readonly artifactSnapshots: readonly PresentationAssetSnapshot[];
  readonly createdAt: string;
  readonly error?: ImageGenerationPersistedError;
  readonly idempotencyKey?: string;
  readonly jobId: string;
  readonly scope: RuntimeScope;
  readonly slots: readonly ImageGenerationPersistedSlot[];
  readonly state: ImageGenerationPersistedState;
  readonly updatedAt: string;
}

/** UI/SSE-safe projection; prompt-bearing fields are intentionally absent. */
export interface ImageGenerationJobWireSnapshot {
  readonly artifactSnapshots: readonly PresentationAssetSnapshot[];
  readonly createdAt: string;
  readonly error?: ImageGenerationPersistedError;
  readonly jobId: string;
  readonly scope: RuntimeScope;
  readonly slots: readonly ImageGenerationWireSlot[];
  readonly state: ImageGenerationPersistedState;
  readonly updatedAt: string;
}

export interface ImageGenerationWireSlot {
  readonly artifactSnapshots?: readonly PresentationAssetSnapshot[];
  readonly assetRefs?: readonly AssetRef[];
  readonly error?: ImageGenerationPersistedError;
  readonly slideId: string;
  readonly slotId: string;
  readonly state: ImageGenerationPersistedSlotState;
}

export interface ImageGenerationPlanCreateInput {
  readonly artifactSnapshots?: readonly PresentationAssetSnapshot[];
  readonly idempotencyKey?: string;
  readonly jobId: string;
  readonly slots: readonly ImageGenerationSlotPlan[];
  readonly state?: ImageGenerationPersistedState;
}

export interface ImageGenerationPlanUpdate {
  readonly artifactSnapshots?: readonly PresentationAssetSnapshot[];
  readonly error?: ImageGenerationPersistedError;
  readonly idempotencyKey?: string;
  readonly slots?: readonly ImageGenerationPersistedSlot[];
  readonly state?: ImageGenerationPersistedState;
}

export interface ImageGenerationPlanRepository {
  get: (scope: RuntimeScope, jobId: string) => Promise<ImageGenerationPersistedJob | null>;
  put: (
    scope: RuntimeScope,
    job: ImageGenerationPersistedJob,
  ) => Promise<ImageGenerationPersistedJob>;
  remove: (scope: RuntimeScope, jobId: string) => Promise<void>;
}

export interface ImageGenerationPersistenceOptions {
  readonly now?: () => string;
  readonly repository?: ImageGenerationPlanRepository;
}

export type ImageGenerationPersistenceErrorCode =
  | 'IMAGE_PLAN_IDEMPOTENCY_CONFLICT'
  | 'IMAGE_PLAN_INVALID'
  | 'IMAGE_PLAN_NOT_FOUND'
  | 'IMAGE_PLAN_PERSISTENCE_DISPOSED'
  | 'IMAGE_PLAN_SCOPE_MISMATCH'
  | 'IMAGE_PLAN_STATE_INVALID';

export class ImageGenerationPersistenceError extends Error {
  constructor(
    public readonly code: ImageGenerationPersistenceErrorCode,
    message: string,
    public readonly path?: string,
  ) {
    super(message);
    this.name = 'ImageGenerationPersistenceError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const unsafeKey = (key: string): boolean =>
  /^(?:bytes?|buffer|path|workspace(?:Path)?|prompt|negativePrompt|apiKey|secret|token|password|authorization|argv|command|cookie)$/iu.test(
    key,
  );

const invalid = (message: string, path?: string): ImageGenerationPersistenceError =>
  new ImageGenerationPersistenceError('IMAGE_PLAN_INVALID', message, path);

const scopeMismatch = (message: string, path = 'scope'): ImageGenerationPersistenceError =>
  new ImageGenerationPersistenceError('IMAGE_PLAN_SCOPE_MISMATCH', message, path);

const normalizeScope = (value: unknown): RuntimeScope => {
  if (!isRecord(value) || !nonEmpty(value.userId) || !nonEmpty(value.sessionId)) {
    throw scopeMismatch('userId and sessionId must be non-empty strings');
  }
  return { sessionId: value.sessionId.trim(), userId: value.userId.trim() };
};

const scopeKey = (scope: RuntimeScope): string =>
  JSON.stringify([scope.userId.trim(), scope.sessionId.trim()]);

const sameScope = (left: RuntimeScope, right: RuntimeScope): boolean =>
  left.userId === right.userId && left.sessionId === right.sessionId;

const cloneValue = <T>(value: T): T => {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
};

const projectWireValue = (
  value: unknown,
  key: string | undefined,
  seen: WeakSet<object>,
): unknown => {
  if (key && unsafeKey(key)) return undefined;
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    return value
      .map((item) => projectWireValue(item, undefined, seen))
      .filter((item): item is Exclude<typeof item, undefined> => item !== undefined);
  }
  if (!isPlainRecord(value)) return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  const output: Record<string, unknown> = {};
  for (const [nestedKey, nestedValue] of Object.entries(value)) {
    const projected = projectWireValue(nestedValue, nestedKey, seen);
    if (projected !== undefined) output[nestedKey] = projected;
  }
  return output;
};

const cloneSafe = <T>(value: T): T =>
  projectWireValue(value, undefined, new WeakSet<object>()) as T;

const normalizeString = (value: unknown, path: string): string => {
  if (!nonEmpty(value)) throw invalid(`${path} must be non-empty`, path);
  return value.trim();
};

const normalizeOptionalString = (value: unknown, path: string): string | undefined => {
  if (value === undefined) return undefined;
  return normalizeString(value, path);
};

const normalizeCount = (value: unknown, path: string): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw invalid(`${path} must be a positive safe integer`, path);
  }
  return value as number;
};

const normalizeAssetSnapshot = (value: unknown, path: string): PresentationAssetSnapshot => {
  if (!isPlainRecord(value)) throw invalid(`${path} must be an asset snapshot`, path);
  if (!isPlainRecord(value.asset)) {
    throw invalid(`${path}.asset must be an object`, `${path}.asset`);
  }
  const ref = normalizeString(value.asset.ref, `${path}.asset.ref`);
  if (!isPlainRecord(value.metadata)) {
    throw invalid(`${path}.metadata must be an object`, `${path}.metadata`);
  }
  const metadata = cloneSafe(value.metadata) as Record<string, unknown>;
  return {
    asset: {
      ref,
      ...(isPlainRecord(value.asset.metadata) ? { metadata: cloneSafe(value.asset.metadata) } : {}),
    },
    metadata: {
      ...metadata,
      ...(nonEmpty(metadata.createdAt) ? { createdAt: metadata.createdAt } : {}),
      ...(nonEmpty(metadata.mimeType) ? { mimeType: metadata.mimeType } : {}),
    } as PresentationAssetSnapshot['metadata'],
  };
};

const normalizeAssetSnapshots = (value: unknown, path: string): PresentationAssetSnapshot[] => {
  if (!Array.isArray(value)) throw invalid(`${path} must be an array`, path);
  return value.map((candidate, index) => normalizeAssetSnapshot(candidate, `${path}[${index}]`));
};

const validStates: readonly ImageGenerationPersistedState[] = [
  'accepted',
  'cancelled',
  'completed',
  'failed',
  'queued',
  'running',
];

const validSlotStates: readonly ImageGenerationPersistedSlotState[] = [
  'cancelled',
  'failed',
  'pending',
  'ready',
  'running',
];

const normalizeState = (value: unknown, path: string): ImageGenerationPersistedState => {
  if (typeof value !== 'string' || !validStates.includes(value as ImageGenerationPersistedState)) {
    throw new ImageGenerationPersistenceError(
      'IMAGE_PLAN_STATE_INVALID',
      `${path} is not a valid image-generation state`,
      path,
    );
  }
  return value as ImageGenerationPersistedState;
};

const normalizeSlotState = (value: unknown, path: string): ImageGenerationPersistedSlotState => {
  if (
    typeof value !== 'string' ||
    !validSlotStates.includes(value as ImageGenerationPersistedSlotState)
  ) {
    throw new ImageGenerationPersistenceError(
      'IMAGE_PLAN_STATE_INVALID',
      `${path} is not a valid image-generation slot state`,
      path,
    );
  }
  return value as ImageGenerationPersistedSlotState;
};

const normalizeError = (value: unknown, path: string): ImageGenerationPersistedError => {
  if (!isPlainRecord(value)) throw invalid(`${path} must be an error object`, path);
  return {
    code: normalizeString(value.code, `${path}.code`),
    message: normalizeString(value.message, `${path}.message`),
  };
};

const normalizeAssetRef = (value: unknown, path: string): AssetRef => {
  if (!isPlainRecord(value)) throw invalid(`${path} must be an asset ref`, path);
  const ref = normalizeString(value.ref, `${path}.ref`);
  if (
    ref.startsWith('/') ||
    ref.startsWith('./') ||
    ref.startsWith('../') ||
    /^[a-z]:[\\/]/iu.test(ref) ||
    ref.startsWith('file:')
  ) {
    throw invalid(`${path}.ref must be an opaque non-path reference`, `${path}.ref`);
  }
  return {
    ref,
    ...(isPlainRecord(value.metadata) ? { metadata: cloneSafe(value.metadata) } : {}),
  };
};

const normalizeAssetRefs = (value: unknown, path: string): AssetRef[] => {
  if (!Array.isArray(value)) throw invalid(`${path} must be an array`, path);
  return value.map((candidate, index) => normalizeAssetRef(candidate, `${path}[${index}]`));
};

const normalizeSlotPlan = (value: unknown, path: string): ImageGenerationSlotPlan => {
  if (!isPlainRecord(value)) throw invalid(`${path} must be an object`, path);
  return {
    count: normalizeCount(value.count, `${path}.count`),
    idempotencyKey: normalizeOptionalString(value.idempotencyKey, `${path}.idempotencyKey`),
    prompt: normalizeString(value.prompt, `${path}.prompt`),
    quality: normalizeOptionalString(value.quality, `${path}.quality`),
    size: normalizeOptionalString(value.size, `${path}.size`),
    slideId: normalizeString(value.slideId, `${path}.slideId`),
    slotId: normalizeString(value.slotId, `${path}.slotId`),
  };
};

const slotKey = (slot: Pick<ImageGenerationSlotPlan, 'slideId' | 'slotId'>): string =>
  `${slot.slideId}\u0000${slot.slotId}`;

const normalizeSlots = (value: unknown, path: string): ImageGenerationPersistedSlot[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid(`${path} must be a non-empty array`, path);
  }
  const seen = new Set<string>();
  return value.map((candidate, index) => {
    const slotPath = `${path}[${index}]`;
    const plan = normalizeSlotPlan(candidate, slotPath);
    const key = slotKey(plan);
    if (seen.has(key)) throw invalid('slotId must be unique within a job', slotPath);
    seen.add(key);
    const record = isPlainRecord(candidate) ? candidate : {};
    return {
      ...plan,
      ...(record.artifactSnapshots === undefined
        ? {}
        : {
            artifactSnapshots: normalizeAssetSnapshots(
              record.artifactSnapshots,
              `${slotPath}.artifactSnapshots`,
            ),
          }),
      ...(record.assetRefs === undefined
        ? {}
        : { assetRefs: normalizeAssetRefs(record.assetRefs, `${slotPath}.assetRefs`) }),
      ...(record.error === undefined
        ? {}
        : { error: normalizeError(record.error, `${slotPath}.error`) }),
      state: normalizeSlotState(record.state ?? 'pending', `${slotPath}.state`),
    };
  });
};

const normalizeJob = (value: unknown, scope: RuntimeScope): ImageGenerationPersistedJob => {
  if (!isPlainRecord(value)) throw invalid('job must be an object', 'job');
  const jobScope = normalizeScope(value.scope);
  if (!sameScope(jobScope, scope)) throw scopeMismatch('job scope does not match requested scope');
  const jobId = normalizeString(value.jobId, 'jobId');
  const createdAt = normalizeString(value.createdAt, 'createdAt');
  const updatedAt = normalizeString(value.updatedAt, 'updatedAt');
  const artifactSnapshots = normalizeAssetSnapshots(
    value.artifactSnapshots ?? [],
    'artifactSnapshots',
  );
  return {
    artifactSnapshots,
    createdAt,
    ...(value.error === undefined ? {} : { error: normalizeError(value.error, 'error') }),
    ...(value.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: normalizeString(value.idempotencyKey, 'idempotencyKey') }),
    jobId,
    scope: jobScope,
    slots: normalizeSlots(value.slots, 'slots'),
    state: normalizeState(value.state, 'state'),
    updatedAt,
  };
};

const slotFingerprint = (slot: ImageGenerationSlotPlan): string =>
  JSON.stringify({
    count: slot.count ?? 1,
    idempotencyKey: slot.idempotencyKey ?? null,
    prompt: slot.prompt,
    quality: slot.quality ?? null,
    size: slot.size ?? null,
    slideId: slot.slideId,
    slotId: slot.slotId,
  });

const planFingerprint = (job: Pick<ImageGenerationPersistedJob, 'slots'>): string =>
  JSON.stringify(job.slots.map(slotFingerprint));

const copyJob = (job: ImageGenerationPersistedJob): ImageGenerationPersistedJob => cloneValue(job);

const copyScope = (scope: RuntimeScope): RuntimeScope => ({
  sessionId: scope.sessionId,
  userId: scope.userId,
});

const toWireError = (error: ImageGenerationPersistedError): ImageGenerationPersistedError => ({
  code: error.code,
  message: error.message,
});

/** Safe projection for SSE/UI callers; no prompt-bearing field is copied. */
export const toImageGenerationJobWireSnapshot = (
  job: ImageGenerationPersistedJob,
): ImageGenerationJobWireSnapshot => ({
  artifactSnapshots: cloneSafe(job.artifactSnapshots),
  createdAt: job.createdAt,
  ...(job.error ? { error: toWireError(job.error) } : {}),
  jobId: job.jobId,
  scope: copyScope(job.scope),
  slots: job.slots.map((slot) => ({
    ...(slot.artifactSnapshots ? { artifactSnapshots: cloneSafe(slot.artifactSnapshots) } : {}),
    ...(slot.assetRefs ? { assetRefs: cloneSafe(slot.assetRefs) } : {}),
    ...(slot.error ? { error: toWireError(slot.error) } : {}),
    slideId: slot.slideId,
    slotId: slot.slotId,
    state: slot.state,
  })),
  state: job.state,
  updatedAt: job.updatedAt,
});

class MapImageGenerationPlanRepository implements ImageGenerationPlanRepository {
  private readonly jobs = new Map<string, ImageGenerationPersistedJob>();
  private readonly owners = new Map<string, string>();

  async get(scope: RuntimeScope, jobId: string): Promise<ImageGenerationPersistedJob | null> {
    const normalizedScope = normalizeScope(scope);
    const normalizedJobId = normalizeString(jobId, 'jobId');
    const owner = this.owners.get(normalizedJobId);
    const key = `${scopeKey(normalizedScope)}\u0000${normalizedJobId}`;
    if (owner && owner !== scopeKey(normalizedScope)) {
      throw scopeMismatch('job belongs to another authenticated scope');
    }
    const job = this.jobs.get(key);
    return job ? copyJob(job) : null;
  }

  async put(
    scope: RuntimeScope,
    job: ImageGenerationPersistedJob,
  ): Promise<ImageGenerationPersistedJob> {
    const normalizedScope = normalizeScope(scope);
    const normalizedJob = normalizeJob(job, normalizedScope);
    const ownerKey = scopeKey(normalizedScope);
    const existingOwner = this.owners.get(normalizedJob.jobId);
    if (existingOwner && existingOwner !== ownerKey) {
      throw scopeMismatch('job belongs to another authenticated scope');
    }
    const key = `${ownerKey}\u0000${normalizedJob.jobId}`;
    const existing = this.jobs.get(key);
    if (existing && planFingerprint(existing) !== planFingerprint(normalizedJob)) {
      throw new ImageGenerationPersistenceError(
        'IMAGE_PLAN_IDEMPOTENCY_CONFLICT',
        'jobId is already bound to another slot plan',
        'jobId',
      );
    }
    this.jobs.set(key, copyJob(normalizedJob));
    this.owners.set(normalizedJob.jobId, ownerKey);
    return copyJob(normalizedJob);
  }

  async remove(scope: RuntimeScope, jobId: string): Promise<void> {
    const normalizedScope = normalizeScope(scope);
    const normalizedJobId = normalizeString(jobId, 'jobId');
    const ownerKey = scopeKey(normalizedScope);
    const owner = this.owners.get(normalizedJobId);
    if (owner && owner !== ownerKey)
      throw scopeMismatch('job belongs to another authenticated scope');
    this.jobs.delete(`${ownerKey}\u0000${normalizedJobId}`);
    if (owner === ownerKey) this.owners.delete(normalizedJobId);
  }
}

const validateRepository = (value: unknown): value is ImageGenerationPlanRepository =>
  isRecord(value) &&
  typeof value.get === 'function' &&
  typeof value.put === 'function' &&
  typeof value.remove === 'function';

/** Pure in-memory repository fake; state survives adapter recreation when reused. */
export class InMemoryImageGenerationPlanRepository extends MapImageGenerationPlanRepository {}

/** Async scope-safe persistence adapter for image slot plans and artifacts. */
export class ImageGenerationPersistencePort {
  private readonly now: () => string;
  private readonly repository: ImageGenerationPlanRepository;
  private disposed = false;

  constructor(options: ImageGenerationPersistenceOptions = {}) {
    if (!isPlainRecord(options)) throw invalid('options must be a plain object', 'options');
    const normalizedOptions = options as ImageGenerationPersistenceOptions;
    if (
      normalizedOptions.repository !== undefined &&
      !validateRepository(normalizedOptions.repository)
    ) {
      throw invalid('repository must provide async get/put/remove methods', 'repository');
    }
    if (normalizedOptions.now !== undefined && typeof normalizedOptions.now !== 'function') {
      throw invalid('now must be a function', 'now');
    }
    this.now = normalizedOptions.now ?? (() => new Date().toISOString());
    this.repository = normalizedOptions.repository ?? new InMemoryImageGenerationPlanRepository();
  }

  async create(
    scope: RuntimeScope,
    input: ImageGenerationPlanCreateInput,
  ): Promise<ImageGenerationPersistedJob> {
    this.assertOpen();
    const normalizedScope = normalizeScope(scope);
    if (!isPlainRecord(input)) throw invalid('input must be a plain object', 'input');
    const jobId = normalizeString(input.jobId, 'jobId');
    const slots = normalizeSlots(input.slots, 'slots');
    const candidate: ImageGenerationPersistedJob = {
      artifactSnapshots: normalizeAssetSnapshots(
        input.artifactSnapshots ?? [],
        'artifactSnapshots',
      ),
      createdAt: normalizeString(this.now(), 'now'),
      ...(input.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: normalizeString(input.idempotencyKey, 'idempotencyKey') }),
      jobId,
      scope: copyScope(normalizedScope),
      slots,
      state: input.state ?? 'accepted',
      updatedAt: normalizeString(this.now(), 'now'),
    };
    const existing = await this.repository.get(normalizedScope, jobId);
    if (existing) {
      const normalizedExisting = normalizeJob(existing, normalizedScope);
      if (planFingerprint(normalizedExisting) !== planFingerprint(candidate)) {
        throw new ImageGenerationPersistenceError(
          'IMAGE_PLAN_IDEMPOTENCY_CONFLICT',
          'jobId is already bound to another slot plan',
          'jobId',
        );
      }
      return copyJob(normalizedExisting);
    }
    return this.save(normalizedScope, candidate);
  }

  async get(scope: RuntimeScope, jobId: string): Promise<ImageGenerationPersistedJob | null> {
    this.assertOpen();
    const normalizedScope = normalizeScope(scope);
    const result = await this.repository.get(normalizedScope, normalizeString(jobId, 'jobId'));
    return result ? normalizeJob(result, normalizedScope) : null;
  }

  async require(scope: RuntimeScope, jobId: string): Promise<ImageGenerationPersistedJob> {
    const result = await this.get(scope, jobId);
    if (result) return result;
    throw new ImageGenerationPersistenceError(
      'IMAGE_PLAN_NOT_FOUND',
      'image-generation plan was not found',
      'jobId',
    );
  }

  async resume(scope: RuntimeScope, jobId: string): Promise<ImageGenerationPersistedJob> {
    return this.require(scope, jobId);
  }

  async save(
    scope: RuntimeScope,
    job: ImageGenerationPersistedJob,
  ): Promise<ImageGenerationPersistedJob> {
    this.assertOpen();
    const normalizedScope = normalizeScope(scope);
    const normalizedJob = normalizeJob(job, normalizedScope);
    return normalizeJob(await this.repository.put(normalizedScope, normalizedJob), normalizedScope);
  }

  async update(
    scope: RuntimeScope,
    jobId: string,
    update: ImageGenerationPlanUpdate,
  ): Promise<ImageGenerationPersistedJob> {
    this.assertOpen();
    const normalizedScope = normalizeScope(scope);
    const existing = await this.require(normalizedScope, jobId);
    if (!isPlainRecord(update)) throw invalid('update must be a plain object', 'update');
    const candidate: ImageGenerationPersistedJob = {
      ...existing,
      ...(update.artifactSnapshots === undefined
        ? {}
        : {
            artifactSnapshots: normalizeAssetSnapshots(
              update.artifactSnapshots,
              'artifactSnapshots',
            ),
          }),
      ...(update.error === undefined ? {} : { error: normalizeError(update.error, 'error') }),
      ...(update.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: normalizeString(update.idempotencyKey, 'idempotencyKey') }),
      ...(update.slots === undefined ? {} : { slots: normalizeSlots(update.slots, 'slots') }),
      ...(update.state === undefined ? {} : { state: normalizeState(update.state, 'state') }),
      updatedAt: normalizeString(this.now(), 'now'),
    };
    return this.save(normalizedScope, candidate);
  }

  async remove(scope: RuntimeScope, jobId: string): Promise<void> {
    this.assertOpen();
    await this.repository.remove(normalizeScope(scope), normalizeString(jobId, 'jobId'));
  }

  toWire(job: ImageGenerationPersistedJob): ImageGenerationJobWireSnapshot {
    this.assertOpen();
    const normalized = normalizeJob(job, normalizeScope(job.scope));
    return toImageGenerationJobWireSnapshot(normalized);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new ImageGenerationPersistenceError(
        'IMAGE_PLAN_PERSISTENCE_DISPOSED',
        'image-generation persistence has been disposed',
      );
    }
  }
}

export const createImageGenerationPersistence = (
  options?: ImageGenerationPersistenceOptions,
): ImageGenerationPersistencePort => new ImageGenerationPersistencePort(options);
