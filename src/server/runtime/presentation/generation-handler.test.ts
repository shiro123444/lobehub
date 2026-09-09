import { describe, expect, it } from 'vitest';

import type {
  PresentationJobInput,
  RuntimeScope,
} from '../../../../packages/runtime-contracts/src';
import type {
  PresentationGenerationCapability,
  PresentationGenerationCapabilityResult,
} from './generation-capability';
import { handlePresentationGenerationRequest } from './generation-handler';
import type { PresentationPipelineContext } from './pipeline';

const scope: RuntimeScope = { userId: 'u', sessionId: 's' };
const input: PresentationJobInput = {
  notebookId: 'n',
  sourceVersionIds: ['v'],
  title: 'Deck',
};
const generated = {
  plan: { planId: 'p', title: 'Deck', aspectRatio: '16:9', sourceVersionIds: ['v'], slides: [] },
  worker: {
    jobId: 'j',
    planId: 'p',
    qualityReport: { passed: true },
    artifacts: [
      {
        artifactId: 'a',
        bytes: new Uint8Array([1]),
        mimeType: 'x',
        name: 'a',
        type: 'pptx',
        status: 'ready',
        createdAt: 'now',
      },
    ],
  },
  artifacts: [
    {
      artifactId: 'a',
      type: 'pptx',
      name: 'a',
      mimeType: 'x',
      sizeBytes: 1,
      status: 'ready',
      createdAt: 'now',
    },
  ],
} as unknown as PresentationGenerationCapabilityResult;
const context: PresentationPipelineContext = {
  plannerContext: {},
  workerContext: {
    jobId: 'j',
    workspace: { path: '/tmp', write: async () => {} },
    qualityCheck: async () => ({ passed: true }),
    convert: async () => [],
  },
};

const requestFor = (body: unknown = input, init: RequestInit = {}): Request =>
  new Request('http://x', {
    ...init,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...init.headers },
    method: 'POST',
  });

const capabilityFor = (
  execute: (
    ...args: Parameters<PresentationGenerationCapability['execute']>
  ) => ReturnType<PresentationGenerationCapability['execute']>,
): PresentationGenerationCapability => ({ execute }) as unknown as PresentationGenerationCapability;

const hasInternalWireValue = (value: unknown): boolean => {
  if (value instanceof Uint8Array) return true;
  if (Array.isArray(value)) return value.some(hasInternalWireValue);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) =>
    key === 'bytes' || key === 'workspace' || key === 'workspacePath' || key === 'path'
      ? true
      : hasInternalWireValue(nested),
  );
};

