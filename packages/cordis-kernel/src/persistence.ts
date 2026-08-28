import type { PluginDescriptor, PluginRuntimeState } from './manager';
import type { AgentProfile } from './profile';
import {
  RUN_STATES,
  type RunError,
  type RunSnapshot,
  type RunState,
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeEvent,
  type StartRunInput,
} from './run';
import type { PermissionManifest, RuntimePluginKind } from './types';

export const PERSISTENCE_TABLES = [
  'runtime_runs',
  'runtime_run_events',
  'runtime_plugin_installations',
] as const;

export type PersistenceTable = (typeof PERSISTENCE_TABLES)[number];

export type PersistenceErrorCode =
  | 'PERSISTENCE_NOT_FOUND'
  | 'PERSISTENCE_DUPLICATE'
  | 'PERSISTENCE_INVALID'
  | 'EVENT_SEQ_INVALID';

export class PersistenceError extends Error {
  constructor(
    public readonly code: PersistenceErrorCode,
    message: string,
    public readonly table?: PersistenceTable,
    public readonly key?: string,
    public readonly path?: string,
  ) {
    super(message);
    this.name = 'PersistenceError';
  }
}

export interface RuntimeRunInput {
  readonly createdAt?: string;
  readonly error?: RunError;
  readonly metadata?: Record<string, unknown>;
  readonly parentRunId?: string;
  readonly profileId?: string;
  readonly result?: unknown;
  readonly runId: string;
  readonly sessionId: string;
  readonly state?: RunState;
  readonly strategyPluginId?: string;
  readonly updatedAt?: string;
}

export type RuntimeRunRecord = RunSnapshot;

export interface RuntimeRunPatch {
  readonly error?: RunError;
  readonly metadata?: Record<string, unknown>;
  readonly parentRunId?: string;
  readonly profileId?: string;
  readonly result?: unknown;
  readonly state?: RunState;
  readonly strategyPluginId?: string;
  readonly updatedAt?: string;
}

export type PluginInstallationSource =
  | 'builtin'
  | 'mcp-http'
  | 'mcp-stdio'
  | 'remote-adapter'
  | 'worker';

export interface PersistedPluginDescriptor extends PluginDescriptor {
  readonly description?: string;
  readonly name?: string;
  readonly source?: PluginInstallationSource;
}

export interface RuntimePluginInstallationInput {
  readonly createdAt?: string;
  readonly description?: string;
  readonly descriptor?: PersistedPluginDescriptor;
  readonly id: string;
  readonly inject?: string[];
  readonly kind?: RuntimePluginKind;
  readonly metadata?: Record<string, unknown>;
  readonly name?: string;
  readonly permissions?: PermissionManifest;
  readonly source?: PluginInstallationSource;
  readonly state?: PluginRuntimeState;
  readonly updatedAt?: string;
  readonly version: string;
}

export interface RuntimePluginInstallation extends RuntimePluginInstallationInput {
  readonly createdAt: string;
  readonly state: PluginRuntimeState;
  readonly updatedAt: string;
}

export type RuntimePluginInstallationPatch = Partial<
  Omit<RuntimePluginInstallation, 'id' | 'version' | 'createdAt'>
>;

export type AgentProfileProjection = AgentProfile;

export interface PersistenceOptions {
  readonly now?: () => string;
}

export interface PersistencePort {
  appendRunEvent: (runId: string, event: RuntimeEvent) => Promise<RuntimeEvent>;
  createPluginInstallation: (
    input: RuntimePluginInstallationInput,
  ) => Promise<RuntimePluginInstallation>;
  createRun: ((input: RuntimeRunInput) => Promise<RuntimeRunRecord>) &
    ((runId: string, input: StartRunInput) => Promise<RuntimeRunRecord>);
  deleteAgentProfile: (profileId: string) => Promise<boolean>;
  deletePluginInstallation: (id: string, version?: string) => Promise<boolean>;

