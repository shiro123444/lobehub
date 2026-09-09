import { describe, expect, it } from 'vitest';

import { InMemoryPresentationAssetStore, PresentationAssetStoreError } from './asset-store';

const scope = { sessionId: 'session-1', userId: 'user-1' } as const;
const otherScope = { sessionId: 'session-2', userId: 'user-1' } as const;

const input = (overrides: Record<string, unknown> = {}) => ({
  asset: {
    metadata: { kind: 'generated-image' },
    ref: 'asset://image-1',
  },
  bytes: new Uint8Array([1, 2, 3]),
  idempotencyKey: 'generation-1',
  metadata: {
    mimeType: 'image/png',
    providerMetadata: { provider: 'mock', token: 'redacted' },
  },
  ...overrides,
});

const expectStoreError = async (operation: Promise<unknown>, code: string) => {
  await expect(operation).rejects.toMatchObject({
    code,
    name: 'PresentationAssetStoreError',
  });
};

describe('C-82 presentation asset store', () => {
  it('stores a wire-safe snapshot and uses the injected clock', async () => {
    const store = new InMemoryPresentationAssetStore({
      now: () => '2026-08-31T00:00:00.000Z',
    });

    const snapshot = await store.put(scope, input());

    expect(snapshot).toMatchObject({
      asset: { ref: 'asset://image-1' },
      metadata: {
        createdAt: '2026-08-31T00:00:00.000Z',
        mimeType: 'image/png',
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain('bytes');
    expect(JSON.stringify(snapshot)).not.toContain('token');
    expect(snapshot).not.toHaveProperty('workspace');
  });

  it('is idempotent for the same key and rejects a conflicting key', async () => {
    const store = new InMemoryPresentationAssetStore({
      now: () => '2026-08-31T00:00:00.000Z',
    });
    const first = await store.put(scope, input());

    await expect(store.put(scope, input())).resolves.toEqual(first);
    await expectStoreError(
      store.put(
        scope,
        input({
          asset: { ref: 'asset://image-2' },
        }),
      ),
      'ASSET_IDEMPOTENCY_CONFLICT',
    );
  });

  it('rejects duplicate asset refs even when the idempotency key differs', async () => {
    const store = new InMemoryPresentationAssetStore();
    await store.put(scope, input());

    await expectStoreError(
      store.put(scope, input({ idempotencyKey: 'generation-2' })),
      'ASSET_DUPLICATE',
    );
  });

  it('isolates reads and removal by user/session scope', async () => {
    const store = new InMemoryPresentationAssetStore();
    await store.put(scope, input());

    await expectStoreError(store.get(otherScope, 'asset://image-1'), 'ASSET_SCOPE_MISMATCH');
    await expectStoreError(store.remove(otherScope, 'asset://image-1'), 'ASSET_SCOPE_MISMATCH');
    await expectStoreError(store.get(scope, 'asset://missing'), 'ASSET_NOT_FOUND');
    await expect(store.find(otherScope, 'asset://missing')).resolves.toBeNull();
  });

  it('returns defensive copies and removes an asset', async () => {
    const store = new InMemoryPresentationAssetStore();
    await store.put(scope, input());

    const stored = await store.get(scope, 'asset://image-1');
    stored.bytes![0] = 99;
    (stored.asset.metadata as { kind: string }).kind = 'mutated';

    await expect(store.get(scope, 'asset://image-1')).resolves.toMatchObject({
      asset: { metadata: { kind: 'generated-image' } },
      bytes: new Uint8Array([1, 2, 3]),
    });

    await expect(store.remove(scope, 'asset://image-1')).resolves.toBeUndefined();
    await expectStoreError(store.get(scope, 'asset://image-1'), 'ASSET_NOT_FOUND');
  });

  it('has stable validation and dispose behavior', async () => {
    const store = new InMemoryPresentationAssetStore();

    await expectStoreError(
      store.put(scope, input({ metadata: { mimeType: '' } })),
      'ASSET_INVALID',
    );
    await expectStoreError(
      store.put(scope, input({ asset: { ref: '/tmp/image.png' } })),
      'ASSET_INVALID',
    );

    store.dispose();
    store.dispose();
    expect(PresentationAssetStoreError).toBeDefined();
    await expectStoreError(store.find(scope, 'asset://image-1'), 'ASSET_STORE_DISPOSED');
  });

  it('PresentationArtifactAssetStoreBridge bridges asset put/get into underlying artifactStore', async () => {
    const { InMemoryPresentationArtifactStore } = await import('./artifact-store');
    const { createPresentationArtifactAssetStoreBridge } = await import('./asset-store');

    const artifactStore = new InMemoryPresentationArtifactStore();
    const assetStore = createPresentationArtifactAssetStoreBridge(artifactStore);

    // 1. Put asset
    const snap = await assetStore.put(scope, input());
    expect(snap.asset.ref).toBe('asset://image-1');

    // 2. Underlying artifactStore should have the artifact with matching ref and bytes
    const storedArtifact = await artifactStore.get(scope, 'asset://image-1');
    expect(storedArtifact).toBeDefined();
    expect(storedArtifact?.artifactId).toBe('asset://image-1');
    expect(storedArtifact?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(storedArtifact?.type).toBe('image');
    expect(storedArtifact?.uri).toBe('/api/runtime/presentation/artifacts/asset%3A%2F%2Fimage-1');

    // 3. AssetStore get and find
    const found = await assetStore.find(scope, 'asset://image-1');
    expect(found?.bytes).toEqual(new Uint8Array([1, 2, 3]));

    // 4. Remove
    await assetStore.remove(scope, 'asset://image-1');
    expect(await artifactStore.get(scope, 'asset://image-1')).toBeNull();
  });
});
