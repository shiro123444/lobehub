/**
 * C-34 production RuntimeFacade assembly seam.
 *
 * This module only assembles injected ports. It does not authenticate a
 * request, read a client session header, execute a provider, or keep a
 * user-scoped cache. The existing factory module remains the compatibility
 * seam used by the default runtime route.
 */

import type { PersistencePort } from '../../../packages/cordis-kernel/src/persistence';
import type { PresentationPort } from '../../../packages/cordis-kernel/src/presentation';
import { PresentationError } from '../../../packages/cordis-kernel/src/presentation';
import type { ImageGenerationPort } from '../../../packages/runtime-contracts/src';
import type {
  RuntimeFacadeFactory,
  RuntimeFacadeFactoryResult,
  RuntimeFacadeScope,
} from './factory';
import {
  configureRuntimeFacadeFactory,
  getRuntimeFacadeFactory,
  resetRuntimeFacadeFactory,
} from './factory';
import type { PresentationAssetStore } from './presentation/asset-store';
import {
  createPresentationRuntimeComposition,
  type PresentationRuntimeComposition,
} from './presentation/composition';
import type {
  PresentationJobEventJournalLoader,
  ScopedPresentationJobEventJournalCache,
} from './presentation/event-journal-cache';
import type { ImageGenerationEventPublisherFactory } from './presentation/image-generation-capability';
import { createImageGenerationCapability } from './presentation/image-generation-capability';
import type {
  OpenAIImageAssetSink,
  OpenAIImageFetcher,
  OpenAIImageUriResolver,
} from './presentation/image-provider-openai';
import type {
  MultimodalChatFetcher,
  MultimodalChatPort,
} from './presentation/multimodal-chat-provider';
import {
  createProductionOpenAIImageGenerationPort,
  type ProductionImageEnv,
} from './presentation/production-image-config';
import {
  createProductionMultimodalChatPort,
  type ProductionMultimodalChatEnv,
} from './presentation/production-multimodal-chat-config';

export interface RuntimeAuthenticatedScope {
  readonly serverDB: unknown;
  readonly userId: string;
}

/** The complete scope that production authentication must resolve. */
export interface RuntimeProductionScope {
  readonly request: Request;
  readonly serverDB: unknown;
  readonly sessionId: string;
  readonly userId: string;
}

/**
 * Resolves the real authenticated scope for a route request. The resolver is
 * the only source of sessionId; this seam never reads x-session-id.
 */
export type RuntimeProductionScopeResolver = (
  request: Request,
  authenticated: RuntimeAuthenticatedScope,
) => RuntimeProductionScope | Promise<RuntimeProductionScope>;

export type RuntimePersistencePortFactory = (
  scope: RuntimeProductionScope,
) => PersistencePort | Promise<PersistencePort>;

export interface RuntimePresentationPortBinding {
  readonly port: PresentationPort;
}

export type RuntimePresentationPortFactoryResult =
  | PresentationPort
  | RuntimePresentationPortBinding;

export type RuntimePresentationPortFactory = (
  scope: RuntimeProductionScope,
) => RuntimePresentationPortFactoryResult | Promise<RuntimePresentationPortFactoryResult>;

/** Explicit C-77 production presentation composition seam. */
export interface RuntimeProductionPresentationComposition {
  readonly portFactory: RuntimePresentationPortFactory;
  /** Optional safe C-73 readiness projection; never required for assembly. */
  readonly readiness?: unknown;
}

export interface RuntimeProductionDependencies {
  readonly imageGenerationAssetStore?: PresentationAssetStore;
  readonly imageGenerationCapability?: ReturnType<typeof createImageGenerationCapability>;
  readonly imageGenerationEventPublisherFactory?: ImageGenerationEventPublisherFactory;
  readonly imageGenerationPort?: ImageGenerationPort;
  readonly multimodalChatPort?: MultimodalChatPort;
  readonly persistence?: PersistencePort;
  readonly presentation?: PresentationPort;
  readonly presentationComposition?: PresentationRuntimeComposition;
}

/**
 * Existing RuntimeFacadeFactory implementations are structurally compatible:
 * they may ignore the additional production-only dependency context.
 */
export interface RuntimeProductionFacadeScope extends RuntimeProductionScope {
  readonly dependencies: RuntimeProductionDependencies;
}

export type RuntimeProductionFacadeFactory = (
  scope: RuntimeProductionFacadeScope,
) => RuntimeFacadeFactoryResult | Promise<RuntimeFacadeFactoryResult>;

