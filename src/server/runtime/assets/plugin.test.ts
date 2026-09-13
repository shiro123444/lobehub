import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { AtomicRuntime } from '../atomic-runtime';
import { InMemoryPresentationArtifactStore } from '../presentation/artifact-store';
import { createSkillsPlugin } from '../skills-plugin';
import { createAssetPlugin } from './plugin';

const scope = { userId: 'alice', sessionId: 'session' };
describe('composable asset tools', () => {
  it('chains transparent extraction, opacity and composition while retaining original pixels', async () => {
    const store = new InMemoryPresentationArtifactStore();
    const pixels = Buffer.alloc(8 * 8 * 4, 255);
    for (let y = 2; y < 6; y++)
      for (let x = 2; x < 6; x++) {
        pixels[(y * 8 + x) * 4] = 0;
        pixels[(y * 8 + x) * 4 + 1] = 100;
        pixels[(y * 8 + x) * 4 + 2] = 100;
      }
    // White inside the subject must not be removed by an edge-connected color key.
    pixels[(3 * 8 + 3) * 4] = 255;
    pixels[(3 * 8 + 3) * 4 + 1] = 255;
    pixels[(3 * 8 + 3) * 4 + 2] = 255;
    const png = await sharp(pixels, { raw: { width: 8, height: 8, channels: 4 } })
      .png()
      .toBuffer();
    await store.put(scope, {
      artifactId: 'source',
      name: 'source.png',
      type: 'image',
      mimeType: 'image/png',
      bytes: new Uint8Array(png),
    });
    const runtime: AtomicRuntime = new AtomicRuntime([
      createAssetPlugin(store),
      createSkillsPlugin(() => runtime),
    ]);
    try {
      const output = await runtime.invoke<any>(
        'skills.run',
        {
          steps: [
            {
              id: 'key',
              operation: 'assets.keyColor',
              input: { ref: 'source', color: '#ffffff', tolerance: 0, feather: 0 },
            },
            {
              id: 'fade',
              operation: 'assets.transform',
              input: { ref: { $ref: 'key.ref' }, opacity: 0.5 },
            },
            {
              id: 'composite',
              operation: 'assets.compose',
              input: {
                width: 16,
                height: 8,
                layers: [
                  { ref: { $ref: 'fade.ref' }, x: 0, y: 0, width: 8, height: 8 },
                  { ref: 'source', x: 8, y: 0, width: 8, height: 8 },
                ],
              },
            },
          ],
        },
        { scope },
      );
      const saved = await store.get(scope, output.last.ref);
      const raw = await sharp(saved!.bytes!).ensureAlpha().raw().toBuffer();
      expect(raw[3]).toBe(0);
      expect(raw[(3 * 16 + 3) * 4 + 3]).toBe(128);
      expect(raw[(3 * 16 + 11) * 4 + 3]).toBe(255);
      expect((await store.get(scope, 'source'))?.bytes).toEqual(new Uint8Array(png));
      await expect(
        runtime.invoke('assets.inspect', { ref: 'source' }, { scope: { ...scope, userId: 'bob' } }),
      ).rejects.toThrow();
      await expect(
        runtime.invoke(
          'skills.run',
          {
            steps: [
              { id: 'bad', operation: 'assets.transform', input: { ref: { $ref: 'later.ref' } } },
            ],
          },
          { scope },
        ),
      ).rejects.toThrow('previous');
      await expect(
        runtime.invoke(
          'skills.run',
          { steps: [{ id: 'bad', operation: 'skills.run', input: { steps: [] } }] },
          { scope },
        ),
      ).rejects.toThrow('cannot be composed');
    } finally {
      await runtime.dispose();
    }
  });
});
