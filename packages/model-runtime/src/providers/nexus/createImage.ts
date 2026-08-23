import { imageUrlToBase64 } from '@lobechat/utils';
import createDebug from 'debug';

import type { CreateImageOptions } from '../../core/openaiCompatibleFactory';
import type { CreateImagePayload, CreateImageResponse } from '../../types/image';
import { AgentRuntimeError } from '../../utils/createError';

const log = createDebug('lobe-image:nexus');

const DEFAULT_BASE_URL = 'https://app.soruxgpt.com/api/codex/v1';
const RESPONSE_MODEL = 'gpt-5.4-mini';
const RETRYABLE_STATUS = new Set([408, 502, 503, 504]);
const RESPONSES_NO_IMAGE_ERROR = 'NEXUS Responses API returned no image';
const IMAGE_B64_KEYS = new Set(['b64_json', 'image_b64', 'partial_image_b64']);
const IMAGE_OUTPUT_TYPES = new Set(['image_generation_call']);

interface TryImageResult {
  error?: string;
  imageUrl?: string;
}

interface ResponsesStreamResult {
  error?: string;
  imageB64?: string;
}

interface ResponsesStreamState {
  completedB64s: string[];
  error?: string;
  latestByOutput: Map<string, string>;
  sawImageGenerationEvent: boolean;
  textSnippets: string[];
}

const joinUrl = (baseURL: string | null | undefined, pathname: string) => {
  return `${(baseURL || DEFAULT_BASE_URL).replace(/\/+$/, '')}${pathname}`;
};

const toDataUrl = (base64: string, mimeType = 'image/png') => {
  if (base64.startsWith('data:')) return base64;

  return `data:${mimeType};base64,${base64}`;
};

const toImageUrl = (value: string, mimeType = 'image/png') => {
  if (value.startsWith('data:') || value.startsWith('http://') || value.startsWith('https://')) {
    return value;
  }

  return toDataUrl(value, mimeType);
};

const resolveSize = (params: CreateImagePayload['params']) => {
  const size = String((params as any).size || '').trim().toLowerCase();
  if (size && size !== 'auto') return size;

  if (params.width && params.height) return `${params.width}x${params.height}`;

  return '1024x1024';
};

const getReferenceImageUrls = async (params: CreateImagePayload['params']) => {
  const urls = [params.imageUrl, ...(params.imageUrls || [])].filter(Boolean) as string[];

  return Promise.all(
    urls.map(async (url) => {
      if (url.startsWith('data:')) return url;

      const { base64, mimeType } = await imageUrlToBase64(url);
      return toDataUrl(base64, mimeType || 'image/png');
    }),
  );
};

