/**
 * C-82 server-only asset store seam.
 *
 * `AssetRef` and `AssetMetadata` are the only wire-facing values returned by
 * `put`/`getSnapshot`. A storage adapter may retain bytes internally, but
 * those bytes never enter the runtime-contracts types or a wire snapshot.
 */

import type {
  AssetMetadata,
  AssetRef,
  RuntimeScope,
} from '../../../../packages/runtime-contracts/src';

export type PresentationAssetMetadataInput = Omit<AssetMetadata, 'createdAt'> & {
  readonly createdAt?: string;
};

export interface PresentationAssetPutInput {
  readonly asset: AssetRef;
  readonly bytes?: Uint8Array;
  readonly idempotencyKey?: string;
  readonly metadata: PresentationAssetMetadataInput;
}

/** Internal server record; `bytes` is intentionally not a runtime contract. */
export interface StoredPresentationAsset {
  readonly asset: AssetRef;
  readonly bytes?: Uint8Array;
  readonly idempotencyKey?: string;
  readonly metadata: AssetMetadata;
}

/** Wire-safe asset projection. */
export interface PresentationAssetSnapshot {
  readonly asset: AssetRef;
  readonly metadata: AssetMetadata;
}

/** Replaceable, key-addressed storage seam for a future durable adapter. */
export interface PresentationAssetStoragePort {
  get: (key: string) => StoredPresentationAsset | null | Promise<StoredPresentationAsset | null>;
  put: (key: string, asset: StoredPresentationAsset) => void | Promise<void>;
  remove: (key: string) => void | Promise<void>;
}

export interface PresentationAssetStoreOptions {
  readonly now?: () => string;
  readonly storage?: PresentationAssetStoragePort;
}

export type PresentationAssetStoreErrorCode =
  | 'ASSET_DUPLICATE'
  | 'ASSET_IDEMPOTENCY_CONFLICT'
  | 'ASSET_INVALID'
  | 'ASSET_NOT_FOUND'
  | 'ASSET_SCOPE_MISMATCH'
  | 'ASSET_STORE_DISPOSED';

export class PresentationAssetStoreError extends Error {
  constructor(
    public readonly code: PresentationAssetStoreErrorCode,
    message: string,
    public readonly path?: string,
  ) {
    super(message);
    this.name = 'PresentationAssetStoreError';
  }
}

export interface PresentationAssetStore {
  find: (scope: RuntimeScope, ref: string) => Promise<StoredPresentationAsset | null>;
  get: (scope: RuntimeScope, ref: string) => Promise<StoredPresentationAsset>;
  getSnapshot: (scope: RuntimeScope, ref: string) => Promise<PresentationAssetSnapshot>;
  put: (
    scope: RuntimeScope,
    input: PresentationAssetPutInput,
  ) => Promise<PresentationAssetSnapshot>;
  remove: (scope: RuntimeScope, ref: string) => Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const forbiddenMetadataKey = (key: string): boolean =>
  /^(?:bytes?|buffer|path|workspace(?:Path)?|prompt|negativePrompt|secret|token|password|authorization|apiKey)$/i.test(
    key,
  );

const invalid = (message: string, path?: string): PresentationAssetStoreError =>
  new PresentationAssetStoreError('ASSET_INVALID', message, path);

const cloneSafeMetadata = (value: unknown, seen = new WeakSet<object>()): unknown => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return undefined;
  if (Array.isArray(value)) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    return value
      .map((item) => cloneSafeMetadata(item, seen))
      .filter((item): item is Exclude<typeof item, undefined> => item !== undefined);
  }
  if (!isPlainRecord(value)) return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (forbiddenMetadataKey(key)) continue;
    const cloned = cloneSafeMetadata(nested, seen);
    if (cloned !== undefined) output[key] = cloned;
  }
  return output;
};

