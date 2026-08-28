import type {
  AgentProfileProjection,
  PersistedPluginDescriptor,
  PersistencePort,
  RuntimePluginInstallation,
  RuntimePluginInstallationInput,
  RuntimePluginInstallationPatch,
  RuntimeRunInput,
  RuntimeRunPatch,
  RuntimeRunRecord,
} from '../../../../packages/cordis-kernel/src/persistence';
import type { RuntimeEvent, StartRunInput } from '../../../../packages/cordis-kernel/src/run';

export interface RuntimeScope {
  readonly sessionId: string;
  readonly userId: string;
}

export interface RuntimeFacade {
  handle: (input: unknown) => Promise<unknown> | unknown;
}

export type ScopeErrorCode = 'SCOPE_INVALID' | 'SCOPE_ACCESS_DENIED';

export class ScopeAccessError extends Error {
  constructor(
    public readonly code: ScopeErrorCode,
    message: string,
    public readonly path?: string,
  ) {
    super(message);
    this.name = 'ScopeAccessError';
  }
}

export { ScopeAccessError as RuntimeScopeError };

type ResourceKind = 'run' | 'plugin' | 'profile';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const requireScopeValue = (value: unknown, path: 'userId' | 'sessionId'): string => {
  if (!nonEmptyString(value)) {
    throw new ScopeAccessError('SCOPE_INVALID', `${path} must be a non-empty string`, path);
  }
  return value;
};

const normalizeScope = (scope: RuntimeScope): RuntimeScope => ({
  userId: requireScopeValue(scope?.userId, 'userId'),
  sessionId: requireScopeValue(scope?.sessionId, 'sessionId'),
});

const requireId = (value: unknown, path: string): string => {
  if (!nonEmptyString(value)) {
    throw new ScopeAccessError('SCOPE_INVALID', `${path} must be a non-empty string`, path);
  }
  return value;
};

const assertSameScopeValue = (
  value: unknown,
  expected: string,
  path: 'userId' | 'sessionId' | 'event.session_id',
): void => {
  if (value !== expected) {
    throw new ScopeAccessError(
      'SCOPE_ACCESS_DENIED',
      `${path} does not belong to the authenticated runtime scope`,
      path,
    );
  }
};

const scopeKeyFor = (scope: RuntimeScope): string =>
  JSON.stringify([scope.userId, scope.sessionId]);

const encode = (value: string): string => encodeURIComponent(value);

class ScopeNamespace {
  readonly key: string;
  readonly prefix: string;

  constructor(readonly scope: RuntimeScope) {
    this.key = scopeKeyFor(scope);
    this.prefix = `runtime-scope:${encode(scope.userId)}:${encode(scope.sessionId)}:`;
  }

  id(kind: ResourceKind, value: string): string {
    return `${this.prefix}${kind}:${encode(value)}`;
  }

  external(kind: ResourceKind, value: string): string | undefined {
    const marker = `${this.prefix}${kind}:`;
    if (!value.startsWith(marker)) return;
    try {
      return decodeURIComponent(value.slice(marker.length));
    } catch {
      throw new ScopeAccessError(
        'SCOPE_ACCESS_DENIED',
        `Stored ${kind} identifier is not valid for the authenticated runtime scope`,
        `${kind}Id`,
      );
    }
  }
}

export class ScopeOwnershipRegistry {
  private readonly owners = new Map<string, string>();

  claim(kind: ResourceKind, id: string, scopeKey: string): void {
    const key = `${kind}:${id}`;
    const owner = this.owners.get(key);
    if (owner && owner !== scopeKey) {
      throw new ScopeAccessError(
        'SCOPE_ACCESS_DENIED',
        `${kind} ${id} belongs to another runtime scope`,
        `${kind}Id`,
      );
    }
    this.owners.set(key, scopeKey);
  }

  assert(kind: ResourceKind, id: string, scopeKey: string, path = `${kind}Id`): void {
    const owner = this.owners.get(`${kind}:${id}`);
    if (owner && owner !== scopeKey) {
      throw new ScopeAccessError(
        'SCOPE_ACCESS_DENIED',
        `${kind} ${id} belongs to another runtime scope`,
        path,
      );
    }
  }

