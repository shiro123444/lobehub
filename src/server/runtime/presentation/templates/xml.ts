import { XMLParser, XMLValidator } from 'fast-xml-parser';

import { PresentationTemplateError } from './types';

export type Xml = Record<string, unknown>;

export const object = (value: unknown): Xml =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Xml) : {};
export const array = (value: unknown): Xml[] =>
  (Array.isArray(value) ? value : value === undefined ? [] : [value]).map(object);
export const attribute = (node: Xml, name: string): string | undefined => {
  const value = node[`@_${name}`];
  return value === undefined ? undefined : String(value);
};
export const number = (value: unknown, fallback = 0): number => {
  const parsed = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : fallback;
};
export const xml = (source: string): Xml => {
  if (/<!DOCTYPE|<!ENTITY/iu.test(source) || XMLValidator.validate(source) !== true)
    throw new PresentationTemplateError('Template contains invalid or unsupported XML');
  const parsed = new XMLParser({
    ignoreAttributes: false,
    parseAttributeValue: false,
    parseTagValue: false,
    removeNSPrefix: false,
    trimValues: false,
  }).parse(source) as Xml;
  // Preserve relationship ids separately from numeric OOXML ids on the same node.
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value as Xml)
        .filter(([key]) => !key.startsWith('@_xmlns'))
        .map(([key, child]) => {
          const attribute = key.startsWith('@_');
          const local = key.split(':').at(-1)!;
          const normalizedKey =
            key === '@_r:id'
              ? '@_relationshipId'
              : attribute
                ? `@_${local.replace(/^@_/u, '')}`
                : local;
          return [normalizedKey, normalize(child)];
        }),
    );
  };
  return normalize(parsed) as Xml;
};

export const descendants = (node: unknown, tag: string): Xml[] => {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap((entry) => descendants(entry, tag));
  return Object.entries(node as Xml).flatMap(([key, value]) => [
    ...(key === tag ? array(value) : []),
    ...(key.startsWith('@_') ? [] : descendants(value, tag)),
  ]);
};

export const textContent = (node: unknown): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  if (!node || typeof node !== 'object') return '';
  return Object.entries(node as Xml)
    .filter(([key]) => !key.startsWith('@_'))
    .map(([, value]) => textContent(value))
    .join('');
};

export const escapeXml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
