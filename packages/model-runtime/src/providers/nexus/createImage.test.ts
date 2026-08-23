import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CreateImageOptions } from '../../core/openaiCompatibleFactory';
import type { CreateImagePayload } from '../../types/image';
import { createNexusImage } from './createImage';

vi.mock('debug', () => ({
  default: vi.fn(() => vi.fn()),
}));

vi.mock('@lobechat/utils', () => ({
  imageUrlToBase64: vi.fn(async () => ({
    base64: 'reference-b64',
    mimeType: 'image/png',
  })),
}));

const streamResponse = (body: string, init?: ResponseInit) =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
    init,
  );

describe('createNexusImage', () => {
  let payload: CreateImagePayload;
  let options: CreateImageOptions;

  beforeEach(() => {
    vi.clearAllMocks();

    payload = {
      model: 'gpt-image-2',
      params: {
        prompt: 'a quiet garden',
        size: 'auto',
      },
    };

    options = {
      apiKey: 'nexus-key',
      baseURL: 'https://nexus.example/v1',
      provider: 'nexus',
    };

    global.fetch = vi.fn();
  });

  it('should create an image from Responses streaming partial image', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      streamResponse(
        [
          'data: {"type":"response.image_generation_call.partial_image","output_index":0,"partial_image_b64":"partial-b64"}',
          'data: [DONE]',
          '',
        ].join('\n'),
        { status: 200 },
      ),
    );

    const result = await createNexusImage(payload, options);

    expect(result).toEqual({ imageUrl: 'data:image/png;base64,partial-b64' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      'https://nexus.example/v1/responses',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer nexus-key',
          'Content-Type': 'application/json',
        },
        method: 'POST',
      }),
    );

    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      model: 'gpt-5.4-mini',
      stream: true,
      tools: [
        expect.objectContaining({
          model: 'gpt-image-2',
          size: '1024x1024',
          type: 'image_generation',
        }),
      ],
    });
  });

  it('should prefer completed response image over partial image', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      streamResponse(
        [
          'data: {"type":"response.image_generation_call.partial_image","output_index":0,"partial_image_b64":"partial-b64"}',
          'data: {"type":"response.completed","response":{"output":[{"content":[{"b64_json":"completed-b64"}]}]}}',
          '',
        ].join('\n'),
        { status: 200 },
      ),
    );

    const result = await createNexusImage(payload, options);

    expect(result).toEqual({ imageUrl: 'data:image/png;base64,completed-b64' });
  });

  it('should read completed Responses image generation result', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      streamResponse(
        [
          'data: {"type":"response.completed","response":{"output":[{"type":"image_generation_call","result":"result-b64"}]}}',
          '',
        ].join('\n'),
        { status: 200 },
      ),
    );

    const result = await createNexusImage(payload, options);

    expect(result).toEqual({ imageUrl: 'data:image/png;base64,result-b64' });
  });

  it('should parse Responses event lines without a space after data colon', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      streamResponse(
        'data:{"type":"response.image_generation_call.partial_image","partial_image_b64":"partial-b64"}\n',
        { status: 200 },
      ),
    );

    const result = await createNexusImage(payload, options);

    expect(result).toEqual({ imageUrl: 'data:image/png;base64,partial-b64' });
  });

  it('should parse non-streaming Responses JSON bodies', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      streamResponse(
        JSON.stringify({
          output: [{ result: 'json-result-b64', type: 'image_generation_call' }],
        }),
        { status: 200 },
      ),
    );

    const result = await createNexusImage(payload, options);

    expect(result).toEqual({ imageUrl: 'data:image/png;base64,json-result-b64' });
  });

  it('should fallback to images generations url when Responses returns no image', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(streamResponse('data: [DONE]\n', { status: 200 }))
      .mockResolvedValueOnce(streamResponse('data: [DONE]\n', { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ url: 'https://cdn.example/image.png' }],
          }),
          { status: 200 },
        ),
      );

    const result = await createNexusImage(payload, options);

    expect(result).toEqual({ imageUrl: 'https://cdn.example/image.png' });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenLastCalledWith(
      'https://nexus.example/v1/images/generations',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('should include reference images in Responses input content', async () => {
    payload.params = {
      imageUrls: ['data:image/png;base64,ref'],
      prompt: 'edit this image',
    };

    vi.mocked(fetch).mockResolvedValueOnce(
      streamResponse(
        'data: {"type":"response.image_generation_call.partial_image","partial_image_b64":"edited-b64"}\n',
        { status: 200 },
      ),
    );

    await createNexusImage(payload, options);

    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(body.input[0].content).toEqual([
      { text: 'edit this image', type: 'input_text' },
      { image_url: 'data:image/png;base64,ref', type: 'input_image' },
    ]);
  });

  it('should report when Responses returns text instead of calling image generation', async () => {
    payload.params = {
      imageUrls: ['data:image/png;base64,ref'],
      prompt: 'edit this image',
    };

    vi.mocked(fetch).mockResolvedValueOnce(
      streamResponse(
        [
          'data: {"type":"response.output_text.delta","delta":"I can provide an SVG instead."}',
          'data: {"type":"response.completed","response":{"output":[]}}',
          '',
        ].join('\n'),
        { status: 200 },
      ),
    );

    await expect(createNexusImage(payload, options)).rejects.toMatchObject({
      error: expect.objectContaining({
        message: expect.stringContaining('did not call image_generation'),
      }),
      errorType: 'ProviderBizError',
      provider: 'nexus',
    });
  });

  it('should report Responses failed event message', async () => {
    payload.params = {
      imageUrls: ['data:image/png;base64,ref'],
      prompt: 'edit this image',
    };

    vi.mocked(fetch).mockResolvedValueOnce(
      streamResponse(
        [
          'data: {"type":"response.failed","response":{"error":{"message":"image tool unavailable"}}}',
          '',
        ].join('\n'),
        { status: 200 },
      ),
    );

    await expect(createNexusImage(payload, options)).rejects.toMatchObject({
      error: expect.objectContaining({
        message: 'image tool unavailable',
      }),
      errorType: 'ProviderBizError',
      provider: 'nexus',
    });
  });
});
