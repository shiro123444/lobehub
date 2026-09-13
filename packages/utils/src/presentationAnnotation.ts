/** Source spans keep every unselected byte intact when applying a visual comment. */
export interface SvgAnnotationElement {
  end: number;
  index: number;
  source: string;
  start: number;
  tag: string;
}
const atomicTags = new Set([
  'text',
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
export function annotationElements(svg: string): SvgAnnotationElement[] {
  const result: SvgAnnotationElement[] = [];
  const stack: { tag: string; start: number; selected: boolean; blocked: boolean }[] = [];
  const tokens =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[a-zA-Z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/g;
  for (const match of svg.matchAll(tokens)) {
    const token = match[0];
    if (token.startsWith('<!')) continue;
    const tag = /^<\/?([\w:-]+)/.exec(token)![1];
    if (token.startsWith('</')) {
      const node = stack.pop();
      if (!node || node.tag !== tag) throw new Error('Invalid SVG nesting');
      if (node.selected)
        result.push({
          start: node.start,
          end: match.index! + token.length,
          source: svg.slice(node.start, match.index! + token.length),
          tag,
          index: 0,
        });
      continue;
    }
    const blocked =
      stack.some((n) => n.blocked || n.selected) ||
      ['defs', 'clipPath', 'mask', 'pattern', 'symbol', 'marker'].includes(tag);
    const selected = !blocked && atomicTags.has(tag);
    const node = { tag, start: match.index!, selected, blocked };
    if (/\/\s*>$/.test(token)) {
      if (selected)
        result.push({
          start: node.start,
          end: node.start + token.length,
          source: token,
          tag,
          index: 0,
        });
    } else stack.push(node);
  }
  if (stack.length) throw new Error('Unclosed SVG element');
  return result.sort((a, b) => a.start - b.start).map((node, index) => ({ ...node, index }));
}

export function mergeAnnotationElements(
  svg: string,
  indices: number[],
  patches: { index: number; svg: string }[],
): string {
  const elements = annotationElements(svg);
  const allowed = new Set(indices);
  if (
    !allowed.size ||
    allowed.size !== indices.length ||
    indices.some((i) => !Number.isInteger(i) || !elements[i])
  )
    throw new Error('Invalid annotation selection');
  if (
    !patches.length ||
    patches.length > indices.length ||
    new Set(patches.map((p) => p.index)).size !== patches.length
  )
    throw new Error('Invalid annotation patches');
  for (const patch of patches) {
    if (!allowed.has(patch.index) || typeof patch.svg !== 'string' || patch.svg.length > 100_000)
      throw new Error('Annotation changed an unselected element');
    // Local patches cannot introduce global styles, external resources or executable SVG.
    if (
      /<\s*(?:\/\s*)?(?:svg|defs|style|script|foreignObject|filter|animate\w*|set|a)\b|<!|\bon\w+\s*=|(?:javascript|data|https?):|url\s*\(/i.test(
        patch.svg,
      )
    )
      throw new Error('Unsafe annotation patch');
    const allowedTags = new Set([
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
    for (const tag of patch.svg.matchAll(/<\/?([\w:-]+)/g))
      if (!allowedTags.has(tag[1])) throw new Error('Unsupported annotation element');
    const nodes = annotationElements(patch.svg);
    if (
      !nodes.length ||
      !/^\s*<(?:g|text|image|rect|circle|ellipse|path|line|polyline|polygon|use)\b/.test(patch.svg)
    )
      throw new Error('Annotation patch must contain SVG elements');
  }
  let output = svg;
  for (const patch of [...patches].sort((a, b) => b.index - a.index)) {
    const element = elements[patch.index];
    output = output.slice(0, element.start) + patch.svg + output.slice(element.end);
  }
  return output;
}
