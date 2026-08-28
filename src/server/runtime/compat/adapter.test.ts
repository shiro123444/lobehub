import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeCommandEnvelope } from '../adapter';
import { LegacyAgentCompatAdapter } from './adapter';
import {
  configureRuntimeV1AgentOpsFlag,
  isRuntimeV1AgentOpsEnabled,
  resetRuntimeV1AgentOpsFlag,
} from './feature-flag';
import type {
  LegacyAgentOperationPort,
  LegacyAgentOperationStartInput,
  LegacyAgentOperationView,
} from './types';
import { LegacyCompatError } from './types';

afterEach(() => {
  resetRuntimeV1AgentOpsFlag();
});

const legacyView = (
  overrides: Partial<LegacyAgentOperationView> = {},
): LegacyAgentOperationView => ({
  operationId: 'op-legacy-1',
  status: 'running',
  source: 'legacy',
  ...overrides,
});

const createLegacyPort = (): {
  port: LegacyAgentOperationPort;
  start: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
} => {
  const port = {
    start: vi.fn(async () => legacyView()),
    get: vi.fn(async () => legacyView({ status: 'idle' })),
    cancel: vi.fn(async () => legacyView({ status: 'interrupted' })),
  };
  return { port: port as unknown as LegacyAgentOperationPort, ...port };
};

const facadeReturning = (
  implementation: (envelope: RuntimeCommandEnvelope) => unknown,
): { handle: ReturnType<typeof vi.fn> } => ({
  handle: vi.fn(implementation),
});

const startInput = (): LegacyAgentOperationStartInput => ({
  userId: 'user-1',
  userMessage: 'hello there',
  agentId: 'agent-1',
  sessionId: 'session-1',
  trigger: 'chat',
  operationId: 'op-legacy-1',
});

const fullSnapshot = () => ({
  runId: 'run-77',
  sessionId: 'session-1',
  state: 'completed',
  profileId: 'agent-1',
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:05:00.000Z',
  result: { text: 'done' },
  metadata: { operationId: 'op-legacy-1' },
});

describe('C-21 adapter: feature flag off → legacy path stays authoritative', () => {
  it('delegates start/get/cancel to the injected legacy port and never touches the facade', async () => {
    const legacy = createLegacyPort();
    const facade = facadeReturning(() => {
      throw new Error('runtime must not be called while the flag is off');
    });
    const adapter = new LegacyAgentCompatAdapter({
      legacyPort: legacy.port,
      runtimeFacade: facade,
      isEnabled: () => false,
    });

    await expect(adapter.startOperation(startInput())).resolves.toMatchObject({
      operationId: 'op-legacy-1',
      status: 'running',
      source: 'legacy',
    });
    await expect(adapter.getOperation('op-legacy-1')).resolves.toMatchObject({ status: 'idle' });
    await expect(adapter.cancelOperation('op-legacy-1')).resolves.toMatchObject({
      status: 'interrupted',
    });

    expect(legacy.start).toHaveBeenCalledWith(startInput());
    expect(facade.handle).not.toHaveBeenCalled();
  });

  it('treats an unset env flag as off without any explicit provider', async () => {
    expect(isRuntimeV1AgentOpsEnabled()).toBe(false);

    const legacy = createLegacyPort();
    const facade = facadeReturning(() => null);
    const adapter = new LegacyAgentCompatAdapter({
      legacyPort: legacy.port,
      runtimeFacade: facade,
    });

    await adapter.startOperation(startInput());
    expect(facade.handle).not.toHaveBeenCalled();
    expect(legacy.start).toHaveBeenCalledTimes(1);
  });
});

