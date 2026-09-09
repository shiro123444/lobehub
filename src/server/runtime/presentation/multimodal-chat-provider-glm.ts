/**
 * Server-only OpenAI-compatible multimodal chat adapter.
 *
 * Provides a vendor-neutral multimodal completion port for PPT agent dialogue
 * and outline generation. Supports text + server-resolved image references (URL).
 * Strictly forbids client-side data URLs, file URIs, local paths, and base64.
 *
 * No process.env, filesystem, database or real network is touched directly.
 * All external boundaries (fetcher, clock, apiKey, endpoint) are explicitly injected.
 */

import type { RuntimeScope } from '../../../../packages/runtime-contracts/src';

export const DEFAULT_MULTIMODAL_CHAT_MODEL = 'gemini-3.8-flash-high';

export interface GLMChatFetchResponse {
  readonly json?: () => unknown | Promise<unknown>;
  readonly ok: boolean;
  readonly status: number;
  readonly text?: () => string | Promise<string>;
}

export type GLMChatFetcher = (
  endpoint: string,
  init: RequestInit,
) => GLMChatFetchResponse | Promise<GLMChatFetchResponse>;

export interface GLMImageContentPart {
  readonly image_url: {
    readonly detail?: 'auto' | 'high' | 'low';
    readonly url: string;
  };
  readonly type: 'image_url';
}

export interface GLMTextContentPart {
  readonly text: string;
  readonly type: 'text';
}

export type GLMChatContentPart = GLMTextContentPart | GLMImageContentPart;

export interface GLMChatMessage {
  readonly content: string | readonly GLMChatContentPart[];
  readonly role: 'assistant' | 'system' | 'user';
}

export interface GLMChatRequest {
  readonly idempotencyKey?: string;
  readonly max_tokens?: number;
  readonly messages: readonly GLMChatMessage[];
  readonly model?: string;
  readonly response_format?: { readonly type: 'json_object' | 'text' };
  readonly temperature?: number;
}

export interface GLMChatChoice {
  readonly finish_reason?: string;
  readonly index: number;
  readonly message: {
    readonly content: string;
    readonly role: 'assistant';
  };
}

export interface GLMChatUsage {
  readonly completion_tokens?: number;
  readonly prompt_tokens?: number;
  readonly total_tokens?: number;
}

export interface GLMChatResult {
  readonly choices: readonly GLMChatChoice[];
  readonly created: number;
  readonly id: string;
  readonly model: string;
  readonly usage?: GLMChatUsage;
}

export interface GLMChatContext {
  readonly idempotencyKey?: string;
  readonly scope: RuntimeScope;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly traceId?: string;
}

export interface GLMChatProviderManifest {
  readonly displayName: string;
  readonly model: string;
  readonly providerId: string;
  readonly supportsIdempotency: boolean;
  readonly supportsVision: boolean;
}

export interface GLMMultimodalChatPort {
  readonly chat: (request: GLMChatRequest, context: GLMChatContext) => Promise<GLMChatResult>;
  readonly manifest: GLMChatProviderManifest;
  readonly providerId: string;
}

export interface GLMChatProviderOptions {
  readonly allowRequestModelOverride?: boolean;
  readonly apiKey: string;
  readonly endpoint: string;
  readonly fetcher: GLMChatFetcher;
  readonly model?: string;
  readonly now?: () => number | string | Date;
  readonly providerId?: string;
}

export type GLMChatProviderErrorCode =
  | 'CHAT_CANCELLED'
  | 'CHAT_PAYLOAD_INVALID'
  | 'CHAT_PROVIDER_REJECTED'
  | 'CHAT_REQUEST_INVALID'
  | 'CHAT_SCOPE_INVALID'
  | 'CHAT_UNAVAILABLE';

