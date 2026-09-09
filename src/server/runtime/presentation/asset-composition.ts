/**
 * C-105 server-side asset composition port and in-memory fake.
 *
 * Implements a pluggable, vendor-neutral raster composition seam (C-105)
 * for combining multiple generated image assets into composite material.
 * Layers carry only geometry and opaque AssetRefs; bytes, local paths,
 * workspaces, and provider credentials never cross this seam.
 *
 * Fail-closed across scope, canvas, layer budget, geometry, MIME types,
 * and rotation. Supports scoped idempotency and cooperative cancellation.
 */

import type {
  AssetCompositionContext,
  AssetCompositionError,
  AssetCompositionErrorCode,
  AssetCompositionLayer,
  AssetCompositionLayerResult,
  AssetCompositionManifest,
  AssetCompositionPort,
  AssetCompositionRequest,
  AssetCompositionResult,
  AssetMetadata,
  AssetRef,
  RuntimeScope,
} from '../../../../packages/runtime-contracts/src';
import { ASSET_COMPOSITION_CANVAS } from '../../../../packages/runtime-contracts/src';

/** RunError-shaped failure with a stable asset-composition code. */
export class PresentationAssetCompositionError extends Error {
  readonly code: AssetCompositionErrorCode;
  readonly details?: Record<string, unknown>;
  readonly path?: string;

  constructor(
    code: AssetCompositionErrorCode,
    message: string,
    detailsOrPath?: Record<string, unknown> | string,
    path?: string,
  ) {
    super(message);
    this.name = 'PresentationAssetCompositionError';
    this.code = code;
    if (typeof detailsOrPath === 'string') {
      this.path = detailsOrPath;
    } else if (detailsOrPath && typeof detailsOrPath === 'object') {
      this.details = detailsOrPath;
      this.path = path ?? (typeof detailsOrPath.path === 'string' ? detailsOrPath.path : undefined);
    } else if (path) {
      this.path = path;
    }
  }
}

const FORBIDDEN_METADATA_KEYS =
  /^(?:bytes?|buffer|path|workspace|workspacePath|argv|command|secret|token|password|apiKey)$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isLocalOrUnsafeRef = (ref: string): boolean => {
  const trimmed = ref.trim();
  if (trimmed.length === 0) return true;
  return (
    trimmed.startsWith('/') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('\\') ||
    trimmed.startsWith('.\\') ||
    trimmed.startsWith('..\\') ||
    /^[a-z]:[\\/]/i.test(trimmed) ||
    trimmed.startsWith('file:') ||
    trimmed.startsWith('data:') ||
    trimmed.startsWith('base64:')
  );
};

const sanitizeWireRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (!isPlainRecord(value)) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (FORBIDDEN_METADATA_KEYS.test(key)) {
      continue;
    }
    if (val instanceof Uint8Array) {
      continue;
    }
    if (
      val === null ||
      typeof val === 'string' ||
      typeof val === 'boolean' ||
      (typeof val === 'number' && Number.isFinite(val))
    ) {
      output[key] = val;
    } else if (Array.isArray(val)) {
      const sanitizedArray = val
        .map((item) => (isPlainRecord(item) ? sanitizeWireRecord(item) : item))
        .filter(
          (item) =>
            item !== undefined &&
            !(item instanceof Uint8Array) &&
            (typeof item === 'string' ||
              typeof item === 'number' ||
              typeof item === 'boolean' ||
              item === null ||
              isPlainRecord(item)),
        );
      output[key] = sanitizedArray;
    } else if (isPlainRecord(val)) {
      const sanitizedNested = sanitizeWireRecord(val);
      if (sanitizedNested && Object.keys(sanitizedNested).length > 0) {
        output[key] = sanitizedNested;
      }
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
};

/**
 * Validates and normalizes an incoming AssetCompositionRequest.
 *
 * Ensures fail-closed enforcement of canvas dimensions, layer counts,
 * opaque asset references, bounding boxes, and field types.
 * Strips forbidden metadata properties (bytes, path, secrets).
 * Sorts layers by zIndex ascending, preserving tie order.
 */