/**
 * Explicit C-98/C-100 image assembly inputs for production bootstrap. The
 * env-like record and every external seam are caller-owned; this module never
 * discovers process configuration, a scope, a provider, or a journal.
 */
export interface RuntimeProductionImageGenerationOptions {
  readonly assetSink?: OpenAIImageAssetSink;
  readonly assetStore?: PresentationAssetStore;
  readonly env: ProductionImageEnv;
  readonly eventPublisherFactory?: ImageGenerationEventPublisherFactory;
  readonly fetcher: OpenAIImageFetcher;
  readonly journalCache?: ScopedPresentationJobEventJournalCache;
  readonly journalLoader?: PresentationJobEventJournalLoader;
  readonly limits?: Parameters<typeof createImageGenerationCapability>[0]['limits'];
  readonly now?: () => number | string | Date;
  readonly providerId?: string;
  readonly resolveAssetUri?: OpenAIImageUriResolver;
  readonly uriResolver?: OpenAIImageUriResolver;
}

export interface RuntimeProductionMultimodalChatOptions {
  readonly env: ProductionMultimodalChatEnv;
  readonly fetcher: MultimodalChatFetcher;
  readonly model?: string;
  readonly now?: () => number | string | Date;
  readonly providerId?: string;
}

export interface RuntimeProductionBootstrapOptions {
  readonly facadeFactory: RuntimeProductionFacadeFactory;
  /** Optional C-98/C-100 image provider assembly; absent preserves legacy behavior. */
  readonly imageGeneration?: RuntimeProductionImageGenerationOptions;
  /** Optional GLM multimodal chat provider assembly. */
  readonly multimodalChat?: RuntimeProductionMultimodalChatOptions;
  /** Deterministic audit timestamp hook for tests and deploy tooling. */
  readonly now?: () => string;
  readonly persistencePortFactory?: RuntimePersistencePortFactory;
  readonly presentationComposition?: RuntimeProductionPresentationComposition;
  readonly presentationPortFactory?: RuntimePresentationPortFactory;
  readonly scopeResolver: RuntimeProductionScopeResolver;
}

export type RuntimeProductionErrorCode =
  | 'RUNTIME_PRODUCTION_DEPENDENCY_MISSING'
  | 'RUNTIME_PRODUCTION_SCOPE_INVALID'
  | 'RUNTIME_PRODUCTION_OPTIONS_INVALID';

export class RuntimeProductionError extends Error {
  constructor(
    public readonly code: RuntimeProductionErrorCode,
    message: string,
    public readonly path?: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RuntimeProductionError';
  }
}

export interface RuntimeProductionAudit {
  readonly configuredAt: string;
  readonly dependencies: {
    readonly imageGeneration: boolean;
    readonly persistence: boolean;
    readonly presentation: boolean;
  };
  readonly routeFactory: 'getRuntimeFacadeFactory';
  readonly scopeResolver: 'injected';
}

export interface RuntimeProductionBootstrap {
  readonly audit: RuntimeProductionAudit;
  readonly factory: RuntimeFacadeFactory;
  reset: () => void;
}

interface RuntimeProductionImageBinding {
  readonly assetStore?: PresentationAssetStore;
  readonly capability?: ReturnType<typeof createImageGenerationCapability>;
  readonly composition?: PresentationRuntimeComposition;
  readonly eventPublisherFactory?: ImageGenerationEventPublisherFactory;
  readonly port: ImageGenerationPort;
}

let activeAudit: RuntimeProductionAudit | undefined;

export const getRuntimeProductionAudit = (): RuntimeProductionAudit | undefined => activeAudit;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isObjectLike = (value: unknown): value is object =>
  typeof value === 'object' && value !== null;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isRequest = (value: unknown): value is Request =>
  typeof Request !== 'undefined' && value instanceof Request;

const productionError = (
  code: RuntimeProductionErrorCode,
  message: string,
  path?: string,
  cause?: unknown,
): RuntimeProductionError => new RuntimeProductionError(code, message, path, cause);

