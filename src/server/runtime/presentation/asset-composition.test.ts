import { describe, expect, it, vi } from 'vitest';

import type {
  AssetCompositionPort,
  AssetCompositionRequest,
  AssetMetadata,
  RuntimeScope,
} from '../../../../packages/runtime-contracts/src';
import {
  assertAssetCompositionPort,
  createFakeAssetCompositionPort,
  PresentationAssetCompositionError,
  toAssetCompositionError,
  validateAssetCompositionRequest,
} from './asset-composition';

const scope: RuntimeScope = { sessionId: 'session-1', userId: 'user-1' };
const otherScope: RuntimeScope = { sessionId: 'session-2', userId: 'user-1' };

const sourceMetadata = (mimeType = 'image/png'): AssetMetadata => ({
  createdAt: '2026-09-02T00:00:00.000Z',
  mimeType,
});

const request = (overrides: Partial<AssetCompositionRequest> = {}): AssetCompositionRequest => ({
  canvas: { height: 1080, width: 1920 },
  idempotencyKey: 'job-1:slide-1:composite',
  layers: [
    {
      asset: { ref: 'asset://background' },
      layerId: 'bg',
      rect: { height: 1080, width: 1920, x: 0, y: 0 },
      zIndex: 0,
    },
    {
      asset: { metadata: { slotId: 'hero' }, ref: 'asset://hero' },
      fit: 'fit',
      layerId: 'hero',
      opacity: 0.9,
      rect: { height: 540, width: 960, x: 480, y: 270 },
      zIndex: 5,
    },
  ],
  output: { mimeType: 'image/png' },
  ...overrides,
});

const sources = new Map<string, Map<string, AssetMetadata>>([
  [
    JSON.stringify([scope.userId, scope.sessionId]),
    new Map([
      ['asset://background', sourceMetadata()],
      ['asset://hero', sourceMetadata('image/jpeg')],
      ['asset://svg', sourceMetadata('image/svg+xml')],
    ]),
  ],
  [
    JSON.stringify([otherScope.userId, otherScope.sessionId]),
    new Map([['asset://foreign', sourceMetadata()]]),
  ],
]);

const resolveSourceAsset = vi.fn(async (requested: RuntimeScope, ref: string) => {
  const owned = sources.get(JSON.stringify([requested.userId, requested.sessionId]));
  return owned?.get(ref) ?? null;
});

const createPort = (
  overrides: Partial<Parameters<typeof createFakeAssetCompositionPort>[0]> = {},
): AssetCompositionPort => {
  let counter = 0;
  return createFakeAssetCompositionPort({
    createRef: () => `asset://composite-${++counter}`,
    now: () => '2026-09-02T00:00:00.000Z',
    resolveSourceAsset,
    ...overrides,
  });
};

const expectCompositionError = async (operation: Promise<unknown>, code: string) => {
  await expect(operation).rejects.toMatchObject({
    code,
    name: 'PresentationAssetCompositionError',
  });
};

