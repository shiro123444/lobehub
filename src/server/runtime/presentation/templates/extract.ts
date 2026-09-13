import type { PresentationPlan } from '../../../../../packages/runtime-contracts/src';
import { validatePresentationPlan } from '../planner';
import type {
  TemplateAssetSlot,
  TemplateBox,
  TemplateConstraints,
  TemplateElement,
  TemplateLayout,
} from './types';
import { PresentationTemplateError } from './types';
import { array, attribute, number, object, textContent, type Xml, xml } from './xml';

const round = (value: number): number => Math.round(value * 10_000) / 10_000;
const normalized = (box: TemplateBox, width: number, height: number): TemplateBox => ({
  height: round(box.height / height),
  width: round(box.width / width),
  x: round(box.x / width),
  y: round(box.y / height),
});

export const normalizedColor = (value?: string): string | undefined => {
  if (!value || /^(?:none|transparent|inherit|currentColor|url\()/iu.test(value)) return;
  if (/^#[\da-f]{3}$/iu.test(value))
    return `#${value
      .slice(1)
      .split('')
      .map((character) => character.repeat(2))
      .join('')}`.toUpperCase();
  if (/^#[\da-f]{6}$/iu.test(value)) return value.toUpperCase();
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/iu.exec(value);
  if (rgb)
    return `#${rgb
      .slice(1)
      .map((part) => Math.min(255, Number(part)).toString(16).padStart(2, '0'))
      .join('')}`.toUpperCase();
  return (
    {
      black: '#000000',
      white: '#FFFFFF',
      gray: '#808080',
      red: '#FF0000',
      blue: '#0000FF',
    } as Record<string, string>
  )[value.toLowerCase()];
};

const ranked = <T extends string | number>(values: T[], limit = 20): T[] => {
  const counts = new Map<T, number>();
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  return [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)!).slice(0, limit);
};

export const layoutKind = (elements: TemplateElement[]): TemplateLayout['kind'] => {
  const images = elements.filter((element) => element.kind === 'image');
  if (images.length) {
    const image = images[0].box;
    if (image.width > 0.6) return 'image-led';
    return image.x + image.width / 2 < 0.5 ? 'image-left' : 'image-right';
  }
  const texts = elements.filter((element) => element.kind === 'text');
  if (texts.length <= 2) return 'cover';
  if (texts.some((element) => element.box.x > 0.48)) return 'two-column';
  return 'text';
};

export const constraintsFromLayouts = (
  aspectRatio: string,
  layouts: TemplateLayout[],
  additionalColors: string[] = [],
  additionalFonts: string[] = [],
): TemplateConstraints => {
  const elements = layouts.flatMap((layout) => layout.elements);
  const content = elements.filter((element) => element.role !== 'decoration');
  const boxes = content.map((element) => element.box);
  const margins = boxes.length
    ? {
        height: round(Math.max(0, 1 - Math.max(...boxes.map((box) => box.y + box.height)))),
        width: round(Math.max(0, 1 - Math.max(...boxes.map((box) => box.x + box.width)))),
        x: round(Math.max(0, Math.min(...boxes.map((box) => box.x)))),
        y: round(Math.max(0, Math.min(...boxes.map((box) => box.y)))),
      }
    : { height: 0.05, width: 0.05, x: 0.05, y: 0.05 };
  const gaps = (axis: 'x' | 'y', extent: 'width' | 'height'): number[] => {
    const values = layouts.flatMap((layout) => {
      const boxes = layout.elements
        .filter((element) => element.role !== 'decoration')
        .map((element) => element.box);
      return boxes
        .flatMap((first) => boxes.map((second) => second[axis] - first[axis] - first[extent]))
        .filter((gap) => gap > 0.005 && gap < 0.3)
        .map(round);
    });
    return ranked(values, 8).sort((a, b) => a - b);
  };
  return {
    aspectRatio,
    fontFamilies: ranked([
      ...elements.flatMap((element) => (element.fontFamily ? [element.fontFamily] : [])),
      ...additionalFonts,
    ]),
    fontSizes: ranked(
      elements.flatMap((element) => (element.fontSize ? [round(element.fontSize)] : [])),
    ).sort((a, b) => b - a),
    palette: ranked(
      [
        ...elements.flatMap((element) => (element.color ? [element.color] : [])),
        ...additionalColors,
      ].flatMap((color) => normalizedColor(color) ?? []),
      12,
    ),
    spacing: { horizontalGaps: gaps('x', 'width'), margins, verticalGaps: gaps('y', 'height') },
  };
};

type Transform = { sx: number; sy: number; tx: number; ty: number };

const transformFor = (
  source: string | undefined,
  parent: Transform,
  warnings: Set<string>,
): Transform => {
  const result = { ...parent };
  for (const part of (source ?? '').matchAll(/(\w+)\(([^)]+)\)/gu)) {
    const values = part[2].split(/[\s,]+/u).map(Number);
    if (part[1] === 'translate') {
      result.tx += (values[0] || 0) * result.sx;
      result.ty += (values[1] || 0) * result.sy;
    } else if (part[1] === 'scale') {
      result.sx *= values[0] ?? 1;
      result.sy *= values[1] ?? values[0] ?? 1;
    } else if (part[1] === 'matrix' && values[1] === 0 && values[2] === 0) {
      result.tx += values[4] * result.sx;
      result.ty += values[5] * result.sy;
      result.sx *= values[0];
      result.sy *= values[3];
    } else
      warnings.add(
        'Rotated or skewed objects keep their reference SVG; learned boxes are approximate.',
      );
  }
  return result;
};

export const extractPlanTemplate = (
  plan: PresentationPlan,
): { constraints: TemplateConstraints; layouts: TemplateLayout[]; warnings: string[] } => {
  validatePresentationPlan(plan, { maxSlides: 100, maxSvgBytes: 10 * 1024 * 1024 });
  const warnings = new Set<string>();
  const allColors: string[] = [];
  const layouts = plan.slides.map((slide): TemplateLayout => {
    if (/<(?:script|foreignObject)\b|\son\w+\s*=|javascript\s*:/iu.test(slide.svg))
      throw new PresentationTemplateError('Template SVG contains active content');
    const root = object(xml(slide.svg).svg);
    const viewBox = (attribute(root, 'viewBox') ?? '0 0 960 540').split(/[\s,]+/u).map(Number);
    const width = viewBox[2] || 960;
    const height = viewBox[3] || 540;
    if (
      viewBox.length !== 4 ||
      viewBox.some((value) => !Number.isFinite(value)) ||
      width <= 0 ||
      height <= 0
    )
      throw new PresentationTemplateError('Template SVG viewport is invalid');
    const elements: TemplateElement[] = [];
    const assetSlots: TemplateAssetSlot[] = [];
    const dimension = (node: Xml, name: string, extent: number, fallback = 0): number => {
      const value = attribute(node, name);
      return value?.endsWith('%') ? (number(value) / 100) * extent : number(value, fallback);
    };
    const visit = (
      tag: string,
      node: Xml,
      inherited: Record<string, string>,
      parent: Transform,
    ): void => {
      const style = { ...inherited };
      for (const part of (attribute(node, 'style') ?? '').split(';')) {
        const [key, value] = part.split(':');
        if (key?.trim() && value?.trim()) style[key.trim()] = value.trim();
      }
      for (const key of ['fill', 'stroke', 'font-family', 'font-size', 'text-anchor']) {
        const value = attribute(node, key);
        if (value) style[key] = value;
      }
      for (const color of [style.fill, style.stroke]) if (color) allColors.push(color);
      const transform = transformFor(attribute(node, 'transform'), parent, warnings);
      const fontSize = number(style['font-size'], 24);
      const text = tag === 'text' ? textContent(node).trim() : '';
      let box: TemplateBox | undefined;
      if (tag === 'text') {
        const tspan = array(node.tspan)[0];
        const x = dimension(node, 'x', width, tspan ? dimension(tspan, 'x', width) : 0);
        const y = dimension(node, 'y', height, tspan ? dimension(tspan, 'y', height) : 0);
        const estimatedWidth = Math.min(
          width,
          [...text].reduce((sum, letter) => sum + (letter.codePointAt(0)! > 127 ? 1 : 0.55), 0) *
            fontSize,
        );
        box = {
          height: fontSize * 1.3,
          width: estimatedWidth,
          x:
            x -
            (style['text-anchor'] === 'middle'
              ? estimatedWidth / 2
              : style['text-anchor'] === 'end'
                ? estimatedWidth
                : 0),
          y: y - fontSize,
        };
      } else if (['rect', 'image', 'foreignObject'].includes(tag)) {
        box = {
          height: dimension(node, 'height', height),
          width: dimension(node, 'width', width),
          x: dimension(node, 'x', width),
          y: dimension(node, 'y', height),
        };
      } else if (['circle', 'ellipse'].includes(tag)) {
        const rx = dimension(node, tag === 'circle' ? 'r' : 'rx', width);
        const ry = dimension(node, tag === 'circle' ? 'r' : 'ry', height);
        box = {
          height: ry * 2,
          width: rx * 2,
          x: dimension(node, 'cx', width) - rx,
          y: dimension(node, 'cy', height) - ry,
        };
      }
      if (box && box.width > 0 && box.height > 0) {
        box = normalized(
          {
            height: box.height * Math.abs(transform.sy),
            width: box.width * Math.abs(transform.sx),
            x: box.x * transform.sx + transform.tx,
            y: box.y * transform.sy + transform.ty,
          },
          width,
          height,
        );
        const kind = tag === 'text' ? 'text' : tag === 'image' ? 'image' : 'shape';
        const scaledFont = round((fontSize * Math.abs(transform.sy) * 960) / width);
        elements.push({
          box,
          color: normalizedColor(style.fill),
          ...(kind === 'text'
            ? {
                fontFamily: style['font-family'] ?? 'Arial',
                fontSize: scaledFont,
                textCapacity: [...text].length,
              }
            : {}),
          kind,
          role: kind === 'image' ? 'image' : kind === 'shape' ? 'decoration' : 'body',
        });
        if (kind === 'image')
          assetSlots.push({
            aspectRatio: round((box.width * width) / Math.max(1, box.height * height)),
            box,
            fit: attribute(node, 'preserveAspectRatio')?.includes('slice') ? 'cover' : 'contain',
            reference: attribute(node, 'href'),
            slotId: `${slide.slideId}:image:${assetSlots.length + 1}`,
          });
      }
      if (tag === 'text') return;
      for (const [childTag, value] of Object.entries(node)) {
        if (!childTag.startsWith('@_') && !childTag.startsWith('#'))
          array(value).forEach((child) => visit(childTag, child, style, transform));
      }
    };
    visit('svg', root, {}, { sx: 1, sy: 1, tx: -(viewBox[0] || 0), ty: -(viewBox[1] || 0) });
    const largestFont = Math.max(...elements.map((element) => element.fontSize ?? 0));
    elements.forEach((element) => {
      if (element.kind === 'text' && element.fontSize === largestFont && element.box.y < 0.55)
        element.role = 'title';
    });
    return {
      assetSlots,
      elements,
      kind: layoutKind(elements),
      layoutId: `layout:${slide.slideId}`,
      notes: slide.notes,
      referenceSvg: slide.svg,
      sourceSlideId: slide.slideId,
      textCapacity: elements.reduce((sum, element) => sum + (element.textCapacity ?? 0), 0),
    };
  });
  warnings.add(
    'SVG text bounds and capacity are estimates; validate overflow after applying a layout.',
  );
  return {
    constraints: constraintsFromLayouts(plan.aspectRatio, layouts, allColors),
    layouts,
    warnings: [...warnings],
  };
};
