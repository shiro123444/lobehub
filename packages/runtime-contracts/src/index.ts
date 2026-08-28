/** The wire protocol version shared by RuntimeFacade and its clients. */
export const RUNTIME_PROTOCOL_VERSION = 'runtime.v1' as const;

export const PLUGIN_KINDS = ['kernel', 'capability', 'agent-strategy', 'ui'] as const;
export type RuntimePluginKind = (typeof PLUGIN_KINDS)[number];

export const PLUGIN_RUNTIME_STATES = [
  'installed',
  'pending',
  'active',
  'failed',
  'unloading',
  'disabled',
] as const;
export type PluginRuntimeState = (typeof PLUGIN_RUNTIME_STATES)[number];

export const RUN_STATES = [
  'created',
  'queued',
  'running',
  'waiting_tool',
  'waiting_human',
  'waiting_child',
  'retrying',
  'completed',
  'failed',
  'cancelled',
] as const;
export type RunState = (typeof RUN_STATES)[number];

export type FiberState = 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | 'disposed';

export interface Disposer {
  (): void | Promise<void>;
}

export type Disposable = Disposer;
export type Effect =
  | Disposable
  | Iterable<Disposable>
  | AsyncIterable<Disposable>
  | Promise<Effect | void>;

export interface Fiber {
  collect: (disposer: Disposer) => Disposable;
  dispose: () => Promise<void>;
  readonly name: string;
  readonly state: FiberState;
}

/** The intentionally small surface exposed to plugin manifests. */
export interface RuntimeContext {
  dispose: () => Promise<void>;
  readonly fiber: Fiber;
  on: (event: string, listener: (...args: unknown[]) => unknown) => Disposable;
  provide: <T>(name: string, service: T) => Disposable;
  readonly root: RuntimeContext;
  withScope: (scope: string | symbol) => RuntimeContext;
}

export interface PermissionManifest {
  device?: string[];
  filesystem?: string[];
  network?: string[];
  tools?: string[];
  uiSlots?: string[];
}

export interface RuntimePluginManifest {
  apply: (ctx: RuntimeContext, config?: unknown) => Effect | Promise<Effect | void> | void;
  id: string;
  inject?: string[];
  kind: RuntimePluginKind;
  permissions?: PermissionManifest;
  version: string;
}

export interface PluginDescriptor {
  description?: string;
  id: string;
  inject?: string[];
  kind: RuntimePluginKind;
  name?: string;
  permissions?: PermissionManifest;
  source?: 'builtin' | 'mcp-http' | 'mcp-stdio' | 'remote-adapter' | 'worker';
  state?: PluginRuntimeState;
  version: string;
}

export interface StartRunInput {
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  parentRunId?: string;
  profileId: string;
  sessionId: string;
  strategyPluginId?: string;
  toolAllowlist?: string[];
  userContext?: Record<string, unknown>;
  userMessage: string;
}

export interface ResumeRunInput {
  input: string;
  metadata?: Record<string, unknown>;
}

export interface RunError {
  code: string;
  details?: unknown;
  message: string;
}

export interface RunSnapshot {
  createdAt: string;
  error?: RunError;
  metadata?: Record<string, unknown>;
  parentRunId?: string;
  profileId?: string;
  result?: unknown;
  runId: string;
  sessionId: string;
  state: RunState;
  strategyPluginId?: string;
  updatedAt: string;
}

export interface RuntimeEvent {
  data: unknown;
  protocol_version: typeof RUNTIME_PROTOCOL_VERSION;
  run_id?: string;
  seq: number;
  session_id: string;
  type: string;
}

export interface CommandEnvelope {
  command: string;
  payload: Record<string, unknown>;
  protocol_version: typeof RUNTIME_PROTOCOL_VERSION;
  request_id: string;
}

export interface AgentProfile {
  enabledCapabilities: string[];
  id: string;
  metadata?: Record<string, unknown>;
  model?: string;
  provider?: string;
  strategyPluginId: string;
  systemPrompt?: string;
}

export type ArtifactStatus = 'pending' | 'ready' | 'failed';

export interface ArtifactSnapshot {
  artifactId: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
  mimeType?: string;
  name?: string;
  sizeBytes?: number;
  status: ArtifactStatus;
  type: string;
  updatedAt?: string;
  uri?: string;
}

export interface PresentationJobInput {
  aspectRatio?: string;
  language?: string;
  notebookId: string;
  options?: Record<string, unknown>;
  prompt?: string;
  slideCount?: number;
  sourceVersionIds: string[];
  template?: string;
  title: string;
}

export type PresentationJobState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface PresentationJob {
  artifactIds?: string[];
  createdAt: string;
  error?: RunError;
  jobId: string;
  state: PresentationJobState;
  updatedAt: string;
}

export type PresentationExportFormat = 'pptx' | 'svg' | 'pdf' | 'quality-report';

export interface ExportResult {
  artifactId: string;
  format: PresentationExportFormat;
  mimeType?: string;
  uri?: string;
}

export interface PresentationPort {
  cancelJob: (jobId: string) => Promise<PresentationJob>;
  createJob: (input: PresentationJobInput) => Promise<PresentationJob>;
  exportArtifact: (artifactId: string, format: PresentationExportFormat) => Promise<ExportResult>;
  getArtifact: (artifactId: string) => Promise<ArtifactSnapshot | null>;
  getJob: (jobId: string) => Promise<PresentationJob | null>;
  retryJob: (jobId: string) => Promise<PresentationJob>;
}

export interface RunHandle {
  cancel: () => Promise<void>;
  runId: string;
  snapshot: () => Promise<RunSnapshot | null>;
}