export class GLMChatProviderError extends Error {
  constructor(
    public readonly code: GLMChatProviderErrorCode,
    message: string,
    public readonly path?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'GLMChatProviderError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const providerError = (
  code: GLMChatProviderErrorCode,
  message: string,
  path?: string,
): GLMChatProviderError => new GLMChatProviderError(code, message, path);

const invalid = (message: string, path?: string): GLMChatProviderError =>
  providerError('CHAT_REQUEST_INVALID', message, path);

const payloadInvalid = (message: string, path?: string): GLMChatProviderError =>
  providerError('CHAT_PAYLOAD_INVALID', message, path);

const unavailable = (message = 'Multimodal chat provider is unavailable'): GLMChatProviderError =>
  providerError('CHAT_UNAVAILABLE', message);

const cancelled = (): GLMChatProviderError =>
  providerError('CHAT_CANCELLED', 'Multimodal chat request was cancelled', 'signal');

export const assertSafeImageUrl = (url: unknown): string => {
  if (!nonEmptyString(url)) {
    throw invalid('Image URL must be a non-empty string', 'image_url.url');
  }
  const trimmed = url.trim();
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith('data:') ||
    lower.startsWith('file:') ||
    lower.startsWith('blob:') ||
    lower.startsWith('/') ||
    lower.startsWith('\\') ||
    lower.startsWith('webpack-internal:') ||
    lower.includes('base64')
  ) {
    throw invalid(
      'Image URL must not be a data URI, file URI, blob URI, local path, or base64 payload',
      'image_url.url',
    );
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('URL protocol must be http or https');
    }
  } catch {
    throw invalid('Image URL must be a valid HTTP/HTTPS URL', 'image_url.url');
  }
  return trimmed;
};

const cloneScope = (value: unknown): RuntimeScope => {
  if (!isRecord(value) || !nonEmptyString(value.userId) || !nonEmptyString(value.sessionId)) {
    throw providerError(
      'CHAT_SCOPE_INVALID',
      'scope.userId and scope.sessionId must be non-empty strings',
      'scope',
    );
  }
  return { sessionId: value.sessionId.trim(), userId: value.userId.trim() };
};

const scopeKey = (scope: RuntimeScope): string => JSON.stringify([scope.userId, scope.sessionId]);

const validateMessages = (messages: unknown): readonly GLMChatMessage[] => {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw invalid('messages must be a non-empty array', 'messages');
  }

  return Object.freeze(
    messages.map((m, index) => {
      if (!isRecord(m)) {
        throw invalid(`messages[${index}] must be an object`, `messages[${index}]`);
      }
      const role = m.role as 'assistant' | 'system' | 'user';
      if (role !== 'system' && role !== 'user' && role !== 'assistant') {
        throw invalid(
          `messages[${index}].role must be system, user, or assistant`,
          `messages[${index}].role`,
        );
      }

      if (typeof m.content === 'string') {
        return { content: m.content, role };
      }

      if (Array.isArray(m.content)) {
        const parts = m.content.map((part, partIndex) => {
          if (!isRecord(part)) {
            throw invalid(
              `messages[${index}].content[${partIndex}] must be an object`,
              `messages[${index}].content[${partIndex}]`,
            );
          }
          if (part.type === 'text') {
            if (typeof part.text !== 'string') {
              throw invalid(
                `messages[${index}].content[${partIndex}].text must be a string`,
                `messages[${index}].content[${partIndex}].text`,
              );
            }
            return { text: part.text, type: 'text' as const };
          }
          if (part.type === 'image_url') {
            if (!isRecord(part.image_url)) {
              throw invalid(
                `messages[${index}].content[${partIndex}].image_url must be an object`,
                `messages[${index}].content[${partIndex}].image_url`,
              );
            }
            const safeUrl = assertSafeImageUrl(part.image_url.url);
            return {
              image_url: {
                ...(part.image_url.detail ? { detail: part.image_url.detail as any } : {}),
                url: safeUrl,
              },
              type: 'image_url' as const,
            };
          }
          throw invalid(
            `messages[${index}].content[${partIndex}].type must be text or image_url`,
            `messages[${index}].content[${partIndex}].type`,
          );
        });

        return { content: Object.freeze(parts), role };
      }

      throw invalid(
        `messages[${index}].content must be a string or array of content parts`,
        `messages[${index}].content`,
      );
    }),
  );
};