export const validateAssetCompositionRequest = (
  raw: AssetCompositionRequest,
): AssetCompositionRequest => {
  if (!isPlainRecord(raw)) {
    throw new PresentationAssetCompositionError(
      'COMPOSITION_REQUEST_INVALID',
      'Asset composition request must be an object',
      'request',
    );
  }

  if (
    !isPlainRecord(raw.canvas) ||
    typeof raw.canvas.width !== 'number' ||
    typeof raw.canvas.height !== 'number' ||
    !Number.isFinite(raw.canvas.width) ||
    !Number.isFinite(raw.canvas.height) ||
    raw.canvas.width <= 0 ||
    raw.canvas.height <= 0 ||
    raw.canvas.width > ASSET_COMPOSITION_CANVAS.maxWidth ||
    raw.canvas.height > ASSET_COMPOSITION_CANVAS.maxHeight
  ) {
    throw new PresentationAssetCompositionError(
      'COMPOSITION_REQUEST_INVALID',
      'Invalid canvas dimensions',
      'canvas',
    );
  }

  const canvasWidth = raw.canvas.width;
  const canvasHeight = raw.canvas.height;

  if (
    !isPlainRecord(raw.output) ||
    typeof raw.output.mimeType !== 'string' ||
    !raw.output.mimeType.startsWith('image/')
  ) {
    throw new PresentationAssetCompositionError(
      'COMPOSITION_REQUEST_INVALID',
      'Invalid output mimeType',
      'output.mimeType',
    );
  }

  if (
    raw.output.quality !== undefined &&
    (typeof raw.output.quality !== 'number' ||
      !Number.isFinite(raw.output.quality) ||
      raw.output.quality < 1 ||
      raw.output.quality > 100)
  ) {
    throw new PresentationAssetCompositionError(
      'COMPOSITION_REQUEST_INVALID',
      'Invalid output quality: must be between 1 and 100',
      'output.quality',
    );
  }

  if (!Array.isArray(raw.layers) || raw.layers.length === 0) {
    throw new PresentationAssetCompositionError(
      'COMPOSITION_REQUEST_INVALID',
      'Layers must be a non-empty array',
      'layers',
    );
  }

  if (raw.layers.length > ASSET_COMPOSITION_CANVAS.maxLayers) {
    throw new PresentationAssetCompositionError(
      'COMPOSITION_BUDGET_EXCEEDED',
      `Layer count (${raw.layers.length}) exceeds canvas limit (${ASSET_COMPOSITION_CANVAS.maxLayers})`,
      'layers',
    );
  }

  if (
    raw.idempotencyKey !== undefined &&
    (typeof raw.idempotencyKey !== 'string' || raw.idempotencyKey.trim().length === 0)
  ) {
    throw new PresentationAssetCompositionError(
      'COMPOSITION_REQUEST_INVALID',
      'Invalid idempotencyKey: must be non-empty string',
      'idempotencyKey',
    );
  }

  const seenLayerIds = new Set<string>();
  const normalizedLayers: (AssetCompositionLayer & { originalIndex: number })[] = [];

  for (let index = 0; index < raw.layers.length; index += 1) {
    const layer = raw.layers[index] as unknown as Record<string, unknown>;
    if (!isPlainRecord(layer)) {
      throw new PresentationAssetCompositionError(
        'COMPOSITION_LAYER_INVALID',
        `Layer at index ${index} must be an object`,
        `layers[${index}]`,
      );
    }

    if (!nonEmptyString(layer.layerId)) {
      throw new PresentationAssetCompositionError(
        'COMPOSITION_LAYER_INVALID',
        `Layer at index ${index} must have a non-empty layerId`,
        `layers[${index}].layerId`,
      );
    }

    const trimmedLayerId = layer.layerId.trim();
    if (seenLayerIds.has(trimmedLayerId)) {
      throw new PresentationAssetCompositionError(
        'COMPOSITION_LAYER_INVALID',
        `Duplicate layerId "${trimmedLayerId}" found at index ${index}`,
        `layers[${index}].layerId`,
      );
    }
    seenLayerIds.add(trimmedLayerId);

    const layerAsset = layer.asset as Record<string, unknown> | undefined;
    if (
      !isPlainRecord(layerAsset) ||
      typeof layerAsset.ref !== 'string' ||
      isLocalOrUnsafeRef(layerAsset.ref)
    ) {
      throw new PresentationAssetCompositionError(
        'COMPOSITION_LAYER_INVALID',
        `Layer "${trimmedLayerId}" must reference a valid opaque asset handle`,
        `layers[${index}].asset.ref`,
      );
    }

    const layerRect = layer.rect as Record<string, unknown> | undefined;
    if (
      !isPlainRecord(layerRect) ||
      typeof layerRect.x !== 'number' ||
      typeof layerRect.y !== 'number' ||
      typeof layerRect.width !== 'number' ||
      typeof layerRect.height !== 'number' ||
      !Number.isFinite(layerRect.x) ||
      !Number.isFinite(layerRect.y) ||
      !Number.isFinite(layerRect.width) ||
      !Number.isFinite(layerRect.height) ||
      layerRect.x < 0 ||
      layerRect.y < 0 ||
      layerRect.width <= 0 ||
      layerRect.height <= 0 ||
      layerRect.x + layerRect.width > canvasWidth ||
      layerRect.y + layerRect.height > canvasHeight
    ) {
      throw new PresentationAssetCompositionError(
        'COMPOSITION_LAYER_INVALID',
        `Layer "${trimmedLayerId}" rect must be non-negative, non-zero and within canvas bounds`,
        `layers[${index}].rect`,
      );
    }

    if (typeof layer.zIndex !== 'number' || !Number.isFinite(layer.zIndex)) {
      throw new PresentationAssetCompositionError(
        'COMPOSITION_LAYER_INVALID',
        `Layer "${trimmedLayerId}" zIndex must be a finite number`,
        `layers[${index}].zIndex`,
      );
    }

    if (
      layer.opacity !== undefined &&
      (typeof layer.opacity !== 'number' ||
        !Number.isFinite(layer.opacity) ||
        layer.opacity < 0 ||
        layer.opacity > 1)
    ) {
      throw new PresentationAssetCompositionError(
        'COMPOSITION_LAYER_INVALID',
        `Layer "${trimmedLayerId}" opacity must be in [0, 1]`,
        `layers[${index}].opacity`,
      );
    }

    if (
      layer.rotation !== undefined &&
      (typeof layer.rotation !== 'number' || !Number.isFinite(layer.rotation))
    ) {
      throw new PresentationAssetCompositionError(
        'COMPOSITION_LAYER_INVALID',
        `Layer "${trimmedLayerId}" rotation must be a finite number`,
        `layers[${index}].rotation`,
      );
    }

    const layerCrop = layer.crop as Record<string, unknown> | undefined;
    if (
      layer.crop !== undefined &&
      (!isPlainRecord(layerCrop) ||
        typeof layerCrop.x !== 'number' ||
        typeof layerCrop.y !== 'number' ||
        typeof layerCrop.width !== 'number' ||
        typeof layerCrop.height !== 'number' ||
        !Number.isFinite(layerCrop.x) ||
        !Number.isFinite(layerCrop.y) ||
        !Number.isFinite(layerCrop.width) ||
        !Number.isFinite(layerCrop.height) ||
        layerCrop.x < 0 ||
        layerCrop.y < 0 ||
        layerCrop.width <= 0 ||
        layerCrop.height <= 0)
    ) {
      throw new PresentationAssetCompositionError(
        'COMPOSITION_LAYER_INVALID',
        `Layer "${trimmedLayerId}" crop must be valid positive coordinates`,
        `layers[${index}].crop`,
      );
    }

    if (layer.fit !== undefined && layer.fit !== 'fill' && layer.fit !== 'fit') {
      throw new PresentationAssetCompositionError(
        'COMPOSITION_LAYER_INVALID',
        `Layer "${trimmedLayerId}" fit must be "fill" or "fit"`,
        `layers[${index}].fit`,
      );
    }

    const safeAssetMeta = sanitizeWireRecord(layerAsset.metadata);
    const safeLayerMeta = sanitizeWireRecord(layer.metadata);

    normalizedLayers.push({
      asset: {
        ...(safeAssetMeta ? { metadata: safeAssetMeta } : {}),
        ref: layerAsset.ref.trim(),
      },
      ...(layerCrop !== undefined
        ? {
            crop: {
              height: layerCrop.height as number,
              width: layerCrop.width as number,
              x: layerCrop.x as number,
              y: layerCrop.y as number,
            },
          }
        : {}),
      ...(layer.fit === 'fill' || layer.fit === 'fit' ? { fit: layer.fit } : {}),
      layerId: trimmedLayerId,
      ...(safeLayerMeta ? { metadata: safeLayerMeta } : {}),
      ...(typeof layer.opacity === 'number' ? { opacity: layer.opacity } : {}),
      originalIndex: index,
      rect: {
        height: layerRect.height,
        width: layerRect.width,
        x: layerRect.x,
        y: layerRect.y,
      },
      ...(typeof layer.rotation === 'number' ? { rotation: layer.rotation } : {}),
      zIndex: layer.zIndex,
    });
  }

  // Paint order: ascending zIndex, ties broken by original position
  normalizedLayers.sort((a, b) => a.zIndex - b.zIndex || a.originalIndex - b.originalIndex);

  const safeOptions = sanitizeWireRecord(raw.options);

  return {
    canvas: { height: raw.canvas.height, width: raw.canvas.width },
    layers: normalizedLayers.map(({ originalIndex: _, ...layer }) => layer),
    output: {
      mimeType: raw.output.mimeType.trim(),
      ...(raw.output.quality !== undefined ? { quality: raw.output.quality } : {}),
    },
    ...(raw.background !== undefined ? { background: raw.background } : {}),
    ...(raw.idempotencyKey !== undefined ? { idempotencyKey: raw.idempotencyKey.trim() } : {}),
    ...(safeOptions ? { options: safeOptions } : {}),
  };
};