  deleteRun: (runId: string) => Promise<boolean>;
  deleteRunEvents: (runId: string) => Promise<number>;
  getAgentProfile: (profileId: string) => Promise<AgentProfileProjection | null>;
  getPluginInstallation: (
    id: string,
    version?: string,
  ) => Promise<RuntimePluginInstallation | null>;

  getRun: (runId: string) => Promise<RuntimeRunRecord | null>;
  getRunEvent: (runId: string, seq: number) => Promise<RuntimeEvent | null>;
  listAgentProfiles: () => Promise<AgentProfileProjection[]>;
  listPluginInstallations: () => Promise<RuntimePluginInstallation[]>;
  listRuns: () => Promise<RuntimeRunRecord[]>;

  putAgentProfile: (profile: AgentProfileProjection) => Promise<AgentProfileProjection>;
  replayRunEvents: (runId: string, afterSeq?: number) => Promise<RuntimeEvent[]>;
  updatePluginInstallation: (
    id: string,
    version: string,
    patch: RuntimePluginInstallationPatch,
  ) => Promise<RuntimePluginInstallation>;
  updateRun: (runId: string, patch: RuntimeRunPatch) => Promise<RuntimeRunRecord>;
}

const isRunState = (value: unknown): value is RunState =>
  typeof value === 'string' && (RUN_STATES as readonly string[]).includes(value);

const isPluginState = (value: unknown): value is PluginRuntimeState =>
  value === 'installed' ||
  value === 'pending' ||
  value === 'active' ||
  value === 'failed' ||
  value === 'unloading' ||
  value === 'disabled';

const requireNonEmpty = (value: unknown, path: string): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new PersistenceError(
      'PERSISTENCE_INVALID',
      'must be a non-empty string',
      undefined,
      undefined,
      path,
    );
  }
  return value;
};

const cloneError = (error?: RunError): RunError | undefined => (error ? { ...error } : undefined);

const clonePermissions = (permissions?: PermissionManifest): PermissionManifest | undefined => {
  if (!permissions) return undefined;
  return {
    network: permissions.network ? [...permissions.network] : undefined,
    filesystem: permissions.filesystem ? [...permissions.filesystem] : undefined,
    tools: permissions.tools ? [...permissions.tools] : undefined,
    device: permissions.device ? [...permissions.device] : undefined,
    uiSlots: permissions.uiSlots ? [...permissions.uiSlots] : undefined,
  };
};

const cloneDescriptor = (
  descriptor?: PersistedPluginDescriptor,
): PersistedPluginDescriptor | undefined =>
  descriptor
    ? {
        ...descriptor,
        inject: descriptor.inject ? [...descriptor.inject] : undefined,
        permissions: clonePermissions(descriptor.permissions),
      }
    : undefined;

const cloneRun = (run: RuntimeRunRecord): RuntimeRunRecord => ({
  ...run,
  error: cloneError(run.error),
  metadata: run.metadata ? { ...run.metadata } : undefined,
});

const cloneEvent = (event: RuntimeEvent): RuntimeEvent => ({ ...event });

const cloneInstallation = (installation: RuntimePluginInstallation): RuntimePluginInstallation => ({
  ...installation,
  inject: installation.inject ? [...installation.inject] : undefined,
  permissions: clonePermissions(installation.permissions),
  descriptor: cloneDescriptor(installation.descriptor),
  metadata: installation.metadata ? { ...installation.metadata } : undefined,
});

const cloneProfile = (profile: AgentProfileProjection): AgentProfileProjection => ({
  ...profile,
  enabledCapabilities: [...profile.enabledCapabilities],
  metadata: profile.metadata ? { ...profile.metadata } : undefined,
});

const eventComparable = (event: RuntimeEvent): string =>
  JSON.stringify({
    protocol_version: event.protocol_version,
    session_id: event.session_id,
    run_id: event.run_id,
    seq: event.seq,
    type: event.type,
    data: event.data,
  });

const installationKey = (id: string, version: string): string => `${id}@${version}`;