export class GLMMultimodalChatAdapter implements GLMMultimodalChatPort {
  public readonly manifest: GLMChatProviderManifest;
  public readonly providerId: string;

  private readonly allowRequestModelOverride: boolean;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetcher: GLMChatFetcher;
  private readonly model: string;
  private readonly now: () => number;
  private readonly responseCache = new Map<string, GLMChatResult>();

  constructor(options: GLMChatProviderOptions) {
    if (!isRecord(options)) throw invalid('Options must be an object');
    if (!nonEmptyString(options.apiKey)) throw unavailable('Chat provider apiKey is required');
    if (!nonEmptyString(options.endpoint)) throw unavailable('Chat provider endpoint is required');
    if (typeof options.fetcher !== 'function')
      throw unavailable('Chat provider fetcher is required');

    this.allowRequestModelOverride = options.allowRequestModelOverride ?? true;
    this.apiKey = options.apiKey.trim();
    this.endpoint = options.endpoint.trim();
    this.fetcher = options.fetcher;
    this.model = nonEmptyString(options.model)
      ? options.model.trim()
      : DEFAULT_MULTIMODAL_CHAT_MODEL;
    this.providerId = nonEmptyString(options.providerId)
      ? options.providerId.trim()
      : 'presentation-multimodal-chat';

    const nowFn = options.now;
    this.now = () => {
      if (typeof nowFn === 'function') {
        const val = nowFn();
        return typeof val === 'number'
          ? val
          : typeof val === 'string'
            ? Date.parse(val)
            : val.getTime();
      }
      return Date.now();
    };

    this.manifest = Object.freeze({
      displayName: '多模态聊天（OpenAI 兼容）',
      model: this.model,
      providerId: this.providerId,
      supportsIdempotency: true,
      supportsVision: true,
    });
  }