describe('C-105 asset composition request validation', () => {
  it('normalises a valid request and sorts layers by zIndex then position', () => {
    const normalized = validateAssetCompositionRequest(
      request({
        layers: [
          {
            asset: { ref: 'asset://top' },
            layerId: 'top',
            rect: { height: 10, width: 10, x: 0, y: 0 },
            zIndex: 2,
          },
          {
            asset: { ref: 'asset://mid-a' },
            layerId: 'mid-a',
            rect: { height: 10, width: 10, x: 0, y: 0 },
            zIndex: 1,
          },
          {
            asset: { ref: 'asset://mid-b' },
            layerId: 'mid-b',
            rect: { height: 10, width: 10, x: 0, y: 0 },
            zIndex: 1,
          },
        ],
      }),
    );

    expect(normalized.layers.map((layer) => layer.layerId)).toEqual(['mid-a', 'mid-b', 'top']);
    expect(normalized.output).toEqual({ mimeType: 'image/png' });
    expect(normalized.idempotencyKey).toBe('job-1:slide-1:composite');
  });

  it('rejects non-object requests, bad canvases and unknown output encodings', () => {
    const invalid = (value: unknown) =>
      (() => validateAssetCompositionRequest(value as AssetCompositionRequest)) as () => unknown;

    expect(invalid(null)).toThrow(PresentationAssetCompositionError);
    expect(invalid(request({ canvas: { height: 0, width: 1920 } }))).toThrowError(
      expect.objectContaining({ code: 'COMPOSITION_REQUEST_INVALID', path: 'canvas' }),
    );
    expect(invalid(request({ canvas: { height: 1080, width: 10_000 } }))).toThrowError(
      expect.objectContaining({ code: 'COMPOSITION_REQUEST_INVALID', path: 'canvas' }),
    );
    expect(invalid(request({ output: { mimeType: 'text/html' } }))).toThrowError(
      expect.objectContaining({ code: 'COMPOSITION_REQUEST_INVALID', path: 'output.mimeType' }),
    );
    expect(invalid(request({ output: { mimeType: 'image/png', quality: 101 } }))).toThrowError(
      expect.objectContaining({ code: 'COMPOSITION_REQUEST_INVALID', path: 'output.quality' }),
    );
    expect(invalid(request({ layers: [] }))).toThrowError(
      expect.objectContaining({ code: 'COMPOSITION_REQUEST_INVALID', path: 'layers' }),
    );
    expect(invalid(request({ idempotencyKey: '   ' }))).toThrowError(
      expect.objectContaining({ code: 'COMPOSITION_REQUEST_INVALID', path: 'idempotencyKey' }),
    );
  });

  it('rejects duplicate ids, out-of-canvas geometry, bad opacity and path-like refs as layer errors', () => {
    const layer = (overrides: Record<string, unknown>) => ({
      asset: { ref: 'asset://x' },
      layerId: 'x',
      rect: { height: 10, width: 10, x: 0, y: 0 },
      zIndex: 0,
      ...overrides,
    });
    const check = (layers: unknown[], path: string) =>
      expect(() =>
        validateAssetCompositionRequest(
          request({ layers: layers as AssetCompositionRequest['layers'] }),
        ),
      ).toThrowError(expect.objectContaining({ code: 'COMPOSITION_LAYER_INVALID', path }));

    check([layer({}), layer({})], 'layers[1].layerId');
    check([layer({ layerId: '' })], 'layers[0].layerId');
    check([layer({ rect: { height: 10, width: 10, x: 1915, y: 0 } })], 'layers[0].rect');
    check([layer({ rect: { height: 10, width: -1, x: 0, y: 0 } })], 'layers[0].rect');
    check([layer({ zIndex: Number.NaN })], 'layers[0].zIndex');
    check([layer({ opacity: 1.5 })], 'layers[0].opacity');
    check([layer({ rotation: Number.POSITIVE_INFINITY })], 'layers[0].rotation');
    check([layer({ crop: { height: 1, width: 1, x: -1, y: 0 } })], 'layers[0].crop');
    check([layer({ fit: 'cover' })], 'layers[0].fit');
    check([layer({ asset: { ref: '/tmp/secret.png' } })], 'layers[0].asset.ref');
    check([layer({ asset: { ref: '../escape.png' } })], 'layers[0].asset.ref');
    check([layer({ asset: { ref: 'C:\\windows\\x.png' } })], 'layers[0].asset.ref');
    check([layer({ asset: { ref: '' } })], 'layers[0].asset.ref');
  });

  it('strips bytes, paths, workspaces and credentials from every metadata projection', () => {
    const normalized = validateAssetCompositionRequest(
      request({
        layers: [
          {
            asset: {
              metadata: { apiKey: 'sk-secret', bytes: new Uint8Array([1]), slotId: 'hero' },
              ref: 'asset://hero',
            },
            layerId: 'hero',
            metadata: { path: '/tmp/x', source: 'planner', workspace: '/w' },
            rect: { height: 10, width: 10, x: 0, y: 0 },
            zIndex: 0,
          },
        ],
        options: { buffer: 'x', engine: 'fake', token: 'abc' },
      }),
    );

    const serialized = JSON.stringify(normalized);
    for (const forbidden of ['apiKey', 'bytes', 'path', 'workspace', 'buffer', 'token']) {
      expect(serialized).not.toContain(`"${forbidden}"`);
    }
    expect(normalized.layers[0].asset.metadata).toEqual({ slotId: 'hero' });
    expect(normalized.layers[0].metadata).toEqual({ source: 'planner' });
    expect(normalized.options).toEqual({ engine: 'fake' });
  });

  it('rejects layer counts above the composition budget', () => {
    const layers = Array.from({ length: 33 }, (_, index) => ({
      asset: { ref: `asset://layer-${index}` },
      layerId: `layer-${index}`,
      rect: { height: 1, width: 1, x: 0, y: 0 },
      zIndex: index,
    }));
    expect(() => validateAssetCompositionRequest(request({ layers }))).toThrowError(
      expect.objectContaining({ code: 'COMPOSITION_BUDGET_EXCEEDED', path: 'layers' }),
    );
  });
});