const normalizeMetadata = (value: unknown, now: () => string): AssetMetadata => {
  if (!isPlainRecord(value)) throw invalid('metadata must be a plain object', 'metadata');
  const createdAt = nonEmptyString(value.createdAt) ? value.createdAt : now();
  const mimeType = value.mimeType;
  if (!nonEmptyString(createdAt))
    throw invalid('createdAt must be non-empty', 'metadata.createdAt');
  if (!nonEmptyString(mimeType)) throw invalid('mimeType must be non-empty', 'metadata.mimeType');

  const sizeBytes = value.sizeBytes;
  if (
    sizeBytes !== undefined &&
    (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0)
  ) {
    throw invalid('sizeBytes must be a non-negative safe integer', 'metadata.sizeBytes');
  }

  const assetId = value.assetId;
  if (assetId !== undefined && !nonEmptyString(assetId)) {
    throw invalid('assetId must be non-empty when provided', 'metadata.assetId');
  }

  const providerMetadata = value.providerMetadata;
  if (providerMetadata !== undefined && !isPlainRecord(providerMetadata)) {
    throw invalid('providerMetadata must be a plain object', 'metadata.providerMetadata');
  }
  const safeProviderMetadata =
    providerMetadata === undefined ? undefined : cloneSafeMetadata(providerMetadata);

  return {
    createdAt,
    mimeType,
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    ...(assetId === undefined ? {} : { assetId }),
    ...(isRecord(safeProviderMetadata) && Object.keys(safeProviderMetadata).length > 0
      ? { providerMetadata: safeProviderMetadata }
      : {}),
  };
};

const normalizeAssetRef = (value: unknown): AssetRef => {
  if (!isPlainRecord(value) || !nonEmptyString(value.ref)) {
    throw invalid('asset.ref must be a non-empty opaque string', 'asset.ref');
  }
  const ref = value.ref.trim();
  if (
    ref.startsWith('/') ||
    ref.startsWith('./') ||
    ref.startsWith('../') ||
    /^[a-z]:[\\/]/i.test(ref)
  ) {
    throw invalid('asset.ref must not be a local filesystem path', 'asset.ref');
  }
  const metadata = value.metadata;
  if (metadata !== undefined && !isPlainRecord(metadata)) {
    throw invalid('asset.metadata must be a plain object', 'asset.metadata');
  }
  const safeMetadata = metadata === undefined ? undefined : cloneSafeMetadata(metadata);
  return {
    ref,
    ...(isRecord(safeMetadata) && Object.keys(safeMetadata).length > 0
      ? { metadata: safeMetadata }
      : {}),
  };
};

const normalizeScope = (scope: RuntimeScope): RuntimeScope => {
  if (!isRecord(scope) || !nonEmptyString(scope.userId) || !nonEmptyString(scope.sessionId)) {
    throw new PresentationAssetStoreError(
      'ASSET_SCOPE_MISMATCH',
      'A non-empty userId and sessionId are required',
      'scope',
    );
  }
  return { userId: scope.userId.trim(), sessionId: scope.sessionId.trim() };
};

const scopeKey = (scope: RuntimeScope): string => {
  const normalized = normalizeScope(scope);
  return JSON.stringify([normalized.userId, normalized.sessionId]);
};

const assetKey = (scope: RuntimeScope, ref: string): string =>
  JSON.stringify([scopeKey(scope), ref]);

const idempotencyKey = (scope: string, key: string): string => `${scope}\u0000${key}`;

const cloneAssetRef = (asset: AssetRef): AssetRef => ({
  ref: asset.ref,
  ...(asset.metadata
    ? { metadata: cloneSafeMetadata(asset.metadata) as Record<string, unknown> }
    : {}),
});

const cloneMetadata = (metadata: AssetMetadata): AssetMetadata => ({
  ...metadata,
  ...(metadata.providerMetadata
    ? { providerMetadata: cloneSafeMetadata(metadata.providerMetadata) as Record<string, unknown> }
    : {}),
});

const cloneStoredAsset = (asset: StoredPresentationAsset): StoredPresentationAsset => ({
  asset: cloneAssetRef(asset.asset),
  ...(asset.bytes ? { bytes: new Uint8Array(asset.bytes) } : {}),
  ...(asset.idempotencyKey ? { idempotencyKey: asset.idempotencyKey } : {}),
  metadata: cloneMetadata(asset.metadata),
});

const snapshot = (asset: StoredPresentationAsset): PresentationAssetSnapshot => ({
  asset: cloneAssetRef(asset.asset),
  metadata: cloneMetadata(asset.metadata),
});

const sameAssetIdentity = (
  existing: StoredPresentationAsset,
  incoming: StoredPresentationAsset,
): boolean =>
  JSON.stringify({ asset: existing.asset, metadata: existing.metadata }) ===
  JSON.stringify({ asset: incoming.asset, metadata: incoming.metadata });