  assertFamily(kind: ResourceKind, id: string, scopeKey: string, path = `${kind}Id`): void {
    const prefix = `${kind}:${id}`;
    for (const [key, owner] of this.owners) {
      if ((key === prefix || key.startsWith(`${prefix}@`)) && owner !== scopeKey) {
        throw new ScopeAccessError(
          'SCOPE_ACCESS_DENIED',
          `${kind} ${id} belongs to another runtime scope`,
          path,
        );
      }
    }
  }

  release(kind: ResourceKind, id: string, scopeKey: string): void {
    const key = `${kind}:${id}`;
    if (this.owners.get(key) === scopeKey) this.owners.delete(key);
  }

  releaseFamily(kind: ResourceKind, prefix: string, scopeKey: string): void {
    for (const [key, owner] of this.owners) {
      if (owner === scopeKey && key.startsWith(`${kind}:${prefix}`)) this.owners.delete(key);
    }
  }
}

const sharedOwnership = new WeakMap<object, ScopeOwnershipRegistry>();

const ownershipFor = (persistence: PersistencePort): ScopeOwnershipRegistry => {
  const existing = sharedOwnership.get(persistence);
  if (existing) return existing;
  const created = new ScopeOwnershipRegistry();
  sharedOwnership.set(persistence, created);
  return created;
};

export interface ScopedPersistencePort extends PersistencePort {
  readonly scope: RuntimeScope;
}

const externalRun = (
  namespace: ScopeNamespace,
  scopeKey: string,
  ownership: ScopeOwnershipRegistry,
  value: RuntimeRunRecord,
): RuntimeRunRecord => {
  assertSameScopeValue(value.sessionId, namespace.scope.sessionId, 'sessionId');
  const runId = namespace.external('run', value.runId);
  if (!runId) {
    throw new ScopeAccessError(
      'SCOPE_ACCESS_DENIED',
      `Run ${value.runId} is outside the authenticated runtime scope`,
      'runId',
    );
  }
  ownership.claim('run', runId, scopeKey);
  const parentRunId = value.parentRunId
    ? (namespace.external('run', value.parentRunId) ??
      (() => {
        throw new ScopeAccessError(
          'SCOPE_ACCESS_DENIED',
          `Parent run ${value.parentRunId} is outside the authenticated runtime scope`,
          'parentRunId',
        );
      })())
    : undefined;
  return { ...value, runId, parentRunId };
};

const externalEvent = (
  namespace: ScopeNamespace,
  scopeKey: string,
  ownership: ScopeOwnershipRegistry,
  value: RuntimeEvent,
): RuntimeEvent => {
  assertSameScopeValue(value.session_id, namespace.scope.sessionId, 'event.session_id');
  const runId = value.run_id ? namespace.external('run', value.run_id) : undefined;
  if (value.run_id && !runId) {
    throw new ScopeAccessError(
      'SCOPE_ACCESS_DENIED',
      `Event run ${value.run_id} is outside the authenticated runtime scope`,
      'event.run_id',
    );
  }
  if (runId) ownership.claim('run', runId, scopeKey);
  return { ...value, run_id: runId };
};

const internalDescriptor = (
  namespace: ScopeNamespace,
  descriptor?: PersistedPluginDescriptor,
): PersistedPluginDescriptor | undefined =>
  descriptor
    ? { ...descriptor, id: namespace.id('plugin', requireId(descriptor.id, 'descriptor.id')) }
    : undefined;

const externalDescriptor = (
  namespace: ScopeNamespace,
  value: PersistedPluginDescriptor | undefined,
): PersistedPluginDescriptor | undefined => {
  if (!value) return;
  const id = namespace.external('plugin', value.id);
  if (!id) {
    throw new ScopeAccessError(
      'SCOPE_ACCESS_DENIED',
      `Plugin descriptor ${value.id} is outside the authenticated runtime scope`,
      'descriptor.id',
    );
  }
  return { ...value, id };
};