describe('C-105 fake asset composition port', () => {
  it('composes resolvable layers into one new asset with per-layer provenance', async () => {
    const port = createPort();

    const result = await port.compose(request(), { scope });

    expect(result).toMatchObject({
      asset: { ref: 'asset://composite-1' },
      idempotencyKey: 'job-1:slide-1:composite',
      metadata: { createdAt: '2026-09-02T00:00:00.000Z', mimeType: 'image/png' },
      state: 'composed',
    });
    expect(result.layers).toEqual([
      { asset: { ref: 'asset://background' }, layerId: 'bg', state: 'composed' },
      {
        asset: { metadata: { slotId: 'hero' }, ref: 'asset://hero' },
        layerId: 'hero',
        state: 'composed',
      },
    ]);
    expect(result.asset.metadata).toMatchObject({
      canvas: { height: 1080, width: 1920 },
      compositionProvider: 'fake.composition',
      layerCount: 2,
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(JSON.stringify(result)).not.toMatch(/"(bytes|path|workspace|apiKey)"/);
    expect(port.manifest.providerId).toBe(port.providerId);
    await expect(port.resolveAsset(scope, result.asset)).resolves.toEqual(result.metadata);
  });

  it('fails closed without a complete scope and never resolves foreign assets', async () => {
    const port = createPort();

    await expectCompositionError(
      port.compose(request(), { scope: { sessionId: '', userId: 'user-1' } }),
      'COMPOSITION_SCOPE_MISMATCH',
    );
    await expectCompositionError(
      port.compose(request(), { scope: undefined as unknown as RuntimeScope }),
      'COMPOSITION_SCOPE_MISMATCH',
    );

    await expectCompositionError(
      port.compose(
        request({
          layers: [
            {
              asset: { ref: 'asset://foreign' },
              layerId: 'foreign',
              rect: { height: 10, width: 10, x: 0, y: 0 },
              zIndex: 0,
            },
          ],
        }),
        { scope },
      ),
      'COMPOSITION_ASSET_NOT_FOUND',
    );
    expect(resolveSourceAsset).toHaveBeenCalledWith(scope, 'asset://foreign');

    const composed = await port.compose(request(), { scope });
    await expect(port.resolveAsset(otherScope, composed.asset)).resolves.toBeNull();
  });

  it('honours the idempotency key and rejects a conflicting reuse', async () => {
    const port = createPort();

    const first = await port.compose(request(), { scope });
    const replay = await port.compose(request(), { scope });
    expect(replay).toEqual(first);

    await expectCompositionError(
      port.compose(request({ background: '#000000' }), { scope }),
      'COMPOSITION_IDEMPOTENCY_CONFLICT',
    );
    // Idempotency is scoped: another scope cannot observe or collide with the key.
    await expectCompositionError(
      port.compose(request(), { scope: otherScope }),
      'COMPOSITION_ASSET_NOT_FOUND',
    );
  });

  it('rejects with COMPOSITION_CANCELLED when the signal is already aborted or aborts mid-flight', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const port = createPort();
    await expectCompositionError(
      port.compose(request(), { scope, signal: aborted.signal }),
      'COMPOSITION_CANCELLED',
    );

    const controller = new AbortController();
    const slowPort = createPort({
      resolveSourceAsset: async (requested, ref) => {
        controller.abort();
        return resolveSourceAsset(requested, ref);
      },
    });
    await expectCompositionError(
      slowPort.compose(request({ idempotencyKey: 'cancel-1' }), {
        scope,
        signal: controller.signal,
      }),
      'COMPOSITION_CANCELLED',
    );
    // A cancelled composition leaves no idempotency binding behind.
    await expect(
      createPort().compose(request({ idempotencyKey: 'cancel-1' }), { scope }),
    ).resolves.toMatchObject({ state: 'composed' });
  });

  it('enforces manifest limits: layer budget, rotation support and input mime types', async () => {
    const limited = createPort({
      manifest: {
        displayName: 'Limited fake',
        maxLayers: 1,
        providerId: 'fake.composition',
        supportedInputMimeTypes: ['image/png'],
        supportedOutputMimeTypes: ['image/png'],
        supportsIdempotency: true,
        supportsRotation: false,
      },
    });

    await expectCompositionError(
      limited.compose(request(), { scope }),
      'COMPOSITION_BUDGET_EXCEEDED',
    );

    const single = (overrides: Record<string, unknown>) =>
      request({
        layers: [
          {
            asset: { ref: 'asset://background' },
            layerId: 'only',
            rect: { height: 10, width: 10, x: 0, y: 0 },
            zIndex: 0,
            ...overrides,
          },
        ],
      });
    await expectCompositionError(
      limited.compose(single({ rotation: 10 }), { scope }),
      'COMPOSITION_LAYER_INVALID',
    );
    await expectCompositionError(
      limited.compose(single({ asset: { ref: 'asset://svg' } }), { scope }),
      'COMPOSITION_LAYER_INVALID',
    );
    await expectCompositionError(
      limited.compose(single({}), { scope: { ...scope }, timeoutMs: 0 }),
      'COMPOSITION_BUDGET_EXCEEDED',
    );
    await expectCompositionError(
      limited.compose({ ...single({}), output: { mimeType: 'image/webp' } }, { scope }),
      'COMPOSITION_REQUEST_INVALID',
    );
  });

  it('maps unknown failures onto stable codes and exposes an unavailable seam by default', async () => {
    expect(
      toAssetCompositionError(
        new PresentationAssetCompositionError('COMPOSITION_FAILED', 'boom', { layerId: 'x' }),
      ),
    ).toEqual({ code: 'COMPOSITION_FAILED', details: { layerId: 'x' }, message: 'boom' });
    expect(toAssetCompositionError(new Error('sharp exploded at /tmp/a.png'))).toEqual({
      code: 'COMPOSITION_FAILED',
      message: 'sharp exploded at /tmp/a.png',
    });
    expect(toAssetCompositionError(Object.assign(new Error('x'), { name: 'AbortError' }))).toEqual({
      code: 'COMPOSITION_CANCELLED',
      message: 'x',
    });
    expect(toAssetCompositionError('nope')).toEqual({
      code: 'COMPOSITION_FAILED',
      message: 'Asset composition failed.',
    });

    expect(() => assertAssetCompositionPort(undefined)).toThrowError(
      expect.objectContaining({ code: 'COMPOSITION_UNAVAILABLE' }),
    );
    const port = createPort();
    expect(assertAssetCompositionPort(port)).toBe(port);

    const failing = createPort({
      resolveSourceAsset: async () => {
        throw new Error('storage offline');
      },
    });
    await expectCompositionError(failing.compose(request(), { scope }), 'COMPOSITION_FAILED');
  });
});
