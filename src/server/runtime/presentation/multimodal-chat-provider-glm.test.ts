import { describe, expect, it, vi } from 'vitest';

import type { RuntimeScope } from '../../../../packages/runtime-contracts/src';
import {
  assertSafeImageUrl,
  createGLMMultimodalChatPort,
  type GLMChatFetcher,
  GLMChatProviderError,
  type GLMChatRequest,
} from './multimodal-chat-provider-glm';

const response = (
  payload: unknown,
  status = 200,
  ok = status >= 200 && status < 300,
): Awaited<ReturnType<GLMChatFetcher>> => ({
  json: async () => payload,
  ok,
  status,
  text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
});

const defaultScope: RuntimeScope = {
  sessionId: 'test-session',
  userId: 'test-user',
};

const defaultOptions = (fetcher: GLMChatFetcher) => ({
  apiKey: 'secret-test-token-12345',
  endpoint: 'https://api.b.ai/v1/chat/completions',
  fetcher,
  model: 'glm-5.3-flash',
  now: () => 1700000000000,
});

describe('GLMMultimodalChatAdapter (C-106)', () => {
  it('sends OpenAI-compatible chat completions requests with bearer authorization', async () => {
    let capturedEndpoint = '';
    let capturedInit: RequestInit | undefined;

    const fetcher: GLMChatFetcher = vi.fn(async (endpoint, init) => {
      capturedEndpoint = endpoint;
      capturedInit = init;
      return response({
        choices: [
          {
            finish_reason: 'stop',
            index: 0,
            message: {
              content: 'Hello! I am GLM-5.3-Flash.',
              role: 'assistant',
            },
          },
        ],
        created: 1700000000,
        id: 'chatcmpl-test-123',
        model: 'glm-5.3-flash',
        usage: {
          completion_tokens: 10,
          prompt_tokens: 15,
          total_tokens: 25,
        },
      });
    });

    const port = createGLMMultimodalChatPort(defaultOptions(fetcher));

    const result = await port.chat(
      {
        messages: [
          { content: 'You are a helpful assistant', role: 'system' },
          { content: 'Hello GLM', role: 'user' },
        ],
        temperature: 0.7,
      },
      { scope: defaultScope },
    );

    expect(capturedEndpoint).toBe('https://api.b.ai/v1/chat/completions');
    expect(capturedInit?.method).toBe('POST');
    expect((capturedInit?.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer secret-test-token-12345',
    );
    expect((capturedInit?.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );

    const body = JSON.parse(capturedInit?.body as string);
    expect(body.model).toBe('glm-5.3-flash');
    expect(body.temperature).toBe(0.7);
    expect(body.messages).toEqual([
      { content: 'You are a helpful assistant', role: 'system' },
      { content: 'Hello GLM', role: 'user' },
    ]);

    expect(result.id).toBe('chatcmpl-test-123');
    expect(result.choices[0].message.content).toBe('Hello! I am GLM-5.3-Flash.');
    expect(result.usage?.total_tokens).toBe(25);
  });

  it('supports multimodal vision content with safe remote image URLs', async () => {
    let capturedBody: any;
    const fetcher: GLMChatFetcher = vi.fn(async (_endpoint, init) => {
      capturedBody = JSON.parse(init.body as string);
      return response({
        choices: [
          {
            finish_reason: 'stop',
            index: 0,
            message: { content: 'I see a presentation slide diagram.', role: 'assistant' },
          },
        ],
        id: 'chatcmpl-vision-1',
        model: 'glm-5.3-flash',
      });
    });

    const port = createGLMMultimodalChatPort(defaultOptions(fetcher));

    const result = await port.chat(
      {
        messages: [
          {
            content: [
              { text: 'Please analyze this slide:', type: 'text' },
              {
                image_url: { detail: 'high', url: 'https://cdn.example.com/slide-preview.png' },
                type: 'image_url',
              },
            ],
            role: 'user',
          },
        ],
      },
      { scope: defaultScope },
    );

    expect(capturedBody.messages[0].content).toEqual([
      { text: 'Please analyze this slide:', type: 'text' },
      {
        image_url: { detail: 'high', url: 'https://cdn.example.com/slide-preview.png' },
        type: 'image_url',
      },
    ]);
    expect(result.choices[0].message.content).toBe('I see a presentation slide diagram.');
  });

  describe('Security invariants: strictly reject data URIs, file URIs, local paths, and base64', () => {
    it.each([
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'DATA:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD',
      'file:///home/shiro/secret.png',
      'FILE:///C:/Windows/System32/config.sys',
      'blob:https://app.lobehub.com/1234-5678',
      '/tmp/upload.png',
      '\\server\\share\\image.png',
      'https://example.com/image?payload=base64data',
    ])('rejects unsafe image url: %s', (unsafeUrl) => {
      expect(() => assertSafeImageUrl(unsafeUrl)).toThrowError(GLMChatProviderError);
    });

    it('rejects chat request containing unsafe image URL', async () => {
      const fetcher = vi.fn<GLMChatFetcher>();
      const port = createGLMMultimodalChatPort(defaultOptions(fetcher));

      await expect(
        port.chat(
          {
            messages: [
              {
                content: [
                  { text: 'Analyze this', type: 'text' },
                  {
                    image_url: { url: 'data:image/png;base64,aGVsbG8=' },
                    type: 'image_url',
                  },
                ],
                role: 'user',
              },
            ],
          },
          { scope: defaultScope },
        ),
      ).rejects.toThrowError(GLMChatProviderError);

      expect(fetcher).not.toHaveBeenCalled();
    });
  });

  describe('Scope isolation, idempotency, timeout and cancellation', () => {
    it('requires valid scope with userId and sessionId', async () => {
      const fetcher = vi.fn<GLMChatFetcher>();
      const port = createGLMMultimodalChatPort(defaultOptions(fetcher));

      await expect(
        port.chat(
          { messages: [{ content: 'Hi', role: 'user' }] },
          { scope: { sessionId: '', userId: 'u1' } as any },
        ),
      ).rejects.toThrowError(/scope/);

      await expect(
        port.chat(
          { messages: [{ content: 'Hi', role: 'user' }] },
          { scope: { sessionId: 's1', userId: '   ' } as any },
        ),
      ).rejects.toThrowError(/scope/);
    });

    it('returns cached result on idempotent replay within the same scope', async () => {
      const fetcher = vi.fn<GLMChatFetcher>(async () =>
        response({
          choices: [{ index: 0, message: { content: 'Idempotent response', role: 'assistant' } }],
          id: 'chatcmpl-idemp',
        }),
      );
      const port = createGLMMultimodalChatPort(defaultOptions(fetcher));

      const req: GLMChatRequest = {
        idempotencyKey: 'key-123',
        messages: [{ content: 'Generate outline', role: 'user' }],
      };

      const res1 = await port.chat(req, { idempotencyKey: 'key-123', scope: defaultScope });
      const res2 = await port.chat(req, { idempotencyKey: 'key-123', scope: defaultScope });

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(res1).toBe(res2);

      // Different scope with same key must not share cache
      const otherScope: RuntimeScope = { sessionId: 'other-session', userId: 'other-user' };
      await port.chat(req, { idempotencyKey: 'key-123', scope: otherScope });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('maps AbortSignal cancellation to CHAT_CANCELLED', async () => {
      const controller = new AbortController();
      controller.abort();

      const fetcher = vi.fn<GLMChatFetcher>();
      const port = createGLMMultimodalChatPort(defaultOptions(fetcher));

      const err = await port
        .chat(
          { messages: [{ content: 'Hi', role: 'user' }] },
          { scope: defaultScope, signal: controller.signal },
        )
        .catch((e) => e);

      expect(err).toBeInstanceOf(GLMChatProviderError);
      expect(err.code).toBe('CHAT_CANCELLED');
    });

    it('maps 401/403 to CHAT_PROVIDER_REJECTED without leaking API key', async () => {
      const fetcher = vi.fn<GLMChatFetcher>(async () =>
        response({ error: { message: 'Invalid API key secret-test-token-12345' } }, 401, false),
      );
      const port = createGLMMultimodalChatPort(defaultOptions(fetcher));

      const err = await port
        .chat({ messages: [{ content: 'Hi', role: 'user' }] }, { scope: defaultScope })
        .catch((e) => e);

      expect(err).toBeInstanceOf(GLMChatProviderError);
      expect(err.code).toBe('CHAT_PROVIDER_REJECTED');
      expect(err.message).not.toContain('secret-test-token-12345');
    });

    it('maps 429/503 to CHAT_UNAVAILABLE', async () => {
      const fetcher = vi.fn<GLMChatFetcher>(async () => response('Overloaded', 503, false));
      const port = createGLMMultimodalChatPort(defaultOptions(fetcher));

      const err = await port
        .chat({ messages: [{ content: 'Hi', role: 'user' }] }, { scope: defaultScope })
        .catch((e) => e);

      expect(err).toBeInstanceOf(GLMChatProviderError);
      expect(err.code).toBe('CHAT_UNAVAILABLE');
    });
  });
});
