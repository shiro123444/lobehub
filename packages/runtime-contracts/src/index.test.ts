import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  AgentProfile,
  ArtifactSnapshot,
  AssetCompositionContext,
  AssetCompositionError,
  AssetCompositionLayer,
  AssetCompositionManifest,
  AssetCompositionPort,
  AssetCompositionRequest,
  AssetCompositionResult,
  AssetCompositionState,
  AssetMetadata,
  AssetRef,
  CommandEnvelope,
  Disposable,
  Disposer,
  Effect,
  Fiber,
  FiberState,
  ImageGenerationContext,
  ImageGenerationError,
  ImageGenerationPort,
  ImageGenerationResult,
  ImageProviderManifest,
  PermissionManifest,
  PluginDescriptor,
  PluginRuntimeState,
  PresentationPort,
  RunSnapshot,
  RunState,
  RuntimeEvent,
  RuntimePluginManifest,
  SceneChartNode,
  SceneGroupNode,
  SceneImageNode,
  SceneNode,
  SlideScene,
  StartRunInput,
} from './index';
import {
  ASSET_COMPOSITION_CANVAS,
  ASSET_COMPOSITION_ERROR_CODES,
  ASSET_COMPOSITION_STATES,
  IMAGE_GENERATION_ERROR_CODES,
  PLUGIN_KINDS,
  PLUGIN_RUNTIME_STATES,
  RUN_STATES,
  RUNTIME_PROTOCOL_VERSION,
  SLIDE_SCENE_CANVAS,
  SLIDE_SCENE_ERROR_CODES,
  validateSlideScene,
} from './index';

