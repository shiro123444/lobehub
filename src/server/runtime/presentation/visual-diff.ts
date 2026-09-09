/**
 * C-86 server-only visual-diff quality-gate seam.
 *
 * The seam owns no image decoder, filesystem, network, provider or process.
 * Callers inject both decoding and comparison so reference assets can remain
 * opaque AssetRef values and rendered output can remain renderer-owned data.
 */

import type { AssetRef, RuntimeScope } from '../../../../packages/runtime-contracts/src';

export type VisualDiffSide = 'actual' | 'reference';
export type VisualDiffReadable = string | Uint8Array;
export type VisualDiffSource = AssetRef | VisualDiffReadable;

export interface VisualDiffDecodeContext {
  readonly scope: RuntimeScope;
  readonly side: VisualDiffSide;
  readonly signal?: AbortSignal;
}

export interface VisualDiffAssetResolver {
  (
    scope: RuntimeScope,
    asset: AssetRef,
  ): VisualDiffReadable | null | Promise<VisualDiffReadable | null>;
}

export interface VisualDiffDecoder {
  (input: VisualDiffReadable, context: VisualDiffDecodeContext): unknown | Promise<unknown>;
}

export interface VisualDiffComparatorOptions {
  readonly scope: RuntimeScope;
  readonly signal?: AbortSignal;
}

export interface VisualDiffRegionComparison {
  readonly score: number;
}

export interface VisualDiffComparison {
  readonly perRegion?: readonly (VisualDiffRegionComparison | number)[];
  readonly score: number;
}

export interface VisualDiffReport {
  readonly passed: boolean;
  readonly perRegion?: readonly {
    readonly index: number;
    readonly passed: boolean;
    readonly score: number;
  }[];
  readonly score: number;
  readonly threshold: number;
}

export interface VisualDiffCompareOptions {
  readonly maxBytes?: number;
  readonly maxDurationMs?: number;
  readonly scope: RuntimeScope;
  readonly signal?: AbortSignal;
  readonly threshold: number;
}

export interface VisualDiffComparator {
  (
    reference: unknown,
    actual: unknown,
    options: VisualDiffComparatorOptions,
  ): VisualDiffComparison | number | Promise<VisualDiffComparison | number>;
}

export interface VisualDiffPort {
  compare: (
    reference: VisualDiffSource,
    rendered: VisualDiffSource,
    options: VisualDiffCompareOptions,
  ) => Promise<VisualDiffReport>;
}

export interface VisualDiffOptions {
  readonly comparator: VisualDiffComparator;
  readonly decoder: VisualDiffDecoder;
  readonly now?: () => number | string | Date;
  readonly resolveAsset?: VisualDiffAssetResolver;
}

export type VisualDiffErrorCode =
  | 'PRESENTATION_VISUAL_MISMATCH'
  | 'VISUAL_DIFF_BUDGET_EXCEEDED'
  | 'VISUAL_DIFF_CANCELLED'
  | 'VISUAL_DIFF_INVALID';

