/**
 * C-103 server-only ppt-master plugin seam.
 *
 * The external ppt-master project is represented only by injected functions.
 * This module never discovers its path, reads process configuration, opens a
 * database, or spawns a process. A caller may wire the runner to a trusted
 * adapter later; tests use an in-memory function instead.
 */

import type {
  AssetRef,
  RuntimeContext,
  RuntimePluginManifest,
  RuntimeScope,
  SceneNode,
  SlideScene,
} from '../../../../packages/runtime-contracts/src';
import { validateSlideScene } from '../../../../packages/runtime-contracts/src';

export const PPT_MASTER_PLUGIN_ID = 'presentation.ppt-master' as const;
export const PPT_MASTER_PLUGIN_VERSION = '1.0.0' as const;
export const PPT_MASTER_CAPABILITY_SERVICE = 'presentation.ppt-master' as const;
export const PPTX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation' as const;

export interface PptMasterSceneContext {
  readonly jobId: string;
  readonly scope: RuntimeScope;
  readonly signal?: AbortSignal;
}

/** The conversion result contains text and editable node identity only. */
export interface PptMasterSceneConversion {
  readonly editableNodes: readonly PptMasterEditableNode[];
  readonly svg: string;
}

export interface PptMasterEditableNode {
  readonly editable: boolean;
  readonly id: string;
  readonly kind: SceneNode['kind'];
  readonly slideId: string;
}

/** Explicit scene converter; no filesystem or external project assumption. */
export type PptMasterSceneConverter = (
  scene: SlideScene,
  context: PptMasterSceneContext,
) => PptMasterSceneConversion | Promise<PptMasterSceneConversion>;

export interface PptMasterRunnerRequest {
  readonly jobId: string;
  readonly scope: RuntimeScope;
  readonly signal?: AbortSignal;
  readonly svg: string;
}

export interface PptMasterRunnerResult {
  readonly artifactId?: string;
  /** Opaque server-side asset reference; never a local path. */
  readonly artifactRef: AssetRef | string;
  readonly metadata?: Record<string, unknown>;
  readonly mimeType?: string;
}

/** Explicit external renderer/provider function; it is not a child-process API. */
export type PptMasterRunner = (
  request: PptMasterRunnerRequest,
) => PptMasterRunnerResult | Promise<PptMasterRunnerResult>;

export interface PptMasterPluginOptions {
  readonly convert: PptMasterSceneConverter;
  readonly runner: PptMasterRunner;
}

export interface PptMasterEditablePptx {
  readonly artifact: AssetRef;
  readonly artifactId: string;
  readonly editableNodes: readonly PptMasterEditableNode[];
  readonly jobId: string;
  readonly mimeType: typeof PPTX_MIME_TYPE;
  readonly scope: RuntimeScope;
}

export type PptMasterPluginErrorCode =
  | 'PRESENTATION_INVALID'
  | 'PRESENTATION_WORKER_CANCELLED'
  | 'PPTX_INVALID'
  | 'PPT_MASTER_FAILED'
  | 'PPT_MASTER_PLUGIN_DISPOSED'
  | 'PROVIDER_UNAVAILABLE';