describe('@lobechat/runtime-contracts', () => {
  it('exports the runtime protocol and state constants', () => {
    expect(RUNTIME_PROTOCOL_VERSION).toBe('runtime.v1');
    expect(PLUGIN_KINDS).toContain('agent-strategy');
    expect(PLUGIN_RUNTIME_STATES).toContain('active');
    expect(RUN_STATES).toContain('waiting_human');
    expect(RUN_STATES).toContain('cancelled');
  });

  it('exports the Fiber lifecycle contracts', () => {
    const disposer: Disposer = () => {};
    const disposable: Disposable = disposer;
    const effect: Effect = disposable;
    const fiber: Fiber = {
      name: 'test-fiber',
      state: 'active',
      collect: (candidate) => candidate,
      dispose: async () => {},
    };

    expect(effect).toBe(disposable);
    expect(fiber.collect(disposable)).toBe(disposable);
    expect(fiber.state satisfies FiberState).toBe('active');
  });

  it('resolves the public runtime contract type exports', () => {
    type ContractExports = {
      agentProfile: AgentProfile;
      artifactSnapshot: ArtifactSnapshot;
      commandEnvelope: CommandEnvelope;
      permissionManifest: PermissionManifest;
      pluginDescriptor: PluginDescriptor;
      pluginRuntimeState: PluginRuntimeState;
      presentationPort: PresentationPort;
      runSnapshot: RunSnapshot;
      runState: RunState;
      runtimeEvent: RuntimeEvent;
      runtimePluginManifest: RuntimePluginManifest;
      startRunInput: StartRunInput;
    };

    expectTypeOf<ContractExports>().toBeObject();
  });

  it('exports stable image-generation error codes (C-81)', () => {
    expect(IMAGE_GENERATION_ERROR_CODES).toContain('IMAGE_REQUEST_INVALID');
    expect(IMAGE_GENERATION_ERROR_CODES).toContain('IMAGE_PROVIDER_REJECTED');
    expect(IMAGE_GENERATION_ERROR_CODES).toContain('IMAGE_BUDGET_EXCEEDED');
    expect(IMAGE_GENERATION_ERROR_CODES).toContain('IMAGE_CANCELLED');
    expect(IMAGE_GENERATION_ERROR_CODES).toContain('IMAGE_PAYLOAD_INVALID');
    expect(IMAGE_GENERATION_ERROR_CODES).toContain('IMAGE_UNAVAILABLE');
  });

  it('projects the image-generation port contract without binary payloads (C-81)', async () => {
    const provider: ImageGenerationPort = {
      manifest: {
        displayName: 'Reference image provider',
        maxImagesPerRequest: 4,
        providerId: 'reference.image',
        supportedMimeTypes: ['image/png'],
        supportsIdempotency: true,
      },
      providerId: 'reference.image',
      generate: async (request, context) => {
        // The wire seam only ever sees JSON-serializable values: a request is
        // round-tripped through JSON and any binary attempt would be lost.
        expect(JSON.parse(JSON.stringify(request))).toEqual(request);
        expect(context.scope.userId).toBe('user-1');
        return [
          {
            asset: { metadata: { generatedBy: 'reference' }, ref: 'asset://ref-1' },
            index: 0,
            metadata: {
              createdAt: '2026-08-31T00:00:00.000Z',
              mimeType: 'image/png',
              sizeBytes: 1024,
            },
          } satisfies ImageGenerationResult,
        ];
      },
      resolveAsset: async (_scope, _ref) =>
        ({
          createdAt: '2026-08-31T00:00:00.000Z',
          mimeType: 'image/png',
        }) satisfies AssetMetadata,
    };

    const results = await provider.generate(
      { count: 1, idempotencyKey: 'job-1:slide-1', prompt: 'a chart of quarterly growth' },
      { scope: { sessionId: 'session-1', userId: 'user-1' } } satisfies ImageGenerationContext,
    );
    expect(results).toHaveLength(1);
    expect(results[0].asset.ref).toBe('asset://ref-1');
    // The manifest is bound to the port's stable provider id.
    expect(provider.manifest.providerId).toBe('reference.image');
    expect(provider.providerId).toBe('reference.image');
    expectTypeOf(provider.manifest).toMatchTypeOf<ImageProviderManifest>();
  });

  it('keeps image-generation error and asset shapes JSON-serializable (C-81)', () => {
    const error: ImageGenerationError = {
      code: 'IMAGE_BUDGET_EXCEEDED',
      details: { elapsedMs: 42_000 },
      message: 'The injected time budget was exhausted.',
    };
    const ref: AssetRef = { metadata: { kind: 'slide' }, ref: 'asset://ref-2' };
    // Round-tripping through JSON is lossless: no Uint8Array/Buffer can hide.
    expect(JSON.parse(JSON.stringify(error))).toEqual(error);
    expect(JSON.parse(JSON.stringify(ref))).toEqual(ref);
    expect(error.code).toBe('IMAGE_BUDGET_EXCEEDED');
  });

  it('exports stable slide-scene error codes and canvas budget (C-83)', () => {
    expect(SLIDE_SCENE_ERROR_CODES).toContain('SCENE_INVALID');
    expect(SLIDE_SCENE_ERROR_CODES).toContain('SCENE_NODE_ID_INVALID');
    expect(SLIDE_SCENE_ERROR_CODES).toContain('SCENE_GEOMETRY_INVALID');
    expect(SLIDE_SCENE_CANVAS.maxWidth).toBeGreaterThanOrEqual(1920);
    expect(SLIDE_SCENE_CANVAS.maxHeight).toBeGreaterThanOrEqual(1080);
  });

  it('validates a full scene graph across every node kind (C-83)', () => {
    const image: SceneImageNode = {
      alt: 'Quarterly growth chart render',
      asset: { ref: 'asset://chart-1' },
      fit: 'fit',
      id: 'node-image',
      kind: 'image',
      rect: { height: 360, width: 640, x: 80, y: 100 },
      zIndex: 1,
    };
    const text: SceneNode = {
      id: 'node-text',
      kind: 'text',
      rect: { height: 48, width: 400, x: 80, y: 40 },
      style: { bold: true, fontSize: 24 },
      text: 'Q3 Highlights',
      zIndex: 2,
    };
    const chart: SceneChartNode = {
      chartType: 'bar',
      id: 'node-chart',
      kind: 'chart',
      rect: { height: 300, width: 480, x: 100, y: 160 },
      series: [{ labels: ['Q1', 'Q2'], name: 'Revenue', values: [12, 30] }],
      zIndex: 3,
    };
    const table: SceneNode = {
      id: 'node-table',
      kind: 'table',
      rect: { height: 120, width: 300, x: 640, y: 160 },
      rows: [
        ['Region', 'Revenue'],
        ['EMEA', '30'],
      ],
      zIndex: 3,
    };
    const shape: SceneNode = {
      fill: 'transparent',
      id: 'node-shape',
      kind: 'shape',
      rect: { height: 120, width: 120, x: 20, y: 20 },
      shape: 'rect',
      stroke: '#333',
      zIndex: 0,
    };
    const group: SceneGroupNode = {
      children: [image, text],
      id: 'node-group',
      kind: 'group',
      rect: { height: 500, width: 700, x: 60, y: 20 },
      zIndex: 4,
    };

    const scene: SlideScene = {
      canvas: { height: 1080, width: 1920 },
      metadata: { source: 'contract-test' },
      nodes: [shape, group, chart, table],
      referenceImage: { ref: 'asset://slide-ref' },
      sceneId: 'slide-001',
    };

    // The whole scene is JSON-serializable: no binary can hide in the graph.
    expect(JSON.parse(JSON.stringify(scene))).toEqual(scene);

    const result = validateSlideScene(scene);
    expect(result).toEqual({ ok: true, scene });
    // Node ids were collected recursively through groups.
    expect(result.ok && result.scene.nodes[1].kind).toBe('group');
  });

  it('rejects duplicate node ids, bad geometry and broken scenes with stable codes (C-83)', () => {
    const baseScene = (): Record<string, unknown> => ({
      canvas: { height: 1080, width: 1920 },
      nodes: [
        {
          id: 'a',
          kind: 'text',
          rect: { height: 40, width: 200, x: 0, y: 0 },
          text: 'x',
          zIndex: 0,
        },
      ],
      sceneId: 'slide-err',
    });

    // Duplicate ids — including nested ones inside groups — are rejected.
    const duplicated = baseScene();
    (duplicated.nodes as unknown[]).push({
      children: [
        { id: 'a', kind: 'shape', rect: { height: 1, width: 1, x: 0, y: 0 }, shape: 'rect' },
      ],
      id: 'g',
      kind: 'group',
      rect: { height: 10, width: 10, x: 0, y: 0 },
    });
    expect(validateSlideScene(duplicated)).toMatchObject({
      error: { code: 'SCENE_NODE_ID_INVALID' },
      ok: false,
    });

    // Negative coordinates and canvas-budget overruns are geometry errors.
    const negative = baseScene();
    (negative.nodes as unknown[])[0] = {
      id: 'a',
      kind: 'text',
      rect: { height: 40, width: 200, x: -5, y: 0 },
      text: 'x',
      zIndex: 0,
    };
    expect(validateSlideScene(negative)).toMatchObject({
      error: { code: 'SCENE_GEOMETRY_INVALID' },
      ok: false,
    });
    const oversized = baseScene();
    (oversized.nodes as unknown[])[0] = {
      id: 'a',
      kind: 'text',
      rect: { height: 40, width: 5000, x: 0, y: 0 },
      text: 'x',
      zIndex: 0,
    };
    expect(validateSlideScene(oversized)).toMatchObject({
      error: { code: 'SCENE_GEOMETRY_INVALID' },
      ok: false,
    });

    // Broken scenes never throw — they project to SCENE_INVALID.
    expect(validateSlideScene(null)).toMatchObject({ error: { code: 'SCENE_INVALID' }, ok: false });
    expect(validateSlideScene({ canvas: { height: 0, width: 1920 }, nodes: [] })).toMatchObject({
      error: { code: 'SCENE_INVALID' },
      ok: false,
    });
  });

  it('exports stable asset-composition error codes, states and canvas budget (C-105)', () => {
    expect(ASSET_COMPOSITION_ERROR_CODES).toEqual([
      'COMPOSITION_REQUEST_INVALID',
      'COMPOSITION_SCOPE_MISMATCH',
      'COMPOSITION_LAYER_INVALID',
      'COMPOSITION_ASSET_NOT_FOUND',
      'COMPOSITION_IDEMPOTENCY_CONFLICT',
      'COMPOSITION_BUDGET_EXCEEDED',
      'COMPOSITION_CANCELLED',
      'COMPOSITION_UNAVAILABLE',
      'COMPOSITION_FAILED',
    ]);
    expect(ASSET_COMPOSITION_STATES).toEqual([
      'planned',
      'composing',
      'composed',
      'failed',
      'cancelled',
    ]);
    expect(ASSET_COMPOSITION_CANVAS.maxWidth).toBeGreaterThanOrEqual(SLIDE_SCENE_CANVAS.maxWidth);
    expect(ASSET_COMPOSITION_CANVAS.maxHeight).toBeGreaterThanOrEqual(
      SLIDE_SCENE_CANVAS.maxHeight,
    );
    expect(ASSET_COMPOSITION_CANVAS.maxLayers).toBeGreaterThanOrEqual(2);
    expectTypeOf<AssetCompositionState>().toEqualTypeOf<
      'cancelled' | 'composed' | 'composing' | 'failed' | 'planned'
    >();
  });

  it('projects the asset-composition port without bytes, paths or secrets (C-105)', async () => {
    const layers: AssetCompositionLayer[] = [
      {
        asset: { ref: 'asset://background' },
        layerId: 'bg',
        opacity: 1,
        rect: { height: 1080, width: 1920, x: 0, y: 0 },
        zIndex: 0,
      },
      {
        asset: { metadata: { slotId: 'hero' }, ref: 'asset://hero' },
        crop: { height: 512, width: 512, x: 0, y: 0 },
        fit: 'fit',
        layerId: 'hero',
        rect: { height: 540, width: 960, x: 480, y: 270 },
        rotation: 15,
        zIndex: 1,
      },
    ];
    const request: AssetCompositionRequest = {
      background: '#ffffff',
      canvas: { height: 1080, width: 1920 },
      idempotencyKey: 'job-1:slide-1:composite',
      layers,
      output: { mimeType: 'image/png' },
    };
    // Requests are pure JSON: a Uint8Array or path could not survive the wire.
    expect(JSON.parse(JSON.stringify(request))).toEqual(request);

    const port: AssetCompositionPort = {
      compose: async (incoming, context) => {
        expect(context.scope).toEqual({ sessionId: 'session-1', userId: 'user-1' });
        expect(incoming.layers.map((layer) => layer.zIndex)).toEqual([0, 1]);
        return {
          asset: { metadata: { composedFrom: 2 }, ref: 'asset://composite-1' },
          idempotencyKey: incoming.idempotencyKey,
          layers: incoming.layers.map((layer) => ({
            asset: layer.asset,
            layerId: layer.layerId,
            state: 'composed',
          })),
          metadata: {
            createdAt: '2026-09-02T00:00:00.000Z',
            mimeType: 'image/png',
            sizeBytes: 2048,
          },
          state: 'composed',
        } satisfies AssetCompositionResult;
      },
      manifest: {
        displayName: 'Reference compositor',
        maxLayers: 8,
        providerId: 'reference.composition',
        supportedInputMimeTypes: ['image/png', 'image/jpeg'],
        supportedOutputMimeTypes: ['image/png'],
        supportsIdempotency: true,
        supportsRotation: true,
      } satisfies AssetCompositionManifest,
      providerId: 'reference.composition',
      resolveAsset: async () =>
        ({ createdAt: '2026-09-02T00:00:00.000Z', mimeType: 'image/png' }) satisfies AssetMetadata,
    };

    const controller = new AbortController();
    const context: AssetCompositionContext = {
      scope: { sessionId: 'session-1', userId: 'user-1' },
      signal: controller.signal,
      timeoutMs: 30_000,
      traceId: 'trace-1',
    };
    const result = await port.compose(request, context);
    expect(result.state).toBe('composed');
    expect(result.asset.ref).toBe('asset://composite-1');
    expect(result.layers.map((layer) => layer.layerId)).toEqual(['bg', 'hero']);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    const serialized = JSON.stringify(result);
    for (const forbidden of ['bytes', 'path', 'workspace', 'apiKey']) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(port.manifest.providerId).toBe(port.providerId);

    const error: AssetCompositionError = {
      code: 'COMPOSITION_CANCELLED',
      details: { layerId: 'hero' },
      message: 'The caller aborted the composition.',
    };
    expect(JSON.parse(JSON.stringify(error))).toEqual(error);
  });
});