const validateOptions = (options: RuntimeProductionBootstrapOptions): void => {
  if (!isRecord(options)) {
    throw productionError(
      'RUNTIME_PRODUCTION_OPTIONS_INVALID',
      'Runtime production bootstrap options must be an object',
      'options',
    );
  }
  if (typeof options.scopeResolver !== 'function') {
    throw productionError(
      'RUNTIME_PRODUCTION_DEPENDENCY_MISSING',
      'An authenticated scopeResolver is required',
      'scopeResolver',
    );
  }
  if (typeof options.facadeFactory !== 'function') {
    throw productionError(
      'RUNTIME_PRODUCTION_DEPENDENCY_MISSING',
      'A RuntimeFacadeFactory is required',
      'facadeFactory',
    );
  }
  if (
    options.persistencePortFactory !== undefined &&
    typeof options.persistencePortFactory !== 'function'
  ) {
    throw productionError(
      'RUNTIME_PRODUCTION_OPTIONS_INVALID',
      'persistencePortFactory must be a function',
      'persistencePortFactory',
    );
  }
  if (
    options.presentationPortFactory !== undefined &&
    typeof options.presentationPortFactory !== 'function'
  ) {
    throw productionError(
      'RUNTIME_PRODUCTION_OPTIONS_INVALID',
      'presentationPortFactory must be a function',
      'presentationPortFactory',
    );
  }
  if (
    options.presentationComposition !== undefined &&
    (!isRecord(options.presentationComposition) ||
      typeof options.presentationComposition.portFactory !== 'function')
  ) {
    throw productionError(
      'RUNTIME_PRODUCTION_OPTIONS_INVALID',
      'presentationComposition must provide a portFactory',
      'presentationComposition',
    );
  }
  if (
    options.presentationComposition !== undefined &&
    options.presentationPortFactory !== undefined
  ) {
    throw productionError(
      'RUNTIME_PRODUCTION_OPTIONS_INVALID',
      'presentationComposition cannot be combined with presentationPortFactory',
      'presentationComposition',
    );
  }
  if (options.multimodalChat !== undefined) {
    if (!isRecord(options.multimodalChat)) {
      throw productionError(
        'RUNTIME_PRODUCTION_OPTIONS_INVALID',
        'multimodalChat must be an object',
        'multimodalChat',
      );
    }
    if (typeof options.multimodalChat.fetcher !== 'function') {
      throw productionError(
        'RUNTIME_PRODUCTION_DEPENDENCY_MISSING',
        'multimodalChat requires a fetcher function',
        'multimodalChat.fetcher',
      );
    }
  }
};

const resolveScope = async (
  routeScope: RuntimeFacadeScope,
  resolver: RuntimeProductionScopeResolver,
): Promise<RuntimeProductionScope> => {
  if (!isRequest(routeScope?.request)) {
    throw productionError(
      'RUNTIME_PRODUCTION_SCOPE_INVALID',
      'Runtime route scope must contain the original Request',
      'request',
    );
  }
  if (!isNonEmptyString(routeScope.userId)) {
    throw productionError(
      'RUNTIME_PRODUCTION_SCOPE_INVALID',
      'Runtime route scope must contain an authenticated userId',
      'userId',
    );
  }

  let resolved: RuntimeProductionScope;
  try {
    resolved = await resolver(routeScope.request, {
      userId: routeScope.userId,
      serverDB: routeScope.serverDB,
    });
  } catch (cause) {
    throw productionError(
      'RUNTIME_PRODUCTION_SCOPE_INVALID',
      'Authenticated scope resolver failed',
      'scope',
      cause,
    );
  }

  if (!isRecord(resolved)) {
    throw productionError(
      'RUNTIME_PRODUCTION_SCOPE_INVALID',
      'Authenticated scope resolver must return an object',
      'scope',
    );
  }
  if (!isNonEmptyString(resolved.userId)) {
    throw productionError(
      'RUNTIME_PRODUCTION_SCOPE_INVALID',
      'Authenticated scope must contain a non-empty userId',
      'userId',
    );
  }
  if (resolved.userId !== routeScope.userId) {
    throw productionError(
      'RUNTIME_PRODUCTION_SCOPE_INVALID',
      'Authenticated scope userId does not match the route scope',
      'userId',
    );
  }
  if (!isNonEmptyString(resolved.sessionId)) {
    throw productionError(
      'RUNTIME_PRODUCTION_SCOPE_INVALID',
      'Authenticated scope must contain a non-empty sessionId',
      'sessionId',
    );
  }
  if (resolved.serverDB === undefined || resolved.serverDB === null) {
    throw productionError(
      'RUNTIME_PRODUCTION_SCOPE_INVALID',
      'Authenticated scope must contain serverDB',
      'serverDB',
    );
  }
  if (resolved.request !== routeScope.request) {
    throw productionError(
      'RUNTIME_PRODUCTION_SCOPE_INVALID',
      'Authenticated scope must preserve the original Request',
      'request',
    );
  }

  return resolved;
};