const externalInstallation = (
  namespace: ScopeNamespace,
  scopeKey: string,
  ownership: ScopeOwnershipRegistry,
  value: RuntimePluginInstallation,
): RuntimePluginInstallation => {
  const id = namespace.external('plugin', value.id);
  if (!id) {
    throw new ScopeAccessError(
      'SCOPE_ACCESS_DENIED',
      `Plugin installation ${value.id} is outside the authenticated runtime scope`,
      'id',
    );
  }
  ownership.claim('plugin', `${id}@${value.version}`, scopeKey);
  return { ...value, id, descriptor: externalDescriptor(namespace, value.descriptor) };
};

const internalInstallation = (
  namespace: ScopeNamespace,
  scopeKey: string,
  ownership: ScopeOwnershipRegistry,
  value: RuntimePluginInstallationInput,
): RuntimePluginInstallationInput => {
  const id = requireId(value.id, 'id');
  const version = requireId(value.version, 'version');
  ownership.claim('plugin', `${id}@${version}`, scopeKey);
  return {
    ...value,
    id: namespace.id('plugin', id),
    version,
    descriptor: internalDescriptor(namespace, value.descriptor),
  };
};

const internalInstallationPatch = (
  namespace: ScopeNamespace,
  patch: RuntimePluginInstallationPatch,
): RuntimePluginInstallationPatch => ({
  ...patch,
  ...(patch.descriptor === undefined
    ? {}
    : { descriptor: internalDescriptor(namespace, patch.descriptor) }),
});

export class ScopedPersistence implements ScopedPersistencePort {
  readonly scope: RuntimeScope;

  private readonly namespace: ScopeNamespace;
  private readonly scopeKey: string;
  private readonly ownership: ScopeOwnershipRegistry;

  constructor(
    private readonly base: PersistencePort,
    scope: RuntimeScope,
    ownership: ScopeOwnershipRegistry = ownershipFor(base),
  ) {
    this.scope = normalizeScope(scope);
    this.namespace = new ScopeNamespace(this.scope);
    this.scopeKey = this.namespace.key;
    this.ownership = ownership;
  }

  async createRun(input: RuntimeRunInput): Promise<RuntimeRunRecord>;
  async createRun(runId: string, input: StartRunInput): Promise<RuntimeRunRecord>;
  async createRun(
    inputOrRunId: RuntimeRunInput | string,
    startInput?: StartRunInput,
  ): Promise<RuntimeRunRecord> {
    const input: RuntimeRunInput =
      typeof inputOrRunId === 'string'
        ? {
            runId: inputOrRunId,
            sessionId: startInput?.sessionId ?? '',
            profileId: startInput?.profileId,
            strategyPluginId: startInput?.strategyPluginId,
            parentRunId: startInput?.parentRunId,
            metadata: startInput?.metadata,
          }
        : inputOrRunId;
    const runId = requireId(input.runId, 'runId');
    assertSameScopeValue(input.sessionId, this.scope.sessionId, 'sessionId');
    this.ownership.claim('run', runId, this.scopeKey);
    const stored = await this.base.createRun({
      ...input,
      runId: this.namespace.id('run', runId),
      sessionId: this.scope.sessionId,
      parentRunId: this.internalParentRunId(input.parentRunId),
    });
    return externalRun(this.namespace, this.scopeKey, this.ownership, stored);
  }

  async getRun(runId: string): Promise<RuntimeRunRecord | null> {
    const id = requireId(runId, 'runId');
    this.ownership.assert('run', id, this.scopeKey);
    const stored = await this.base.getRun(this.namespace.id('run', id));
    return stored ? externalRun(this.namespace, this.scopeKey, this.ownership, stored) : null;
  }

  async listRuns(): Promise<RuntimeRunRecord[]> {
    const stored = await this.base.listRuns();
    return stored
      .map((value) => {
        const id = this.namespace.external('run', value.runId);
        return id ? externalRun(this.namespace, this.scopeKey, this.ownership, value) : null;
      })
      .filter((value): value is RuntimeRunRecord => value !== null);
  }

  async updateRun(runId: string, patch: RuntimeRunPatch): Promise<RuntimeRunRecord> {
    const id = requireId(runId, 'runId');
    this.ownership.assert('run', id, this.scopeKey);
    const stored = await this.base.updateRun(this.namespace.id('run', id), {
      ...patch,
      parentRunId: this.internalParentRunId(patch.parentRunId),
    });
    return externalRun(this.namespace, this.scopeKey, this.ownership, stored);
  }