describe('C-21 adapter: feature flag on → runtime.v1 mapping', () => {
  it('starts a run through a valid runtime.v1 envelope and preserves legacy identity fields', async () => {
    configureRuntimeV1AgentOpsFlag(true);
    const legacy = createLegacyPort();
    const facade = facadeReturning((envelope) => {
      expect(envelope.protocol_version).toBe('runtime.v1');
      expect(envelope.command).toBe('run.start');
      expect(envelope.payload).toMatchObject({
        sessionId: 'session-1',
        userMessage: 'hello there',
        profileId: 'agent-1',
        idempotencyKey: 'op-legacy-1',
        metadata: { operationId: 'op-legacy-1' },
        userContext: { userId: 'user-1' },
      });
      return fullSnapshot();
    });
    const adapter = new LegacyAgentCompatAdapter({
      legacyPort: legacy.port,
      runtimeFacade: facade,
      isEnabled: () => true,
      createRequestId: () => 'req-fixed',
    });

    const view = await adapter.startOperation(startInput());

    expect(view).toEqual({
      operationId: 'op-legacy-1',
      agentId: 'agent-1',
      status: 'done',
      completionReason: 'done',
      sessionId: 'session-1',
      runId: 'run-77',
      startedAt: '2026-08-27T00:00:00.000Z',
      completedAt: '2026-08-27T00:05:00.000Z',
      source: 'runtime.v1',
    });
    expect(legacy.start).not.toHaveBeenCalled();
  });

  it('maps a failed run onto status error with the real error fields preserved', async () => {
    configureRuntimeV1AgentOpsFlag(true);
    const facade = facadeReturning(() => ({
      runId: 'run-fail',
      sessionId: 'session-1',
      state: 'failed',
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:09:00.000Z',
      error: {
        code: 'MODEL_PROVIDER_ERROR',
        message: 'upstream exploded',
        details: { retryable: false },
      },
      metadata: {},
    }));
    const adapter = new LegacyAgentCompatAdapter({
      legacyPort: createLegacyPort().port,
      runtimeFacade: facade,
      isEnabled: () => true,
    });

    const view = await adapter.startOperation({ ...startInput(), operationId: undefined });

    expect(view.operationId).toBe('run-fail');
    expect(view.status).toBe('error');
    expect(view.completionReason).toBe('error');
    expect(view.error).toMatchObject({
      code: 'MODEL_PROVIDER_ERROR',
      message: 'upstream exploded',
      details: { retryable: false },
    });
    expect(view.completedAt).toBe('2026-08-27T00:09:00.000Z');
    expect(view.agentId).toBeUndefined();
  });

  it('cancels through run.cancel and reports honest interrupted status', async () => {
    configureRuntimeV1AgentOpsFlag(true);
    const facade = facadeReturning((envelope) => {
      expect(envelope.command).toBe('run.cancel');
      expect(envelope.payload).toEqual({ runId: 'op-legacy-1' });
      return {
        runId: 'run-88',
        sessionId: 'session-1',
        state: 'cancelled',
        updatedAt: '2026-08-27T01:00:00.000Z',
      };
    });
    const adapter = new LegacyAgentCompatAdapter({
      legacyPort: createLegacyPort().port,
      runtimeFacade: facade,
      isEnabled: () => true,
    });

    const view = await adapter.cancelOperation('op-legacy-1');

    expect(view).toMatchObject({
      operationId: 'op-legacy-1',
      runId: 'run-88',
      status: 'interrupted',
      completionReason: 'interrupted',
      completedAt: '2026-08-27T01:00:00.000Z',
    });
    expect(view.agentId).toBeUndefined();
  });

  it('propagates not-found semantics and coded facade rejections on get', async () => {
    configureRuntimeV1AgentOpsFlag(true);
    const facade = facadeReturning(async (envelope) => {
      if (envelope.command === 'run.get') return null;
      throw Object.assign(new Error('run does not exist'), { code: 'RUN_NOT_FOUND' });
    });
    const adapter = new LegacyAgentCompatAdapter({
      legacyPort: createLegacyPort().port,
      runtimeFacade: facade,
      isEnabled: () => true,
    });

    await expect(adapter.getOperation('gone-op')).resolves.toBe(null);
    await expect(adapter.cancelOperation('gone-op')).rejects.toMatchObject({
      code: 'RUN_NOT_FOUND',
    });
  });

  it('tolerates missing optional snapshot fields while keeping required identity intact', async () => {
    configureRuntimeV1AgentOpsFlag(true);
    const facade = facadeReturning(() => ({
      runId: 'run-bare',
      sessionId: 'session-bare',
      state: 'waiting_human',
    }));
    const adapter = new LegacyAgentCompatAdapter({
      legacyPort: createLegacyPort().port,
      runtimeFacade: facade,
      isEnabled: () => true,
    });

    const view = await adapter.getOperation('whatever');

    // The requested legacy id stays the caller-facing identity; the runtime
    // runId is preserved separately rather than replacing it.
    expect(view).toEqual({
      operationId: 'whatever',
      status: 'waiting_for_human',
      completionReason: 'waiting_for_human',
      sessionId: 'session-bare',
      runId: 'run-bare',
      source: 'runtime.v1',
    });
  });

  it('throws LEGACY_COMPAT_INVALID_INPUT for incomplete legacy inputs without calling the facade', async () => {
    configureRuntimeV1AgentOpsFlag(true);
    const facade = facadeReturning(() => fullSnapshot());
    const adapter = new LegacyAgentCompatAdapter({
      legacyPort: createLegacyPort().port,
      runtimeFacade: facade,
      isEnabled: () => true,
    });

    await expect(adapter.startOperation({ ...startInput(), sessionId: '' })).rejects.toMatchObject({
      code: 'LEGACY_COMPAT_INVALID_INPUT',
      path: 'sessionId',
    });
    await expect(
      adapter.startOperation({ ...startInput(), agentId: undefined }),
    ).rejects.toBeInstanceOf(LegacyCompatError);
    expect(facade.handle).not.toHaveBeenCalled();

    // The same input remains acceptable on the legacy path.
    resetRuntimeV1AgentOpsFlag();
  });

  it('wraps a malformed facade response as LEGACY_COMPAT_RESPONSE_INVALID', async () => {
    configureRuntimeV1AgentOpsFlag(true);
    const facade = facadeReturning(() => ({ hello: 'world' }));
    const adapter = new LegacyAgentCompatAdapter({
      legacyPort: createLegacyPort().port,
      runtimeFacade: facade,
      isEnabled: () => true,
    });

    await expect(adapter.startOperation(startInput())).rejects.toMatchObject({
      code: 'LEGACY_COMPAT_RESPONSE_INVALID',
    });
  });

  it('resumes via run.resume when mapped and falls back to the legacy port when unmapped', async () => {
    configureRuntimeV1AgentOpsFlag(true);
    const legacy = createLegacyPort();
    const resumeSpy = vi.fn(async () => legacyView({ status: 'done' }));
    const portWithResume = { ...legacy.port, resume: resumeSpy } as LegacyAgentOperationPort;

    const facade = facadeReturning((envelope) => {
      expect(envelope.command).toBe('run.resume');
      expect(envelope.payload).toEqual({ runId: 'op-r', input: 'continue please' });
      return {
        runId: 'run-rr',
        sessionId: 'session-1',
        state: 'completed',
        profileId: 'agent-1',
        metadata: { operationId: 'op-r' },
      };
    });
    const adapter = new LegacyAgentCompatAdapter({
      legacyPort: portWithResume,
      runtimeFacade: facade,
      isEnabled: () => true,
    });
    await expect(
      adapter.resumeOperation('op-r', { input: 'continue please' }),
    ).resolves.toMatchObject({
      operationId: 'op-r',
      agentId: 'agent-1',
      status: 'done',
    });

    // Off-path: injected port without resume surfaces a stable compat error.
    configureRuntimeV1AgentOpsFlag(false);
    const plainAdapter = new LegacyAgentCompatAdapter({
      legacyPort: legacy.port,
      runtimeFacade: facadeReturning(() => null),
      isEnabled: () => false,
    });
    await expect(plainAdapter.resumeOperation('op-r', { input: 'x' })).rejects.toMatchObject({
      code: 'LEGACY_COMPAT_RUNTIME_FAILED',
    });
  });
});