const resolvePersistence = async (
  factory: RuntimePersistencePortFactory | undefined,
  scope: RuntimeProductionScope,
): Promise<PersistencePort | undefined> => {
  if (!factory) return undefined;
  try {
    const persistence = await factory(scope);
    if (!isObjectLike(persistence)) {
      throw productionError(
        'RUNTIME_PRODUCTION_DEPENDENCY_MISSING',
        'persistencePortFactory must return a PersistencePort',
        'persistencePort',
      );
    }
    return persistence;
  } catch (error) {
    if (error instanceof RuntimeProductionError) throw error;
    throw productionError(
      'RUNTIME_PRODUCTION_DEPENDENCY_MISSING',
      'PersistencePort factory failed',
      'persistencePort',
      error,
    );
  }
};

const presentationPortFrom = (value: RuntimePresentationPortFactoryResult): PresentationPort => {
  if (isRecord(value) && 'port' in value) {
    const port = value.port;
    if (isObjectLike(port)) return port as PresentationPort;
    throw productionError(
      'RUNTIME_PRODUCTION_DEPENDENCY_MISSING',
      'presentationPortFactory returned an invalid binding',
      'presentationPort',
    );
  }
  if (isObjectLike(value)) return value as PresentationPort;
  throw productionError(
    'RUNTIME_PRODUCTION_DEPENDENCY_MISSING',
    'presentationPortFactory must return a PresentationPort',
    'presentationPort',
  );
};

const resolvePresentation = async (
  factory: RuntimePresentationPortFactory | undefined,
  scope: RuntimeProductionScope,
  preservePresentationErrors = false,
): Promise<PresentationPort | undefined> => {
  if (!factory) return undefined;
  try {
    return presentationPortFrom(await factory(scope));
  } catch (error) {
    if (error instanceof RuntimeProductionError) throw error;
    if (preservePresentationErrors && error instanceof PresentationError) throw error;
    throw productionError(
      'RUNTIME_PRODUCTION_DEPENDENCY_MISSING',
      'PresentationPort factory failed',
      'presentationPort',
      error,
    );
  }
};

const createImageBinding = (
  options: RuntimeProductionImageGenerationOptions | undefined,
  multimodalChatPort?: MultimodalChatPort,
): RuntimeProductionImageBinding | undefined => {
  if (!options) return undefined;

  const port = createProductionOpenAIImageGenerationPort(options.env, {
    ...(options.assetSink === undefined ? {} : { assetSink: options.assetSink }),
    fetcher: options.fetcher,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.providerId === undefined ? {} : { providerId: options.providerId }),
    ...(options.resolveAssetUri === undefined
      ? options.uriResolver === undefined
        ? {}
        : { uriResolver: options.uriResolver }
      : { resolveAssetUri: options.resolveAssetUri }),
  });

  const assetStore = options.assetStore;
  const eventPublisherFactory = options.eventPublisherFactory;
  const hasCapabilityDependencies = assetStore !== undefined && eventPublisherFactory !== undefined;
  let capability: ReturnType<typeof createImageGenerationCapability> | undefined;
  let composition: PresentationRuntimeComposition | undefined;

  if (hasCapabilityDependencies) {
    const compositionJournalOptions =
      options.journalCache !== undefined || options.journalLoader !== undefined;
    if (options.journalCache !== undefined && options.journalLoader !== undefined) {
      throw productionError(
        'RUNTIME_PRODUCTION_OPTIONS_INVALID',
        'imageGeneration journalCache and journalLoader are mutually exclusive',
        'imageGeneration',
      );
    }
    const commonCompositionOptions = {
      imageGenerationAssetStore: assetStore,
      imageGenerationEventPublisherFactory: eventPublisherFactory,
      imageGenerationPort: port,
      ...(multimodalChatPort === undefined ? {} : { multimodalChatPort }),
      ...(options.journalCache === undefined ? {} : { journalCache: options.journalCache }),
      ...(options.journalLoader === undefined ? {} : { journalLoader: options.journalLoader }),
      ...(options.now === undefined ? {} : { now: () => String(options.now!()) }),
    } as const;

    if (compositionJournalOptions) {
      composition = createPresentationRuntimeComposition(commonCompositionOptions);
      capability = composition.imageGenerationCapability;
    } else {
      const nowForCapability =
        options.now === undefined
          ? undefined
          : () => {
              const value = options.now!();
              return value instanceof Date ? value.getTime() : value;
            };
      capability = createImageGenerationCapability({
        assetStore,
        eventPublisherFactory,
        imagePort: port,
        ...(options.limits === undefined ? {} : { limits: options.limits }),
        ...(nowForCapability === undefined ? {} : { now: nowForCapability }),
      });
    }
  } else if (options.journalCache !== undefined || options.journalLoader !== undefined) {
    throw productionError(
      'RUNTIME_PRODUCTION_OPTIONS_INVALID',
      'imageGeneration journal requires assetStore and eventPublisherFactory',
      'imageGeneration',
    );
  }

  return {
    ...(options.assetStore === undefined ? {} : { assetStore: options.assetStore }),
    ...(capability === undefined ? {} : { capability }),
    ...(composition === undefined ? {} : { composition }),
    ...(options.eventPublisherFactory === undefined
      ? {}
      : { eventPublisherFactory: options.eventPublisherFactory }),
    port,
  };
};