  async deleteRun(runId: string): Promise<boolean> {
    const id = requireId(runId, 'runId');
    this.ownership.assert('run', id, this.scopeKey);
    const deleted = await this.base.deleteRun(this.namespace.id('run', id));
    if (deleted) this.ownership.release('run', id, this.scopeKey);
    return deleted;
  }

  async appendRunEvent(runId: string, event: RuntimeEvent): Promise<RuntimeEvent> {
    const id = requireId(runId, 'runId');
    this.ownership.claim('run', id, this.scopeKey);
    assertSameScopeValue(event.session_id, this.scope.sessionId, 'event.session_id');
    if (event.run_id !== undefined && event.run_id !== id) {
      throw new ScopeAccessError(
        'SCOPE_ACCESS_DENIED',
        'event.run_id must match the scoped runId',
        'event.run_id',
      );
    }
    const stored = await this.base.appendRunEvent(this.namespace.id('run', id), {
      ...event,
      session_id: this.scope.sessionId,
      run_id: this.namespace.id('run', id),
    });
    return externalEvent(this.namespace, this.scopeKey, this.ownership, stored);
  }

  async getRunEvent(runId: string, seq: number): Promise<RuntimeEvent | null> {
    const id = requireId(runId, 'runId');
    this.ownership.assert('run', id, this.scopeKey);
    const stored = await this.base.getRunEvent(this.namespace.id('run', id), seq);
    return stored ? externalEvent(this.namespace, this.scopeKey, this.ownership, stored) : null;
  }

  async replayRunEvents(runId: string, afterSeq?: number): Promise<RuntimeEvent[]> {
    const id = requireId(runId, 'runId');
    this.ownership.assert('run', id, this.scopeKey);
    const stored = await this.base.replayRunEvents(this.namespace.id('run', id), afterSeq);
    return stored.map((value) =>
      externalEvent(this.namespace, this.scopeKey, this.ownership, value),
    );
  }

  async deleteRunEvents(runId: string): Promise<number> {
    const id = requireId(runId, 'runId');
    this.ownership.assert('run', id, this.scopeKey);
    return this.base.deleteRunEvents(this.namespace.id('run', id));
  }

  async createPluginInstallation(
    input: RuntimePluginInstallationInput,
  ): Promise<RuntimePluginInstallation> {
    const internal = internalInstallation(this.namespace, this.scopeKey, this.ownership, input);
    const stored = await this.base.createPluginInstallation(internal);
    return externalInstallation(this.namespace, this.scopeKey, this.ownership, stored);
  }

  async getPluginInstallation(
    id: string,
    version?: string,
  ): Promise<RuntimePluginInstallation | null> {
    const externalId = requireId(id, 'id');
    if (version !== undefined) {
      const normalizedVersion = requireId(version, 'version');
      this.ownership.assert('plugin', `${externalId}@${normalizedVersion}`, this.scopeKey);
      const stored = await this.base.getPluginInstallation(
        this.namespace.id('plugin', externalId),
        normalizedVersion,
      );
      return stored
        ? externalInstallation(this.namespace, this.scopeKey, this.ownership, stored)
        : null;
    }
    this.ownership.assertFamily('plugin', externalId, this.scopeKey);
    const stored = await this.base.getPluginInstallation(this.namespace.id('plugin', externalId));
    return stored
      ? externalInstallation(this.namespace, this.scopeKey, this.ownership, stored)
      : null;
  }

  async listPluginInstallations(): Promise<RuntimePluginInstallation[]> {
    const stored = await this.base.listPluginInstallations();
    return stored
      .map((value) => {
        const id = this.namespace.external('plugin', value.id);
        return id
          ? externalInstallation(this.namespace, this.scopeKey, this.ownership, value)
          : null;
      })
      .filter((value): value is RuntimePluginInstallation => value !== null);
  }

