import { describe, expect, it, vi } from 'vitest';

import type { AssetRef, RuntimeScope } from '../../../../packages/runtime-contracts/src';
import {
  createVisualDiffPort,
  type VisualDiffComparator,
  type VisualDiffDecoder,
  type VisualDiffError,
} from './visual-diff';

const scope: RuntimeScope = { sessionId: 'session-1', userId: 'user-1' };

const decoder: VisualDiffDecoder = async (input) => input;

const portFor = (
  comparator: VisualDiffComparator,
  options: Partial<Parameters<typeof createVisualDiffPort>[0]> = {},
) => createVisualDiffPort({ comparator, decoder, ...options });

const compareOptions = (
  overrides: Partial<Parameters<ReturnType<typeof portFor>['compare']>[2]> = {},
) => ({
  scope,
  threshold: 0.1,
  ...overrides,
});

describe('C-86 visual diff quality gate', () => {
  it('returns a stable passed report when the score is below the threshold', async () => {
    const port = portFor(() => ({ score: 0.05 }));

    await expect(port.compare('reference-svg', 'rendered-svg', compareOptions())).resolves.toEqual({
      passed: true,
      score: 0.05,
      threshold: 0.1,
    });
  });

  it('treats the threshold boundary as passed', async () => {
    const port = portFor(() => ({ score: 0.1 }));

    await expect(
      port.compare('reference-svg', 'rendered-svg', compareOptions()),
    ).resolves.toMatchObject({
      passed: true,
      score: 0.1,
    });
  });

  it('maps a score above the threshold to PRESENTATION_VISUAL_MISMATCH', async () => {
    const port = portFor(() => ({ score: 0.2, perRegion: [{ score: 0.4 }] }));

    await expect(
      port.compare('reference-svg', 'rendered-svg', compareOptions()),
    ).rejects.toMatchObject({
      code: 'PRESENTATION_VISUAL_MISMATCH',
      report: {
        passed: false,
        score: 0.2,
        threshold: 0.1,
        perRegion: [{ index: 0, passed: false }],
      },
    });
  });

  it('uses the injected resolver with the authenticated scope and omits sensitive asset metadata', async () => {
    const resolveAsset = vi.fn(async (_scope: RuntimeScope, asset: AssetRef) => {
      expect(asset).toEqual({ ref: 'asset://reference' });
      return new Uint8Array([1, 2, 3]);
    });
    const comparator: VisualDiffComparator = (reference, actual) => {
      expect(reference).toEqual(new Uint8Array([1, 2, 3]));
      expect(actual).toBe('rendered-svg');
      return { score: 0, perRegion: [{ score: 0 }] };
    };
    const port = portFor(comparator, { resolveAsset });
    const report = await port.compare(
      { metadata: { prompt: 'do not expose me', secret: 'token' }, ref: 'asset://reference' },
      'rendered-svg',
      compareOptions(),
    );

    expect(resolveAsset).toHaveBeenCalledWith(scope, { ref: 'asset://reference' });
    expect(JSON.stringify(report)).not.toContain('do not expose me');
    expect(report.perRegion).toEqual([{ index: 0, passed: true, score: 0 }]);
  });

  it('rejects malformed input and scope with VISUAL_DIFF_INVALID', async () => {
    const port = portFor(() => 0);

    await expect(port.compare('', 'rendered-svg', compareOptions())).rejects.toMatchObject({
      code: 'VISUAL_DIFF_INVALID',
      path: 'reference',
    });
    await expect(
      port.compare(
        'reference-svg',
        'rendered-svg',
        compareOptions({ scope: { userId: '', sessionId: 's' } }),
      ),
    ).rejects.toMatchObject({ code: 'VISUAL_DIFF_INVALID', path: 'scope' });
  });

  it('cancels an in-flight comparator through AbortSignal', async () => {
    const controller = new AbortController();
    let release!: (value: number) => void;
    const comparator: VisualDiffComparator = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const port = portFor(comparator);
    const pending = port.compare(
      'reference-svg',
      'rendered-svg',
      compareOptions({ signal: controller.signal }),
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'VISUAL_DIFF_CANCELLED' });
    release?.(0);
  });

  it('rejects invalid comparator output without fabricating passed', async () => {
    const port = portFor(() => ({ score: Number.NaN }));

    try {
      await port.compare('reference-svg', 'rendered-svg', compareOptions());
      expect.unreachable('invalid comparator output must fail');
    } catch (error) {
      expect(error as VisualDiffError).toMatchObject({ code: 'VISUAL_DIFF_INVALID' });
      expect((error as VisualDiffError).report).toBeUndefined();
    }
  });
});