/** Maps unknown errors onto stable AssetCompositionError wire shapes. */
export const toAssetCompositionError = (error: unknown): AssetCompositionError => {
  if (error instanceof PresentationAssetCompositionError) {
    return {
      code: error.code,
      ...(error.details ? { details: error.details } : {}),
      message: error.message,
    };
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return {
        code: 'COMPOSITION_CANCELLED',
        message: error.message,
      };
    }
    return {
      code: 'COMPOSITION_FAILED',
      message: error.message,
    };
  }
  return {
    code: 'COMPOSITION_FAILED',
    message: 'Asset composition failed.',
  };
};

/** Asserts that a port is configured, throwing COMPOSITION_UNAVAILABLE otherwise. */
export const assertAssetCompositionPort = (
  port: AssetCompositionPort | undefined | null,
): AssetCompositionPort => {
  if (!port || typeof port.compose !== 'function' || typeof port.resolveAsset !== 'function') {
    throw new PresentationAssetCompositionError(
      'COMPOSITION_UNAVAILABLE',
      'Asset composition is not available.',
    );
  }
  return port;
};

export interface FakeAssetCompositionPortOptions {
  readonly createRef?: () => string;
  readonly manifest?: Partial<AssetCompositionManifest>;
  readonly now?: () => string;
  readonly providerId?: string;
  readonly resolveSourceAsset?: (
    scope: RuntimeScope,
    ref: string,
  ) => Promise<AssetMetadata | null> | AssetMetadata | null;
}

