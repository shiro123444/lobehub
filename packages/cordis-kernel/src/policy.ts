import type { PermissionManifest } from './types';

export const PERMISSION_KINDS = [
  'network',
  'filesystem',
  'tools',
  'device',
  'uiSlots',
] as const satisfies readonly (keyof PermissionManifest)[];

export type PermissionKind = (typeof PERMISSION_KINDS)[number];
export type PermissionManifestInput = PermissionManifest | readonly PermissionManifest[];

export type PolicyDecision = 'allow' | 'deny';
export type PolicyErrorCode = 'POLICY_DENIED' | 'POLICY_TIMEOUT' | 'POLICY_INVALID';

export interface PolicyRequest {
  readonly kind: PermissionKind;
  readonly resource: string;
}

export interface PolicyEvaluation {
  readonly decision: PolicyDecision;
  readonly kind: PermissionKind;
  readonly matchedPattern?: string;
  readonly resource: string;
}

export interface PolicyEvaluatorOptions {
  readonly deny?: PermissionManifestInput;
  readonly maxResultBytes?: number;
  readonly timeoutMs?: number;
}

export interface PolicyExecutionOptions {
  readonly maxResultBytes?: number;
  readonly timeoutMs?: number;
}

export interface TruncatedResult {
  readonly marker: '[truncated]';
  readonly maxBytes: number;
  readonly originalBytes: number;
  readonly result: string;
  readonly truncated: true;
  readonly value: string;
}

export type PolicyResult<T> = T | TruncatedResult;
export type PolicyOperation<T> = (() => T | PromiseLike<T>) | PromiseLike<T>;

export interface PolicyErrorDetails {
  readonly cause?: unknown;
  readonly kind?: PermissionKind;
  readonly path?: string;
  readonly resource?: string;
}

export class PolicyError extends Error {
  constructor(
    public readonly code: PolicyErrorCode,
    message: string,
    details: PolicyErrorDetails = {},
  ) {
    super(message);
    this.name = 'PolicyError';
    this.kind = details.kind;
    this.resource = details.resource;
    this.path = details.path;
    this.cause = details.cause;
  }

  public readonly kind?: PermissionKind;
  public readonly resource?: string;
  public readonly path?: string;
  public readonly cause?: unknown;
}

export interface PolicyEvaluatorSeam {
  allow: ((request: PolicyRequest) => boolean) &
    ((kind: PermissionKind, resource: string) => boolean);
  assertAllowed: ((request: PolicyRequest) => void) &
    ((kind: PermissionKind, resource: string) => void);
  deny: ((request: PolicyRequest) => boolean) &
    ((kind: PermissionKind, resource: string) => boolean);
  evaluate: ((request: PolicyRequest) => PolicyEvaluation) &
    ((kind: PermissionKind, resource: string) => PolicyEvaluation);
  execute: (<T>(
    request: PolicyRequest,
    operation: PolicyOperation<T>,
    options?: PolicyExecutionOptions,
  ) => Promise<PolicyResult<T>>) &
    (<T>(
      kind: PermissionKind,
      resource: string,
      operation: PolicyOperation<T>,
      options?: PolicyExecutionOptions,
    ) => Promise<PolicyResult<T>>);
  truncate: <T>(value: T, maxResultBytes?: number) => PolicyResult<T>;
  withTimeout: <T>(
    operation: PolicyOperation<T>,
    timeoutMs?: number,
    target?: PolicyRequest,
  ) => Promise<T>;
}

interface NormalizedTarget extends PolicyRequest {}

const isPermissionKind = (value: unknown): value is PermissionKind =>
  typeof value === 'string' && (PERMISSION_KINDS as readonly string[]).includes(value);

const invalid = (path: string, message: string): never => {
  throw new PolicyError('POLICY_INVALID', message, { path });
};

const validateLimit = (value: number | undefined, path: string): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    invalid(path, 'must be a non-negative integer');
  }
  return value;
};

const cloneManifest = (
  input: PermissionManifestInput | undefined,
  path: string,
): PermissionManifest => {
  const manifests = input === undefined ? [] : Array.isArray(input) ? input : [input];
  const result: PermissionManifest = {};

  for (const manifest of manifests) {
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
      invalid(path, 'must contain PermissionManifest objects');
    }

    for (const kind of PERMISSION_KINDS) {
      const patterns = manifest[kind];
      if (patterns === undefined) continue;
      if (!Array.isArray(patterns)) invalid(`${path}.${kind}`, 'must be an array of strings');

      const target = (result[kind] ??= []);
      for (const [patternIndex, pattern] of patterns.entries()) {
        if (typeof pattern !== 'string' || !pattern.trim()) {
          invalid(`${path}.${kind}[${patternIndex}]`, 'must be a non-empty string');
        }
        if (!target.includes(pattern)) target.push(pattern);
      }
    }
  }

  return result;
};

