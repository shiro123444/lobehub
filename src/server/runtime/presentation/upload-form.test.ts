// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { readPresentationUploadForm } from './upload-form';

describe('presentation multipart uploads', () => {
  it('preserves file bytes beyond the old 10 MiB proxy boundary', async () => {
    const bytes = new Uint8Array(11 * 1024 * 1024);
    bytes[bytes.length - 1] = 173;
    const body = new FormData();
    body.append('file', new File([bytes], '第一次课.pptx'));
    const form = await readPresentationUploadForm(
      new Request('http://localhost/upload', { method: 'POST', body }),
    );
    const file = form.get('file') as File;
    expect(file.name).toBe('第一次课.pptx');
    expect(file.size).toBe(bytes.length);
    expect(new Uint8Array(await file.arrayBuffer()).at(-1)).toBe(173);
  });

  it('reports a truncated multipart body as an actionable invalid upload', async () => {
    const body = new FormData();
    body.append('file', new File(['source bytes'], '第一次课.pptx'));
    const valid = new Request('http://localhost/upload', { method: 'POST', body });
    const truncated = (await valid.arrayBuffer()).slice(0, -30);
    await expect(
      readPresentationUploadForm(
        new Request(valid.url, { method: 'POST', headers: valid.headers, body: truncated }),
      ),
    ).rejects.toMatchObject({
      code: 'PRESENTATION_INVALID',
      message: expect.stringContaining('上传数据不完整'),
    });
  });
});
