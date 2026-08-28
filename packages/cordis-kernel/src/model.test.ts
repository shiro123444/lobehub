import { describe, expect, it } from 'vitest';

import { ModelAdapterRegistry } from './index';
import type { ModelAdapter, ModelGateway, ModelRequest, ModelStreamChunk } from './model';

const request: ModelRequest = {
  model: 'test-model',
  input: 'hello',
};

const adapter = (id: string, overrides: Partial<ModelAdapter> = {}): ModelAdapter => ({
  id,
  execute: async () => ({ id: `${id}-response`, content: 'ok' }),
  stream: async function* () {
    yield { type: 'text', content: 'ok' };
  },
  ...overrides,
});

const collect = async (stream: AsyncIterable<ModelStreamChunk>): Promise<ModelStreamChunk[]> => {
  const chunks: ModelStreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
};

describe('@lobechat/cordis-kernel ModelAdapterRegistry', () => {
  it('registers, gets, lists, and satisfies the ModelGateway seam', () => {
    const registry = new ModelAdapterRegistry();
    const local = adapter('local');
    registry.register(local);

    const gateway: ModelGateway = registry;
    expect(registry.get('local')).toBe(local);
    expect(registry.list()).toEqual([local]);
    expect(gateway).toBe(registry);
  });

  it('rejects duplicate adapter ids with MODEL_DUPLICATE', () => {
    const registry = new ModelAdapterRegistry();
    registry.register(adapter('duplicate'));

    expect(() => registry.register(adapter('duplicate'))).toThrow(
      expect.objectContaining({ code: 'MODEL_DUPLICATE' }),
    );
  });

  it('reports MODEL_NOT_FOUND for an unknown adapter', async () => {
    const registry = new ModelAdapterRegistry();

    await expect(registry.execute('missing', request)).rejects.toMatchObject({
      code: 'MODEL_NOT_FOUND',
    });
    expect(() => registry.stream('missing', request)).toThrow(
      expect.objectContaining({ code: 'MODEL_NOT_FOUND' }),
    );
  });

  it('executes the selected adapter with the original request', async () => {
    const registry = new ModelAdapterRegistry();
    let received: ModelRequest | undefined;
    registry.register(
      adapter('execute', {
        execute: async (value) => {
          received = value;
          return { content: 'answer', finishReason: 'stop' };
        },
      }),
    );

    const response = await registry.execute('execute', request);

    expect(received).toBe(request);
    expect(response).toEqual({ content: 'answer', finishReason: 'stop' });
  });

  it('streams chunks through the selected adapter', async () => {
    const registry = new ModelAdapterRegistry();
    registry.register(
      adapter('stream', {
        stream: async function* (value) {
          expect(value).toBe(request);
          yield { type: 'delta', content: 'a' };
          yield { type: 'delta', content: 'b' };
        },
      }),
    );

    await expect(collect(registry.stream('stream', request))).resolves.toEqual([
      { type: 'delta', content: 'a' },
      { type: 'delta', content: 'b' },
    ]);
  });

  it('normalizes execute provider errors and preserves their cause', async () => {
    const failure = new Error('upstream unavailable');
    const registry = new ModelAdapterRegistry();
    registry.register(adapter('broken-execute', { execute: () => Promise.reject(failure) }));

    try {
      await registry.execute('broken-execute', request);
      throw new Error('expected provider failure');
    } catch (error) {
      expect(error).toMatchObject({ code: 'MODEL_PROVIDER_ERROR', cause: failure });
    }
  });

  it('normalizes asynchronous stream provider errors and preserves their cause', async () => {
    const failure = new Error('stream interrupted');
    const registry = new ModelAdapterRegistry();
    registry.register(
      adapter('broken-stream', {
        stream: async function* () {
          yield { type: 'delta', content: 'partial' };
          throw failure;
        },
      }),
    );

    await expect(collect(registry.stream('broken-stream', request))).rejects.toMatchObject({
      code: 'MODEL_PROVIDER_ERROR',
      cause: failure,
    });
  });

  it('normalizes synchronous stream creation errors when iterated', async () => {
    const failure = new Error('stream setup failed');
    const registry = new ModelAdapterRegistry();
    registry.register(
      adapter('broken-setup', {
        stream: () => {
          throw failure;
        },
      }),
    );

    await expect(collect(registry.stream('broken-setup', request))).rejects.toMatchObject({
      code: 'MODEL_PROVIDER_ERROR',
      cause: failure,
    });
  });

  it('keeps adapter registration in memory only', () => {
    const registry = new ModelAdapterRegistry();
    registry.register(adapter('memory-only'));

    expect(registry.list().map(({ id }) => id)).toEqual(['memory-only']);
  });
});
