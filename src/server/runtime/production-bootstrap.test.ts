import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PersistencePort } from '../../../packages/cordis-kernel/src/persistence';
import type {
  PresentationPort,
  PresentationRunner,
} from '../../../packages/cordis-kernel/src/presentation';
import type { RuntimeFacadePort } from './adapter';
import type { RuntimeFacadeFactory } from './factory';
import { getRuntimeFacadeFactory, resetRuntimeFacadeFactory } from './factory';
import type { PresentationAssetStore } from './presentation/asset-store';
import type {
  PresentationCachedSession,
  PresentationPortScopeCacheBinding,
} from './presentation/factory';
import {
  createScopedPresentationPortCache,
  presentationPortFactoryFromScopeCache,
} from './presentation/factory';
import { PresentationJobEventJournal } from './presentation/job-event-journal';
import { PRODUCTION_PRESENTATION_ENV_KEYS } from './presentation/production-config';
import { createPptMasterProductionPresentationComposition } from './presentation/production-factory';
import {
  getRuntimeProductionAudit,
  initializeRuntimeProduction,
  resetRuntimeProduction,
  type RuntimeProductionBootstrapOptions,
  type RuntimeProductionFacadeFactory,
  type RuntimeProductionScope,
  type RuntimeProductionScopeResolver,
} from './production-bootstrap';

const facade: RuntimeFacadePort = {
  handle: async () => ({ ok: true }),
};

const makePresentationPort = (): PresentationPort =>
  ({
    cancelJob: vi.fn(),
    createJob: vi.fn(),
    exportArtifact: vi.fn(),
    getArtifact: vi.fn(),
    getJob: vi.fn(),
    retryJob: vi.fn(),
  }) as unknown as PresentationPort;

const requestFor = (path = 'a'): Request =>
  new Request(`https://example.test/api/runtime/v1/${path}`, { method: 'GET' });

const routeScopeFor = (
  userId = 'route-user',
  request = requestFor(),
): {
  request: Request;
  serverDB: object;
  userId: string;
} => ({
  request,
  serverDB: { route: userId },
  userId,
});

const defaultScopeResolver = vi.fn<RuntimeProductionScopeResolver>(
  async (request, authenticated) => ({
    request,
    serverDB: authenticated.serverDB,
    sessionId: 'authenticated-session',
    userId: authenticated.userId,
  }),
);

const defaultFacadeFactory = vi.fn<RuntimeProductionFacadeFactory>(async () => facade);

const optionsFor = (
  overrides: Partial<RuntimeProductionBootstrapOptions> = {},
): RuntimeProductionBootstrapOptions => ({
  facadeFactory: defaultFacadeFactory,
  scopeResolver: defaultScopeResolver,
  ...overrides,
});

afterEach(() => {
  resetRuntimeProduction();
  resetRuntimeFacadeFactory();
  vi.clearAllMocks();
});