const collectImageValues = (value: unknown, found: string[]) => {
  if (!value) return;

  if (Array.isArray(value)) {
    value.forEach((item) => collectImageValues(item, found));
    return;
  }

  if (typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : undefined;

  if (type && IMAGE_OUTPUT_TYPES.has(type) && typeof record.result === 'string' && record.result) {
    found.push(record.result);
  }

  Object.entries(record).forEach(([key, item]) => {
    if (IMAGE_B64_KEYS.has(key) && typeof item === 'string' && item) {
      found.push(item);
      return;
    }

    collectImageValues(item, found);
  });
};

const extractErrorMessageFromData = (data: any) => {
  const error = data?.error;

  if (typeof error?.message === 'string') return error.message;
  if (typeof error?.detail === 'string') return error.detail;
  if (typeof error?.code === 'string') return error.code;
  if (typeof data?.message === 'string') return data.message;
  if (typeof data?.detail === 'string') return data.detail;

  return undefined;
};

const extractErrorMessage = async (response: Response) => {
  try {
    const data = await response.json();
    const message = extractErrorMessageFromData(data);
    if (message) return message;
  } catch {
    try {
      const text = await response.text();
      if (text) return text.slice(0, 500);
    } catch {
      // ignore body parse errors
    }
  }

  return `NEXUS image API returned HTTP ${response.status}`;
};

const createResponsesStreamState = (): ResponsesStreamState => ({
  completedB64s: [],
  latestByOutput: new Map<string, string>(),
  sawImageGenerationEvent: false,
  textSnippets: [],
});

const pushTextSnippet = (state: ResponsesStreamState, value: unknown) => {
  if (typeof value !== 'string' || !value.trim()) return;

  const currentLength = state.textSnippets.join('').length;
  if (currentLength >= 300) return;

  state.textSnippets.push(value.slice(0, 300 - currentLength));
};

const finalizeResponsesStreamResult = (state: ResponsesStreamState): ResponsesStreamResult => {
  const imageB64 = state.completedB64s[0] || Array.from(state.latestByOutput.values())[0];
  if (imageB64) return { imageB64 };
  if (state.error) return { error: state.error };
  if (state.sawImageGenerationEvent) {
    return { error: 'NEXUS Responses API image_generation call completed without an image' };
  }

  const text = state.textSnippets.join('').trim();
  if (text) {
    return {
      error: `NEXUS Responses API did not call image_generation; upstream returned text: ${text}`,
    };
  }

  return { error: RESPONSES_NO_IMAGE_ERROR };
};

const parseResponsesStream = async (response: Response): Promise<ResponsesStreamResult> => {
  const state = createResponsesStreamState();

  if (!response.body) {
    const text = await response.text();

    text.split(/\r?\n/).forEach((line) => {
      parseResponsesStreamLine(line, state);
    });
  } else {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';

      lines.forEach((line) => {
        parseResponsesStreamLine(line, state);
      });
    }

    buffer
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => {
        parseResponsesStreamLine(line, state);
      });
  }

  return finalizeResponsesStreamResult(state);
};

const parseResponsesStreamLine = (line: string, state: ResponsesStreamState) => {
  const trimmed = line.trim();
  const raw = trimmed.startsWith('data:')
    ? trimmed.slice(5).trim()
    : trimmed.startsWith('{')
      ? trimmed
      : undefined;

  if (!raw || raw === '[DONE]') return;

  try {
    const event = JSON.parse(raw);

    if (event.type === 'response.image_generation_call.partial_image') {
      state.sawImageGenerationEvent = true;
      const b64 = event.partial_image_b64;
      if (b64) state.latestByOutput.set(String(event.output_index ?? 0), b64);
      return;
    }

    if (event.type === 'response.completed') {
      collectImageValues(event.response, state.completedB64s);
      const output = event.response?.output;
      if (
        Array.isArray(output) &&
        output.some((item) => item?.type === 'image_generation_call')
      ) {
        state.sawImageGenerationEvent = true;
      }
      return;
    }

    if (
      typeof event.type === 'string' &&
      event.type.includes('image_generation_call') &&
      typeof event.result === 'string' &&
      event.result
    ) {
      state.sawImageGenerationEvent = true;
      state.completedB64s.push(event.result);
      return;
    }

    if (typeof event.type === 'string' && event.type.includes('image_generation_call')) {
      state.sawImageGenerationEvent = true;
    }

    if (event.type === 'response.failed' || event.type === 'response.incomplete') {
      state.error = extractErrorMessageFromData(event.response || event) || event.type;
      return;
    }

    pushTextSnippet(state, event.delta);
    pushTextSnippet(state, event.text);
    if (event.type === 'response.output_text.done') pushTextSnippet(state, event.text);

    collectImageValues(event, state.completedB64s);
  } catch {
    // Ignore malformed upstream SSE lines.
  }
};