export class VisualDiffError extends Error {
  constructor(
    public readonly code: VisualDiffErrorCode,
    message: string,
    public readonly path?: string,
    public readonly report?: VisualDiffReport,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'VisualDiffError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const invalid = (message: string, path?: string): VisualDiffError =>
  new VisualDiffError('VISUAL_DIFF_INVALID', message, path);

const cloneScope = (value: unknown): RuntimeScope => {
  if (!isRecord(value) || !nonEmptyString(value.userId) || !nonEmptyString(value.sessionId)) {
    throw invalid('scope.userId and scope.sessionId must be non-empty strings', 'scope');
  }
  return { sessionId: value.sessionId.trim(), userId: value.userId.trim() };
};

const cloneAssetRef = (value: unknown, path: string): AssetRef => {
  if (!isPlainRecord(value) || !nonEmptyString(value.ref)) {
    throw invalid('asset reference must contain a non-empty ref', `${path}.ref`);
  }
  const ref = value.ref.trim();
  if (
    ref.startsWith('/') ||
    ref.startsWith('./') ||
    ref.startsWith('../') ||
    /^[a-z]:[\\/]/iu.test(ref) ||
    ref.startsWith('file:')
  ) {
    throw invalid('asset reference must not be a local file path', `${path}.ref`);
  }
  // Metadata is intentionally not carried into the resolver or report. It
  // may contain provider-specific or sensitive values.
  return { ref };
};

const cloneBytes = (value: Uint8Array): Uint8Array => new Uint8Array(value);

const normalizeSource = (
  value: unknown,
  path: string,
): { readonly asset?: AssetRef; readonly input: VisualDiffReadable } => {
  if (value instanceof Uint8Array) {
    if (value.byteLength === 0) throw invalid('binary input must not be empty', path);
    return { input: cloneBytes(value) };
  }
  if (typeof value === 'string') {
    if (!nonEmptyString(value)) throw invalid('text input must not be empty', path);
    return { input: value };
  }
  const asset = cloneAssetRef(value, path);
  return { asset, input: asset.ref };
};

const inputBytes = (value: VisualDiffReadable): number =>
  value instanceof Uint8Array ? value.byteLength : new TextEncoder().encode(value).byteLength;

const readTime = (now: () => number | string | Date): number => {
  const value = now();
  const timestamp =
    value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) throw invalid('now must return a valid time', 'now');
  return timestamp;
};

function assertSignal(signal: unknown): asserts signal is AbortSignal {
  if (
    signal !== undefined &&
    (!isRecord(signal) ||
      typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function')
  ) {
    throw invalid('signal must be an AbortSignal', 'signal');
  }
}

const assertLimit = (value: number | undefined, path: string): void => {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw invalid(`${path} must be a non-negative safe integer`, path);
  }
};

const cancellation = (): VisualDiffError =>
  new VisualDiffError('VISUAL_DIFF_CANCELLED', 'visual diff was cancelled', 'signal');

const budgetExceeded = (path: string): VisualDiffError =>
  new VisualDiffError('VISUAL_DIFF_BUDGET_EXCEEDED', 'visual diff budget was exceeded', path);

const awaitWithGuards = async <T>(
  operation: PromiseLike<T> | T,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): Promise<T> => {
  if (!signal && timeoutMs === undefined) return operation;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = (): void => finish(() => reject(cancellation()));

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs !== undefined) {
      timer = setTimeout(
        () => finish(() => reject(budgetExceeded('maxDurationMs'))),
        Math.max(timeoutMs, 0),
      );
    }
    Promise.resolve(operation).then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
};

const resolveComparison = (value: unknown): VisualDiffComparison => {
  if (typeof value === 'number') return { score: value };
  if (!isPlainRecord(value) || typeof value.score !== 'number') {
    throw invalid('comparator must return a numeric score', 'comparison.score');
  }
  return {
    ...(value.perRegion === undefined ? {} : { perRegion: value.perRegion as never }),
    score: value.score,
  };
};

const normalizeReport = (comparison: VisualDiffComparison, threshold: number): VisualDiffReport => {
  if (!Number.isFinite(comparison.score) || comparison.score < 0) {
    throw invalid('comparison score must be a finite non-negative number', 'comparison.score');
  }
  const rawRegions = comparison.perRegion;
  let perRegion: VisualDiffReport['perRegion'];
  if (rawRegions !== undefined) {
    if (!Array.isArray(rawRegions))
      throw invalid('perRegion must be an array', 'comparison.perRegion');
    perRegion = rawRegions.map((region, index) => {
      const score = typeof region === 'number' ? region : region?.score;
      if (typeof score !== 'number' || !Number.isFinite(score) || score < 0) {
        throw invalid(
          'region score must be finite and non-negative',
          `comparison.perRegion.${index}`,
        );
      }
      return { index, passed: score <= threshold, score };
    });
  }
  return {
    ...(perRegion === undefined ? {} : { perRegion }),
    passed: comparison.score <= threshold,
    score: comparison.score,
    threshold,
  };
};

class VisualDiffQualityGate implements VisualDiffPort {
  private readonly comparator: VisualDiffComparator;
  private readonly decoder: VisualDiffDecoder;
  private readonly now: () => number | string | Date;
  private readonly resolveAsset?: VisualDiffAssetResolver;