describe('C-34 production RuntimeFacade bootstrap', () => {
  it('fails closed when the required scope resolver is missing', () => {
    const before = getRuntimeFacadeFactory();

    expect(() =>
      initializeRuntimeProduction({
        facadeFactory: defaultFacadeFactory,
      } as unknown as RuntimeProductionBootstrapOptions),
    ).toThrowError(
      expect.objectContaining({
        code: 'RUNTIME_PRODUCTION_DEPENDENCY_MISSING',
        path: 'scopeResolver',
      }),
    );
    expect(getRuntimeFacadeFactory()).toBe(before);
    expect(getRuntimeProductionAudit()).toBeUndefined();
  });

  it('fails closed when the RuntimeFacadeFactory is missing', () => {
    expect(() =>
      initializeRuntimeProduction({
        scopeResolver: defaultScopeResolver,
      } as unknown as RuntimeProductionBootstrapOptions),
    ).toThrowError(
      expect.objectContaining({
        code: 'RUNTIME_PRODUCTION_DEPENDENCY_MISSING',
        path: 'facadeFactory',
      }),
    );
    expect(getRuntimeProductionAudit()).toBeUndefined();
  });

  it('installs an auditable factory on the existing route getter', () => {
    const bootstrap = initializeRuntimeProduction(
      optionsFor({ now: () => '2026-08-28T00:00:00.000Z' }),
    );

    expect(getRuntimeFacadeFactory()).toBe(bootstrap.factory);
    expect(bootstrap.audit).toEqual({
      configuredAt: '2026-08-28T00:00:00.000Z',
      dependencies: { imageGeneration: false, persistence: false, presentation: false },
      routeFactory: 'getRuntimeFacadeFactory',
      scopeResolver: 'injected',
    });
    expect(getRuntimeProductionAudit()).toBe(bootstrap.audit);
  });

  it('accepts the existing RuntimeFacadeFactory type without a new runtime API', () => {
    const existingFactory: RuntimeFacadeFactory = async () => facade;
    const bootstrap = initializeRuntimeProduction({
      facadeFactory: existingFactory,
      scopeResolver: defaultScopeResolver,
    });

    expect(getRuntimeFacadeFactory()).toBe(bootstrap.factory);
  });

  it('keeps the authenticated sessionId required for production facade scopes', async () => {
    const scopeResolver: RuntimeProductionScopeResolver = (request, authenticated) => ({
      request,
      serverDB: authenticated.serverDB,
      sessionId: 'typed-session',
      userId: authenticated.userId,
    });
    const facadeFactory: RuntimeProductionFacadeFactory = async (scope) => {
      const sessionId: string = scope.sessionId;
      expect(sessionId).toBe('typed-session');
      return facade;
    };
    const bootstrap = initializeRuntimeProduction({ facadeFactory, scopeResolver });

    await expect(bootstrap.factory(routeScopeFor())).resolves.toBe(facade);
  });

  it('keeps optional presentation dependencies assignable through the production seam', async () => {
    const presentation = makePresentationPort();
    const presentationPortFactory: RuntimeProductionBootstrapOptions['presentationPortFactory'] =
      async () => ({ port: presentation });
    const facadeFactory: RuntimeProductionFacadeFactory = async (scope) => {
      const dependency: PresentationPort | undefined = scope.dependencies.presentation;
      expect(dependency).toBe(presentation);
      return facade;
    };
    const bootstrap = initializeRuntimeProduction({
      facadeFactory,
      presentationPortFactory,
      scopeResolver: defaultScopeResolver,
    });

    await expect(bootstrap.factory(routeScopeFor())).resolves.toBe(facade);
  });

  it('wires an explicit C-77 presentation composition through authenticated scope', async () => {
    const runner = {
      id: 'ppt-master-runner',
      spawn: vi.fn(() => {
        throw new Error('spawn must not happen during bootstrap assembly');
      }),
    } as unknown as PresentationRunner;
    const runnerFactory = vi.fn(() => runner);
    const composition = createPptMasterProductionPresentationComposition({
      env: {
        [PRODUCTION_PRESENTATION_ENV_KEYS.provider]: 'ppt-master',
        [PRODUCTION_PRESENTATION_ENV_KEYS.command]: JSON.stringify(['node', 'runner.js']),
        [PRODUCTION_PRESENTATION_ENV_KEYS.runnerId]: 'ppt-master-runner',
        [PRODUCTION_PRESENTATION_ENV_KEYS.allowedRunnerIds]: JSON.stringify(['ppt-master-runner']),
      },
      runnerFactory,
      workspaceFactory: (jobId) => ({
        path: `/workspace/${jobId}`,
        cleanup: async () => undefined,
      }),
    });
    const facadeFactory = vi.fn<RuntimeProductionFacadeFactory>(async (scope) => {
      expect(scope.dependencies.presentation).toBeDefined();
      expect(scope.sessionId).toBe('authenticated-session');
      return facade;
    });
    const bootstrap = initializeRuntimeProduction({
      facadeFactory,
      presentationComposition: composition,
      scopeResolver: defaultScopeResolver,
    });

    await expect(bootstrap.factory(routeScopeFor('composition-user'))).resolves.toBe(facade);
    expect(composition.readiness).toMatchObject({ available: true, commandAvailable: true });
    expect(runnerFactory).toHaveBeenCalledOnce();
    expect(runner.spawn).not.toHaveBeenCalled();
  });

  it('keeps a C-77 composition with missing provider fail-closed', async () => {
    const runnerFactory = vi.fn(() => {
      throw new Error('runnerFactory must not be called for unavailable config');
    });
    const composition = createPptMasterProductionPresentationComposition({
      env: {},
      runnerFactory,
    });
    const bootstrap = initializeRuntimeProduction({
      facadeFactory: defaultFacadeFactory,
      presentationComposition: composition,
      scopeResolver: defaultScopeResolver,
    });

    await expect(bootstrap.factory(routeScopeFor())).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
    expect(runnerFactory).not.toHaveBeenCalled();
  });

  it('rejects composition together with the legacy presentation factory', () => {
    const composition = createPptMasterProductionPresentationComposition({
      env: {},
      runnerFactory: () => ({ id: 'runner', spawn: vi.fn() }) as unknown as PresentationRunner,
    });

    expect(() =>
      initializeRuntimeProduction({
        ...optionsFor(),
        presentationComposition: composition,
        presentationPortFactory: async () => makePresentationPort(),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'RUNTIME_PRODUCTION_OPTIONS_INVALID',
        path: 'presentationComposition',
      }),
    );
  });

  it('narrows a valid optional session resolver to a required cached-session id', async () => {
    const presentation = makePresentationPort();
    const binding = createScopedPresentationPortCache({
      factory: () => presentation,
    });
    const sessionIdFor: (request: Request) => string | undefined = () => 'cached-session';
    const adapted: ReturnType<typeof presentationPortFactoryFromScopeCache> =
      presentationPortFactoryFromScopeCache(binding, sessionIdFor);

    await expect(
      adapted({ request: requestFor(), serverDB: {}, userId: 'user-cached' }),
    ).resolves.toBe(presentation);
    await binding.dispose();
  });

  it('rejects an undefined session resolver result before cache resolution', async () => {
    const presentation = makePresentationPort();
    const binding = createScopedPresentationPortCache({
      factory: () => presentation,
    });
    const typedBinding: PresentationPortScopeCacheBinding = binding;
    const session: PresentationCachedSession = {
      request: requestFor('missing-session'),
      sessionId: 'not-used',
      userId: 'user-missing-session',
    };
    const adapted = presentationPortFactoryFromScopeCache(typedBinding, () => undefined);

    await expect(
      adapted({ request: session.request, serverDB: {}, userId: session.userId }),
    ).rejects.toMatchObject({
      code: 'PRESENTATION_CACHE_SCOPE_INVALID',
      path: 'sessionId',
    });
    expect(binding.cache.size).toBe(0);
    await binding.dispose();
  });

  it('resolves the complete authenticated scope and optional ports per request', async () => {
    const request = requestFor('scope');
    const routeScope = routeScopeFor('user-a', request);
    const persistence = {} as PersistencePort;
    const presentation = {} as PresentationPort;
    const scopeResolver = vi.fn<RuntimeProductionScopeResolver>(
      async (receivedRequest, authenticated) => ({
        request: receivedRequest,
        serverDB: authenticated.serverDB,
        sessionId: 'real-session-a',
        userId: authenticated.userId,
      }),
    );
    const persistencePortFactory = vi.fn(async (scope: RuntimeProductionScope) => {
      expect(scope.request).toBe(request);
      return persistence;
    });
    const presentationPortFactory = vi.fn(async (scope: RuntimeProductionScope) => {
      expect(scope.sessionId).toBe('real-session-a');
      return { port: presentation };
    });
    let receivedScope: RuntimeProductionScope & {
      dependencies: { persistence?: PersistencePort; presentation?: PresentationPort };
    };
    const facadeFactory = vi.fn<RuntimeProductionFacadeFactory>(async (scope) => {
      receivedScope = scope;
      return facade;
    });

    const bootstrap = initializeRuntimeProduction({
      facadeFactory,
      persistencePortFactory,
      presentationPortFactory,
      scopeResolver,
    });

    await bootstrap.factory(routeScope);

    expect(scopeResolver).toHaveBeenCalledWith(request, {
      serverDB: routeScope.serverDB,
      userId: 'user-a',
    });
    expect(receivedScope!).toMatchObject({
      dependencies: { persistence, presentation },
      request,
      serverDB: routeScope.serverDB,
      sessionId: 'real-session-a',
      userId: 'user-a',
    });
  });

  it('uses only the injected auth resolver instead of a client x-session-id header', async () => {
    const request = new Request('https://example.test/api/runtime/v1/plugins', {
      headers: { 'x-session-id': 'client-forged-session' },
      method: 'GET',
    });
    const facadeFactory = vi.fn<RuntimeProductionFacadeFactory>(async (scope) => {
      expect(scope.sessionId).toBe('server-auth-session');
      return facade;
    });
    const scopeResolver = vi.fn<RuntimeProductionScopeResolver>(async (receivedRequest, auth) => ({
      request: receivedRequest,
      serverDB: auth.serverDB,
      sessionId: 'server-auth-session',
      userId: auth.userId,
    }));
    const bootstrap = initializeRuntimeProduction({ facadeFactory, scopeResolver });

    await bootstrap.factory(routeScopeFor('user-header', request));

    expect(scopeResolver).toHaveBeenCalledOnce();
    expect(facadeFactory).toHaveBeenCalledOnce();
  });

  it('rejects an incomplete authenticated scope with a stable error before facade creation', async () => {
    const facadeFactory = vi.fn<RuntimeProductionFacadeFactory>(async () => facade);
    const scopeResolver = vi.fn<RuntimeProductionScopeResolver>(async (request, auth) => ({
      request,
      serverDB: auth.serverDB,
      sessionId: '',
      userId: auth.userId,
    }));
    const bootstrap = initializeRuntimeProduction({ facadeFactory, scopeResolver });

    await expect(bootstrap.factory(routeScopeFor())).rejects.toMatchObject({
      code: 'RUNTIME_PRODUCTION_SCOPE_INVALID',
      path: 'sessionId',
    });
    expect(facadeFactory).not.toHaveBeenCalled();
  });

  it('rejects a resolver that changes the authenticated user or Request identity', async () => {
    const request = requestFor('identity');
    const facadeFactory = vi.fn<RuntimeProductionFacadeFactory>(async () => facade);
    const changedUserResolver = vi.fn<RuntimeProductionScopeResolver>(async () => ({
      request,
      serverDB: {},
      sessionId: 'session',
      userId: 'different-user',
    }));
    const changedUserBootstrap = initializeRuntimeProduction({
      facadeFactory,
      scopeResolver: changedUserResolver,
    });

    await expect(
      changedUserBootstrap.factory(routeScopeFor('user-a', request)),
    ).rejects.toMatchObject({
      code: 'RUNTIME_PRODUCTION_SCOPE_INVALID',
      path: 'userId',
    });

    resetRuntimeProduction(changedUserBootstrap);
    const originalRequest = requestFor('original');
    const changedRequestResolver = vi.fn<RuntimeProductionScopeResolver>(async (_, auth) => ({
      request: requestFor('forged'),
      serverDB: auth.serverDB,
      sessionId: 'session',
      userId: auth.userId,
    }));
    const changedRequestBootstrap = initializeRuntimeProduction({
      facadeFactory,
      scopeResolver: changedRequestResolver,
    });

    await expect(
      changedRequestBootstrap.factory(routeScopeFor('user-a', originalRequest)),
    ).rejects.toMatchObject({
      code: 'RUNTIME_PRODUCTION_SCOPE_INVALID',
      path: 'request',
    });
  });

  it('rejects a missing optional port without invoking the facade factory', async () => {
    const facadeFactory = vi.fn<RuntimeProductionFacadeFactory>(async () => facade);
    const persistencePortFactory = vi.fn(async () => undefined as never);
    const bootstrap = initializeRuntimeProduction(
      optionsFor({ facadeFactory, persistencePortFactory }),
    );

    await expect(bootstrap.factory(routeScopeFor())).rejects.toMatchObject({
      code: 'RUNTIME_PRODUCTION_DEPENDENCY_MISSING',
      path: 'persistencePort',
    });
    expect(facadeFactory).not.toHaveBeenCalled();
  });

  it('injects the C-98 image port and C-100 capability through the authenticated scope', async () => {
    const fetcher = vi.fn();
    const assetSink = vi.fn();
    const assetStore = { put: vi.fn() } as unknown as PresentationAssetStore;
    const eventPublisherFactory = vi.fn();
    const journalLoader = vi.fn(
      async (scope: { userId: string; sessionId: string }) =>
        new PresentationJobEventJournal({ scope }),
    );
    let receivedScope: Parameters<RuntimeProductionFacadeFactory>[0] | undefined;
    const facadeFactory = vi.fn<RuntimeProductionFacadeFactory>(async (scope) => {
      receivedScope = scope;
      return facade;
    });

    const bootstrap = initializeRuntimeProduction({
      facadeFactory,
      imageGeneration: {
        assetSink,
        assetStore,
        env: {
          OPENAI_API_KEY: 'injected-test-credential',
          OPENAI_BASE_URL: 'https://images.example.test',
        },
        eventPublisherFactory,
        fetcher,
        journalLoader,
        now: () => '2026-09-01T00:00:00.000Z',
      },
      scopeResolver: defaultScopeResolver,
    });

    await expect(bootstrap.factory(routeScopeFor('image-user'))).resolves.toBe(facade);
    expect(receivedScope?.dependencies.imageGenerationPort).toMatchObject({
      providerId: 'openai.image',
    });
    expect(receivedScope?.dependencies.imageGenerationCapability).toBeDefined();
    expect(receivedScope?.dependencies.presentationComposition).toBeDefined();
    expect(fetcher).not.toHaveBeenCalled();
    expect(assetSink).not.toHaveBeenCalled();
    expect(eventPublisherFactory).not.toHaveBeenCalled();
    expect(journalLoader).not.toHaveBeenCalled();
  });

  it('keeps a complete image capability available without inventing a journal seam', async () => {
    const imageGenerationAssetStore = { put: vi.fn() } as unknown as PresentationAssetStore;
    const imageGenerationEventPublisherFactory = vi.fn();
    let receivedScope: Parameters<RuntimeProductionFacadeFactory>[0] | undefined;
    const facadeFactory = vi.fn<RuntimeProductionFacadeFactory>(async (scope) => {
      receivedScope = scope;
      return facade;
    });
    const bootstrap = initializeRuntimeProduction({
      facadeFactory,
      imageGeneration: {
        assetStore: imageGenerationAssetStore,
        env: {
          OPENAI_API_KEY: 'injected-test-credential',
          OPENAI_BASE_URL: 'https://images.example.test/v1',
        },
        eventPublisherFactory: imageGenerationEventPublisherFactory,
        fetcher: vi.fn(),
      },
      scopeResolver: defaultScopeResolver,
    });

    await bootstrap.factory(routeScopeFor('image-direct'));

    expect(receivedScope?.dependencies.imageGenerationCapability).toBeDefined();
    expect(receivedScope?.dependencies.presentationComposition).toBeUndefined();
    expect(receivedScope?.dependencies.imageGenerationPort).toBeDefined();
  });

  it('fails closed on missing image configuration before installing a provider', () => {
    expect(() =>
      initializeRuntimeProduction({
        facadeFactory: defaultFacadeFactory,
        imageGeneration: { env: {}, fetcher: vi.fn() },
        scopeResolver: defaultScopeResolver,
      }),
    ).toThrowError(expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE' }));
    expect(getRuntimeProductionAudit()).toBeUndefined();
  });

  it('does not create a capability for partial C-100 image dependencies', async () => {
    let receivedScope: Parameters<RuntimeProductionFacadeFactory>[0] | undefined;
    const facadeFactory = vi.fn<RuntimeProductionFacadeFactory>(async (scope) => {
      receivedScope = scope;
      return facade;
    });
    const bootstrap = initializeRuntimeProduction({
      facadeFactory,
      imageGeneration: {
        env: {
          OPENAI_API_KEY: 'injected-test-credential',
          OPENAI_BASE_URL: 'https://images.example.test',
        },
        fetcher: vi.fn(),
      },
      scopeResolver: defaultScopeResolver,
    });

    await bootstrap.factory(routeScopeFor('image-partial'));

    expect(receivedScope?.dependencies.imageGenerationPort).toBeDefined();
    expect(receivedScope?.dependencies.imageGenerationCapability).toBeUndefined();
  });

  it('keeps concurrent requests isolated and does not cache user state in the module', async () => {
    const scopes: RuntimeProductionScope[] = [];
    const scopeResolver = vi.fn<RuntimeProductionScopeResolver>(async (request, auth) => ({
      request,
      serverDB: auth.serverDB,
      sessionId: request.url.endsWith('/a') ? 'session-a' : 'session-b',
      userId: auth.userId,
    }));
    const facadeFactory = vi.fn<RuntimeProductionFacadeFactory>(async (scope) => {
      scopes.push(scope);
      await Promise.resolve();
      return facade;
    });
    const bootstrap = initializeRuntimeProduction({ facadeFactory, scopeResolver });
    const requestA = requestFor('a');
    const requestB = requestFor('b');

    await Promise.all([
      bootstrap.factory(routeScopeFor('user-a', requestA)),
      bootstrap.factory(routeScopeFor('user-b', requestB)),
    ]);

    expect(scopes).toHaveLength(2);
    expect(scopes.map(({ userId, sessionId }) => `${userId}:${sessionId}`)).toEqual([
      'user-a:session-a',
      'user-b:session-b',
    ]);
    expect(scopes[0]).not.toBe(scopes[1]);
  });

  it('resets idempotently and an older bootstrap cannot clear a replacement', () => {
    const first = initializeRuntimeProduction(optionsFor({ now: () => 'first' }));
    const second = initializeRuntimeProduction(optionsFor({ now: () => 'second' }));

    first.reset();
    expect(getRuntimeFacadeFactory()).toBe(second.factory);
    expect(getRuntimeProductionAudit()).toBe(second.audit);

    second.reset();
    second.reset();
    expect(getRuntimeProductionAudit()).toBeUndefined();
    expect(() => getRuntimeFacadeFactory()(routeScopeFor())).toThrowError(
      expect.objectContaining({ code: 'RUNTIME_FACADE_UNAVAILABLE' }),
    );
  });

  it('injects GLM multimodal chat port through authenticated scope dependencies', async () => {
    let capturedDependencies: any;
    const facadeFactory = vi.fn<RuntimeProductionFacadeFactory>(async (scope) => {
      capturedDependencies = scope.dependencies;
      return facade;
    });

    const bootstrap = initializeRuntimeProduction({
      facadeFactory,
      multimodalChat: {
        env: {
          BAI_API_KEY: 'test-key',
          BAI_BASE_URL: 'https://api.b.ai',
          BAI_CHAT_MODEL: 'glm-5.3-flash',
        },
        fetcher: vi.fn(async () => ({
          json: async () => ({ choices: [] }),
          ok: true,
          status: 200,
        })),
        model: 'glm-custom-override',
      },
      scopeResolver: defaultScopeResolver,
    });

    await bootstrap.factory(routeScopeFor('user-1'));

    expect(capturedDependencies?.multimodalChatPort).toBeDefined();
    expect(capturedDependencies.multimodalChatPort.manifest.model).toBe('glm-custom-override');
    expect(capturedDependencies.multimodalChatPort.manifest.supportsVision).toBe(true);
  });

  it('fails closed when multimodalChat has missing fetcher or invalid object', () => {
    expect(() =>
      initializeRuntimeProduction({
        facadeFactory: vi.fn(),
        multimodalChat: 'invalid' as any,
        scopeResolver: defaultScopeResolver,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'RUNTIME_PRODUCTION_OPTIONS_INVALID',
        path: 'multimodalChat',
      }),
    );

    expect(() =>
      initializeRuntimeProduction({
        facadeFactory: vi.fn(),
        multimodalChat: {
          env: { BAI_API_KEY: 'key' },
        } as any,
        scopeResolver: defaultScopeResolver,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'RUNTIME_PRODUCTION_DEPENDENCY_MISSING',
        path: 'multimodalChat.fetcher',
      }),
    );
  });

  it('fails closed with PROVIDER_UNAVAILABLE when multimodalChat is missing API key', () => {
    expect(() =>
      initializeRuntimeProduction({
        facadeFactory: vi.fn(),
        multimodalChat: {
          env: {},
          fetcher: vi.fn(),
        },
        scopeResolver: defaultScopeResolver,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'PROVIDER_UNAVAILABLE',
      }),
    );
  });
});
