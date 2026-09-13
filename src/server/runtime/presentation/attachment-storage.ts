import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { RuntimeScope } from '../../../../packages/runtime-contracts/src';
import { FilePresentationStorage } from './file-storage';
import { readPresentationUploadForm } from './upload-form';

export const presentationAttachmentStorage = () =>
  new FilePresentationStorage(
    process.env.CORDIS_PRESENTATION_DATA_DIR ?? path.join(process.cwd(), '.data', 'presentation'),
  );
const supported = /\.(?:txt|md|csv|tsv|pdf|docx|xlsx|pptx|png|jpe?g|webp)$/i;
export async function uploadPresentationAttachment(request: Request, scope: RuntimeScope) {
  const form = await readPresentationUploadForm(request);
  const file = form.get('file');
  if (
    !file ||
    typeof file === 'string' ||
    !supported.test(file.name) ||
    file.size > 32 * 1024 * 1024 ||
    file.size === 0
  )
    throw new Error('请上传 32 MiB 以内的文档或图片');
  const artifactId = `attachment-${randomUUID()}`;
  const image = /\.(?:png|jpe?g|webp)$/i.test(file.name);
  const output = await presentationAttachmentStorage().put(scope, {
    artifactId,
    name: path.basename(file.name),
    bytes: new Uint8Array(await file.arrayBuffer()),
    type: image ? 'image' : 'file',
    mimeType: file.type || 'application/octet-stream',
    metadata: { source: 'presentation-upload' },
  });
  return { id: artifactId, url: output.uri, name: output.name };
}
export async function readPresentationAttachment(id: string, scope: RuntimeScope) {
  const file = await presentationAttachmentStorage().get(scope, id);
  if (!file?.bytes || !file.name || !supported.test(file.name))
    throw new Error('附件不存在或不属于当前账号');
  if (file.type === 'image') {
    const { default: sharp } = await import('sharp');
    const bytes = await sharp(file.bytes, { limitInputPixels: 32_000_000 })
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
    return { name: file.name, imageUrl: `data:image/png;base64,${bytes.toString('base64')}` };
  }
  if (/\.(?:txt|md|csv|tsv)$/i.test(file.name))
    return { name: file.name, content: Buffer.from(file.bytes).toString('utf8').slice(0, 36000) };
  const directory = await mkdtemp(path.join(tmpdir(), 'jumi-attachment-'));
  try {
    const filename = path.join(directory, `source${path.extname(file.name).toLowerCase()}`);
    await writeFile(filename, file.bytes, { mode: 0o600 });
    const { loadFile } = await import('@lobechat/file-loaders');
    const document = await loadFile(filename);
    if (!document.content.trim()) throw new Error('附件没有可读取的正文');
    return { name: file.name, content: document.content.slice(0, 36000) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