class MapAssetStorage implements PresentationAssetStoragePort {
  private readonly values = new Map<string, StoredPresentationAsset>();

  get(key: string): StoredPresentationAsset | null {
    const value = this.values.get(key);
    return value ? cloneStoredAsset(value) : null;
  }

  put(key: string, asset: StoredPresentationAsset): void {
    this.values.set(key, cloneStoredAsset(asset));
  }

  remove(key: string): void {
    this.values.delete(key);
  }
}

/**
 * Scope-isolated in-memory implementation. The default storage is local to
 * this instance; no module-level singleton or client-provided scope exists.
 */
export class InMemoryPresentationAssetStore implements PresentationAssetStore {
  private readonly assetScopes = new Map<string, Set<string>>();
  private readonly idempotency = new Map<string, string>();
  private readonly now: () => string;
  private disposed = false;
  private readonly storage: PresentationAssetStoragePort;

  constructor(options?: PresentationAssetStoreOptions | (() => string)) {
    const normalizedOptions = typeof options === 'function' ? { now: options } : (options ?? {});
    this.now = normalizedOptions.now ?? (() => new Date().toISOString());
    this.storage = normalizedOptions.storage ?? new MapAssetStorage();
  }

  async put(
    scope: RuntimeScope,
    input: PresentationAssetPutInput,
  ): Promise<PresentationAssetSnapshot> {
    this.assertOpen();
    const normalizedScope = normalizeScope(scope);
    if (!isPlainRecord(input)) throw invalid('asset input must be a plain object', 'input');
    const asset = normalizeAssetRef(input.asset);
    const metadata = normalizeMetadata(input.metadata, this.now);
    if (
      input.bytes !== undefined &&
      (!(input.bytes instanceof Uint8Array) || input.bytes.length === 0)
    ) {
      throw invalid('bytes must be a non-empty Uint8Array when provided', 'bytes');
    }
    if (input.idempotencyKey !== undefined && !nonEmptyString(input.idempotencyKey)) {
      throw invalid('idempotencyKey must be non-empty when provided', 'idempotencyKey');
    }

    const normalizedScopeKey = scopeKey(normalizedScope);
    const storageKey = assetKey(normalizedScope, asset.ref);
    const normalizedIdempotencyKey = input.idempotencyKey?.trim();
    const idempotencyIndex = normalizedIdempotencyKey
      ? idempotencyKey(normalizedScopeKey, normalizedIdempotencyKey)
      : undefined;
    const incoming: StoredPresentationAsset = {
      asset,
      ...(input.bytes ? { bytes: new Uint8Array(input.bytes) } : {}),
      ...(normalizedIdempotencyKey ? { idempotencyKey: normalizedIdempotencyKey } : {}),
      metadata,
    };

    if (idempotencyIndex) {
      const previousStorageKey = this.idempotency.get(idempotencyIndex);
      if (previousStorageKey) {
        const previous = await this.storage.get(previousStorageKey);
        if (previous && sameAssetIdentity(previous, incoming)) return snapshot(previous);
        throw new PresentationAssetStoreError(
          'ASSET_IDEMPOTENCY_CONFLICT',
          'idempotencyKey is already bound to another asset',
          'idempotencyKey',
        );
      }
    }

    const existing = await this.storage.get(storageKey);
    if (existing) {
      throw new PresentationAssetStoreError(
        'ASSET_DUPLICATE',
        `Asset already exists: ${asset.ref}`,
        'asset.ref',
      );
    }

    await this.storage.put(storageKey, incoming);
    const owners = this.assetScopes.get(asset.ref) ?? new Set<string>();
    owners.add(normalizedScopeKey);
    this.assetScopes.set(asset.ref, owners);
    if (idempotencyIndex) this.idempotency.set(idempotencyIndex, storageKey);
    return snapshot(incoming);
  }

  async find(scope: RuntimeScope, ref: string): Promise<StoredPresentationAsset | null> {
    this.assertOpen();
    const normalizedScope = normalizeScope(scope);
    const normalizedRef = this.normalizeRef(ref);
    const normalizedScopeKey = scopeKey(normalizedScope);
    const value = await this.storage.get(assetKey(normalizedScope, normalizedRef));
    if (value) return cloneStoredAsset(value);
    this.assertNotCrossScope(normalizedRef, normalizedScopeKey);
    return null;
  }

