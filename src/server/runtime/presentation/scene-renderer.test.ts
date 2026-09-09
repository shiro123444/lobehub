import { describe, expect, it, vi } from 'vitest';

import type {
  AssetRef,
  RuntimeScope,
  SceneChartNode,
  SceneGroupNode,
  SceneImageNode,
  SceneShapeNode,
  SceneTableNode,
  SceneTextNode,
  SlideScene,
} from '../../../../packages/runtime-contracts/src';
import { SLIDE_SCENE_ERROR_CODES } from '../../../../packages/runtime-contracts/src';
import { createSceneRenderer, SceneRendererError } from './scene-renderer';

const scope: RuntimeScope = { sessionId: 'session-1', userId: 'user-1' };
const context = { scope, traceId: 'trace-1' };

const t0 = '2026-08-31T00:00:00.000Z';

const image = (id: string, overrides: Partial<SceneImageNode> = {}): SceneImageNode => ({
  asset: { metadata: { createdAt: t0 }, ref: 'asset://chart' },
  id,
  kind: 'image',
  rect: { height: 300, width: 480, x: 100, y: 100 },
  zIndex: 1,
  ...overrides,
});

const text = (id: string, overrides: Partial<SceneTextNode> = {}): SceneTextNode => ({
  id,
  kind: 'text',
  rect: { height: 48, width: 400, x: 80, y: 40 },
  text: 'Q3 Highlights',
  zIndex: 2,
  ...overrides,
});

const shape = (id: string, overrides: Partial<SceneShapeNode> = {}): SceneShapeNode => ({
  fill: '#e0e0ff',
  id,
  kind: 'shape',
  rect: { height: 120, width: 120, x: 20, y: 20 },
  shape: 'rect',
  zIndex: 0,
  ...overrides,
});

const table = (id: string, overrides: Partial<SceneTableNode> = {}): SceneTableNode => ({
  id,
  kind: 'table',
  rect: { height: 120, width: 300, x: 640, y: 160 },
  rows: [
    ['Region', 'Revenue'],
    ['EMEA', '30'],
  ],
  zIndex: 3,
  ...overrides,
});

const chart = (id: string, overrides: Partial<SceneChartNode> = {}): SceneChartNode => ({
  chartType: 'bar',
  id,
  kind: 'chart',
  rect: { height: 300, width: 480, x: 100, y: 160 },
  series: [{ labels: ['Q1', 'Q2'], name: 'Revenue', values: [12, 30] }],
  zIndex: 4,
  ...overrides,
});

const scene = (nodes: SlideScene['nodes'], overrides: Partial<SlideScene> = {}): SlideScene => ({
  canvas: { height: 1080, width: 1920 },
  nodes,
  sceneId: 'slide-001',
  ...overrides,
});

const resolveAssetUri = vi.fn(async (_s: RuntimeScope, asset: AssetRef) =>
  asset.ref === 'asset://chart' ? 'https://assets.example/chart.png' : null,
);