export class PptMasterPluginError extends Error {
  constructor(
    public readonly code: PptMasterPluginErrorCode,
    message: string,
    public readonly path?: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PptMasterPluginError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const scopeOf = (value: unknown): RuntimeScope => {
  if (!isRecord(value) || !nonEmpty(value.userId) || !nonEmpty(value.sessionId)) {
    throw new PptMasterPluginError(
      'PRESENTATION_INVALID',
      'An authenticated userId and sessionId are required',
      'scope',
    );
  }
  return { sessionId: value.sessionId.trim(), userId: value.userId.trim() };
};

const localPath = (value: string): boolean =>
  value.startsWith('/') ||
  value.startsWith('./') ||
  value.startsWith('../') ||
  /^[a-z]:[\\/]/iu.test(value) ||
  value.startsWith('file:');

const safeAssetRef = (value: unknown, path: string): AssetRef => {
  const ref = typeof value === 'string' ? value : isRecord(value) ? value.ref : undefined;
  if (!nonEmpty(ref) || localPath(ref.trim())) {
    throw new PptMasterPluginError(
      'PPTX_INVALID',
      'runner must return an opaque artifact reference',
      path,
    );
  }
  return { ref: ref.trim() };
};

const safeMetadata = (value: unknown): Record<string, unknown> | undefined => {
  if (!isPlainRecord(value)) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (
      /^(?:bytes?|buffer|path|workspace|argv|command|secret|token|password|apiKey)$/iu.test(key)
    ) {
      continue;
    }
    if (
      nested === null ||
      typeof nested === 'string' ||
      typeof nested === 'boolean' ||
      (typeof nested === 'number' && Number.isFinite(nested))
    ) {
      output[key] = nested;
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
};

const sceneNodeIds = (nodes: readonly SceneNode[], slideId: string): PptMasterEditableNode[] => {
  const output: PptMasterEditableNode[] = [];
  const visit = (node: SceneNode): void => {
    output.push({ editable: node.locked !== true, id: node.id, kind: node.kind, slideId });
    if (node.kind === 'group') node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return output;
};

const safeEditableNodes = (value: unknown, scene: SlideScene): readonly PptMasterEditableNode[] => {
  if (!Array.isArray(value)) {
    throw new PptMasterPluginError(
      'PPTX_INVALID',
      'convert must return editableNodes',
      'editableNodes',
    );
  }
  const expected = new Map(sceneNodeIds(scene.nodes, scene.sceneId).map((node) => [node.id, node]));
  const seen = new Set<string>();
  return value.map((candidate, index) => {
    if (!isPlainRecord(candidate) || !nonEmpty(candidate.id)) {
      throw new PptMasterPluginError(
        'PPTX_INVALID',
        'editableNodes must contain non-empty node ids',
        `editableNodes[${index}]`,
      );
    }
    const id = candidate.id.trim();
    const expectedNode = expected.get(id);
    if (!expectedNode || seen.has(id)) {
      throw new PptMasterPluginError(
        'PPTX_INVALID',
        'editableNodes must map scene node ids exactly once',
        `editableNodes[${index}].id`,
      );
    }
    seen.add(id);
    return {
      editable:
        candidate.editable === undefined ? expectedNode.editable : candidate.editable === true,
      id,
      kind: expectedNode.kind,
      slideId: expectedNode.slideId,
    };
  });
};

const normalizeConversion = (value: unknown, scene: SlideScene): PptMasterSceneConversion => {
  if (!isPlainRecord(value) || !nonEmpty(value.svg)) {
    throw new PptMasterPluginError(
      'PPTX_INVALID',
      'convert must return non-empty SVG and editableNodes',
      'conversion',
    );
  }
  return {
    editableNodes: safeEditableNodes(value.editableNodes, scene),
    svg: value.svg,
  };
};

const normalizeRequest = (
  value: unknown,
): {
  readonly jobId: string;
  readonly scene: SlideScene;
  readonly scope: RuntimeScope;
  readonly signal?: AbortSignal;
} => {
  if (!isPlainRecord(value)) {
    throw new PptMasterPluginError(
      'PRESENTATION_INVALID',
      'render input must be an object',
      'input',
    );
  }
  if (!nonEmpty(value.jobId)) {
    throw new PptMasterPluginError('PRESENTATION_INVALID', 'jobId must be non-empty', 'jobId');
  }
  const scope = scopeOf(value.scope);
  const validation = validateSlideScene(value.scene);
  if (!validation.ok) {
    throw new PptMasterPluginError('PRESENTATION_INVALID', validation.error.message, 'scene');
  }
  if (
    value.signal !== undefined &&
    (!isRecord(value.signal) || typeof value.signal.aborted !== 'boolean')
  ) {
    throw new PptMasterPluginError('PRESENTATION_INVALID', 'signal is invalid', 'signal');
  }
  return {
    jobId: value.jobId.trim(),
    scene: validation.scene,
    scope,
    ...(value.signal === undefined ? {} : { signal: value.signal as unknown as AbortSignal }),
  };
};

function validateOptions(value: unknown): asserts value is PptMasterPluginOptions {
  if (
    !isPlainRecord(value) ||
    typeof value.convert !== 'function' ||
    typeof value.runner !== 'function'
  ) {
    throw new PptMasterPluginError(
      'PROVIDER_UNAVAILABLE',
      'ppt-master requires explicit convert and runner functions',
      'options',
    );
  }
}

export class PptMasterPresentationCapability {
  readonly manifest: RuntimePluginManifest = PPT_MASTER_PLUGIN_MANIFEST;

  private disposed = false;

  constructor(private readonly options: PptMasterPluginOptions) {
    validateOptions(options);
  }

  async render(input: {
    readonly jobId: string;
    readonly scene: SlideScene;
    readonly scope: RuntimeScope;
    readonly signal?: AbortSignal;
  }): Promise<PptMasterEditablePptx> {
    if (this.disposed) {
      throw new PptMasterPluginError(
        'PPT_MASTER_PLUGIN_DISPOSED',
        'ppt-master capability has been disposed',
      );
    }
    const request = normalizeRequest(input);
    if (request.signal?.aborted) {
      throw new PptMasterPluginError(
        'PRESENTATION_WORKER_CANCELLED',
        'ppt-master rendering was cancelled',
        'signal',
      );
    }

    let conversion: PptMasterSceneConversion;
    try {
      conversion = normalizeConversion(
        await this.options.convert(request.scene, {
          jobId: request.jobId,
          scope: request.scope,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        }),
        request.scene,
      );
    } catch (error) {
      if (request.signal?.aborted) {
        throw new PptMasterPluginError(
          'PRESENTATION_WORKER_CANCELLED',
          'ppt-master rendering was cancelled',
          'signal',
          error,
        );
      }
      if (error instanceof PptMasterPluginError) throw error;
      throw new PptMasterPluginError(
        'PPT_MASTER_FAILED',
        'ppt-master scene conversion failed',
        undefined,
        error,
      );
    }

    if (request.signal?.aborted) {
      throw new PptMasterPluginError(
        'PRESENTATION_WORKER_CANCELLED',
        'ppt-master rendering was cancelled',
        'signal',
      );
    }

    let result: PptMasterRunnerResult;
    try {
      result = await this.options.runner({
        jobId: request.jobId,
        scope: request.scope,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        svg: conversion.svg,
      });
    } catch (error) {
      if (request.signal?.aborted) {
        throw new PptMasterPluginError(
          'PRESENTATION_WORKER_CANCELLED',
          'ppt-master rendering was cancelled',
          'signal',
          error,
        );
      }
      if (error instanceof PptMasterPluginError) throw error;
      throw new PptMasterPluginError(
        'PPT_MASTER_FAILED',
        'ppt-master runner failed',
        undefined,
        error,
      );
    }

    if (!isPlainRecord(result)) {
      throw new PptMasterPluginError('PPTX_INVALID', 'runner returned an invalid result', 'result');
    }
    if ('bytes' in result || 'path' in result || 'workspace' in result) {
      throw new PptMasterPluginError(
        'PPTX_INVALID',
        'runner result must not expose bytes, path, or workspace',
        'result',
      );
    }
    const artifact = safeAssetRef(result.artifactRef, 'result.artifactRef');
    const mimeType = result.mimeType ?? PPTX_MIME_TYPE;
    if (mimeType !== PPTX_MIME_TYPE) {
      throw new PptMasterPluginError(
        'PPTX_INVALID',
        'runner must return a PPTX artifact',
        'result.mimeType',
      );
    }

    const metadata = safeMetadata(result.metadata);
    return {
      artifact: metadata ? { ...artifact, metadata } : artifact,
      artifactId: nonEmpty(result.artifactId) ? result.artifactId.trim() : `${request.jobId}:pptx`,
      editableNodes: conversion.editableNodes,
      jobId: request.jobId,
      mimeType: PPTX_MIME_TYPE,
      scope: request.scope,
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

const provideCapability = (ctx: RuntimeContext, options: unknown): (() => void | Promise<void>) => {
  validateOptions(options);
  const capability = new PptMasterPresentationCapability(options);
  return ctx.provide(PPT_MASTER_CAPABILITY_SERVICE, capability);
};

/** Unbound manifest; callers pass explicit options as Context.plugin config. */
export const PPT_MASTER_PLUGIN_MANIFEST: RuntimePluginManifest = {
  apply: provideCapability,
  id: PPT_MASTER_PLUGIN_ID,
  inject: [],
  kind: 'capability',
  permissions: { filesystem: [], tools: ['ppt-master'] },
  version: PPT_MASTER_PLUGIN_VERSION,
};

export const createPptMasterPresentationCapability = (
  options: PptMasterPluginOptions,
): PptMasterPresentationCapability => new PptMasterPresentationCapability(options);

export const createPptMasterPluginManifest = (
  options: PptMasterPluginOptions,
): RuntimePluginManifest => {
  validateOptions(options);
  return {
    ...PPT_MASTER_PLUGIN_MANIFEST,
    apply: (ctx) =>
      ctx.provide(PPT_MASTER_CAPABILITY_SERVICE, new PptMasterPresentationCapability(options)),
  };
};
