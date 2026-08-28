import type { EventListener } from './journal';
import { EventJournal } from './journal';
import { PluginManager } from './manager';
import type { CommandEnvelope } from './protocol';
import { CommandEnvelopeCodec } from './protocol';
import type { ResumeRunInput, RunSnapshot, StartRunInput } from './run';
import { RunStore } from './run';
import type { Disposable, RuntimePluginManifest } from './types';

export type RuntimeFacadeErrorCode = 'COMMAND_NOT_FOUND' | 'COMMAND_INVALID';

export class RuntimeFacadeError extends Error {
  constructor(
    public readonly code: RuntimeFacadeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeFacadeError';
  }
}

export interface InMemoryRuntimeFacadeOptions {
  codec?: CommandEnvelopeCodec;
  eventJournal?: EventJournal;
  journal?: EventJournal;
  pluginManager?: PluginManager;
  plugins?: RuntimePluginManifest[];
  runs?: RunStore;
  runStore?: RunStore;
}

type Payload = Record<string, unknown>;

const isRecord = (value: unknown): value is Payload =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

export class InMemoryRuntimeFacade {
  public readonly codec: CommandEnvelopeCodec;
  public readonly runStore: RunStore;
  public readonly eventJournal: EventJournal;
  public readonly pluginManager: PluginManager;

  private readonly requestResults = new Map<string, Promise<unknown>>();

  constructor(options: InMemoryRuntimeFacadeOptions = {}) {
    this.codec = options.codec ?? new CommandEnvelopeCodec();
    this.runStore = options.runStore ?? options.runs ?? new RunStore();
    this.eventJournal = options.eventJournal ?? options.journal ?? new EventJournal();
    this.pluginManager = options.pluginManager ?? new PluginManager(options.plugins ?? []);
  }

  async handle(input: CommandEnvelope | string | unknown): Promise<unknown> {
    const envelope =
      typeof input === 'string' ? this.codec.decode(input) : this.codec.validate(input);
    const existing = this.requestResults.get(envelope.request_id);
    if (existing) return existing;

    const result = this.dispatch(envelope);
    this.requestResults.set(envelope.request_id, result);
    return result;
  }

  subscribe(runId: string, listener: EventListener): Disposable {
    return this.eventJournal.subscribe(runId, listener);
  }

  subscribeRunEvents(runId: string, listener: EventListener): Disposable {
    return this.subscribe(runId, listener);
  }

  onRunEvent(runId: string, listener: EventListener): Disposable {
    return this.subscribe(runId, listener);
  }

  private async dispatch(envelope: CommandEnvelope): Promise<unknown> {
    switch (envelope.command) {
      case 'run.start': {
        return this.startRun(envelope);
      }
      case 'run.get': {
        return this.runStore.snapshot(this.requiredRunId(envelope.payload));
      }
      case 'run.cancel': {
        return this.changeRun(envelope, (runId) => this.runStore.cancel(runId));
      }
      case 'run.resume': {
        return this.resumeRun(envelope);
      }
      case 'run.events': {
        return this.eventJournal.replay(
          this.requiredRunId(envelope.payload),
          this.afterSeq(envelope.payload),
        );
      }
      case 'plugin.list': {
        return this.pluginManager.list();
      }
      case 'plugin.mount': {
        return this.pluginManager.mount(this.requiredPluginId(envelope.payload));
      }
      case 'plugin.unmount': {
        return this.pluginManager.unmount(this.requiredPluginId(envelope.payload));
      }
      default: {
        throw new RuntimeFacadeError(
          'COMMAND_NOT_FOUND',
          `Runtime command is not supported: ${envelope.command}`,
        );
      }
    }
  }

  private async startRun(envelope: CommandEnvelope): Promise<RunSnapshot | null> {
    const payload = envelope.payload;
    const nestedInput = isRecord(payload.input) ? payload.input : undefined;
    const source = nestedInput ?? payload;
    const runId =
      stringValue(payload.runId) ??
      stringValue(nestedInput?.runId) ??
      stringValue(source.idempotencyKey) ??
      envelope.request_id;
    const input: StartRunInput = {
      sessionId: stringValue(source.sessionId) ?? envelope.request_id,
      profileId: stringValue(source.profileId) ?? 'default',
      strategyPluginId: stringValue(source.strategyPluginId),
      userMessage: typeof source.userMessage === 'string' ? source.userMessage : '',
      toolAllowlist: Array.isArray(source.toolAllowlist)
        ? source.toolAllowlist.filter((value): value is string => typeof value === 'string')
        : undefined,
      userContext: isRecord(source.userContext) ? source.userContext : undefined,
      parentRunId: stringValue(source.parentRunId),
      idempotencyKey: stringValue(source.idempotencyKey),
      metadata: isRecord(source.metadata) ? source.metadata : undefined,
    };

    const before = this.runStore.snapshot(runId);
    const created = this.runStore.create(runId, input);
    let result = created;
    if (result.state === 'created') result = this.runStore.enqueue(runId);
    if (result.state === 'queued') this.runStore.start(runId);

    const snapshot = this.runStore.snapshot(runId);
    if (snapshot && (!before || before.state !== snapshot.state))
      this.publish(snapshot, envelope.command);
    return snapshot;
  }

  private async resumeRun(envelope: CommandEnvelope): Promise<RunSnapshot | null> {
    const payload = envelope.payload;
    const runId = this.requiredRunId(payload);
    const rawInput = isRecord(payload.input) ? payload.input : payload;
    const input: ResumeRunInput = {
      input: typeof rawInput.input === 'string' ? rawInput.input : '',
      metadata: isRecord(rawInput.metadata) ? rawInput.metadata : undefined,
    };
    return this.changeRun(envelope, (id) => this.runStore.resume(id, input), runId);
  }

  private async changeRun(
    envelope: CommandEnvelope,
    change: (runId: string) => RunSnapshot,
    explicitRunId?: string,
  ): Promise<RunSnapshot> {
    const runId = explicitRunId ?? this.requiredRunId(envelope.payload);
    const snapshot = change(runId);
    this.publish(snapshot, envelope.command);
    return snapshot;
  }

  private publish(snapshot: RunSnapshot, command: string): void {
    const previous = this.eventJournal.replay(snapshot.runId).at(-1);
    this.eventJournal.append(snapshot.runId, {
      protocol_version: 'runtime.v1',
      session_id: snapshot.sessionId,
      run_id: snapshot.runId,
      seq: (previous?.seq ?? 0) + 1,
      type: 'run.state_changed',
      data: { command, state: snapshot.state },
    });
  }

  private requiredRunId(payload: Payload): string {
    const runId = stringValue(payload.runId);
    if (!runId) throw new RuntimeFacadeError('COMMAND_INVALID', 'payload.runId is required');
    return runId;
  }

  private requiredPluginId(payload: Payload): string {
    const id = stringValue(payload.id);
    if (!id) throw new RuntimeFacadeError('COMMAND_INVALID', 'payload.id is required');
    return id;
  }

  private afterSeq(payload: Payload): number | undefined {
    const value = payload.after_seq ?? payload.afterSeq;
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new RuntimeFacadeError(
        'COMMAND_INVALID',
        'payload.after_seq must be a non-negative integer',
      );
    }
    return value;
  }
}

export { InMemoryRuntimeFacade as RuntimeFacade };