const escapeRegExp = (value: string): string => value.replaceAll(/[|\\{}()[\]^$+?.]/g, '\\$&');

const globPattern = (pattern: string): RegExp => {
  let source = '^';
  let literal = '';

  const flushLiteral = () => {
    if (literal) {
      source += escapeRegExp(literal);
      literal = '';
    }
  };

  for (const character of pattern) {
    if (character === '*') {
      flushLiteral();
      source += '.*';
    } else if (character === '?') {
      flushLiteral();
      source += '.';
    } else {
      literal += character;
    }
  }
  flushLiteral();

  return new RegExp(`${source}$`);
};

const encoder = new TextEncoder();

const byteLength = (value: string): number => encoder.encode(value).byteLength;

const takeBytes = (value: string, maxBytes: number): string => {
  if (byteLength(value) <= maxBytes) return value;

  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const characterBytes = byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    bytes += characterBytes;
    end += character.length;
  }
  return value.slice(0, end);
};

const serializeResult = (value: unknown): string => {
  if (typeof value === 'string') return value;
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
};

export class PolicyEvaluator implements PolicyEvaluatorSeam {
  public readonly manifest: PermissionManifest;
  public readonly denyManifest: PermissionManifest;

  private readonly defaultTimeoutMs?: number;
  private readonly defaultMaxResultBytes?: number;
  private readonly patternCache = new Map<string, RegExp>();

  constructor(manifest: PermissionManifestInput = {}, options: PolicyEvaluatorOptions = {}) {
    this.manifest = cloneManifest(manifest, 'permissions');
    this.denyManifest = cloneManifest(options.deny, 'deny');
    this.defaultTimeoutMs = validateLimit(options.timeoutMs, 'timeoutMs');
    this.defaultMaxResultBytes = validateLimit(options.maxResultBytes, 'maxResultBytes');
  }

  evaluate(request: PolicyRequest): PolicyEvaluation;
  evaluate(kind: PermissionKind, resource: string): PolicyEvaluation;
  evaluate(requestOrKind: PolicyRequest | PermissionKind, resource?: string): PolicyEvaluation {
    const target = this.normalizeTarget(requestOrKind, resource);
    const deniedPattern = this.match(this.denyManifest, target);
    if (deniedPattern) {
      return { ...target, decision: 'deny', matchedPattern: deniedPattern };
    }

    const matchedPattern = this.match(this.manifest, target);
    return matchedPattern
      ? { ...target, decision: 'allow', matchedPattern }
      : { ...target, decision: 'deny' };
  }

  allow(request: PolicyRequest): boolean;
  allow(kind: PermissionKind, resource: string): boolean;
  allow(requestOrKind: PolicyRequest | PermissionKind, resource?: string): boolean {
    return (
      (typeof requestOrKind === 'object'
        ? this.evaluate(requestOrKind)
        : this.evaluate(requestOrKind, resource as string)
      ).decision === 'allow'
    );
  }

  deny(request: PolicyRequest): boolean;
  deny(kind: PermissionKind, resource: string): boolean;
  deny(requestOrKind: PolicyRequest | PermissionKind, resource?: string): boolean {
    return !(typeof requestOrKind === 'object'
      ? this.allow(requestOrKind)
      : this.allow(requestOrKind, resource as string));
  }

  isAllowed(request: PolicyRequest): boolean;
  isAllowed(kind: PermissionKind, resource: string): boolean;
  isAllowed(requestOrKind: PolicyRequest | PermissionKind, resource?: string): boolean {
    return typeof requestOrKind === 'object'
      ? this.allow(requestOrKind)
      : this.allow(requestOrKind, resource as string);
  }

  isDenied(request: PolicyRequest): boolean;
  isDenied(kind: PermissionKind, resource: string): boolean;
  isDenied(requestOrKind: PolicyRequest | PermissionKind, resource?: string): boolean {
    return typeof requestOrKind === 'object'
      ? this.deny(requestOrKind)
      : this.deny(requestOrKind, resource as string);
  }

  assertAllowed(request: PolicyRequest): void;
  assertAllowed(kind: PermissionKind, resource: string): void;
  assertAllowed(requestOrKind: PolicyRequest | PermissionKind, resource?: string): void {
    const target = this.normalizeTarget(requestOrKind, resource);
    const evaluation = this.evaluate(target);
    if (evaluation.decision === 'allow') return;

    throw new PolicyError(
      'POLICY_DENIED',
      `Permission denied for ${target.kind}: ${target.resource}`,
      {
        kind: target.kind,
        path: `permissions.${target.kind}`,
        resource: target.resource,
      },
    );
  }