  async get(scope: RuntimeScope, ref: string): Promise<StoredPresentationAsset> {
    const value = await this.find(scope, ref);
    if (value) return value;
    throw new PresentationAssetStoreError(
      'ASSET_NOT_FOUND',
      `Asset does not exist: ${ref}`,
      'asset.ref',
    );
  }

  async getSnapshot(scope: RuntimeScope, ref: string): Promise<PresentationAssetSnapshot> {
    return snapshot(await this.get(scope, ref));
  }

  async remove(scope: RuntimeScope, ref: string): Promise<void> {
    this.assertOpen();
    const normalizedScope = normalizeScope(scope);
    const normalizedRef = this.normalizeRef(ref);
    const normalizedScopeKey = scopeKey(normalizedScope);
    const storageKey = assetKey(normalizedScope, normalizedRef);
    const existing = await this.storage.get(storageKey);
    if (!existing) {
      this.assertNotCrossScope(normalizedRef, normalizedScopeKey);
      throw new PresentationAssetStoreError(
        'ASSET_NOT_FOUND',
        `Asset does not exist: ${normalizedRef}`,
        'asset.ref',
      );
    }
    await this.storage.remove(storageKey);
    const owners = this.assetScopes.get(normalizedRef);
    owners?.delete(normalizedScopeKey);
    if (owners?.size === 0) this.assetScopes.delete(normalizedRef);
    for (const [key, value] of this.idempotency) {
      if (value === storageKey) this.idempotency.delete(key);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.assetScopes.clear();
    this.idempotency.clear();
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new PresentationAssetStoreError(
        'ASSET_STORE_DISPOSED',
        'Asset store has been disposed',
      );
    }
  }

  private normalizeRef(ref: string): string {
    if (!nonEmptyString(ref))
      throw new PresentationAssetStoreError(
        'ASSET_NOT_FOUND',
        'asset.ref is required',
        'asset.ref',
      );
    return normalizeAssetRef({ ref }).ref;
  }

  private assertNotCrossScope(ref: string, requestedScopeKey: string): void {
    const owners = this.assetScopes.get(ref);
    if (owners && [...owners].some((owner) => owner !== requestedScopeKey)) {
      throw new PresentationAssetStoreError(
        'ASSET_SCOPE_MISMATCH',
        `Asset belongs to another scope: ${ref}`,
        'scope',
      );
    }
  }
}

export class PresentationArtifactAssetStoreBridge implements PresentationAssetStore {
  private readonly now: () => string;

  constructor(
    private readonly artifactStore: import('./artifact-store').PresentationArtifactStore,
    options: PresentationAssetStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async find(scope: RuntimeScope, ref: string): Promise<StoredPresentationAsset | null> {
    const normalizedScope = normalizeScope(scope);
    const normalizedRef = normalizeAssetRef({ ref }).ref;
    try {
      const artifact = await this.artifactStore.get(normalizedScope, normalizedRef);
      if (!artifact) return null;
      const metadata = (artifact.metadata as unknown as AssetMetadata) ?? {
        createdAt: artifact.createdAt,
        mimeType: artifact.mimeType,
      };
      const safeMetadata = cloneSafeMetadata(
        metadata as unknown as Record<string, unknown>,
      ) as Record<string, unknown>;
      return {
        asset: {
          metadata: safeMetadata,
          ref: artifact.artifactId,
        },
        bytes: artifact.bytes ? new Uint8Array(artifact.bytes) : undefined,
        metadata: cloneSafeMetadata(safeMetadata) as unknown as AssetMetadata,
      };
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === 'ARTIFACT_SCOPE_MISMATCH') {
        throw new PresentationAssetStoreError(
          'ASSET_SCOPE_MISMATCH',
          `Asset belongs to another scope: ${normalizedRef}`,
          'scope',
        );
      }
      return null;
    }
  }

  async get(scope: RuntimeScope, ref: string): Promise<StoredPresentationAsset> {
    const asset = await this.find(scope, ref);
    if (!asset) {
      throw new PresentationAssetStoreError(
        'ASSET_NOT_FOUND',
        `Asset does not exist: ${ref}`,
        'asset.ref',
      );
    }
    return asset;
  }

