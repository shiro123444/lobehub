/**
 * C-89 server-only capability wrapper for the C-84 image-generation planner.
 *
 * A planner and event publisher are created for one authenticated
 * scope/job invocation only. This module has no cache, provider discovery,
 * environment access, storage access beyond the injected port, or process
 * boundary.
 */

import type {
  AssetRef,
  ImageGenerationPort,
  RuntimeScope,
} from '../../../../packages/runtime-contracts/src';
import type { ImageGenerationEventPublisherPort } from './asset-events';
import type { PresentationAssetStore } from './asset-store';
import {
  ImageGenerationPlanner,
  type ImageGenerationPlanOutput,
  type ImageGenerationSlot,
} from './image-generation-planner';

export interface ImageGenerationCapabilityLimits {
  readonly concurrency?: number;
  readonly maxDurationMs?: number;
  readonly maxImages?: number;
  readonly maxRetries?: number;
}

export interface ImageGenerationCapabilityOptions {
  readonly assetStore: PresentationAssetStore;
  readonly eventPublisherFactory: ImageGenerationEventPublisherFactory;
  readonly imagePort: ImageGenerationPort;
  readonly limits?: ImageGenerationCapabilityLimits;
  readonly now?: () => number | string;
}

export interface ImageGenerationCapabilityGenerateOptions {
  readonly jobId?: string;
  readonly signal?: AbortSignal;
}

export type ImageGenerationEventPublisherFactory = (
  scope: RuntimeScope,
  jobId: string,
) => ImageGenerationEventPublisherPort | Promise<ImageGenerationEventPublisherPort>;

export type ImageGenerationCapabilityErrorCode =
  | 'IMAGE_BUDGET_EXCEEDED'
  | 'IMAGE_CANCELLED'
  | 'IMAGE_PLAN_INVALID'
  | 'IMAGE_UNAVAILABLE';

export class ImageGenerationCapabilityError extends Error {
  constructor(
    public readonly code: ImageGenerationCapabilityErrorCode,
    message: string,
    public readonly path?: string,
  ) {
    super(message);
    this.name = 'ImageGenerationCapabilityError';
  }
}

const ERROR_MESSAGES: Record<ImageGenerationCapabilityErrorCode, string> = {
  IMAGE_BUDGET_EXCEEDED: 'The image-generation budget was exceeded.',
  IMAGE_CANCELLED: 'Image generation was cancelled.',
  IMAGE_PLAN_INVALID: 'The image-generation plan is invalid.',
  IMAGE_UNAVAILABLE: 'The image provider is unavailable.',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const normalizeScope = (value: unknown): RuntimeScope => {
  if (!isRecord(value) || !nonEmptyString(value.userId) || !nonEmptyString(value.sessionId)) {
    throw new ImageGenerationCapabilityError(
      'IMAGE_PLAN_INVALID',
      ERROR_MESSAGES.IMAGE_PLAN_INVALID,
      'scope',
    );
  }
  return { sessionId: value.sessionId.trim(), userId: value.userId.trim() };
};

const hash = (value: string): string => {
  let result = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.codePointAt(index) ?? 0;
    result = Math.imul(result, 16_777_619);
  }
  return (result >>> 0).toString(16).padStart(8, '0');
};

const generatedJobId = (scope: RuntimeScope, slots: readonly ImageGenerationSlot[]): string =>
  `image-generation:${hash(JSON.stringify([scope.userId, scope.sessionId, slots]))}`;

const normalizeJobId = (
  scope: RuntimeScope,
  slots: readonly ImageGenerationSlot[],
  jobId: unknown,
): string => {
  if (jobId !== undefined && !nonEmptyString(jobId)) {
    throw new ImageGenerationCapabilityError(
      'IMAGE_PLAN_INVALID',
      ERROR_MESSAGES.IMAGE_PLAN_INVALID,
      'jobId',
    );
  }
  return typeof jobId === 'string' ? jobId.trim() : generatedJobId(scope, slots);
};

const unsafeKey = (key: string): boolean =>
  /^(?:bytes?|buffer|path|workspace(?:Path)?|prompt|negativePrompt|apiKey|secret|token|password|authorization|argv|command)$/iu.test(
    key,
  );