  async chat(request: GLMChatRequest, context: GLMChatContext): Promise<GLMChatResult> {
    if (!isRecord(request)) throw invalid('Request must be an object', 'request');
    if (!isRecord(context)) throw invalid('Context must be an object', 'context');

    const scope = cloneScope(context.scope);

    if (context.signal?.aborted) throw cancelled();

    const validatedMessages = validateMessages(request.messages);
    const resolvedModel =
      this.allowRequestModelOverride && nonEmptyString(request.model)
        ? request.model.trim()
        : this.model;

    const idempotencyKey = nonEmptyString(context.idempotencyKey)
      ? context.idempotencyKey.trim()
      : nonEmptyString(request.idempotencyKey)
        ? request.idempotencyKey.trim()
        : undefined;

    const cacheKey = idempotencyKey ? `${scopeKey(scope)}:${idempotencyKey}` : undefined;
    if (cacheKey && this.responseCache.has(cacheKey)) {
      return this.responseCache.get(cacheKey)!;
    }

    const payload: Record<string, unknown> = {
      messages: validatedMessages,
      model: resolvedModel,
      ...(typeof request.temperature === 'number' ? { temperature: request.temperature } : {}),
      ...(typeof request.max_tokens === 'number' ? { max_tokens: request.max_tokens } : {}),
      ...(request.response_format ? { response_format: request.response_format } : {}),
    };

    let response: GLMChatFetchResponse;
    try {
      response = await this.fetcher(this.endpoint, {
        body: JSON.stringify(payload),
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
        signal: context.signal,
      });
    } catch (error: any) {
      if (context.signal?.aborted || error?.name === 'AbortError') {
        throw cancelled();
      }
      throw unavailable(`Multimodal chat request failed: ${error?.message || 'network error'}`);
    }

    if (context.signal?.aborted) throw cancelled();

    if (!response.ok || response.status < 200 || response.status >= 300) {
      if (response.status === 401 || response.status === 403) {
        throw providerError(
          'CHAT_PROVIDER_REJECTED',
          'Multimodal chat provider rejected authentication or authorization',
        );
      }
      if (response.status === 429 || response.status >= 500) {
        throw unavailable(`Multimodal chat provider returned HTTP ${response.status}`);
      }
      let errBody = '';
      try {
        if (typeof response.text === 'function') errBody = await response.text();
        else if (typeof response.json === 'function')
          errBody = JSON.stringify(await response.json());
      } catch {
        // ignore
      }
      throw providerError(
        'CHAT_REQUEST_INVALID',
        `Multimodal chat provider returned HTTP ${response.status}${errBody ? `: ${errBody}` : ''}`,
      );
    }

    let parsedBody: unknown;
    try {
      if (typeof response.json === 'function') {
        parsedBody = await response.json();
      } else if (typeof response.text === 'function') {
        parsedBody = JSON.parse(await response.text());
      }
    } catch {
      throw payloadInvalid('Failed to parse multimodal chat response JSON');
    }

    if (!isRecord(parsedBody)) {
      throw payloadInvalid('Multimodal chat response must be an object');
    }

    if (!Array.isArray(parsedBody.choices) || parsedBody.choices.length === 0) {
      throw payloadInvalid('Multimodal chat response choices must be a non-empty array');
    }

    const choices: GLMChatChoice[] = parsedBody.choices.map((c, idx) => {
      if (!isRecord(c) || !isRecord(c.message) || typeof c.message.content !== 'string') {
        throw payloadInvalid(`Multimodal chat response choices[${idx}] has invalid message`);
      }
      return {
        finish_reason: typeof c.finish_reason === 'string' ? c.finish_reason : undefined,
        index: typeof c.index === 'number' ? c.index : idx,
        message: {
          content: c.message.content,
          role: 'assistant' as const,
        },
      };
    });

    const result: GLMChatResult = Object.freeze({
      choices: Object.freeze(choices),
      created:
        typeof parsedBody.created === 'number' ? parsedBody.created : Math.floor(this.now() / 1000),
      id: typeof parsedBody.id === 'string' ? parsedBody.id : `chatcmpl-${this.now()}`,
      model: typeof parsedBody.model === 'string' ? parsedBody.model : resolvedModel,
      usage: isRecord(parsedBody.usage)
        ? {
            completion_tokens:
              typeof parsedBody.usage.completion_tokens === 'number'
                ? parsedBody.usage.completion_tokens
                : undefined,
            prompt_tokens:
              typeof parsedBody.usage.prompt_tokens === 'number'
                ? parsedBody.usage.prompt_tokens
                : undefined,
            total_tokens:
              typeof parsedBody.usage.total_tokens === 'number'
                ? parsedBody.usage.total_tokens
                : undefined,
          }
        : undefined,
    });

    if (cacheKey) {
      this.responseCache.set(cacheKey, result);
    }

    return result;
  }
}

export const createGLMMultimodalChatPort = (
  options: GLMChatProviderOptions,
): GLMMultimodalChatPort => new GLMMultimodalChatAdapter(options);

/**
 * Provider-neutral aliases used by the production presentation pipeline.
 * The GLM-suffixed exports above remain only as a source-compatibility seam
 * for older integrations; no GLM provider is registered or selected by
 * default anymore.
 */
export type MultimodalChatFetchResponse = GLMChatFetchResponse;
export type MultimodalChatFetcher = GLMChatFetcher;
export type MultimodalImageContentPart = GLMImageContentPart;
export type MultimodalTextContentPart = GLMTextContentPart;
export type MultimodalChatContentPart = GLMChatContentPart;
export type MultimodalChatMessage = GLMChatMessage;
export type MultimodalChatRequest = GLMChatRequest;
export type MultimodalChatChoice = GLMChatChoice;
export type MultimodalChatUsage = GLMChatUsage;
export type MultimodalChatResult = GLMChatResult;
export type MultimodalChatContext = GLMChatContext;
export type MultimodalChatProviderManifest = GLMChatProviderManifest;
export type MultimodalChatPort = GLMMultimodalChatPort;
export type MultimodalChatProviderOptions = GLMChatProviderOptions;
export type MultimodalChatProviderErrorCode = GLMChatProviderErrorCode;
export const MultimodalChatProviderError = GLMChatProviderError;
export const createMultimodalChatPort = createGLMMultimodalChatPort;