export class InMemoryPersistence implements PersistencePort {
  private readonly runs = new Map<string, RuntimeRunRecord>();
  private readonly events = new Map<string, RuntimeEvent[]>();
  private readonly installations = new Map<string, RuntimePluginInstallation>();
  private readonly profiles = new Map<string, AgentProfileProjection>();
  private readonly now: () => string;

  constructor(options: PersistenceOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
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
            sessionId: startInput!.sessionId,
            profileId: startInput!.profileId,
            strategyPluginId: startInput!.strategyPluginId,
            parentRunId: startInput!.parentRunId,
            metadata: startInput!.metadata,
          }
        : inputOrRunId;
    const runId = requireNonEmpty(input.runId, 'runtime_runs.runId');
    const sessionId = requireNonEmpty(input.sessionId, 'runtime_runs.sessionId');
    const existing = this.runs.get(runId);
    if (existing) return cloneRun(existing);
    if (input.state !== undefined && !isRunState(input.state)) {
      throw new PersistenceError(
        'PERSISTENCE_INVALID',
        `Unknown run state: ${String(input.state)}`,
        'runtime_runs',
        runId,
        'state',
      );
    }

    const timestamp = this.now();
    const record: RuntimeRunRecord = {
      runId,
      sessionId,
      state: input.state ?? 'created',
      profileId: input.profileId,
      strategyPluginId: input.strategyPluginId,
      parentRunId: input.parentRunId,
      createdAt: input.createdAt ?? timestamp,
      updatedAt: input.updatedAt ?? timestamp,
      result: input.result,
      error: cloneError(input.error),
      metadata: input.metadata ? { ...input.metadata } : undefined,
    };
    this.runs.set(runId, record);
    return cloneRun(record);
  }

  async getRun(runId: string): Promise<RuntimeRunRecord | null> {
    const record = this.runs.get(runId);
    return record ? cloneRun(record) : null;
  }

  async listRuns(): Promise<RuntimeRunRecord[]> {
    return [...this.runs.values()].map(cloneRun);
  }

  async updateRun(runId: string, patch: RuntimeRunPatch): Promise<RuntimeRunRecord> {
    const record = this.requireRun(runId);
    if (patch.state !== undefined && !isRunState(patch.state)) {
      throw new PersistenceError(
        'PERSISTENCE_INVALID',
        `Unknown run state: ${String(patch.state)}`,
        'runtime_runs',
        runId,
        'state',
      );
    }

    Object.assign(record, {
      ...(patch.state === undefined ? {} : { state: patch.state }),
      ...(patch.profileId === undefined ? {} : { profileId: patch.profileId }),
      ...(patch.strategyPluginId === undefined ? {} : { strategyPluginId: patch.strategyPluginId }),
      ...(patch.parentRunId === undefined ? {} : { parentRunId: patch.parentRunId }),
      ...(patch.result === undefined ? {} : { result: patch.result }),
      ...(patch.error === undefined ? {} : { error: cloneError(patch.error) }),
      ...(patch.metadata === undefined ? {} : { metadata: { ...patch.metadata } }),
      updatedAt: patch.updatedAt ?? this.now(),
    });
    return cloneRun(record);
  }

  async deleteRun(runId: string): Promise<boolean> {
    const deleted = this.runs.delete(runId);
    this.events.delete(runId);
    return deleted;
  }

  async appendRunEvent(runId: string, event: RuntimeEvent): Promise<RuntimeEvent> {
    const normalizedRunId = requireNonEmpty(runId, 'runtime_run_events.runId');
    if (event.run_id !== undefined && event.run_id !== normalizedRunId) {
      throw new PersistenceError(
        'PERSISTENCE_INVALID',
        'event run_id must match the stream runId',
        'runtime_run_events',
        normalizedRunId,
        'run_id',
      );
    }
    if (!Number.isInteger(event.seq) || event.seq < 1) {
      throw new PersistenceError(
        'EVENT_SEQ_INVALID',
        `Event sequence must be a positive integer: ${event.seq}`,
        'runtime_run_events',
        normalizedRunId,
        'seq',
      );
    }

    const stream = this.events.get(normalizedRunId) ?? [];
    const normalizedEvent: RuntimeEvent = {
      ...event,
      protocol_version: event.protocol_version ?? RUNTIME_PROTOCOL_VERSION,
      run_id: normalizedRunId,
    };
    const existing = stream.find((candidate) => candidate.seq === normalizedEvent.seq);
    if (existing) {
      if (eventComparable(existing) === eventComparable(normalizedEvent))
        return cloneEvent(existing);
      throw new PersistenceError(
        'EVENT_SEQ_INVALID',
        `Event sequence ${normalizedEvent.seq} already contains a different event`,
        'runtime_run_events',
        normalizedRunId,
        'seq',
      );
    }

    const latest = stream.at(-1);
    if (latest && normalizedEvent.seq < latest.seq) {
      throw new PersistenceError(
        'EVENT_SEQ_INVALID',
        `Event sequence ${normalizedEvent.seq} is behind latest sequence ${latest.seq}`,
        'runtime_run_events',
        normalizedRunId,
        'seq',
      );
    }

    stream.push(cloneEvent(normalizedEvent));
    this.events.set(normalizedRunId, stream);
    return cloneEvent(normalizedEvent);
  }

  async getRunEvent(runId: string, seq: number): Promise<RuntimeEvent | null> {
    const event = this.events.get(runId)?.find((candidate) => candidate.seq === seq);
    return event ? cloneEvent(event) : null;
  }

  async replayRunEvents(runId: string, afterSeq = 0): Promise<RuntimeEvent[]> {
    if (!Number.isInteger(afterSeq) || afterSeq < 0) {
      throw new PersistenceError(
        'EVENT_SEQ_INVALID',
        `afterSeq must be a non-negative integer: ${afterSeq}`,
        'runtime_run_events',
        runId,
        'afterSeq',
      );
    }
    return (this.events.get(runId) ?? []).filter((event) => event.seq > afterSeq).map(cloneEvent);
  }

  async deleteRunEvents(runId: string): Promise<number> {
    const stream = this.events.get(runId);
    if (!stream) return 0;
    this.events.delete(runId);
    return stream.length;
  }

  async createPluginInstallation(
    input: RuntimePluginInstallationInput,
  ): Promise<RuntimePluginInstallation> {
    const id = requireNonEmpty(input.id, 'runtime_plugin_installations.id');
    const version = requireNonEmpty(input.version, 'runtime_plugin_installations.version');
    const key = installationKey(id, version);
    const existing = this.installations.get(key);
    if (existing) {
      throw new PersistenceError(
        'PERSISTENCE_DUPLICATE',
        `Plugin installation already exists: ${key}`,
        'runtime_plugin_installations',
        key,
      );
    }
    if (input.state !== undefined && !isPluginState(input.state)) {
      throw new PersistenceError(
        'PERSISTENCE_INVALID',
        `Unknown plugin installation state: ${String(input.state)}`,
        'runtime_plugin_installations',
        key,
        'state',
      );
    }

    const timestamp = this.now();
    const installation: RuntimePluginInstallation = {
      id,
      version,
      state: input.state ?? input.descriptor?.state ?? 'installed',
      kind: input.kind ?? input.descriptor?.kind,
      name: input.name ?? input.descriptor?.name,
      description: input.description ?? input.descriptor?.description,
      inject: input.inject ? [...input.inject] : input.descriptor?.inject?.slice(),
      permissions: clonePermissions(input.permissions ?? input.descriptor?.permissions),
      source: input.source ?? input.descriptor?.source,
      descriptor: cloneDescriptor(input.descriptor),
      metadata: input.metadata ? { ...input.metadata } : undefined,
      createdAt: input.createdAt ?? timestamp,
      updatedAt: input.updatedAt ?? timestamp,
    };
    this.installations.set(key, installation);
    return cloneInstallation(installation);
  }

  async getPluginInstallation(
    id: string,
    version?: string,
  ): Promise<RuntimePluginInstallation | null> {
    const installation = version
      ? this.installations.get(installationKey(id, version))
      : [...this.installations.values()].findLast((candidate) => candidate.id === id);
    return installation ? cloneInstallation(installation) : null;
  }

  async listPluginInstallations(): Promise<RuntimePluginInstallation[]> {
    return [...this.installations.values()].map(cloneInstallation);
  }

  async updatePluginInstallation(
    id: string,
    version: string,
    patch: RuntimePluginInstallationPatch,
  ): Promise<RuntimePluginInstallation> {
    const key = installationKey(id, version);
    const installation = this.requireInstallation(key);
    if (patch.state !== undefined && !isPluginState(patch.state)) {
      throw new PersistenceError(
        'PERSISTENCE_INVALID',
        `Unknown plugin installation state: ${String(patch.state)}`,
        'runtime_plugin_installations',
        key,
        'state',
      );
    }

    Object.assign(installation, {
      ...(patch.state === undefined ? {} : { state: patch.state }),
      ...(patch.kind === undefined ? {} : { kind: patch.kind }),
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.description === undefined ? {} : { description: patch.description }),
      ...(patch.inject === undefined ? {} : { inject: [...patch.inject] }),
      ...(patch.permissions === undefined
        ? {}
        : { permissions: clonePermissions(patch.permissions) }),
      ...(patch.source === undefined ? {} : { source: patch.source }),
      ...(patch.descriptor === undefined ? {} : { descriptor: cloneDescriptor(patch.descriptor) }),
      ...(patch.metadata === undefined ? {} : { metadata: { ...patch.metadata } }),
      updatedAt: patch.updatedAt ?? this.now(),
    });
    return cloneInstallation(installation);
  }

  async deletePluginInstallation(id: string, version?: string): Promise<boolean> {
    if (version !== undefined) return this.installations.delete(installationKey(id, version));

    const matches = [...this.installations.keys()].filter((key) => key.startsWith(`${id}@`));
    for (const key of matches) this.installations.delete(key);
    return matches.length > 0;
  }

  async putAgentProfile(profile: AgentProfileProjection): Promise<AgentProfileProjection> {
    const id = requireNonEmpty(profile.id, 'agent_profiles.id');
    const value = cloneProfile({ ...profile, id });
    this.profiles.set(id, value);
    return cloneProfile(value);
  }

  async getAgentProfile(profileId: string): Promise<AgentProfileProjection | null> {
    const profile = this.profiles.get(profileId);
    return profile ? cloneProfile(profile) : null;
  }

  async listAgentProfiles(): Promise<AgentProfileProjection[]> {
    return [...this.profiles.values()].map(cloneProfile);
  }

  async deleteAgentProfile(profileId: string): Promise<boolean> {
    return this.profiles.delete(profileId);
  }

  async createAgentProfile(profile: AgentProfileProjection): Promise<AgentProfileProjection> {
    if (this.profiles.has(profile.id)) {
      throw new PersistenceError(
        'PERSISTENCE_DUPLICATE',
        `Agent profile already exists: ${profile.id}`,
        undefined,
        profile.id,
      );
    }
    return this.putAgentProfile(profile);
  }

  async upsertAgentProfile(profile: AgentProfileProjection): Promise<AgentProfileProjection> {
    return this.putAgentProfile(profile);
  }

  private requireRun(runId: string): RuntimeRunRecord {
    const record = this.runs.get(runId);
    if (!record) {
      throw new PersistenceError(
        'PERSISTENCE_NOT_FOUND',
        `Run does not exist: ${runId}`,
        'runtime_runs',
        runId,
      );
    }
    return record;
  }

  private requireInstallation(key: string): RuntimePluginInstallation {
    const installation = this.installations.get(key);
    if (!installation) {
      throw new PersistenceError(
        'PERSISTENCE_NOT_FOUND',
        `Plugin installation does not exist: ${key}`,
        'runtime_plugin_installations',
        key,
      );
    }
    return installation;
  }
}

export { PersistenceError as PersistencePortError };
