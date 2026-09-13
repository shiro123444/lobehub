import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { AtomicRuntime } from './atomic-runtime';
import { createSkillsPlugin } from './skills-plugin';

const scope = { userId: 'alice', sessionId: 'account' };
it('lets an agent inspect then fill native objects and deduplicates the same request', async () => {
  const inspect = vi.fn(async () => ({
    pages: [{ page: 1, shapes: [{ id: '7', runs: ['Title'] }] }],
  }));
  const fill = vi.fn(async (_input: unknown) => ({
    artifactId: 'native-result',
    uri: '/api/runtime/presentation/artifacts/native-result?raw=true',
  }));
  const chat = vi
    .fn()
    .mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              operation: 'presentation.template.inspectNative',
              input: { templateId: 'owned' },
            }),
          },
        },
      ],
    })
    .mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              operation: 'presentation.template.fillNative',
              input: {
                templateId: 'owned',
                patches: [{ page: 1, shapeId: '7', text: 'New title' }],
              },
            }),
          },
        },
      ],
    })
    .mockResolvedValueOnce({
      choices: [
        { message: { content: JSON.stringify({ done: true, summary: '已保留原稿结构完成修改' }) } },
      ],
    });
  const runtime: AtomicRuntime = new AtomicRuntime([
    {
      id: 'presentation',
      version: '1',
      operations: [
        {
          name: 'presentation.template.inspectNative',
          description: 'Inspect',
          input: z.object({ templateId: z.string() }).strict(),
          execute: inspect,
        },
        {
          name: 'presentation.template.fillNative',
          description: 'Fill',
          input: z
            .object({
              templateId: z.string(),
              patches: z.array(
                z.object({ page: z.number(), shapeId: z.string(), text: z.string() }),
              ),
            })
            .strict(),
          execute: fill,
        },
      ],
    },
    createSkillsPlugin(() => runtime, { chat, manifest: { model: 'test' } } as any),
  ]);
  try {
    const input = { instruction: '改标题', requestId: 'one', resources: { templateId: 'owned' } };
    const output = await runtime.invoke<any>('skills.autorun', input, { scope });
    expect(output.result.artifactId).toBe('native-result');
    expect(fill.mock.calls[0][0]).toMatchObject({
      patches: [{ page: 1, shapeId: '7', text: 'New title' }],
    });
    await runtime.invoke('skills.autorun', input, { scope });
    expect(chat).toHaveBeenCalledTimes(3);
    await expect(
      runtime.invoke('skills.autorun', { ...input, instruction: 'another' }, { scope }),
    ).rejects.toThrow('reused');
  } finally {
    await runtime.dispose();
  }
});
describe('composed plugin lifecycle', () => {
  it('holds every participating plugin version until the whole sequence finishes', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const runtime: AtomicRuntime = new AtomicRuntime([
      {
        id: 'assets',
        version: '1',
        operations: [
          {
            name: 'assets.inspect',
            description: 'Wait',
            input: z.object({}).strict(),
            execute: async () => {
              entered();
              await gate;
              return { ref: 'a' };
            },
          },
        ],
      },
      createSkillsPlugin(() => runtime),
    ]);
    const work = runtime.invoke(
      'skills.run',
      { steps: [{ id: 'inspect', operation: 'assets.inspect', input: {} }] },
      { scope },
    );
    await started;
    await expect(runtime.remove('assets')).rejects.toThrow('Finish or cancel');
    finish();
    await work;
    await runtime.remove('assets');
    await runtime.dispose();
  });
});