  check(request: PolicyRequest): void;
  check(kind: PermissionKind, resource: string): void;
  check(requestOrKind: PolicyRequest | PermissionKind, resource?: string): void {
    if (typeof requestOrKind === 'object') this.assertAllowed(requestOrKind);
    else this.assertAllowed(requestOrKind, resource as string);
  }

  async withTimeout<T>(
    operation: PolicyOperation<T>,
    timeoutMs?: number,
    target?: PolicyRequest,
  ): Promise<T> {
    const limit = validateLimit(timeoutMs ?? this.defaultTimeoutMs, 'timeoutMs');
    const task = Promise.resolve().then(() =>
      typeof operation === 'function' ? operation() : operation,
    );

    if (limit === undefined) return task;

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new PolicyError('POLICY_TIMEOUT', 'Policy operation timed out', {
            kind: target?.kind,
            resource: target?.resource,
            path: 'timeout',
          }),
        );
      }, limit);

      task.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  truncate<T>(value: T, maxResultBytes = this.defaultMaxResultBytes): PolicyResult<T> {
    const limit = validateLimit(maxResultBytes, 'maxResultBytes');
    if (limit === undefined) return value;

    const serialized = serializeResult(value);
    const originalBytes = byteLength(serialized);
    if (originalBytes <= limit) return value;

    const truncated = takeBytes(serialized, limit);
    return {
      truncated: true,
      marker: '[truncated]',
      value: truncated,
      result: truncated,
      originalBytes,
      maxBytes: limit,
    };
  }

  truncateResult<T>(value: T, maxResultBytes = this.defaultMaxResultBytes): PolicyResult<T> {
    return this.truncate(value, maxResultBytes);
  }

  execute<T>(
    request: PolicyRequest,
    operation: PolicyOperation<T>,
    options?: PolicyExecutionOptions,
  ): Promise<PolicyResult<T>>;
  execute<T>(
    kind: PermissionKind,
    resource: string,
    operation: PolicyOperation<T>,
    options?: PolicyExecutionOptions,
  ): Promise<PolicyResult<T>>;
  async execute<T>(
    requestOrKind: PolicyRequest | PermissionKind,
    resourceOrOperation: string | PolicyOperation<T>,
    operationOrOptions?: PolicyOperation<T> | PolicyExecutionOptions,
    options?: PolicyExecutionOptions,
  ): Promise<PolicyResult<T>> {
    const request =
      typeof requestOrKind === 'object'
        ? this.normalizeTarget(requestOrKind)
        : this.normalizeTarget(requestOrKind, resourceOrOperation as string);
    const operation =
      typeof requestOrKind === 'object'
        ? (resourceOrOperation as PolicyOperation<T>)
        : (operationOrOptions as PolicyOperation<T>);
    const callOptions =
      typeof requestOrKind === 'object'
        ? (operationOrOptions as PolicyExecutionOptions | undefined)
        : options;

    this.assertAllowed(request);
    const result = await this.withTimeout(
      operation,
      callOptions?.timeoutMs ?? this.defaultTimeoutMs,
      request,
    );
    return this.truncate(result, callOptions?.maxResultBytes ?? this.defaultMaxResultBytes);
  }

  private normalizeTarget(
    requestOrKind: PolicyRequest | PermissionKind,
    resource?: string,
  ): NormalizedTarget {
    const isRequest = typeof requestOrKind === 'object' && requestOrKind !== null;
    const kind = isRequest ? requestOrKind.kind : requestOrKind;
    const targetResource = isRequest ? requestOrKind.resource : resource;

    if (!isPermissionKind(kind)) invalid('kind', 'must be a supported permission category');
    if (typeof targetResource !== 'string' || !targetResource.trim()) {
      invalid('resource', 'must be a non-empty string');
    }

    return { kind, resource: targetResource as string };
  }

  private match(manifest: PermissionManifest, target: NormalizedTarget): string | undefined {
    const patterns = manifest[target.kind] ?? [];
    return patterns.find((pattern) => this.pattern(pattern).test(target.resource));
  }

  private pattern(pattern: string): RegExp {
    const cached = this.patternCache.get(pattern);
    if (cached) return cached;
    const compiled = globPattern(pattern);
    this.patternCache.set(pattern, compiled);
    return compiled;
  }
}

export { PolicyError as PolicyEvaluatorError };
export { PolicyEvaluator as InMemoryPolicyEvaluator };