describe('SlideScene → SVG/PPTX renderer seam (C-85)', () => {
  it('projects every node kind with geometry, zIndex and editable markers intact', async () => {
    const group: SceneGroupNode = {
      children: [image('node-image'), text('node-text')],
      id: 'node-group',
      kind: 'group',
      rect: { height: 500, width: 700, x: 60, y: 20 },
      zIndex: 5,
    };
    const renderer = createSceneRenderer({ resolveAssetUri });
    const svg = await renderer.renderSvg(
      scene([shape('node-shape'), group, table('node-table'), chart('node-chart')]),
      context,
    );

    // Root SVG carries the canvas and scene id.
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('data-scene-id="slide-001"');
    expect(svg).toContain('viewBox="0 0 1920 1080"');
    // Every node id appears exactly once with its z-index marker.
    for (const id of [
      'node-shape',
      'node-group',
      'node-image',
      'node-text',
      'node-table',
      'node-chart',
    ]) {
      expect(svg.match(new RegExp(`data-scene-node="${id}"`, 'g'))).toHaveLength(1);
      expect(svg).toContain(`data-scene-node="${id}"`);
    }
    expect(svg).toContain('data-z-index="0"');
    // Table cell text survived as plain text.
    expect(svg).toContain('EMEA');
    // Chart data projected as bars.
    expect(svg).toContain('<rect');
    // The image went through the injected resolver.
    expect(resolveAssetUri).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ ref: 'asset://chart' }),
    );
    expect(svg).toContain('href="https://assets.example/chart.png"');
  });

  it('keeps grouped scene output balanced after closing each node', async () => {
    const renderer = createSceneRenderer({ resolveAssetUri });
    const group: SceneGroupNode = {
      children: [shape('group-child')],
      id: 'group-root',
      kind: 'group',
      rect: { height: 500, width: 700, x: 60, y: 20 },
      zIndex: 0,
    };
    const svg = await renderer.renderSvg(scene([group]), context);

    expect(svg.match(/<\/g>/g)).toHaveLength(2);
    expect(svg.endsWith('</g></svg>')).toBe(true);
  });

  it('renders paint order by ascending zIndex regardless of declaration order', async () => {
    const renderer = createSceneRenderer({ resolveAssetUri });
    const svg = await renderer.renderSvg(
      scene([text('late-low', { zIndex: 1 }), shape('early-high', { zIndex: 9 })]),
      context,
    );
    const low = svg.indexOf('data-scene-node="late-low"');
    const high = svg.indexOf('data-scene-node="early-high"');
    expect(low).toBeGreaterThan(-1);
    expect(high).toBeGreaterThan(low);
  });

  it('resolves image assets only through the injected resolver and skips unresolvable refs', async () => {
    const renderer = createSceneRenderer({ resolveAssetUri });
    const svg = await renderer.renderSvg(
      scene([image('ok'), image('missing', { asset: { ref: 'asset://gone' } })]),
      context,
    );
    expect(svg).toContain('href="https://assets.example/chart.png"');
    // Unresolvable ref → honest placeholder frame, never a fabricated <image>.
    const placeholder = svg.slice(svg.indexOf('data-scene-node="missing"'));
    expect(placeholder).toContain('<rect');
    expect(placeholder).toContain('stroke-dasharray');
    expect(placeholder).not.toContain('<image');
  });

  it('refuses unsafe resolver output and never treats an opaque ref as a path', async () => {
    const evilResolver = vi.fn(async () => 'file:///etc/passwd');
    const renderer = createSceneRenderer({ resolveAssetUri: evilResolver });
    const svg = await renderer.renderSvg(scene([image('evil')]), context);
    expect(svg).not.toContain('file://');
    expect(svg).not.toContain('/etc/passwd');
    expect(svg).toContain('<rect'); // placeholder, not an <image>
  });

  it('escapes script/HTML injection in text, table cells and attributes', async () => {
    const renderer = createSceneRenderer({ resolveAssetUri });
    const svg = await renderer.renderSvg(
      scene([
        text('xss-text', { text: '<script>alert("x")</script> & <b>bold</b>' }),
        table('xss-table', { rows: [['"><img src=x onerror=alert(1)>']] }),
      ]),
      context,
    );
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('<img');
    expect(svg).not.toContain('onerror=');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toContain('&quot;&gt;&lt;img');
    // Escaped text is still readable in the DOM.
    expect(svg).toContain('&lt;b&gt;bold&lt;/b&gt;');
  });

  it('maps invalid scenes to stable SCENE_* errors without fabricating artifacts', async () => {
    const renderer = createSceneRenderer({ resolveAssetUri });
    const cases: readonly unknown[] = [
      null,
      { canvas: { height: 0, width: 1920 }, nodes: [], sceneId: 'x' },
      {
        canvas: { height: 1080, width: 1920 },
        nodes: [
          {
            id: 'dup',
            kind: 'text',
            rect: { height: 1, width: 1, x: 0, y: 0 },
            text: 'a',
            zIndex: 0,
          },
          {
            id: 'dup',
            kind: 'text',
            rect: { height: 1, width: 1, x: 5, y: 0 },
            text: 'b',
            zIndex: 1,
          },
        ],
        sceneId: 'x',
      },
      {
        canvas: { height: 1080, width: 1920 },
        nodes: [
          { id: 'neg', kind: 'shape', rect: { height: -5, width: 10, x: 0, y: 0 }, shape: 'rect' },
        ],
        sceneId: 'x',
      },
    ];
    const codes: string[] = [];
    for (const candidate of cases) {
      try {
        await renderer.renderSvg(candidate as SlideScene, context);
        expect.unreachable('invalid scene must throw');
      } catch (err) {
        expect(err).toBeInstanceOf(SceneRendererError);
        codes.push((err as SceneRendererError).code);
      }
    }
    expect(codes).toEqual([
      'SCENE_INVALID',
      'SCENE_INVALID',
      'SCENE_NODE_ID_INVALID',
      'SCENE_GEOMETRY_INVALID',
    ]);
    expect(codes.every((code) => SLIDE_SCENE_ERROR_CODES.includes(code as never))).toBe(true);
  });

  it('keeps rotation, crop and locked metadata on the projected nodes', async () => {
    const renderer = createSceneRenderer({ resolveAssetUri });
    const svg = await renderer.renderSvg(
      scene([
        image('rot-crop', {
          crop: { height: 100, width: 100, x: 10, y: 10 },
          rotation: 15,
        }),
        text('locked', { locked: true, zIndex: 3 }),
      ]),
      context,
    );
    expect(svg).toContain('rotate(15');
    expect(svg).toContain('data-crop="10,10,100,100"');
    expect(svg).toContain('data-locked="true"');
  });

  it('exposes convertSvg only when a converter is injected and surfaces converter failures', async () => {
    // No converter → no convertSvg seam on the port.
    const bare = createSceneRenderer({ resolveAssetUri });
    expect(bare.convertSvg).toBeUndefined();

    const failing = createSceneRenderer({
      convertSvg: async () => {
        throw new Error('ppt-master offline');
      },
      resolveAssetUri,
    });
    expect(typeof failing.convertSvg).toBe('function');
    const svg = await failing.renderSvg(scene([shape('s')]), context);
    await expect(failing.convertSvg?.(svg, context)).rejects.toMatchObject({
      message: 'ppt-master offline',
    });

    // A working converter receives the projected SVG and the render context.
    const convertSvg = vi.fn(async (input: string) => ({ format: 'pptx', svg: input }));
    const working = createSceneRenderer({ convertSvg, resolveAssetUri });
    const projected = await working.renderSvg(scene([shape('s')]), context);
    const result = (await working.convertSvg?.(projected, context)) as { svg: string };
    expect(convertSvg).toHaveBeenCalledWith(projected, context);
    expect(result.svg).toBe(projected);
    // Renderer itself never fabricated a PPTX result.
    expect(result.svg).toContain('data-scene-node="s"');
  });
});
