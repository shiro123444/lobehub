export interface ElementBox {
  height: number;
  index: number;
  width: number;
  x: number;
  y: number;
}
const tags = new Set([
  'svg',
  'g',
  'text',
  'tspan',
  'image',
  'rect',
  'circle',
  'ellipse',
  'path',
  'line',
  'polyline',
  'polygon',
  'use',
]);
const attributes = new Set([
  'x',
  'y',
  'x1',
  'x2',
  'y1',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'width',
  'height',
  'd',
  'points',
  'transform',
  'viewBox',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'dominant-baseline',
  'letter-spacing',
  'dx',
  'dy',
]);
/** Reconstruct geometry only: no live markup, URLs, event handlers or external assets. */
export function measureAnnotationElements(source: string): ElementBox[] {
  const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
  if (parsed.querySelector('parsererror')) throw new Error('无法读取页面元素');
  const nodes: SVGGraphicsElement[] = [];
  function copy(element: Element, insideAtomic = false): SVGElement | null {
    if (!tags.has(element.localName)) return null;
    const output = document.createElementNS('http://www.w3.org/2000/svg', element.localName);
    for (const attr of element.attributes)
      if (attributes.has(attr.name)) output.setAttribute(attr.name, attr.value);
    // Honor only geometric style properties; never copy arbitrary CSS.
    for (const declaration of (element.getAttribute('style') ?? '').split(';')) {
      const [name, value] = declaration.split(':');
      if (attributes.has(name?.trim()) && value && !/url|[<>]/i.test(value))
        output.setAttribute(name.trim(), value.trim());
    }
    const atomic = !['svg', 'g', 'tspan'].includes(element.localName);
    if (atomic && !insideAtomic) nodes.push(output as SVGGraphicsElement);
    for (const child of element.childNodes) {
      if (child.nodeType === Node.TEXT_NODE)
        output.append(document.createTextNode(child.textContent ?? ''));
      else if (child instanceof Element) {
        const cloned = copy(child, insideAtomic || atomic);
        if (cloned) output.append(cloned);
      }
    }
    return output;
  }
  const svg = copy(parsed.documentElement) as SVGSVGElement;
  const box = parsed.documentElement
    .getAttribute('viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number) ?? [0, 0, 960, 540];
  svg.setAttribute('width', String(box[2]));
  svg.setAttribute('height', String(box[3]));
  Object.assign(svg.style, {
    position: 'fixed',
    left: '-10000px',
    top: '0',
    visibility: 'hidden',
    pointerEvents: 'none',
  });
  document.body.append(svg);
  try {
    return nodes.map((node, index) => {
      const bounds = node.getBBox();
      const matrix = node.getCTM();
      const points = [
        [bounds.x, bounds.y],
        [bounds.x + bounds.width, bounds.y],
        [bounds.x, bounds.y + bounds.height],
        [bounds.x + bounds.width, bounds.y + bounds.height],
      ].map(([x, y]) => new DOMPoint(x, y).matrixTransform(matrix ?? undefined));
      const left = Math.min(...points.map((p) => p.x));
      const top = Math.min(...points.map((p) => p.y));
      return {
        index,
        x: left / box[2],
        y: top / box[3],
        width: (Math.max(...points.map((p) => p.x)) - left) / box[2],
        height: (Math.max(...points.map((p) => p.y)) - top) / box[3],
      };
    });
  } finally {
    svg.remove();
  }
}

export function selectAnnotationElements(boxes: ElementBox[], region: Omit<ElementBox, 'index'>) {
  const point = region.width < 0.008 && region.height < 0.008;
  const hits = boxes.filter(
    (b) =>
      b.width > 0 &&
      b.height > 0 &&
      (point
        ? region.x >= b.x - 0.004 &&
          region.x <= b.x + b.width + 0.004 &&
          region.y >= b.y - 0.007 &&
          region.y <= b.y + b.height + 0.007
        : b.x >= region.x &&
          b.y >= region.y &&
          b.x + b.width <= region.x + region.width &&
          b.y + b.height <= region.y + region.height),
  );
  // On a point prefer the smallest visible element, so a slide background never steals a text hit.
  return (
    point ? hits.sort((a, b) => a.width * a.height - b.width * b.height).slice(0, 1) : hits
  ).map((b) => b.index);
}
