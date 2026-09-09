export interface PresentationReferenceInput {
  assetRef?: string;
  id: string;
  kind: 'image' | 'pptx' | 'pdf' | 'docx' | 'xlsx' | 'text';
  mimeType?: string;
  name: string;
  sizeBytes?: number;
  status: 'uploading' | 'ready' | 'failed';
}

export const getSafeAssetRef = (file: any): string => {
  const url =
    typeof file?.url === 'string'
      ? file.url
      : typeof file?.fileUrl === 'string'
        ? file.fileUrl
        : typeof (file as any)?.assetRef === 'string'
          ? (file as any).assetRef
          : '';

  if (url) {
    const lower = url.toLowerCase();
    const isForbidden =
      lower.startsWith('data:') ||
      lower.startsWith('file:') ||
      lower.startsWith('blob:') ||
      lower.startsWith('/') ||
      lower.startsWith('\\') ||
      lower.startsWith('webpack-internal:') ||
      lower.includes('base64');

    if (!isForbidden) {
      return url;
    }
  }

  return file?.id || '';
};

/** Convert LobeHub upload records into the presentation reference contract. */
export const toPresentationReference = (file: any): PresentationReferenceInput => {
  const name = file?.file?.name || file?.name || file?.id || '未命名文件';
  const mimeType = file?.file?.type || file?.mimeType || file?.fileType || '';
  const status =
    file?.status === 'success' || file?.status === 'ready' || file?.url || file?.fileUrl
      ? 'ready'
      : file?.status === 'error' || file?.status === 'failed'
        ? 'failed'
        : 'uploading';

  return {
    assetRef: getSafeAssetRef(file),
    id: file?.id || name,
    kind: inferReferenceKind(name, mimeType),
    mimeType,
    name,
    sizeBytes: file?.file?.size || file?.size,
    status,
  };
};

export const inferReferenceKind = (
  name: string = '',
  mimeType: string = '',
): PresentationReferenceInput['kind'] => {
  const lowerName = name.toLowerCase();
  const lowerMime = mimeType.toLowerCase();

  if (lowerMime.startsWith('image/') || /\.(?:png|jpe?g|webp|gif|svg|avif|bmp)$/i.test(lowerName)) {
    return 'image';
  }
  if (
    lowerMime.includes('presentation') ||
    lowerMime.includes('powerpoint') ||
    /\.(?:pptx?|key|odp)$/i.test(lowerName)
  ) {
    return 'pptx';
  }
  if (lowerMime.includes('pdf') || lowerName.endsWith('.pdf')) {
    return 'pdf';
  }
  if (
    lowerMime.includes('spreadsheet') ||
    lowerMime.includes('excel') ||
    lowerMime.includes('csv') ||
    /\.(?:xlsx?|csv|tsv|ods)$/i.test(lowerName)
  ) {
    return 'xlsx';
  }
  if (
    lowerMime.includes('word') ||
    lowerMime.includes('wordprocessingml') ||
    lowerMime.includes('msword') ||
    /\.(?:docx?|odt|rtf)$/i.test(lowerName)
  ) {
    return 'docx';
  }
  return 'text';
};
