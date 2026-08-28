/**
 * C-21 Legacy Agent compatibility seam — the injectable adapter.
 *
 * `LegacyAgentCompatAdapter` gives legacy agent-operation call sites a single
 * entry point: when the feature flag is off it forwards to an injected
 * `LegacyAgentOperationPort` (the real legacy path stays untouched); when the
 * flag is on it maps the same inputs to runtime.v1 command envelopes, sends
 * them through an injected `RuntimeFacadePort`, and projects RunSnapshot-like
 * responses back onto `LegacyAgentOperationView`.
 *
 * Hard constraints (per contract): this adapter never imports or constructs
 * AgentRuntimeService, never touches a database, and never executes anything
 * itself — every runtime interaction is an envelope handed to the injected
 * facade port.
 */

import type { RuntimeCommandEnvelope, RuntimeFacadePort } from '../adapter';
import { isRuntimeV1AgentOpsEnabled } from './feature-flag';
import {
  buildRunCancelEnvelope,
  buildRunGetEnvelope,
  buildRunResumeEnvelope,
  buildRunStartEnvelope,
  legacyViewFromSnapshot,
  toLegacyCompatError,
} from './mapper';
import {
  type LegacyAgentOperationPort,
  type LegacyAgentOperationResumeInput,
  type LegacyAgentOperationStartInput,
  type LegacyAgentOperationView,
  LegacyCompatError,
} from './types';

export interface LegacyAgentCompatAdapterDeps {
  /** Injectable request-id generator (defaults to crypto.randomUUID). */
  readonly createRequestId?: () => string;
  /** Optional per-adapter override; falls back to the global feature flag. */
  readonly isEnabled?: () => boolean;
  /** Injected legacy execution boundary; required so the off-path stays realistic. */
  readonly legacyPort: LegacyAgentOperationPort;
  /** Injected runtime.v1 command surface; only called while the flag is on. */
  readonly runtimeFacade: RuntimeFacadePort;
}

let requestIdSequence = 0;

const defaultRequestId = (): string => {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return `legacy-compat-${random}`;
  requestIdSequence += 1;
  return `legacy-compat-${Date.now().toString(36)}-${requestIdSequence.toString(36)}`;
};

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new LegacyCompatError(
      'LEGACY_COMPAT_INVALID_INPUT',
      `${field} must be a non-empty string`,
      field,
    );
  }
  return value;
};

export class LegacyAgentCompatAdapter {
  private readonly deps: LegacyAgentCompatAdapterDeps;

  constructor(deps: LegacyAgentCompatAdapterDeps) {
    this.deps = deps;
  }

  get enabled(): boolean {
    const isEnabled = this.deps.isEnabled ?? isRuntimeV1AgentOpsEnabled;
    try {
      return isEnabled();
    } catch {
      // A broken flag provider must never be silently resolved to either path;
      // surface it as a stable compat error instead of guessing.
      throw new LegacyCompatError(
        'LEGACY_COMPAT_RUNTIME_FAILED',
        'Feature-flag provider threw while resolving runtime_v1_agent_ops',
      );
    }
  }

  async startOperation(input: LegacyAgentOperationStartInput): Promise<LegacyAgentOperationView> {
    if (!this.enabled) {
      return await this.deps.legacyPort.start(input);
    }

    this.validateStartInput(input);
    const envelope = buildRunStartEnvelope(input, this.nextRequestId());
    const snapshot = await this.dispatch(envelope);
    const view = legacyViewFromSnapshot(snapshot);
    // Preserve the caller's legacy identity even if the facade dropped metadata.
    return input.operationId ? { ...view, operationId: input.operationId } : view;
  }

  async getOperation(operationId: string): Promise<LegacyAgentOperationView | null> {
    const id = requiredString(operationId, 'operationId');
    if (!this.enabled) {
      return await this.deps.legacyPort.get(id);
    }

    const envelope = buildRunGetEnvelope(id, this.nextRequestId());
    const snapshot = await this.tryDispatchAllowingNull(envelope);
    if (snapshot === null || snapshot === undefined) return null;
    const view = legacyViewFromSnapshot(snapshot);
    return { ...view, operationId: id };
  }

  async cancelOperation(operationId: string): Promise<LegacyAgentOperationView> {
    const id = requiredString(operationId, 'operationId');
    if (!this.enabled) {
      return await this.deps.legacyPort.cancel(id);
    }

    const envelope = buildRunCancelEnvelope(id, this.nextRequestId());
    const snapshot = await this.dispatch(envelope);
    const view = legacyViewFromSnapshot(snapshot);
    return { ...view, operationId: id };
  }

  async resumeOperation(
    operationId: string,
    resumeInput: LegacyAgentOperationResumeInput,
  ): Promise<LegacyAgentOperationView> {
    const id = requiredString(operationId, 'operationId');
    requiredString(resumeInput.input, 'input');
    if (!this.enabled) {
      if (!this.deps.legacyPort.resume) {
        throw new LegacyCompatError(
          'LEGACY_COMPAT_RUNTIME_FAILED',
          'Injected legacy port does not support resume',
        );
      }
      return await this.deps.legacyPort.resume(id, resumeInput);
    }

    const envelope = buildRunResumeEnvelope(id, resumeInput, this.nextRequestId());
    const snapshot = await this.dispatch(envelope);
    const view = legacyViewFromSnapshot(snapshot);
    return { ...view, operationId: id };
  }

  private validateStartInput(input: LegacyAgentOperationStartInput): void {
    requiredString(input.userId, 'userId');
    requiredString(input.userMessage, 'userMessage');
    requiredString(input.sessionId, 'sessionId');
    requiredString(input.agentId, 'agentId');
  }

  private nextRequestId(): string {
    return this.deps.createRequestId ? this.deps.createRequestId() : defaultRequestId();
  }

  /**
   * Sends one runtime.v1 command and structurally validates the response.
   * A bare `null`/`undefined` response is preserved as "not found" semantics.
   */
  private async dispatch(envelope: RuntimeCommandEnvelope): Promise<unknown> {
    const raw = await this.tryDispatchAllowingNull(envelope);
    if (raw === null || raw === undefined) {
      throw new LegacyCompatError(
        'LEGACY_COMPAT_RESPONSE_INVALID',
        `Runtime facade returned no snapshot for ${envelope.command}`,
      );
    }
    return raw;
  }

  private async tryDispatchAllowingNull(envelope: RuntimeCommandEnvelope): Promise<unknown> {
    let response: unknown;
    try {
      response = await this.deps.runtimeFacade.handle(envelope);
    } catch (error) {
      throw toLegacyCompatError(error);
    }
    return response;
  }
}

export const createLegacyAgentCompatAdapter = (
  deps: LegacyAgentCompatAdapterDeps,
): LegacyAgentCompatAdapter => new LegacyAgentCompatAdapter(deps);
