import { describe, expect, it, vi } from 'vitest';

import { Context } from '../../../../packages/cordis-kernel/src/context';
import type { PptMasterPluginOptions, PptMasterPresentationCapability } from './ppt-master-plugin';
import {
  createPptMasterPluginManifest,
  createPptMasterPresentationCapability,
  PPT_MASTER_CAPABILITY_SERVICE,
  PPT_MASTER_PLUGIN_ID,
  PPT_MASTER_PLUGIN_MANIFEST,
  PptMasterPluginError,
  PPTX_MIME_TYPE,
} from './ppt-master-plugin';

const scope = { sessionId: 'session-1', userId: 'user-1' } as const;
const otherScope = { sessionId: 'session-2', userId: 'user-2' } as const;

const scene = {
  canvas: { height: 720, width: 1280 },
  nodes: [
    {
      id: 'title',
      kind: 'text' as const,
      rect: { height: 80, width: 600, x: 40, y: 40 },
      text: 'Editable title',
      zIndex: 1,
    },
  ],
  sceneId: 'slide-1',
};

const optionsFor = (overrides: Partial<PptMasterPluginOptions> = {}): PptMasterPluginOptions => ({
  convert: vi.fn(async () => ({
    editableNodes: [{ editable: true, id: 'title', kind: 'text' as const, slideId: 'slide-1' }],
    svg: '<svg data-scene-node="title" />',
  })),
  runner: vi.fn(async () => ({ artifactRef: 'asset://pptx/job-1' })),
  ...overrides,
});

const expectCode = async (operation: Promise<unknown>, code: string) => {
  await expect(operation).rejects.toMatchObject({ code, name: 'PptMasterPluginError' });
};

describe('C-103 ppt-master plugin seam', () => {
  it('exposes a declarative manifest without discovering the external project', () => {
    expect(PPT_MASTER_PLUGIN_MANIFEST).toMatchObject({
      id: PPT_MASTER_PLUGIN_ID,
      kind: 'capability',
      version: '1.0.0',
    });
    expect(PPT_MASTER_PLUGIN_MANIFEST.permissions).toEqual({
      filesystem: [],
      tools: ['ppt-master'],
    });
  });

  it('converts a scene through injected functions and returns editable node identity', async () => {
    const options = optionsFor();
    const capability = createPptMasterPresentationCapability(options);

    const result = await capability.render({ jobId: 'job-1', scene, scope });

    expect(result).toEqual({
      artifact: { ref: 'asset://pptx/job-1' },
      artifactId: 'job-1:pptx',
      editableNodes: [{ editable: true, id: 'title', kind: 'text', slideId: 'slide-1' }],
      jobId: 'job-1',
      mimeType: PPTX_MIME_TYPE,
      scope,
    });
    expect(options.convert).toHaveBeenCalledWith(
      scene,
      expect.objectContaining({ jobId: 'job-1', scope }),
    );
    expect(options.runner).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1', scope, svg: expect.any(String) }),
    );
  });

  it('forwards each authenticated scope independently and never caches user state', async () => {
    const received: string[] = [];
    const options = optionsFor({
      runner: vi.fn(async ({ scope: receivedScope }) => {
        received.push(`${receivedScope.userId}:${receivedScope.sessionId}`);
        return { artifactRef: `asset://${receivedScope.userId}` };
      }),
    });
    const capability = createPptMasterPresentationCapability(options);

    await capability.render({ jobId: 'job-a', scene, scope });
    await capability.render({ jobId: 'job-b', scene, scope: otherScope });

    expect(received).toEqual(['user-1:session-1', 'user-2:session-2']);
  });

  it('fails closed for incomplete scope and cancellation without invoking the runner', async () => {
    const options = optionsFor();
    const capability = createPptMasterPresentationCapability(options);
    const controller = new AbortController();
    controller.abort();

    await expectCode(
      capability.render({ jobId: 'job-1', scene, scope: { userId: 'user-1' } as never }),
      'PRESENTATION_INVALID',
    );
    await expectCode(
      capability.render({ jobId: 'job-1', scene, scope, signal: controller.signal }),
      'PRESENTATION_WORKER_CANCELLED',
    );
    expect(options.runner).not.toHaveBeenCalled();
  });

  it('keeps injected conversion and runner failures truthful', async () => {
    const runnerError = new Error('external renderer failed');
    const capability = createPptMasterPresentationCapability(
      optionsFor({
        runner: vi.fn(async () => {
          throw runnerError;
        }),
      }),
    );

    await expect(capability.render({ jobId: 'job-1', scene, scope })).rejects.toMatchObject({
      cause: runnerError,
      code: 'PPT_MASTER_FAILED',
    });
  });

  it('rejects invalid scene conversion and runner path/bytes projections', async () => {
    const invalidConversion = createPptMasterPresentationCapability(
      optionsFor({ convert: vi.fn(async () => ({ svg: '<svg />' })) as never }),
    );
    await expectCode(invalidConversion.render({ jobId: 'job-1', scene, scope }), 'PPTX_INVALID');

    const unsafeResult = createPptMasterPresentationCapability(
      optionsFor({
        runner: vi.fn(async () => ({ artifactRef: '/tmp/result.pptx' })) as never,
      }),
    );
    await expectCode(unsafeResult.render({ jobId: 'job-1', scene, scope }), 'PPTX_INVALID');

    const bytesResult = createPptMasterPresentationCapability(
      optionsFor({
        runner: vi.fn(async () => ({
          artifactRef: 'asset://pptx/job-1',
          bytes: new Uint8Array([1]),
        })) as never,
      }),
    );
    await expectCode(bytesResult.render({ jobId: 'job-1', scene, scope }), 'PPTX_INVALID');
  });

  it('installs the capability through Cordis and disposes it idempotently', async () => {
    const options = optionsFor();
    const manifest = createPptMasterPluginManifest(options);
    const context = new Context();
    await context.plugin(manifest);
    const capability = context.get(PPT_MASTER_CAPABILITY_SERVICE) as {
      render: PptMasterPresentationCapability['render'];
      dispose: () => Promise<void>;
    };

    expect(capability).toBeDefined();
    await capability.dispose();
    await capability.dispose();
    await expectCode(
      capability.render({ jobId: 'job-1', scene, scope }),
      'PPT_MASTER_PLUGIN_DISPOSED',
    );
    await context.dispose();
    expect(PptMasterPluginError).toBeDefined();
  });
});