  constructor(options: VisualDiffOptions) {
    if (!isRecord(options) || typeof options.comparator !== 'function') {
      throw invalid('comparator is required', 'comparator');
    }
    if (typeof options.decoder !== 'function') throw invalid('decoder is required', 'decoder');
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw invalid('now must be a function', 'now');
    }
    if (options.resolveAsset !== undefined && typeof options.resolveAsset !== 'function') {
      throw invalid('resolveAsset must be a function', 'resolveAsset');
    }
    this.comparator = options.comparator;
    this.decoder = options.decoder;
    this.now = options.now ?? (() => Date.now());
    this.resolveAsset = options.resolveAsset;
  }

  async compare(
    reference: VisualDiffSource,
    rendered: VisualDiffSource,
    options: VisualDiffCompareOptions,
  ): Promise<VisualDiffReport> {
    if (!isRecord(options)) throw invalid('compare options are required', 'options');
    const scope = cloneScope(options.scope);
    if (typeof options.threshold !== 'number' || !Number.isFinite(options.threshold)) {
      throw invalid('threshold must be a finite number', 'threshold');
    }
    if (options.threshold < 0) throw invalid('threshold must be non-negative', 'threshold');
    assertLimit(options.maxBytes, 'maxBytes');
    assertLimit(options.maxDurationMs, 'maxDurationMs');
    assertSignal(options.signal);

    const startedAt = readTime(this.now);
    const maxDurationMs = options.maxDurationMs;
    const assertBudget = (): number | undefined => {
      if (options.signal?.aborted) throw cancellation();
      if (maxDurationMs === undefined) return;
      const elapsed = readTime(this.now) - startedAt;
      if (elapsed > maxDurationMs) throw budgetExceeded('maxDurationMs');
      return Math.max(maxDurationMs - elapsed, 0);
    };

    let consumedBytes = 0;
    const materialize = async (
      source: unknown,
      side: VisualDiffSide,
    ): Promise<{ readonly asset?: AssetRef; readonly input: VisualDiffReadable }> => {
      assertBudget();
      const normalized = normalizeSource(source, side);
      if (normalized.asset && this.resolveAsset) {
        const resolved = await awaitWithGuards(
          this.resolveAsset(scope, normalized.asset),
          options.signal,
          assertBudget(),
        );
        if (resolved === null) throw invalid('asset resolver returned no data', `${side}.asset`);
        const resolvedSource = normalizeSource(resolved, `${side}.asset`);
        consumedBytes += inputBytes(resolvedSource.input);
        if (options.maxBytes !== undefined && consumedBytes > options.maxBytes) {
          throw budgetExceeded('maxBytes');
        }
        return resolvedSource;
      }
      if (normalized.asset && !/^[a-z][a-z\d+.-]*:/iu.test(normalized.asset.ref)) {
        throw invalid('asset ref requires a URI or an injected resolver', `${side}.ref`);
      }
      consumedBytes += inputBytes(normalized.input);
      if (options.maxBytes !== undefined && consumedBytes > options.maxBytes) {
        throw budgetExceeded('maxBytes');
      }
      return normalized;
    };

    const referenceSource = await materialize(reference, 'reference');
    const actualSource = await materialize(rendered, 'actual');
    const decode = async (
      source: { readonly asset?: AssetRef; readonly input: VisualDiffReadable },
      side: VisualDiffSide,
    ): Promise<unknown> => {
      const remaining = assertBudget();
      return await awaitWithGuards(
        this.decoder(source.input, { scope, side, signal: options.signal }),
        options.signal,
        remaining,
      );
    };
    const decodedReference = await decode(referenceSource, 'reference');
    const decodedActual = await decode(actualSource, 'actual');
    const remaining = assertBudget();
    const comparison = await awaitWithGuards(
      this.comparator(decodedReference, decodedActual, {
        scope,
        signal: options.signal,
      }),
      options.signal,
      remaining,
    );
    assertBudget();
    const report = normalizeReport(resolveComparison(comparison), options.threshold);
    if (!report.passed) {
      throw new VisualDiffError(
        'PRESENTATION_VISUAL_MISMATCH',
        'rendered output exceeds the visual-diff threshold',
        'score',
        report,
      );
    }
    return report;
  }
}

export const createVisualDiffPort = (options: VisualDiffOptions): VisualDiffPort =>
  new VisualDiffQualityGate(options);

export const createVisualDiff = createVisualDiffPort;

/** Deterministic no-library comparator useful for contract tests and adapters. */
export const deterministicVisualDiffComparator: VisualDiffComparator = (reference, actual) => ({
  score: JSON.stringify(reference) === JSON.stringify(actual) ? 0 : 1,
});