  async updatePluginInstallation(
    id: string,
    version: string,
    patch: RuntimePluginInstallationPatch,
  ): Promise<RuntimePluginInstallation> {
    const externalId = requireId(id, 'id');
    const normalizedVersion = requireId(version, 'version');
    this.ownership.assert('plugin', `${externalId}@${normalizedVersion}`, this.scopeKey);
    const stored = await this.base.updatePluginInstallation(
      this.namespace.id('plugin', externalId),
      normalizedVersion,
      internalInstallationPatch(this.namespace, patch),
    );
    return externalInstallation(this.namespace, this.scopeKey, this.ownership, stored);
  }

  async deletePluginInstallation(id: string, version?: string): Promise<boolean> {
    const externalId = requireId(id, 'id');
    if (version !== undefined) {
      const normalizedVersion = requireId(version, 'version');
      this.ownership.assert('plugin', `${externalId}@${normalizedVersion}`, this.scopeKey);
      const deleted = await this.base.deletePluginInstallation(
        this.namespace.id('plugin', externalId),
        normalizedVersion,
      );
      if (deleted)
        this.ownership.release('plugin', `${externalId}@${normalizedVersion}`, this.scopeKey);
      return deleted;
    }
    this.ownership.assertFamily('plugin', externalId, this.scopeKey);
    const installations = await this.listPluginInstallations();
    const deleted = await this.base.deletePluginInstallation(
      this.namespace.id('plugin', externalId),
    );
    if (deleted) {
      for (const installation of installations) {
        this.ownership.release('plugin', `${externalId}@${installation.version}`, this.scopeKey);
      }
    }
    return deleted;
  }

  async putAgentProfile(profile: AgentProfileProjection): Promise<AgentProfileProjection> {
    const id = requireId(profile.id, 'profile.id');
    this.ownership.claim('profile', id, this.scopeKey);
    const stored = await this.base.putAgentProfile({
      ...profile,
      id: this.namespace.id('profile', id),
    });
    return this.externalProfile(stored);
  }

  async getAgentProfile(profileId: string): Promise<AgentProfileProjection | null> {
    const id = requireId(profileId, 'profileId');
    this.ownership.assert('profile', id, this.scopeKey);
    const stored = await this.base.getAgentProfile(this.namespace.id('profile', id));
    return stored ? this.externalProfile(stored) : null;
  }

  async listAgentProfiles(): Promise<AgentProfileProjection[]> {
    const stored = await this.base.listAgentProfiles();
    return stored
      .map((value) => {
        const id = this.namespace.external('profile', value.id);
        return id ? this.externalProfile(value) : null;
      })
      .filter((value): value is AgentProfileProjection => value !== null);
  }

  async deleteAgentProfile(profileId: string): Promise<boolean> {
    const id = requireId(profileId, 'profileId');
    this.ownership.assert('profile', id, this.scopeKey);
    const deleted = await this.base.deleteAgentProfile(this.namespace.id('profile', id));
    if (deleted) this.ownership.release('profile', id, this.scopeKey);
    return deleted;
  }

  private internalParentRunId(parentRunId: string | undefined): string | undefined {
    if (parentRunId === undefined) return;
    const id = requireId(parentRunId, 'parentRunId');
    this.ownership.assert('run', id, this.scopeKey, 'parentRunId');
    return this.namespace.id('run', id);
  }

  private externalProfile(value: AgentProfileProjection): AgentProfileProjection {
    const id = this.namespace.external('profile', value.id);
    if (!id) {
      throw new ScopeAccessError(
        'SCOPE_ACCESS_DENIED',
        `Agent profile ${value.id} is outside the authenticated runtime scope`,
        'profileId',
      );
    }
    this.ownership.claim('profile', id, this.scopeKey);
    return { ...value, id };
  }
}

export interface ScopedRuntimeBridge {
  readonly facade: RuntimeFacade;
  readonly persistence: ScopedPersistencePort;
  readonly persistencePort: ScopedPersistencePort;
  readonly runtimeFacade: RuntimeFacade;
  readonly scope: RuntimeScope;
}

export interface ScopedRuntimeBridgeOptions {
  readonly facade?: RuntimeFacade;
  readonly facadeFactory?: (
    scope: RuntimeScope,
    persistence: ScopedPersistencePort,
  ) => RuntimeFacade;
  readonly ownership?: ScopeOwnershipRegistry;
  readonly persistence: PersistencePort;
  readonly scope: RuntimeScope;
}

