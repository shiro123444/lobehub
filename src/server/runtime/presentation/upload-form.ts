/** Decode uploads consistently, including requests truncated by an upstream proxy. */
export async function readPresentationUploadForm(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    throw Object.assign(
      new Error('上传数据不完整或格式无效，请重新上传；若仍失败，请检查服务的上传大小限制。'),
      {
        code: 'PRESENTATION_INVALID',
      },
    );
  }
}