const callResponsesImageGeneration = async (
  payload: CreateImagePayload,
  options: CreateImageOptions,
): Promise<TryImageResult> => {
  const { apiKey, baseURL } = options;
  const { model, params } = payload;
  const endpoint = joinUrl(baseURL, '/responses');
  const referenceImages = await getReferenceImageUrls(params);
  const content = [
    { text: params.prompt, type: 'input_text' },
    ...referenceImages.map((imageUrl) => ({ image_url: imageUrl, type: 'input_image' })),
  ];
  const requestBody = {
    input: [{ content, role: 'user', type: 'message' }],
    model: RESPONSE_MODEL,
    store: false,
    stream: true,
    tool_choice: 'auto',
    tools: [
      {
        model,
        moderation: 'auto',
        output_format: 'png',
        quality: (params as any).quality || 'auto',
        size: resolveSize(params),
        type: 'image_generation',
      },
    ],
  };

  let lastError = RESPONSES_NO_IMAGE_ERROR;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      log('Calling NEXUS Responses image API: %s attempt=%d', endpoint, attempt + 1);

      const response = await fetch(endpoint, {
        body: JSON.stringify(requestBody),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      });

      if (!response.ok) {
        lastError = await extractErrorMessage(response);
        if (RETRYABLE_STATUS.has(response.status) && attempt === 0) continue;

        return { error: lastError };
      }

      const result = await parseResponsesStream(response);
      if (result.imageB64) return { imageUrl: toImageUrl(result.imageB64) };
      if (result.error) {
        lastError = result.error;
        if (result.error !== RESPONSES_NO_IMAGE_ERROR) return { error: lastError };
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt === 0) continue;
    }
  }

  return { error: lastError };
};

const callImagesGeneration = async (
  payload: CreateImagePayload,
  options: CreateImageOptions,
  responseFormat: 'url' | 'b64_json',
): Promise<TryImageResult> => {
  const { apiKey, baseURL } = options;
  const { model, params } = payload;
  const endpoint = joinUrl(baseURL, '/images/generations');
  const maxAttempts = responseFormat === 'url' ? 2 : 1;
  let lastError = 'NEXUS Images API returned no image';

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      log(
        'Calling NEXUS Images API: %s format=%s attempt=%d',
        endpoint,
        responseFormat,
        attempt + 1,
      );

      const response = await fetch(endpoint, {
        body: JSON.stringify({
          model,
          n: 1,
          prompt: params.prompt,
          response_format: responseFormat,
          size: resolveSize(params),
        }),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      });

      if (!response.ok) {
        lastError = await extractErrorMessage(response);
        if (RETRYABLE_STATUS.has(response.status) && attempt < maxAttempts - 1) continue;

        return { error: lastError };
      }

      const data = await response.json();
      const image = data?.data?.[0];
      if (image?.b64_json) return { imageUrl: toDataUrl(image.b64_json) };
      if (image?.url) return { imageUrl: image.url };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < maxAttempts - 1) continue;
    }
  }

  return { error: lastError };
};

export async function createNexusImage(
  payload: CreateImagePayload,
  options: CreateImageOptions,
): Promise<CreateImageResponse> {
  const { provider } = options;

  try {
    const streamResult = await callResponsesImageGeneration(payload, options);
    if (streamResult.imageUrl) return { imageUrl: streamResult.imageUrl };

    const hasReferenceImages =
      Boolean(payload.params.imageUrl) ||
      Boolean(payload.params.imageUrls && payload.params.imageUrls.length > 0);

    if (!hasReferenceImages) {
      const urlResult = await callImagesGeneration(payload, options, 'url');
      if (urlResult.imageUrl) return { imageUrl: urlResult.imageUrl };

      const b64Result = await callImagesGeneration(payload, options, 'b64_json');
      if (b64Result.imageUrl) return { imageUrl: b64Result.imageUrl };

      throw new Error(b64Result.error || urlResult.error || streamResult.error);
    }

    throw new Error(streamResult.error);
  } catch (error) {
    log('Error in createNexusImage: %O', error);

    throw AgentRuntimeError.createImage({
      error: error as any,
      errorType: 'ProviderBizError',
      provider,
    });
  }
}