describe('C-57 generation handler', () => {
  it('validates POST JSON and returns a wire-safe success response', async () => {
    const capability = capabilityFor(async () => generated);
    const response = await handlePresentationGenerationRequest(
      requestFor(),
      scope,
      capability,
      () => context,
    );

    expect(response.status).toBe(200);
    expect(hasInternalWireValue(response.body)).toBe(false);
    expect(JSON.stringify(response.body)).not.toContain('bytes');
    expect(JSON.stringify(response.body)).not.toContain('workspace');
  });

  it('normalizes prompt-only requests for the studio workflow', async () => {
    let received: PresentationJobInput | undefined;
    const capability = capabilityFor(async (_scope, input) => {
      received = input;
      return generated;
    });

    const response = await handlePresentationGenerationRequest(
      requestFor({ prompt: '人工智能导论课程\n请突出 Transformer', slideCount: 8 }),
      scope,
      capability,
      () => context,
    );

    expect(response.status).toBe(200);
    expect(received).toMatchObject({
      notebookId: 'studio',
      sourceVersionIds: [],
      title: '人工智能导论课程',
    });
  });

  it('passes a defensive input clone and request AbortSignal to the capability', async () => {
    const requestInput = {
      ...input,
      options: { nested: { values: ['original'] } },
    };
    let receivedInput: PresentationJobInput | undefined;
    let receivedContext: PresentationPipelineContext | undefined;
    const capability = capabilityFor(async (_scope, received, receivedPipelineContext) => {
      receivedInput = received;
      receivedContext = receivedPipelineContext;
      received.sourceVersionIds.push('mutated');
      const nested = received.options?.nested as { values: string[] };
      nested.values.push('mutated');
      return generated;
    });
    const controller = new AbortController();
    const response = await handlePresentationGenerationRequest(
      requestFor(requestInput, { signal: controller.signal }),
      scope,
      capability,
      () => context,
    );

    expect(response.status).toBe(200);
    expect(requestInput.sourceVersionIds).toEqual(['v']);
    expect(requestInput.options).toEqual({ nested: { values: ['original'] } });
    expect(receivedInput).not.toBe(requestInput);
    expect(receivedContext?.workerContext.abortSignal).toBe(controller.signal);
  });

  it('returns a structured response when contextFactory throws', async () => {
    const capability = capabilityFor(async () => generated);
    const contextFactory = (): PresentationPipelineContext => {
      throw Object.assign(new Error('quality context failed'), {
        code: 'PRESENTATION_QUALITY_FAILED',
        details: { stage: 'context' },
      });
    };

    await expect(
      handlePresentationGenerationRequest(requestFor(), scope, capability, contextFactory),
    ).resolves.toEqual({
      status: 502,
      headers: { 'content-type': 'application/json' },
      body: {
        error: {
          code: 'PRESENTATION_QUALITY_FAILED',
          message: 'quality context failed',
          details: { stage: 'context' },
        },
      },
    });
  });

  it.each([
    ['PROVIDER_UNAVAILABLE', 503],
    ['PRESENTATION_QUALITY_FAILED', 502],
    ['PPTX_INVALID', 502],
    ['PRESENTATION_WORKER_CANCELLED', 499],
    ['PRESENTATION_INVALID', 400],
    ['NOT_FOUND', 404],
  ] as const)('maps %s to HTTP status %s', async (code, expectedStatus) => {
    const capability = capabilityFor(async () => {
      throw Object.assign(new Error(`failed: ${code}`), { code });
    });

    await expect(
      handlePresentationGenerationRequest(requestFor(), scope, capability, () => context),
    ).resolves.toMatchObject({
      status: expectedStatus,
      body: { error: { code } },
    });
  });

  it('rejects malformed scope and input with structured PRESENTATION_INVALID responses', async () => {
    const capability = capabilityFor(async () => generated);
    const malformedInput = { notebookId: {}, sourceVersionIds: ['v'], title: 'Deck' };

    await expect(
      handlePresentationGenerationRequest(
        requestFor(),
        { userId: 42, sessionId: 's' } as unknown as RuntimeScope,
        capability,
        () => context,
      ),
    ).resolves.toMatchObject({ status: 400, body: { error: { code: 'PRESENTATION_INVALID' } } });
    await expect(
      handlePresentationGenerationRequest(
        requestFor(malformedInput),
        scope,
        capability,
        () => context,
      ),
    ).resolves.toMatchObject({ status: 400, body: { error: { code: 'PRESENTATION_INVALID' } } });
  });

  it('strips nested binary and workspace details from plan, quality, and artifacts', async () => {
    const unsafeResult = {
      ...generated,
      plan: {
        ...generated.plan,
        designSpec: {
          bytes: new Uint8Array([1]),
          keep: 'plan-detail',
          workspace: { path: '/private/workspace' },
        },
      },
      worker: {
        ...generated.worker,
        qualityReport: {
          passed: true,
          details: {
            bytes: new Uint8Array([2]),
            keep: 'quality-detail',
            workspacePath: '/private/workspace',
          },
        },
      },
    } as unknown as PresentationGenerationCapabilityResult;
    const capability = capabilityFor(async () => unsafeResult);

    const response = await handlePresentationGenerationRequest(
      requestFor(),
      scope,
      capability,
      () => context,
    );

    expect(response.status).toBe(200);
    expect(hasInternalWireValue(response.body)).toBe(false);
    expect(JSON.stringify(response.body)).toContain('plan-detail');
    expect(JSON.stringify(response.body)).toContain('quality-detail');
    expect(JSON.stringify(response.body)).not.toContain('/private/workspace');
  });

  it('returns 400 for unsupported method, invalid JSON, and non-object bodies', async () => {
    const capability = capabilityFor(async () => generated);

    await expect(
      handlePresentationGenerationRequest(
        new Request('http://x', { method: 'GET' }),
        scope,
        capability,
        () => context,
      ),
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      handlePresentationGenerationRequest(
        new Request('http://x', { method: 'POST', body: '{' }),
        scope,
        capability,
        () => context,
      ),
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      handlePresentationGenerationRequest(
        requestFor(['not', 'an', 'object']),
        scope,
        capability,
        () => context,
      ),
    ).resolves.toMatchObject({ status: 400 });
  });
});