  async getSnapshot(scope: RuntimeScope, ref: string): Promise<PresentationAssetSnapshot> {
    const asset = await this.get(scope, ref);
    return {
      asset: asset.asset,
      metadata: asset.metadata,
    };
  }

  async put(
    scope: RuntimeScope,
    input: PresentationAssetPutInput,
  ): Promise<PresentationAssetSnapshot> {
    const normalizedScope = normalizeScope(scope);
    if (!input || !isRecord(input) || !isRecord(input.asset)) {
      throw new PresentationAssetStoreError('ASSET_INVALID', 'Invalid asset input', 'asset');
    }
    const normalizedRef = normalizeAssetRef(input.asset).ref;
    const createdAt = input.metadata?.createdAt ?? this.now();
    const mimeType = (input.metadata?.mimeType as string) || 'image/png';
    const metadata: AssetMetadata = {
      ...input.metadata,
      createdAt,
      mimeType,
    };
    const safeMeta = cloneSafeMetadata(metadata as unknown as Record<string, unknown>) as Record<
      string,
      unknown
    >;

    try {
      const existing = await this.artifactStore.get(normalizedScope, normalizedRef);
      if (existing) {
        return {
          asset: { metadata: safeMeta, ref: normalizedRef },
          metadata,
        };
      }

      const localUri = `/api/runtime/presentation/artifacts/${encodeURIComponent(normalizedRef)}`;
      const uri =
        input.bytes === undefined && /^https:\/\//iu.test(normalizedRef) ? normalizedRef : localUri;
      await this.artifactStore.put(normalizedScope, {
        artifactId: normalizedRef,
        bytes: input.bytes ? new Uint8Array(input.bytes) : undefined,
        metadata: {
          ...safeMeta,
          idempotencyKey: input.idempotencyKey,
          mimeType,
          ref: normalizedRef,
          status: 'ready' as const,
          type: 'image',
          uri,
        },
        mimeType,
        name: `${normalizedRef}.png`,
        status: 'ready',
        type: 'image',
        uri,
      });

      return {
        asset: { metadata: safeMeta, ref: normalizedRef },
        metadata,
      };
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === 'ARTIFACT_DUPLICATE' || code === 'ARTIFACT_CONFLICT') {
        throw new PresentationAssetStoreError(
          'ASSET_DUPLICATE',
          `Asset already exists: ${normalizedRef}`,
          'asset.ref',
        );
      }
      if (code === 'ARTIFACT_SCOPE_MISMATCH') {
        throw new PresentationAssetStoreError(
          'ASSET_SCOPE_MISMATCH',
          `Asset belongs to another scope: ${normalizedRef}`,
          'scope',
        );
      }
      throw new PresentationAssetStoreError(
        'ASSET_INVALID',
        error instanceof Error ? error.message : String(error),
        'asset',
      );
    }
  }

  async remove(scope: RuntimeScope, ref: string): Promise<void> {
    const normalizedScope = normalizeScope(scope);
    const normalizedRef = normalizeAssetRef({ ref }).ref;
    try {
      const existing = await this.artifactStore.get(normalizedScope, normalizedRef);
      if (!existing) {
        throw new PresentationAssetStoreError(
          'ASSET_NOT_FOUND',
          `Asset does not exist: ${normalizedRef}`,
          'asset.ref',
        );
      }
      await this.artifactStore.remove(normalizedScope, normalizedRef);
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === 'ARTIFACT_SCOPE_MISMATCH') {
        throw new PresentationAssetStoreError(
          'ASSET_SCOPE_MISMATCH',
          `Asset belongs to another scope: ${normalizedRef}`,
          'scope',
        );
      }
      if (error instanceof PresentationAssetStoreError) throw error;
      throw new PresentationAssetStoreError(
        'ASSET_INVALID',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

export const createPresentationArtifactAssetStoreBridge = (
  artifactStore: import('./artifact-store').PresentationArtifactStore,
  options?: PresentationAssetStoreOptions,
): PresentationAssetStore => new PresentationArtifactAssetStoreBridge(artifactStore, options);

export { InMemoryPresentationAssetStore as InMemoryAssetStore };
export type AssetStoreInput = PresentationAssetPutInput;
export type AssetStoreRecord = PresentationAssetSnapshot;
