import { describe, expect, it } from 'vitest';

import {
  InMemoryPresentationPlanner,
  PresentationPlanError,
  validatePresentationPlan,
} from './planner';

const slide = (
  id: string,
  order: number,
  svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect /></svg>',
) => ({
  slideId: id,
  order,
  svg,
  metadata: { nested: { tags: ['intro'] } },
});

const plan = (slides = [slide('slide-1', 0)]) => ({
  planId: 'plan-1',
  title: 'Deck',
  aspectRatio: '16:9',
  sourceVersionIds: ['version-1'],
  designSpec: { theme: { name: 'light' } },
  slides,
});

const expectInvalid = (value: unknown, options?: Parameters<typeof validatePresentationPlan>[1]) =>
  expect(() => validatePresentationPlan(value as never, options)).toThrowError(
    expect.objectContaining({ code: 'PLAN_INVALID', name: 'PresentationPlanError' }),
  );

describe('C-51 presentation planner seam', () => {
  it('accepts valid single and multi-page plans and clones metadata', async () => {
    const planner = new InMemoryPresentationPlanner(async () =>
      plan([slide('s-1', 1), slide('s-2', 2)]),
    );
    const result = await planner.plan(
      { notebookId: 'nb', sourceVersionIds: ['v'], title: 'Deck' },
      {},
    );
    expect(result.slides).toHaveLength(2);
    expect(result.slides.map((item) => item.order)).toEqual([1, 2]);
    (result.designSpec!.theme as { name: string }).name = 'changed';
    (result.slides[0]!.metadata!.nested as { tags: string[] }).tags.push('changed');
    const second = await planner.plan(
      { notebookId: 'nb', sourceVersionIds: ['v'], title: 'Deck' },
      {},
    );
    expect(second.designSpec).toEqual({ theme: { name: 'light' } });
    expect(second.slides[0]!.metadata).toEqual({ nested: { tags: ['intro'] } });
  });

  it('rejects empty pages, duplicate ids, invalid orders, invalid SVG and budgets', () => {
    expectInvalid(plan([]));
    expectInvalid(plan([slide('same', 0), slide('same', 1)]));
    expectInvalid(plan([slide('s-1', 0), slide('s-2', 2)]));
    expectInvalid(plan([slide('s-1', 1), slide('s-2', 0)]));
    expectInvalid(plan([slide('s-1', 0), slide('s-2', 0)]));
    expectInvalid(plan([slide('s-1', 0, '<html>not svg</html>')]));
    expectInvalid(plan([slide('s-1', 0, '<svg><script>alert(1)</script></svg>')]));
    expectInvalid(plan([slide('s-1', 0), slide('s-2', 1)]), { maxSlides: 1 });
    expectInvalid(plan([slide('s-1', 0, '<svg>12345</svg>')]), { maxSvgBytes: 3 });
  });

  it('normalizes malformed plan values to PLAN_INVALID and preserves builder errors', async () => {
    expectInvalid({ ...plan(), planId: ' ' });
    expectInvalid({ ...plan(), slides: [{ ...slide('s-1', 0), svg: '<svg>' }] });
    const plannerError = new Error('planner backend failed');
    const planner = new InMemoryPresentationPlanner(async () => {
      throw plannerError;
    });
    await expect(
      planner.plan({ notebookId: 'nb', sourceVersionIds: ['v'], title: 'Deck' }, {}),
    ).rejects.toBe(plannerError);
    expect(() => new InMemoryPresentationPlanner(undefined as never)).toThrowError(
      PresentationPlanError,
    );
  });
});
