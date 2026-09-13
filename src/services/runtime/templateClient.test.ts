import { afterEach, describe, expect, it, vi } from 'vitest';

import { presentationTemplateClient } from './templateClient';

afterEach(() => vi.restoreAllMocks());

describe('presentationTemplateClient', () => {
  it('uploads multipart bytes with same-origin credentials and leaves boundary generation to fetch', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          layouts: [{ layoutId: 'cover' }],
          name: 'Reference',
          templateId: 'template-1',
          versionId: 'v1',
        }),
      ),
    );
    const file = new File(['source bytes'], 'reference.pptx');
    const result = await presentationTemplateClient.importPptx(file, 'Reference');
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe('/api/runtime/presentation/templates/import');
    expect(options?.credentials).toBe('same-origin');
    expect(options?.headers).toBeUndefined();
    expect(options?.body).toBeInstanceOf(FormData);
    expect((options?.body as FormData).get('file')).toBe(file);
    expect(result.layoutCount).toBe(1);
  });

  it('preserves server error messages so failed template applications are visible', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Template version was not found' } }), {
        status: 404,
      }),
    );
    await expect(
      presentationTemplateClient.apply('job-1', {
        requestId: 'request-1',
        templateId: 'template-1',
        versionId: 'missing-version',
      }),
    ).rejects.toThrow('Template version was not found');
  });
});
