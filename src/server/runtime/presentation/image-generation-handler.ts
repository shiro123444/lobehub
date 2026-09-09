/**
 * C-91 server-only HTTP seam for the C-89 image-generation capability.
 *
 * This module parses one JSON request and projects one wire-safe response. It
 * deliberately receives the authenticated scope from the route boundary and
 * has no authentication, environment, storage, provider, or process logic.
 */

import type { RuntimeScope } from '../../../../packages/runtime-contracts/src';
import type { ImageGenerationCapability } from './image-generation-capability';
import type { ImageGenerationSlot } from './image-generation-planner';

export interface ImageGenerationHttpResponse {
  body: unknown;
  headers: { 'content-type': 'application/json' };
  status: number;
}

const headers = { 'content-type': 'application/json' } as const;

type ImageGenerationHttpErrorCode =
  | 'IMAGE_BUDGET_EXCEEDED'
  | 'IMAGE_CANCELLED'
  | 'IMAGE_PLAN_INVALID'
  | 'IMAGE_UNAVAILABLE'
  | 'PROVIDER_UNAVAILABLE';

const statusByCode: Record<ImageGenerationHttpErrorCode, number> = {
  IMAGE_BUDGET_EXCEEDED: 429,
  IMAGE_CANCELLED: 499,
  IMAGE_PLAN_INVALID: 400,
  IMAGE_UNAVAILABLE: 503,
  PROVIDER_UNAVAILABLE: 503,
};

const messageByCode: Record<ImageGenerationHttpErrorCode, string> = {
  IMAGE_BUDGET_EXCEEDED: 'Image generation budget exceeded.',
  IMAGE_CANCELLED: 'Image generation was cancelled.',
  IMAGE_PLAN_INVALID: 'Image generation request is invalid.',
  IMAGE_UNAVAILABLE: 'Image generation provider is unavailable.',
  PROVIDER_UNAVAILABLE: 'Image generation provider is not configured.',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const stableError = (code: ImageGenerationHttpErrorCode): Error =>
  Object.assign(new Error(messageByCode[code]), { code });

const errorCode = (error: unknown): ImageGenerationHttpErrorCode => {
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
  switch (code) {
    case 'IMAGE_BUDGET_EXCEEDED':
    case 'IMAGE_CANCELLED':
    case 'IMAGE_PLAN_INVALID':
    case 'IMAGE_UNAVAILABLE':
    case 'PROVIDER_UNAVAILABLE': {
      return code;
    }
    case 'IMAGE_PAYLOAD_INVALID': {
      return 'IMAGE_UNAVAILABLE';
    }
    default: {
      return 'IMAGE_UNAVAILABLE';
    }
  }
};

const errorResponse = (error: unknown): ImageGenerationHttpResponse => {
  const code = errorCode(error);
  return {
    body: { error: { code, message: messageByCode[code] } },
    headers,
    status: statusByCode[code],
  };
};

const invalid = (): Error => stableError('IMAGE_PLAN_INVALID');

const normalizeScope = (value: unknown): RuntimeScope => {
  if (!isRecord(value) || !nonEmptyString(value.userId) || !nonEmptyString(value.sessionId)) {
    throw invalid();
  }
  return { sessionId: value.sessionId.trim(), userId: value.userId.trim() };
};

const sameScope = (left: RuntimeScope, right: RuntimeScope): boolean =>
  left.userId === right.userId && left.sessionId === right.sessionId;

const optionalString = (value: unknown): string | undefined => {
  if (value === undefined) return;
  if (!nonEmptyString(value)) throw invalid();
  return value.trim();
};

const normalizeSlot = (value: unknown): ImageGenerationSlot => {
  if (!isPlainObject(value)) throw invalid();
  if (!nonEmptyString(value.slideId)) throw invalid();
  if (!nonEmptyString(value.slotId)) throw invalid();
  if (!nonEmptyString(value.prompt)) throw invalid();

  const countValue = value.count;
  let count: number | undefined;
  if (countValue !== undefined) {
    if (!Number.isSafeInteger(countValue) || typeof countValue !== 'number' || countValue < 1) {
      throw invalid();
    }
    count = countValue;
  }

  const size = optionalString(value.size);
  const quality = optionalString(value.quality);
  return {
    ...(count === undefined ? {} : { count }),
    prompt: value.prompt.trim(),
    ...(quality === undefined ? {} : { quality }),
    ...(size === undefined ? {} : { size }),
    slideId: value.slideId.trim(),
    slotId: value.slotId.trim(),
  };
};

const normalizeBody = (value: unknown): { jobId?: string; slots: ImageGenerationSlot[] } => {
  if (!isPlainObject(value) || !Array.isArray(value.slots) || value.slots.length === 0) {
    throw invalid();
  }
  const jobId = optionalString(value.jobId);
  return { ...(jobId === undefined ? {} : { jobId }), slots: value.slots.map(normalizeSlot) };
};

const unsafeKey = (key: string): boolean =>
  /^(?:bytes?|buffer|path|workspace(?:Path)?|prompt|negativePrompt|apiKey|secret|token|password|authorization|argv|command|cookie)$/iu.test(
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
  if (!isPlainObject(value)) return undefined;
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

const stableOutputCode = (value: unknown): ImageGenerationHttpErrorCode => {
  const code = isRecord(value) && typeof value.code === 'string' ? value.code : undefined;
  switch (code) {
    case 'IMAGE_BUDGET_EXCEEDED':
    case 'IMAGE_CANCELLED':
    case 'IMAGE_PLAN_INVALID':
    case 'IMAGE_UNAVAILABLE': {
      return code;
    }
    default: {
      return 'IMAGE_UNAVAILABLE';
    }
  }
};

const projectAssetRef = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value) || !nonEmptyString(value.ref)) throw stableError('IMAGE_UNAVAILABLE');
  const ref = value.ref.trim();
  if (localPath(ref)) throw stableError('IMAGE_UNAVAILABLE');
  const metadata =
    value.metadata === undefined
      ? undefined
      : projectSafeValue(value.metadata, undefined, new WeakSet<object>());
  return {
    ...(isPlainObject(metadata) && Object.keys(metadata).length > 0 ? { metadata } : {}),
    ref,
  };
};

