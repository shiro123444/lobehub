export const RUNTIME_PROTOCOL_VERSION = 'runtime.v1' as const;

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
export type WaitingRunState = Extract<RunState, `waiting_${string}`>;
export type WaitKind = WaitingRunState | 'tool' | 'human' | 'child';

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

export interface RunRecord extends RunSnapshot {
  readonly events: readonly RuntimeEvent[];
}

export type RunStoreErrorCode = 'RUN_NOT_FOUND' | 'INVALID_TRANSITION' | 'RUN_ALREADY_TERMINAL';

export class RunStoreError extends Error {
  constructor(
    public readonly code: RunStoreErrorCode,
    message: string,
    public readonly runId?: string,
    public readonly from?: RunState,
    public readonly to?: RunState,
  ) {
    super(message);
    this.name = 'RunStoreError';
  }
}

export const RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  created: ['queued', 'cancelled'],
  queued: ['running', 'cancelled'],
  running: [
    'waiting_tool',
    'waiting_human',
    'waiting_child',
    'retrying',
    'completed',
    'failed',
    'cancelled',
  ],
  waiting_tool: ['running', 'retrying', 'completed', 'failed', 'cancelled'],
  waiting_human: ['running', 'retrying', 'completed', 'failed', 'cancelled'],
  waiting_child: ['running', 'retrying', 'completed', 'failed', 'cancelled'],
  retrying: ['running', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export interface RunStoreOptions {
  now?: () => string;
}

interface StoredRunRecord extends RunSnapshot {
  events: RuntimeEvent[];
}

const TERMINAL_STATES: ReadonlySet<RunState> = new Set(['completed', 'failed', 'cancelled']);

const WAIT_STATE_BY_KIND: Record<WaitKind, WaitingRunState> = {
  tool: 'waiting_tool',
  human: 'waiting_human',
  child: 'waiting_child',
  waiting_tool: 'waiting_tool',
  waiting_human: 'waiting_human',
  waiting_child: 'waiting_child',
};

const cloneError = (error?: RunError): RunError | undefined => (error ? { ...error } : undefined);

const cloneRecord = (record: StoredRunRecord): RunRecord => ({
  runId: record.runId,
  sessionId: record.sessionId,
  state: record.state,
  profileId: record.profileId,
  strategyPluginId: record.strategyPluginId,
  parentRunId: record.parentRunId,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  result: record.result,
  error: cloneError(record.error),
  metadata: record.metadata ? { ...record.metadata } : undefined,
  events: record.events.map((event) => ({ ...event })),
});

const normalizeError = (failure: RunError | Error | string): RunError => {
  if (typeof failure === 'string') return { code: 'RUN_FAILED', message: failure };
  if (failure instanceof Error) {
    const code =
      'code' in failure && typeof failure.code === 'string' ? failure.code : 'RUN_FAILED';
    return { code, message: failure.message };
  }
  return { ...failure };
};

export class RunStore {
  private readonly records = new Map<string, StoredRunRecord>();
  private readonly now: () => string;

  constructor(options: RunStoreOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Create a run once; subsequent calls with the same runId return its current record. */
  create(runId: string, input: StartRunInput): RunRecord {
    const existing = this.records.get(runId);
    if (existing) return cloneRecord(existing);

    const timestamp = this.now();
    const record: StoredRunRecord = {
      runId,
      sessionId: input.sessionId,
      state: 'created',
      profileId: input.profileId,
      strategyPluginId: input.strategyPluginId,
      parentRunId: input.parentRunId,
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: input.metadata ? { ...input.metadata } : undefined,
      events: [],
    };

    this.records.set(runId, record);
    this.emit(record, 'run.created', { state: record.state });
    return cloneRecord(record);
  }

  enqueue(runId: string): RunRecord {
    return this.change(runId, 'queued');
  }

  start(runId: string): RunRecord {
    return this.change(runId, 'running');
  }

  wait(runId: string, kind: WaitKind): RunRecord {
    const state = WAIT_STATE_BY_KIND[kind];
    if (!state) {
      throw new RunStoreError('INVALID_TRANSITION', `Unknown wait kind: ${String(kind)}`, runId);
    }
    return this.change(runId, state);
  }

  resume(runId: string, input?: ResumeRunInput): RunRecord {
    const record = this.require(runId);
    this.assertNotTerminal(record);

    return this.changeRecord(record, 'running', {}, (current) => {
      if (input?.metadata) current.metadata = { ...current.metadata, ...input.metadata };
    });
  }

  retry(runId: string): RunRecord {
    const record = this.require(runId);
    this.assertNotTerminal(record);

    return this.changeRecord(record, 'retrying', {}, (current) => {
      current.error = undefined;
    });
  }

  complete(runId: string, result?: unknown): RunRecord {
    const record = this.require(runId);
    this.assertNotTerminal(record);

    return this.changeRecord(record, 'completed', {}, (current) => {
      current.result = result;
    });
  }

  fail(runId: string, failure: RunError | Error | string = 'Run failed'): RunRecord {
    const record = this.require(runId);
    this.assertNotTerminal(record);
    const error = normalizeError(failure);

    return this.changeRecord(record, 'failed', { error }, (current) => {
      current.error = error;
    });
  }

  cancel(runId: string): RunRecord {
    const record = this.require(runId);
    this.assertNotTerminal(record);
    return this.changeRecord(record, 'cancelled');
  }

  get(runId: string): RunRecord | null {
    const record = this.records.get(runId);
    return record ? cloneRecord(record) : null;
  }

  snapshot(runId: string): RunSnapshot | null {
    const record = this.get(runId);
    if (!record) return null;
    const { events: _events, ...snapshot } = record;
    return snapshot;
  }

  getEvents(runId: string, afterSeq = 0): RuntimeEvent[] {
    const record = this.require(runId);
    return record.events.filter((event) => event.seq > afterSeq).map((event) => ({ ...event }));
  }

  events(runId: string, afterSeq = 0): RuntimeEvent[] {
    return this.getEvents(runId, afterSeq);
  }

  private change(runId: string, next: RunState): RunRecord {
    const record = this.require(runId);
    this.assertNotTerminal(record);
    return this.changeRecord(record, next);
  }

  private changeRecord(
    record: StoredRunRecord,
    next: RunState,
    data: Record<string, unknown> = {},
    update?: (record: StoredRunRecord) => void,
  ): RunRecord {
    const from = record.state;
    if (!RUN_TRANSITIONS[from].includes(next)) {
      throw new RunStoreError(
        'INVALID_TRANSITION',
        `Cannot transition run ${record.runId} from ${from} to ${next}`,
        record.runId,
        from,
        next,
      );
    }

    update?.(record);
    record.state = next;
    record.updatedAt = this.now();
    this.emit(record, 'run.state_changed', { from, to: next, ...data });
    return cloneRecord(record);
  }

  private emit(record: StoredRunRecord, type: string, data: unknown): void {
    record.events.push({
      protocol_version: RUNTIME_PROTOCOL_VERSION,
      session_id: record.sessionId,
      run_id: record.runId,
      seq: record.events.length + 1,
      type,
      data,
    });
  }

  private require(runId: string): StoredRunRecord {
    const record = this.records.get(runId);
    if (!record) {
      throw new RunStoreError('RUN_NOT_FOUND', `Run does not exist: ${runId}`, runId);
    }
    return record;
  }

  private assertNotTerminal(record: StoredRunRecord): void {
    if (TERMINAL_STATES.has(record.state)) {
      throw new RunStoreError(
        'RUN_ALREADY_TERMINAL',
        `Run ${record.runId} is already ${record.state}`,
        record.runId,
        record.state,
      );
    }
  }
}

export { RunStore as InMemoryRunService, RunStore as RunFSM, RunStoreError as RunFSMError };
