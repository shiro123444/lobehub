import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { strToU8, zipSync } from 'fflate';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';

import { InMemoryPresentationArtifactStore } from '../artifact-store';
import type { GLMMultimodalChatPort } from '../multimodal-chat-provider-glm';
import { FilePresentationTemplateLibrary } from './library';
import { TemplateVisualLearning } from './visual-learning';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const scope = { userId: 'designer', sessionId: 'account' };
const fixture = () =>
  zipSync(
    Object.fromEntries(
      Object.entries({
        '[Content_Types].xml':
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
        'ppt/presentation.xml':
          '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="r1"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>',
        'ppt/_rels/presentation.xml.rels':
          '<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
        'ppt/slides/slide1.xml':
          '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree/></p:cSld></p:sld>',
      }).map(([name, value]) => [name, strToU8(value)]),
    ),
  );

it('looks at native page pixels, caches by owned version, and refuses to reuse baked text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jumi-visual-test-'));
  directories.push(root);
  const library = new FilePresentationTemplateLibrary({ root });
  const profile = await library.importPptx(scope, { bytes: fixture(), name: 'Watercolor' });
  const store = new InMemoryPresentationArtifactStore();
  const jpeg = await sharp({
    create: { width: 200, height: 100, channels: 3, background: '#92afc4' },
  })
    .jpeg()
    .toBuffer();
  const renderer = vi.fn(async () => [{ page: 1, bytes: jpeg }]);
  const analysis = {
    summary: '水彩课堂',
    families: [
      {
        id: 'watercolor',
        name: '水彩',
        pages: [1],
        palette: ['#92afc4'],
        typography: '留白标题',
        composition: '纸张与留白',
        artwork: '水彩笔触',
        preserve: ['纸张纹理'],
      },
    ],
    components: [
      {
        id: 'book',
        name: '书本',
        page: 1,
        familyId: 'watercolor',
        box: { x: 0, y: 0, width: 0.4, height: 0.8 },
        role: 'artwork',
        containsText: false,
        treatment: 'crop',
        rationale: '独立装饰',
      },
      {
        id: 'ribbon',
        name: '旧标题',
        page: 1,
        familyId: 'watercolor',
        box: { x: 0.4, y: 0.1, width: 0.5, height: 0.3 },
        role: 'heading',
        containsText: true,
        treatment: 'redraw',
        rationale: '文字烧录',
      },
    ],
    guidance: '复用书本，标题重绘',
  };
  const chat = vi.fn<GLMMultimodalChatPort['chat']>(async () => ({
    choices: [
      { index: 0, message: { role: 'assistant' as const, content: JSON.stringify(analysis) } },
    ],
    id: 'vision',
    model: 'vision-test',
    created: 1,
  }));
  chat.mockResolvedValueOnce({
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: JSON.stringify({
            ...analysis,
            components: [
              { ...analysis.components[0], box: { x: 10, y: 20, width: 30, height: 40 } },
            ],
          }),
        },
      },
    ],
    id: 'invalid-coordinates',
    model: 'test',
    created: 1,
  });
  const port: GLMMultimodalChatPort = {
    chat,
    providerId: 'test',
    manifest: {
      providerId: 'test',
      model: 'vision-test',
      displayName: 'Vision',
      supportsVision: true,
      supportsIdempotency: true,
    },
  };
  const learning = new TemplateVisualLearning({ library, store, chat: port, renderer });
  const ref = { templateId: profile.templateId, versionId: profile.versionId };
  const result = await learning.analyze(ref, { scope });
  expect(result.pages).toHaveLength(1);
  expect(chat.mock.calls[0][0].messages[1].content).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: 'image_url' })]),
  );
  expect(chat.mock.calls[0][1].trustedImages).toBeDefined();
  await learning.analyze(ref, { scope });
  expect(chat).toHaveBeenCalledTimes(2);
  expect(renderer).toHaveBeenCalledOnce();
  const component = await learning.extract({ ...ref, componentId: 'p1-book' }, { scope });
  expect((await store.get(scope, component.ref))?.metadata).toMatchObject({
    sourcePage: 1,
    componentId: 'p1-book',
  });
  await expect(learning.extract({ ...ref, componentId: 'p1-ribbon' }, { scope })).rejects.toThrow(
    '旧文字',
  );
  await expect(learning.analyze(ref, { scope: { ...scope, userId: 'other' } })).rejects.toThrow(
    '找不到',
  );
  expect((await library.resolve(scope, ref)).visual?.families[0].name).toBe('水彩');
  analysis.components[0].box.x = 0.1;
  await learning.analyze({ ...ref, pages: [1], refresh: true }, { scope });
  const refined = await learning.extract({ ...ref, componentId: 'p1-book' }, { scope });
  expect(refined.ref).not.toBe(component.ref);
  expect((await store.get(scope, refined.ref))?.metadata?.region).toMatchObject({ x: 0.1 });
});

it('renders a template learned from an existing SVG deck without requiring a native PPTX', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jumi-plan-visual-'));
  directories.push(root);
  const library = new FilePresentationTemplateLibrary({ root });
  const store = new InMemoryPresentationArtifactStore();
  const profile = await library.learnFromPlan(scope, {
    name: 'Existing work',
    plan: {
      planId: 'p',
      title: 'Work',
      aspectRatio: '16:9',
      sourceVersionIds: [],
      slides: [
        {
          slideId: 's1',
          order: 1,
          svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><rect width="960" height="540" fill="#F9F0E2"/><text x="50" y="80" font-size="32">Course</text></svg>',
        },
      ],
    },
  });
  const chat = {} as GLMMultimodalChatPort;
  const pages = await new TemplateVisualLearning({ library, store, chat }).render(
    { templateId: profile.templateId },
    { scope },
  );
  expect(pages).toHaveLength(1);
  expect(pages[0].nativeTextCount).toBe(1);
  const image = await store.get(scope, pages[0].ref);
  expect(image?.mimeType).toBe('image/jpeg');
  expect((await sharp(image!.bytes).metadata()).width).toBe(1400);
});