const projectSlot = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value) || !nonEmptyString(value.slideId) || !nonEmptyString(value.slotId)) {
    throw stableError('IMAGE_UNAVAILABLE');
  }
  if (value.state !== 'cancelled' && value.state !== 'failed' && value.state !== 'ready') {
    throw stableError('IMAGE_UNAVAILABLE');
  }
  if (!Array.isArray(value.assetRefs)) throw stableError('IMAGE_UNAVAILABLE');
  return {
    assetRefs: value.assetRefs.map(projectAssetRef),
    ...(value.error !== undefined
      ? {
          error: {
            code: stableOutputCode(value.error),
            message: messageByCode[stableOutputCode(value.error)],
          },
        }
      : {}),
    slideId: value.slideId.trim(),
    slotId: value.slotId.trim(),
    state: value.state,
  };
};

const projectOutput = (value: unknown, scope: RuntimeScope): Record<string, unknown> => {
  if (!isRecord(value) || !nonEmptyString(value.jobId) || !isRecord(value.scope)) {
    throw stableError('IMAGE_UNAVAILABLE');
  }
  const outputScope = normalizeScope(value.scope);
  if (!sameScope(scope, outputScope)) throw invalid();
  if (!Array.isArray(value.slots)) throw stableError('IMAGE_UNAVAILABLE');
  return {
    jobId: value.jobId.trim(),
    scope: { sessionId: scope.sessionId, userId: scope.userId },
    slots: value.slots.map(projectSlot),
  };
};

/** Handles POST /api/runtime/presentation/image-generation. */
export const handleImageGenerationRequest = async (
  request: Request,
  scope: RuntimeScope,
  capability?: ImageGenerationCapability,
): Promise<ImageGenerationHttpResponse> => {
  try {
    if (request.method.toUpperCase() !== 'POST') throw invalid();
    const authenticatedScope = normalizeScope(scope);
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      throw invalid();
    }
    const input = normalizeBody(rawBody);
    if (!capability || typeof capability.generate !== 'function') {
      throw stableError('PROVIDER_UNAVAILABLE');
    }
    const result = await capability.generate(authenticatedScope, input.slots, {
      ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
      signal: request.signal,
    });
    return { body: projectOutput(result, authenticatedScope), headers, status: 200 };
  } catch (error) {
    return errorResponse(error);
  }
};