const projectSafeValue = (
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
      .map((item) => projectSafeValue(item, undefined, seen))
      .filter((item): item is Exclude<typeof item, undefined> => item !== undefined);
  }
  if (!isPlainRecord(value)) return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  const output: Record<string, unknown> = {};
  for (const [nestedKey, nestedValue] of Object.entries(value)) {
    const projected = projectSafeValue(nestedValue, nestedKey, seen);
    if (projected !== undefined) output[nestedKey] = projected;
  }
  return output;
};

const localPath = (value: string): boolean =>
  value.startsWith('/') ||
  value.startsWith('./') ||
  value.startsWith('../') ||
  /^[a-z]:[\\/]/iu.test(value) ||
  value.startsWith('file:');

const safeAssetRef = (value: unknown): AssetRef => {
  if (!isRecord(value) || !nonEmptyString(value.ref)) {
    throw new ImageGenerationCapabilityError(
      'IMAGE_UNAVAILABLE',
      ERROR_MESSAGES.IMAGE_UNAVAILABLE,
      'assetRefs',
    );
  }
  const ref = value.ref.trim();
  if (localPath(ref)) {
    throw new ImageGenerationCapabilityError(
      'IMAGE_UNAVAILABLE',
      ERROR_MESSAGES.IMAGE_UNAVAILABLE,
      'assetRefs.ref',
    );
  }
  const metadata =
    value.metadata === undefined
      ? undefined
      : projectSafeValue(value.metadata, undefined, new WeakSet<object>());
  return {
    ref,
    ...(isPlainRecord(metadata) && Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
};

const plannerCode = (value: unknown): ImageGenerationCapabilityErrorCode | undefined => {
  if (!isRecord(value) || typeof value.code !== 'string') return undefined;
  switch (value.code) {
    case 'IMAGE_BUDGET_EXCEEDED':
    case 'IMAGE_CANCELLED':
    case 'IMAGE_PLAN_INVALID':
    case 'IMAGE_UNAVAILABLE': {
      return value.code;
    }
    case 'IMAGE_PAYLOAD_INVALID': {
      return 'IMAGE_UNAVAILABLE';
    }
    default: {
      return undefined;
    }
  }
};

const isScopeMismatch = (value: unknown): boolean =>
  isRecord(value) && value.code === 'ASSET_SCOPE_MISMATCH';

const capabilityError = (error: unknown): ImageGenerationCapabilityError => {
  const code = plannerCode(error);
  if (code) {
    return new ImageGenerationCapabilityError(code, ERROR_MESSAGES[code]);
  }
  if (isScopeMismatch(error)) {
    return new ImageGenerationCapabilityError(
      'IMAGE_PLAN_INVALID',
      ERROR_MESSAGES.IMAGE_PLAN_INVALID,
      'scope',
    );
  }
  return new ImageGenerationCapabilityError('IMAGE_UNAVAILABLE', ERROR_MESSAGES.IMAGE_UNAVAILABLE);
};

const safeOutput = (output: ImageGenerationPlanOutput): ImageGenerationPlanOutput => ({
  jobId: nonEmptyString(output.jobId) ? output.jobId.trim() : 'image-generation:unknown',
  scope: { sessionId: output.scope.sessionId, userId: output.scope.userId },
  slots: output.slots.map((slot) => ({
    assetRefs: slot.assetRefs.map(safeAssetRef),
    ...(slot.error
      ? {
          error: (() => {
            const code = plannerCode(slot.error) ?? 'IMAGE_UNAVAILABLE';
            return { code, message: ERROR_MESSAGES[code] };
          })(),
        }
      : {}),
    slideId: slot.slideId,
    slotId: slot.slotId,
    state: slot.state,
  })),
});

const isPublisher = (value: unknown): value is ImageGenerationEventPublisherPort =>
  isRecord(value) &&
  typeof value.assertScope === 'function' &&
  typeof value.publish === 'function' &&
  typeof value.dispose === 'function';

const isAbortSignal = (value: unknown): value is AbortSignal =>
  isRecord(value) && typeof value.aborted === 'boolean';

/** Scope-safe, per-call capability facade over the C-84 planner. */
export class ImageGenerationCapability {
  private readonly assetStore: PresentationAssetStore;
  private readonly eventPublisherFactory: ImageGenerationEventPublisherFactory;
  private readonly imagePort: ImageGenerationPort;
  private readonly limits: ImageGenerationCapabilityLimits;
  private readonly now?: () => number | string;

  constructor(options: ImageGenerationCapabilityOptions) {
    if (!isRecord(options)) {
      throw new ImageGenerationCapabilityError(
        'IMAGE_PLAN_INVALID',
        ERROR_MESSAGES.IMAGE_PLAN_INVALID,
      );
    }
    if (!isRecord(options.imagePort) || typeof options.imagePort.generate !== 'function') {
      throw new ImageGenerationCapabilityError(
        'IMAGE_PLAN_INVALID',
        ERROR_MESSAGES.IMAGE_PLAN_INVALID,
        'imagePort',
      );
    }
    if (!isRecord(options.assetStore) || typeof options.assetStore.put !== 'function') {
      throw new ImageGenerationCapabilityError(
        'IMAGE_PLAN_INVALID',
        ERROR_MESSAGES.IMAGE_PLAN_INVALID,
        'assetStore',
      );
    }
    if (typeof options.eventPublisherFactory !== 'function') {
      throw new ImageGenerationCapabilityError(
        'IMAGE_PLAN_INVALID',
        ERROR_MESSAGES.IMAGE_PLAN_INVALID,
        'eventPublisherFactory',
      );
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new ImageGenerationCapabilityError(
        'IMAGE_PLAN_INVALID',
        ERROR_MESSAGES.IMAGE_PLAN_INVALID,
        'now',
      );
    }
    this.assetStore = options.assetStore;
    this.eventPublisherFactory = options.eventPublisherFactory;
    this.imagePort = options.imagePort;
    this.limits = { ...options.limits };
    this.now = options.now;
  }

  async generate(
    scope: RuntimeScope,
    slots: readonly ImageGenerationSlot[],
    options: ImageGenerationCapabilityGenerateOptions = {},
  ): Promise<ImageGenerationPlanOutput> {
    const normalizedScope = normalizeScope(scope);
    if (!Array.isArray(slots)) {
      throw new ImageGenerationCapabilityError(
        'IMAGE_PLAN_INVALID',
        ERROR_MESSAGES.IMAGE_PLAN_INVALID,
        'slots',
      );
    }
    const rawOptions: unknown = options;
    if (!isRecord(rawOptions)) {
      throw new ImageGenerationCapabilityError(
        'IMAGE_PLAN_INVALID',
        ERROR_MESSAGES.IMAGE_PLAN_INVALID,
        'options',
      );
    }
    const signalValue = rawOptions.signal;
    if (signalValue !== undefined && !isAbortSignal(signalValue)) {
      throw new ImageGenerationCapabilityError(
        'IMAGE_PLAN_INVALID',
        ERROR_MESSAGES.IMAGE_PLAN_INVALID,
        'signal',
      );
    }

    const signal = signalValue;
    const jobId = normalizeJobId(normalizedScope, slots, rawOptions.jobId);
    let publisher: ImageGenerationEventPublisherPort | undefined;
    let output: ImageGenerationPlanOutput | undefined;
    let primaryError: unknown;
    let failed = false;
    try {
      const candidate = await this.eventPublisherFactory({ ...normalizedScope }, jobId);
      if (!isPublisher(candidate)) {
        throw new ImageGenerationCapabilityError(
          'IMAGE_PLAN_INVALID',
          ERROR_MESSAGES.IMAGE_PLAN_INVALID,
          'eventPublisherFactory',
        );
      }
      publisher = candidate;
      const planner = new ImageGenerationPlanner({
        ...this.limits,
        assetStore: this.assetStore,
        eventPublisher: publisher,
        imagePort: this.imagePort,
        ...(this.now === undefined ? {} : { now: this.now }),
      });
      output = safeOutput(
        await planner.plan({
          jobId,
          scope: normalizedScope,
          signal,
          slots,
        }),
      );
    } catch (error) {
      primaryError = error;
      failed = true;
    }

    let disposeError: unknown;
    if (publisher) {
      try {
        publisher.dispose();
      } catch (error) {
        disposeError = error;
      }
    }

    if (failed) {
      if (primaryError instanceof ImageGenerationCapabilityError) throw primaryError;
      throw capabilityError(primaryError);
    }
    if (disposeError !== undefined) throw capabilityError(disposeError);
    if (!output) {
      throw new ImageGenerationCapabilityError(
        'IMAGE_UNAVAILABLE',
        ERROR_MESSAGES.IMAGE_UNAVAILABLE,
      );
    }
    return output;
  }
}

export const createImageGenerationCapability = (
  options: ImageGenerationCapabilityOptions,
): ImageGenerationCapability => new ImageGenerationCapability(options);
