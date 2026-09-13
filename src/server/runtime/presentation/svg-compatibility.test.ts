import { describe, expect, it, vi } from 'vitest';

import { normalizePresentationSvg, normalizeRasterOpacity } from './svg-compatibility';

describe('PPT SVG compatibility', () => {
  it('keeps untouched compatible pages byte-for-byte', () => {
    const svg = '<svg>\n <text>A &amp; B</text>\n</svg>';
    expect(normalizePresentationSvg(svg)).toBe(svg);
  });
  it('moves nested group opacity onto shapes and preserves escaped text', () => {
    const result = normalizePresentationSvg(
      '<svg><g opacity="0.5"><g opacity="0.4"><rect opacity="0.5"/></g><text>A &amp; B</text></g></svg>',
    );
    expect(result).not.toMatch(/<g[^>]*opacity/);
    expect(result).toContain('<rect opacity="0.1"');
    expect(result).toContain('<text opacity="0.5">A &amp; B</text>');
  });
});

it('bakes image opacity through the asset processor and preserves shape opacity', async () => {
  const transform = vi.fn(async () => '/processed.png');
  const input = normalizePresentationSvg(
    '<svg><g opacity="0.5"><image href="/owned.png" opacity="0.8"/><rect opacity="0.4"/></g></svg>',
  );
  const output = await normalizeRasterOpacity(input, transform);
  expect(transform).toHaveBeenCalledWith('/owned.png', 0.4);
  expect(output).toContain('<image href="/processed.png"');
  expect(output).not.toMatch(/<image[^>]*opacity/);
  expect(output).toContain('<rect opacity="0.2"');
});
