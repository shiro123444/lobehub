import { createHash } from 'node:crypto';
import { posix } from 'node:path';

import { XMLValidator } from 'fast-xml-parser';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

const fail = (message: string) =>
  Object.assign(new Error(message), { code: 'PRESENTATION_INVALID' });
const escape = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const decode = (text: string) =>
  text
    .replaceAll(/&#(?:x([\da-f]+)|(\d+));/gi, (_, hex, dec) =>
      String.fromCodePoint(parseInt(hex ?? dec, hex ? 16 : 10)),
    )
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
const attribute = (xml: string, name: string) =>
  new RegExp(`\\b${name}=["']([^"']*)["']`).exec(xml)?.[1];
export function openNativePptx(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > 32 * 1024 * 1024)
    throw fail('Native PPTX exceeds upload budget');
  let size = 0;
  let count = 0;
  const files = unzipSync(bytes, {
    filter: (entry) => {
      size += entry.originalSize;
      if (
        ++count > 5000 ||
        size > 128 * 1024 * 1024 ||
        entry.originalSize > 64 * 1024 * 1024 ||
        entry.name.split('/').includes('..') ||
        entry.name.startsWith('/')
      )
        throw fail('Invalid native PPTX archive');
      return true;
    },
  });
  if (!files['ppt/presentation.xml'] || !files['[Content_Types].xml'])
    throw fail('Invalid native PPTX');
  return files;
}
function relationships(files: Record<string, Uint8Array>, path: string) {
  const relPath = posix.join(posix.dirname(path), '_rels', posix.basename(path) + '.rels');
  return {
    path: relPath,
    xml: files[relPath]
      ? strFromU8(files[relPath])
      : '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>',
  };
}
function slidePaths(files: Record<string, Uint8Array>) {
  const rel = relationships(files, 'ppt/presentation.xml').xml;
  const mapping = new Map(
    [...rel.matchAll(/<Relationship\b[^>]*>/g)]
      .filter((m) => !m[0].includes('TargetMode="External"'))
      .map((m) => [
        attribute(m[0], 'Id'),
        (attribute(m[0], 'Target') ?? '').startsWith('/')
          ? (attribute(m[0], 'Target') ?? '').slice(1)
          : posix.normalize(posix.join('ppt', attribute(m[0], 'Target') ?? '')),
      ]),
  );
  return [...strFromU8(files['ppt/presentation.xml']).matchAll(/<(?:p:)?sldId\b[^>]*>/g)]
    .map((m) => mapping.get(attribute(m[0], 'r:id')))
    .filter((path): path is string => !!path && !!files[path]);
}
function shapes(xml: string) {
  return [...xml.matchAll(/<p:(sp|pic|graphicFrame)\b[\s\S]*?<\/p:\1>/g)].map((match) => {
    const nonVisual = /<p:cNvPr\b[^>]*>/.exec(match[0])?.[0] ?? '';
    return {
      id: attribute(nonVisual, 'id') ?? '',
      name: decode(attribute(nonVisual, 'name') ?? ''),
      kind: match[1],
      source: match[0],
      start: match.index!,
      runs: [...match[0].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((run) =>
        decode(run[1]),
      ),
      relationshipId: attribute(/<a:blip\b[^>]*>/.exec(match[0])?.[0] ?? '', 'r:embed'),
    };
  });
}
export function inspectNativePptx(bytes: Uint8Array) {
  const files = openNativePptx(bytes);
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    pages: slidePaths(files).map((path, index) => ({
      page: index + 1,
      path,
      shapes: shapes(strFromU8(files[path])).map(({ source, start, ...shape }) => ({
        ...shape,
        editable: shape.kind === 'sp' || shape.kind === 'pic',
      })),
    })),
    preservedParts: {
      masters: Object.keys(files).filter((p) => /^ppt\/slideMasters\/[^/]+\.xml$/.test(p)).length,
      charts: Object.keys(files).filter((p) => /^ppt\/charts\/[^/]+\.xml$/.test(p)).length,
      media: Object.keys(files).filter((p) => p.startsWith('ppt/media/')).length,
    },
    strategy: 'native-object-patching',
  };
}
export interface NativeTemplatePatch {
  image?: { bytes: Uint8Array; mimeType: string };
  page: number;
  runs?: string[];
  shapeId: string;
  text?: string;
}
export function fillNativePptx(bytes: Uint8Array, patches: NativeTemplatePatch[]) {
  if (!patches.length || patches.length > 100) throw fail('Provide 1 to 100 native object patches');
  const files = openNativePptx(bytes);
  const paths = slidePaths(files);
  const touched = new Set<string>();
  const changedParts = new Set<string>();
  for (const patch of patches) {
    const path = paths[patch.page - 1];
    if (!path) throw fail('Native page not found');
    const xml = strFromU8(files[path]);
    const matches = shapes(xml).filter((shape) => shape.id === patch.shapeId);
    if (matches.length !== 1) throw fail('Native shape id is missing or ambiguous');
    const key = `${patch.page}:${patch.shapeId}`;
    if (touched.has(key)) throw fail('Native object patched twice');
    touched.add(key);
    const shape = matches[0];
    let replacement = shape.source;
    if (patch.image) {
      if (patch.text !== undefined || patch.runs || shape.kind !== 'pic' || !shape.relationshipId)
        throw fail('Image patch requires a native picture');
      const extension = (
        { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as Record<string, string>
      )[patch.image.mimeType];
      if (!extension) throw fail('Unsupported native image type');
      const digest = createHash('sha256').update(patch.image.bytes).digest('hex').slice(0, 32);
      const media = `ppt/media/cordis-${digest}.${extension}`;
      files[media] = new Uint8Array(patch.image.bytes);
      changedParts.add(media);
      const rel = relationships(files, path);
      const relId = `rIdCordis${digest}${patch.shapeId}`;
      if (rel.xml.includes(`Id="${relId}"`)) throw fail('Native relationship collision');
      const relEntry = `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${posix.relative(posix.dirname(path), media)}"/>`;
      files[rel.path] = strToU8(
        rel.xml.replace(/<\/Relationships\s*>/, relEntry + '</Relationships>'),
      );
      changedParts.add(rel.path);
      replacement = replacement.replace(
        new RegExp(`r:embed=["']${shape.relationshipId}["']`),
        `r:embed="${relId}"`,
      );
      const types = strFromU8(files['[Content_Types].xml']);
      if (!types.includes(`Extension="${extension}"`)) {
        files['[Content_Types].xml'] = strToU8(
          types.replace(
            '</Types>',
            `<Default Extension="${extension}" ContentType="${patch.image.mimeType}"/></Types>`,
          ),
        );
        changedParts.add('[Content_Types].xml');
      }
    } else {
      if (
        shape.kind !== 'sp' ||
        !shape.runs.length ||
        (patch.text === undefined && !patch.runs) ||
        (patch.text !== undefined && patch.runs)
      )
        throw fail('Text patch requires one text or runs field');
      if (patch.runs && patch.runs.length !== shape.runs.length)
        throw fail('Native rich-text run count must be preserved');
      let index = 0;
      replacement = replacement.replaceAll(
        /(<a:t(?:\s[^>]*)?>)[\s\S]*?(<\/a:t>)/g,
        (_, start, end) =>
          `${start}${escape(patch.runs ? patch.runs[index++] : index++ === 0 ? patch.text! : '')}${end}`,
      );
    }
    const updated =
      xml.slice(0, shape.start) + replacement + xml.slice(shape.start + shape.source.length);
    if (XMLValidator.validate(updated) !== true) throw fail('Native patch produced invalid XML');
    files[path] = strToU8(updated);
    changedParts.add(path);
  }
  const output = zipSync(files, { level: 6, mtime: new Date('1980-01-01T00:00:00Z') });
  return { bytes: output, changedParts: [...changedParts], inspection: inspectNativePptx(output) };
}