const scopeValueFrom = (value: unknown, key: 'userId' | 'sessionId'): unknown =>
  isRecord(value) ? value[key] : undefined;

const assertEnvelopeScope = (value: unknown, scope: RuntimeScope): void => {
  if (!isRecord(value)) return;
  const payload = isRecord(value.payload) ? value.payload : undefined;
  const targets = [value, payload, payload && isRecord(payload.input) ? payload.input : undefined];
  for (const target of targets) {
    if (!target) continue;
    const userId = scopeValueFrom(target, 'userId');
    const sessionId = scopeValueFrom(target, 'sessionId');
    if (userId !== undefined) assertSameScopeValue(userId, scope.userId, 'userId');
    if (sessionId !== undefined) assertSameScopeValue(sessionId, scope.sessionId, 'sessionId');
  }
};

const boundEnvelope = (value: unknown, scope: RuntimeScope): unknown => {
  if (!isRecord(value) || !isRecord(value.payload)) return value;

  assertEnvelopeScope(value, scope);
  const payload = { ...value.payload };
  const nestedInput = isRecord(payload.input) ? { ...payload.input } : undefined;
  const bindTarget = (target: Record<string, unknown>): void => {
    if (target.userId === undefined) target.userId = scope.userId;
    if (target.sessionId === undefined) target.sessionId = scope.sessionId;
  };

  bindTarget(payload);
  if (nestedInput) {
    bindTarget(nestedInput);
    payload.input = nestedInput;
  }
  return { ...value, payload };
};

const bindFacade = (facade: RuntimeFacade, scope: RuntimeScope): RuntimeFacade => ({
  async handle(input: unknown): Promise<unknown> {
    if (typeof input === 'string') {
      try {
        return facade.handle(boundEnvelope(JSON.parse(input) as unknown, scope));
      } catch (error) {
        if (error instanceof SyntaxError) return facade.handle(input);
        throw error;
      }
    }
    return facade.handle(boundEnvelope(input, scope));
  },
});

export const createScopedRuntimeFacade = (
  facade: RuntimeFacade,
  scope: RuntimeScope,
): RuntimeFacade => bindFacade(facade, normalizeScope(scope));

export const createScopedRuntimeBridge = (
  options: ScopedRuntimeBridgeOptions,
): ScopedRuntimeBridge => {
  const scope = normalizeScope(options.scope);
  const persistence = new ScopedPersistence(
    options.persistence,
    scope,
    options.ownership ?? ownershipFor(options.persistence),
  );
  if (options.facade && options.facadeFactory) {
    throw new ScopeAccessError(
      'SCOPE_INVALID',
      'Provide either facade or facadeFactory, not both',
      'facade',
    );
  }
  const facade = options.facadeFactory?.(scope, persistence) ?? options.facade;
  if (!facade) {
    throw new ScopeAccessError('SCOPE_INVALID', 'A RuntimeFacade is required', 'facade');
  }
  const boundFacade = createScopedRuntimeFacade(facade, scope);
  return {
    scope,
    persistence,
    persistencePort: persistence,
    facade: boundFacade,
    runtimeFacade: boundFacade,
  };
};

export interface ScopedRuntimeFactoryOptions {
  readonly facadeFactory: (
    scope: RuntimeScope,
    persistence: ScopedPersistencePort,
  ) => RuntimeFacade;
  readonly ownership?: ScopeOwnershipRegistry;
  readonly persistence: PersistencePort;
}

export type ScopedRuntimeFactory = (scope: RuntimeScope) => ScopedRuntimeBridge;

export const createScopedRuntimeFactory = (
  options: ScopedRuntimeFactoryOptions,
): ScopedRuntimeFactory => {
  const ownership = options.ownership ?? ownershipFor(options.persistence);
  return (scope) =>
    createScopedRuntimeBridge({
      scope,
      persistence: options.persistence,
      ownership,
      facadeFactory: options.facadeFactory,
    });
};

export const createScopedPersistencePort = (
  persistence: PersistencePort,
  scope: RuntimeScope,
  ownership?: ScopeOwnershipRegistry,
): ScopedPersistencePort => new ScopedPersistence(persistence, scope, ownership);

export const bindRuntimeScope = createScopedRuntimeBridge;