const DEFAULT_FAKE_MANIFEST: AssetCompositionManifest = {
  displayName: 'Fake asset compositor',
  maxLayers: ASSET_COMPOSITION_CANVAS.maxLayers,
  providerId: 'fake.composition',
  supportedInputMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'],
  supportedOutputMimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
  supportsIdempotency: true,
  supportsRotation: true,
};

/**
 * Creates an in-memory fake AssetCompositionPort.
 *
 * Enforces authenticated scope checks, manifest limits, source asset resolution,
 * scoped idempotency caching, and cooperative cancellation without spawning
 * processes, touching disk, or loading heavy image libraries.
 */
export const createFakeAssetCompositionPort = (
  options: FakeAssetCompositionPortOptions = {},
): AssetCompositionPort => {
  let counter = 0;
  const createRef = options.createRef ?? (() => `asset://fake-composite-${++counter}`);
  const now = options.now ?? (() => new Date().toISOString());
  const resolveSourceAsset = options.resolveSourceAsset;

  const providerId =
    options.providerId ?? options.manifest?.providerId ?? DEFAULT_FAKE_MANIFEST.providerId;

  const manifest: AssetCompositionManifest = {
    ...DEFAULT_FAKE_MANIFEST,
    ...options.manifest,
    providerId,
  };

  // Scoped stores: Map<scopeKey, Map<ref, AssetMetadata>>
  const assetStore = new Map<string, Map<string, AssetMetadata>>();

  // Scoped idempotency: Map<scopeKey, Map<idempotencyKey, { cachedRequest, cachedResult }>>
  const idempotencyStore = new Map<
    string,
    Map<
      string,
      {
        cachedRequest: AssetCompositionRequest;
        cachedResult: AssetCompositionResult;
      }
    >
  >();

  const getScopeKey = (scope: RuntimeScope): string =>
    JSON.stringify([scope.userId.trim(), scope.sessionId.trim()]);

  const port: AssetCompositionPort = {
    compose: async (
      rawRequest: AssetCompositionRequest,
      context: AssetCompositionContext,
    ): Promise<AssetCompositionResult> => {
      if (
        !context ||
        !isRecord(context.scope) ||
        !nonEmptyString(context.scope.userId) ||
        !nonEmptyString(context.scope.sessionId)
      ) {
        throw new PresentationAssetCompositionError(
          'COMPOSITION_SCOPE_MISMATCH',
          'A complete authenticated RuntimeScope (userId, sessionId) is required.',
          'scope',
        );
      }

      const scopeKey = getScopeKey(context.scope);

      if (context.timeoutMs !== undefined && context.timeoutMs <= 0) {
        throw new PresentationAssetCompositionError(
          'COMPOSITION_BUDGET_EXCEEDED',
          'The injected composition timeout budget was exhausted.',
          'timeoutMs',
        );
      }

      if (context.signal?.aborted) {
        throw new PresentationAssetCompositionError(
          'COMPOSITION_CANCELLED',
          'Asset composition was cancelled.',
          'signal',
        );
      }

      const request = validateAssetCompositionRequest(rawRequest);

      if (manifest.maxLayers !== undefined && request.layers.length > manifest.maxLayers) {
        throw new PresentationAssetCompositionError(
          'COMPOSITION_BUDGET_EXCEEDED',
          `Layer count (${request.layers.length}) exceeds compositor limit (${manifest.maxLayers})`,
          'layers',
        );
      }

      if (!manifest.supportedOutputMimeTypes.includes(request.output.mimeType)) {
        throw new PresentationAssetCompositionError(
          'COMPOSITION_REQUEST_INVALID',
          `Output mimeType "${request.output.mimeType}" is not supported by this compositor`,
          'output.mimeType',
        );
      }

      if (!manifest.supportsRotation) {
        for (const layer of request.layers) {
          if (layer.rotation !== undefined && layer.rotation !== 0) {
            throw new PresentationAssetCompositionError(
              'COMPOSITION_LAYER_INVALID',
              `Layer "${layer.layerId}" has rotation, but rotation is not supported by this compositor`,
              'layers.rotation',
            );
          }
        }
      }

      if (request.idempotencyKey && manifest.supportsIdempotency) {
        const scopedIdempotency = idempotencyStore.get(scopeKey);
        if (scopedIdempotency?.has(request.idempotencyKey)) {
          const entry = scopedIdempotency.get(request.idempotencyKey)!;
          if (JSON.stringify(entry.cachedRequest) === JSON.stringify(request)) {
            return JSON.parse(JSON.stringify(entry.cachedResult)) as AssetCompositionResult;
          }
          throw new PresentationAssetCompositionError(
            'COMPOSITION_IDEMPOTENCY_CONFLICT',
            `Idempotency key "${request.idempotencyKey}" conflict: request does not match previous call`,
            'idempotencyKey',
          );
        }
      }

      const layerResults: AssetCompositionLayerResult[] = [];

      for (const layer of request.layers) {
        if (context.signal?.aborted) {
          throw new PresentationAssetCompositionError(
            'COMPOSITION_CANCELLED',
            'Asset composition was cancelled.',
            'signal',
          );
        }

        if (!resolveSourceAsset) {
          throw new PresentationAssetCompositionError(
            'COMPOSITION_FAILED',
            'Source asset resolver is not configured.',
          );
        }

        let sourceMetadata: AssetMetadata | null;
        try {
          sourceMetadata = await resolveSourceAsset(context.scope, layer.asset.ref);
        } catch (error) {
          if (context.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
            throw new PresentationAssetCompositionError(
              'COMPOSITION_CANCELLED',
              'Asset composition was cancelled.',
              'signal',
            );
          }
          if (error instanceof PresentationAssetCompositionError) {
            throw error;
          }
          throw new PresentationAssetCompositionError(
            'COMPOSITION_FAILED',
            error instanceof Error ? error.message : 'Failed to resolve source asset.',
          );
        }

        if (context.signal?.aborted) {
          throw new PresentationAssetCompositionError(
            'COMPOSITION_CANCELLED',
            'Asset composition was cancelled.',
            'signal',
          );
        }

        if (!sourceMetadata) {
          throw new PresentationAssetCompositionError(
            'COMPOSITION_ASSET_NOT_FOUND',
            `Asset "${layer.asset.ref}" could not be resolved inside the caller's scope`,
            { layerId: layer.layerId, ref: layer.asset.ref },
          );
        }

        if (
          sourceMetadata.mimeType &&
          !manifest.supportedInputMimeTypes.includes(sourceMetadata.mimeType)
        ) {
          throw new PresentationAssetCompositionError(
            'COMPOSITION_LAYER_INVALID',
            `Layer "${layer.layerId}" source asset mimeType "${sourceMetadata.mimeType}" is not supported by this compositor`,
            { layerId: layer.layerId, mimeType: sourceMetadata.mimeType },
          );
        }

        layerResults.push({
          asset: layer.asset,
          layerId: layer.layerId,
          state: 'composed',
        });
      }

      if (context.signal?.aborted) {
        throw new PresentationAssetCompositionError(
          'COMPOSITION_CANCELLED',
          'Asset composition was cancelled.',
          'signal',
        );
      }

      const compositeRef = createRef();
      const createdAt = now();

      const outputMetadata: AssetMetadata = {
        createdAt,
        mimeType: request.output.mimeType,
      };

      const compositeAsset: AssetRef = {
        metadata: {
          canvas: {
            height: request.canvas.height,
            width: request.canvas.width,
          },
          compositionProvider: manifest.providerId,
          layerCount: request.layers.length,
        },
        ref: compositeRef,
      };

      const result: AssetCompositionResult = {
        asset: compositeAsset,
        ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
        layers: layerResults,
        metadata: outputMetadata,
        state: 'composed',
      };

      if (!assetStore.has(scopeKey)) {
        assetStore.set(scopeKey, new Map());
      }
      assetStore.get(scopeKey)!.set(compositeRef, outputMetadata);

      if (request.idempotencyKey && manifest.supportsIdempotency) {
        if (!idempotencyStore.has(scopeKey)) {
          idempotencyStore.set(scopeKey, new Map());
        }
        idempotencyStore.get(scopeKey)!.set(request.idempotencyKey, {
          cachedRequest: request,
          cachedResult: result,
        });
      }

      return result;
    },

    manifest,

    providerId: manifest.providerId,

    resolveAsset: async (
      scope: RuntimeScope,
      ref: AssetRef | string,
    ): Promise<AssetMetadata | null> => {
      if (!isRecord(scope) || !nonEmptyString(scope.userId) || !nonEmptyString(scope.sessionId)) {
        return null;
      }
      const refString = typeof ref === 'string' ? ref : ref?.ref;
      if (!nonEmptyString(refString)) {
        return null;
      }
      const scopeKey = getScopeKey(scope);
      return assetStore.get(scopeKey)?.get(refString.trim()) ?? null;
    },
  };

  return port;
};