const createMultimodalChatBinding = (
  options: RuntimeProductionMultimodalChatOptions | undefined,
): MultimodalChatPort | undefined => {
  if (!options) return undefined;
  return createProductionMultimodalChatPort({
    env: options.env,
    fetcher: options.fetcher,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.providerId === undefined ? {} : { providerId: options.providerId }),
  });
};

/**
 * Validates and installs one explicitly injected production factory. The
 * installed function remains request-scoped and stateless; it performs no
 * caching and resolves every request through the injected auth resolver.
 */
export const initializeRuntimeProduction = (
  options: RuntimeProductionBootstrapOptions,
): RuntimeProductionBootstrap => {
  validateOptions(options);
  const multimodalChatPort = createMultimodalChatBinding(options.multimodalChat);
  const imageBinding = createImageBinding(options.imageGeneration, multimodalChatPort);

  const productionFactory: RuntimeFacadeFactory = async (routeScope) => {
    const scope = await resolveScope(routeScope, options.scopeResolver);
    const persistence = await resolvePersistence(options.persistencePortFactory, scope);
    const presentation = await resolvePresentation(
      options.presentationPortFactory ?? options.presentationComposition?.portFactory,
      scope,
      options.presentationComposition !== undefined,
    );

    return await options.facadeFactory({
      ...scope,
      dependencies: {
        ...(imageBinding?.assetStore === undefined
          ? {}
          : { imageGenerationAssetStore: imageBinding.assetStore }),
        ...(imageBinding?.capability === undefined
          ? {}
          : { imageGenerationCapability: imageBinding.capability }),
        ...(imageBinding?.eventPublisherFactory === undefined
          ? {}
          : { imageGenerationEventPublisherFactory: imageBinding.eventPublisherFactory }),
        ...(imageBinding === undefined ? {} : { imageGenerationPort: imageBinding.port }),
        ...(multimodalChatPort === undefined ? {} : { multimodalChatPort }),
        ...(persistence ? { persistence } : {}),
        ...(presentation ? { presentation } : {}),
        ...(imageBinding?.composition === undefined
          ? {}
          : { presentationComposition: imageBinding.composition }),
      },
    });
  };

  const audit = Object.freeze<RuntimeProductionAudit>({
    configuredAt: options.now?.() ?? new Date().toISOString(),
    dependencies: Object.freeze({
      imageGeneration: options.imageGeneration !== undefined,
      persistence: options.persistencePortFactory !== undefined,
      presentation:
        options.presentationPortFactory !== undefined ||
        options.presentationComposition !== undefined,
    }),
    routeFactory: 'getRuntimeFacadeFactory',
    scopeResolver: 'injected',
  });

  configureRuntimeFacadeFactory(productionFactory);
  activeAudit = audit;

  let reset = false;
  return {
    audit,
    factory: productionFactory,
    reset: () => {
      if (reset) return;
      reset = true;
      if (getRuntimeFacadeFactory() !== productionFactory) return;
      resetRuntimeFacadeFactory();
      if (activeAudit === audit) activeAudit = undefined;
      void imageBinding?.composition?.dispose();
    },
  };
};

/** Explicit shutdown/reset helper; safe to call repeatedly. */
export const resetRuntimeProduction = (bootstrap?: RuntimeProductionBootstrap): void => {
  if (bootstrap) {
    bootstrap.reset();
    return;
  }
  resetRuntimeFacadeFactory();
  activeAudit = undefined;
};
