import { describe, expect, it, vi } from 'vitest';

import { PresentationError } from '../../../../packages/cordis-kernel/src/presentation';
import type {
  ImageGenerationContext,
  RuntimeScope,
} from '../../../../packages/runtime-contracts/src';
import type { OpenAIImageFetcher } from './image-provider-openai';
import {
  createProductionOpenAIImageGenerationPort,
  DEFAULT_PRODUCTION_IMAGE_MODEL,
  loadProductionOpenAIImageProviderConfig,
  loadProductionOpenAIImageProviderOptions,
  normalizeOpenAIImageEndpoint,
  PRODUCTION_IMAGE_ENV_KEYS,
  type ProductionOpenAIImageProviderDependencies,
} from './production-image-config';

const env = (overrides: Record<string, string | undefined> = {}) => ({
  [PRODUCTION_IMAGE_ENV_KEYS.apiKey]: 'test-key',
  [PRODUCTION_IMAGE_ENV_KEYS.baseUrl]: 'https://images.example.test',
  ...overrides,
});

const scope: RuntimeScope = { sessionId: 'session-1', userId: 'user-1' };

const response = (payload: unknown): Awaited<ReturnType<OpenAIImageFetcher>> => ({
  json: async () => payload,
  ok: true,
  status: 200,
});

const dependenciesFor = (
  overrides: Partial<ProductionOpenAIImageProviderDependencies> = {},
): ProductionOpenAIImageProviderDependencies => ({
  fetcher: vi.fn<OpenAIImageFetcher>(async () =>
    response({ data: [{ url: 'https://cdn.test/a' }] }),
  ),
  ...overrides,
});

describe('C-98 production OpenAI image configuration seam', () => {
  it('normalizes host, trailing slash, /v1, and the complete path exactly once', () => {
    expect(normalizeOpenAIImageEndpoint('https://images.example.test')).toBe(
      'https://images.example.test/v1/images/generations',
    );
    expect(normalizeOpenAIImageEndpoint('https://images.example.test/')).toBe(
      'https://images.example.test/v1/images/generations',
    );
    expect(normalizeOpenAIImageEndpoint('https://images.example.test/v1/')).toBe(
      'https://images.example.test/v1/images/generations',
    );
    expect(normalizeOpenAIImageEndpoint('https://images.example.test/v1/images/generations')).toBe(
      'https://images.example.test/v1/images/generations',
    );
  });

  it('loads the default model and preserves explicit model configuration', () => {
    expect(loadProductionOpenAIImageProviderConfig(env())).toEqual({
      apiKey: 'test-key',
      endpoint: 'https://images.example.test/v1/images/generations',
      model: DEFAULT_PRODUCTION_IMAGE_MODEL,
    });
    expect(
      loadProductionOpenAIImageProviderConfig(
        env({ [PRODUCTION_IMAGE_ENV_KEYS.model]: 'custom-image-model' }),
      ).model,
    ).toBe('custom-image-model');
  });

  it('fails closed for missing base URL or key without invoking injected seams', () => {
    const dependencies = dependenciesFor();
    for (const missing of [
      { [PRODUCTION_IMAGE_ENV_KEYS.apiKey]: 'test-key' },
      { [PRODUCTION_IMAGE_ENV_KEYS.baseUrl]: 'https://images.example.test' },
    ]) {
      expect(() => createProductionOpenAIImageGenerationPort(missing, dependencies)).toThrowError(
        expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE' }),
      );
    }
    expect(dependencies.fetcher).not.toHaveBeenCalled();
  });

  it('rejects non-HTTPS, malformed, credential-bearing, and unexpected-path URLs', () => {
    for (const value of [
      'http://images.example.test',
      'not-a-url',
      'https://user:password@images.example.test',
      'https://images.example.test/other',
    ]) {
      expect(() =>
        loadProductionOpenAIImageProviderConfig(
          env({
            [PRODUCTION_IMAGE_ENV_KEYS.baseUrl]: value,
          }),
        ),
      ).toThrowError(expect.objectContaining({ code: 'PRESENTATION_INVALID' }));
    }
  });

  it('rejects invalid model and missing fetcher with stable errors', () => {
    expect(() =>
      loadProductionOpenAIImageProviderConfig(env({ [PRODUCTION_IMAGE_ENV_KEYS.model]: '   ' })),
    ).toThrowError(expect.objectContaining({ code: 'PRESENTATION_INVALID' }));
    expect(() =>
      createProductionOpenAIImageGenerationPort(
        env(),
        {} as ProductionOpenAIImageProviderDependencies,
      ),
    ).toThrowError(expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE' }));
  });

  it('passes injected fetcher, sink, clock, and caller-owned scope only at invocation time', async () => {
    const fetcher = vi.fn<OpenAIImageFetcher>(async (_endpoint, init) => {
      expect(_endpoint).toBe('https://images.example.test/v1/images/generations');
      expect(init.method).toBe('POST');
      return response({ data: [{ b64_json: 'aGVsbG8=' }] });
    });
    const assetSink = vi.fn(async ({ scope: receivedScope }: { scope: RuntimeScope }) => ({
      ref: `asset://${receivedScope.userId}/${receivedScope.sessionId}`,
    }));
    const now = vi.fn(() => '2026-09-01T00:00:00.000Z');
    const port = createProductionOpenAIImageGenerationPort(env(), {
      assetSink,
      fetcher,
      now,
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(assetSink).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();

    const context: ImageGenerationContext = { scope };
    const result = await port.generate({ prompt: 'safe test prompt' }, context);

    expect(assetSink).toHaveBeenCalledWith(expect.objectContaining({ scope }));
    expect(result[0]?.asset.ref).toBe('asset://user-1/session-1');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(now).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('safe test prompt');
  });

  it('keeps one assembled port safe for distinct caller scopes', async () => {
    const assetSink = vi.fn(async ({ scope: receivedScope }: { scope: RuntimeScope }) => ({
      ref: `asset://${receivedScope.sessionId}`,
    }));
    const port = createProductionOpenAIImageGenerationPort(env(), {
      assetSink,
      fetcher: vi.fn<OpenAIImageFetcher>(async () => response({ data: [{ b64_json: 'aA==' }] })),
    });

    await port.generate({ prompt: 'one' }, { scope });
    await port.generate({ prompt: 'two' }, { scope: { sessionId: 'session-2', userId: 'user-2' } });

    expect(assetSink.mock.calls.map(([input]) => input.scope)).toEqual([
      scope,
      { sessionId: 'session-2', userId: 'user-2' },
    ]);
  });

  it('does not echo credentials in configuration failures', () => {
    const secret = 'test-key-that-must-not-appear';
    let error: unknown;
    try {
      loadProductionOpenAIImageProviderConfig(
        env({ [PRODUCTION_IMAGE_ENV_KEYS.baseUrl]: 'https://images.example.test/invalid' }),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PresentationError);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it('supports the explicit { env, dependencies } composition form', () => {
    const dependencies = dependenciesFor();
    const options = loadProductionOpenAIImageProviderOptions(env(), dependencies);
    expect(options.endpoint).toBe('https://images.example.test/v1/images/generations');
    expect(options.model).toBe('gpt-image-2');

    const port = createProductionOpenAIImageGenerationPort({ env: env(), ...dependencies });
    expect(port.providerId).toBe('openai.image');
  });
});
