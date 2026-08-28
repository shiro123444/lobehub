import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeFacadePort } from '../adapter';
import type { RuntimeFacadeFactoryResult } from '../factory';
import { createScopedLegacyAgentCompatAdapter } from './factory';
import { configureRuntimeV1AgentOpsFlag, resetRuntimeV1AgentOpsFlag } from './feature-flag';
import type { LegacyAgentOperationPort, LegacyAgentOperationView } from './types';
import { LegacyCompatError } from './types';

afterEach(() => {
  resetRuntimeV1AgentOpsFlag();
});

const baseScope = () => ({
  userId: 'user-1',
  sessionId: 'session-1',
  serverDB: { handle: 'db-stub' } as unknown,
  request: new Request('https://example.test/api/agent/operations'),
});

const legacyView = (
  overrides: Partial<LegacyAgentOperationView> = {},
): LegacyAgentOperationView => ({
  operationId: 'op-legacy-1',
  status: 'running',
  source: 'legacy',
  ...overrides,
});

const makeLegacyPort = (
  overrides: Partial<LegacyAgentOperationPort> = {},
): LegacyAgentOperationPort => ({
  start: vi.fn(async () => legacyView()),
  get: vi.fn(async () => legacyView({ status: 'idle' })),
  cancel: vi.fn(async () => legacyView({ status: 'interrupted' })),
  resume: vi.fn(async () => legacyView({ status: 'done' })),
  ...overrides,
});

const facadeReturningSnapshot = (): RuntimeFacadePort => ({
  handle: vi.fn(async () => ({
    runId: 'run-99',
    sessionId: 'session-1',
    state: 'completed',
    profileId: 'agent-1',
    metadata: { operationId: 'op-legacy-1' },
  })),
});

describe('C-29 scoped legacy agent compat construction', () => {
  it('rejects missing or forged scope fields with LEGACY_COMPAT_INVALID_INPUT before touching factories', () => {
    const legacyPortFactory = vi.fn();
    const runtimeFacadeFactory = vi.fn();

    const brokenScopes = [
      undefined,
      { ...baseScope(), userId: '' },
      { ...baseScope(), sessionId: '   ' },
      { ...baseScope(), serverDB: undefined },
      { ...baseScope(), request: undefined },
      { ...baseScope(), request: 'not-a-request' },
    ] as unknown as Parameters<typeof createScopedLegacyAgentCompatAdapter>[0][];

    for (const scope of brokenScopes) {
      expect(() =>
        createScopedLegacyAgentCompatAdapter(scope, {
          legacyPortFactory: legacyPortFactory as never,
          runtimeFacadeFactory,
        }),
      ).toThrowError(LegacyCompatError);
      try {
        createScopedLegacyAgentCompatAdapter(scope, {
          legacyPortFactory: legacyPortFactory as never,
          runtimeFacadeFactory,
        });
      } catch (error) {
        expect((error as LegacyCompatError).code).toBe('LEGACY_COMPAT_INVALID_INPUT');
      }
    }

    expect(legacyPortFactory).not.toHaveBeenCalled();
    expect(runtimeFacadeFactory).not.toHaveBeenCalled();
  });

  it('flag off: lazily builds the legacy port with {userId, sessionId} and never touches the runtime factory', async () => {
    configureRuntimeV1AgentOpsFlag(false);
    const port = makeLegacyPort();
    const legacyPortFactory = vi.fn(async () => port);
    const runtimeFacadeFactory = vi.fn(() => {
      throw new Error('runtime must not be touched while the flag is off');
    });
    const scope = baseScope();
    const adapter = createScopedLegacyAgentCompatAdapter(scope, {
      legacyPortFactory,
      runtimeFacadeFactory,
    });

    await expect(
      adapter.startOperation({
        userId: 'user-1',
        userMessage: 'hello',
        agentId: 'agent-1',
        sessionId: 'session-1',
        operationId: 'op-legacy-1',
      }),
    ).resolves.toMatchObject({ operationId: 'op-legacy-1', status: 'running', source: 'legacy' });
    await expect(adapter.getOperation('op-legacy-1')).resolves.toMatchObject({ status: 'idle' });
    await expect(adapter.cancelOperation('op-legacy-1')).resolves.toMatchObject({
      status: 'interrupted',
    });

    expect(legacyPortFactory).toHaveBeenCalledTimes(1);
    expect(legacyPortFactory).toHaveBeenCalledWith({ userId: 'user-1', sessionId: 'session-1' });
    expect(runtimeFacadeFactory).not.toHaveBeenCalled();
    // The bridge never leaks the request object or DB handle to the legacy side.
    expect(legacyPortFactory.mock.calls[0]?.[0]).not.toHaveProperty('request');
    expect(legacyPortFactory.mock.calls[0]?.[0]).not.toHaveProperty('serverDB');
  });

  it('flag on: lazily builds the runtime facade through the existing factory with the exact request scope and never touches legacy', async () => {
    configureRuntimeV1AgentOpsFlag(true);
    const facade = facadeReturningSnapshot();
    const runtimeFacadeFactory = vi.fn(() => facade);
    const legacyPortFactory = vi.fn(() => {
      throw new Error('legacy must not be touched while the flag is on');
    });
    const scope = baseScope();
    const adapter = createScopedLegacyAgentCompatAdapter(scope, {
      legacyPortFactory,
      runtimeFacadeFactory,
    });

    const view = await adapter.startOperation({
      userId: 'user-1',
      userMessage: 'hello',
      agentId: 'agent-1',
      sessionId: 'session-1',
      operationId: 'op-legacy-1',
    });

    expect(view).toMatchObject({
      operationId: 'op-legacy-1',
      agentId: 'agent-1',
      status: 'done',
      runId: 'run-99',
      source: 'runtime.v1',
    });
    expect(runtimeFacadeFactory).toHaveBeenCalledTimes(1);
    const factoryScope = runtimeFacadeFactory.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(factoryScope).toMatchObject({ userId: 'user-1', serverDB: scope.serverDB });
    expect(factoryScope.request).toBe(scope.request); // original object identity preserved
    expect(legacyPortFactory).not.toHaveBeenCalled();
  });

  it('memoizes each side per scope: repeated operations reuse the same port/facade without re-invoking factories', async () => {
    const port = makeLegacyPort();
    const legacyPortFactory = vi.fn(async () => port);
    const facade = facadeReturningSnapshot();
    const runtimeFacadeFactory = vi.fn(() => facade);

    // Off-path memoization.
    configureRuntimeV1AgentOpsFlag(false);
    const offAdapter = createScopedLegacyAgentCompatAdapter(baseScope(), {
      legacyPortFactory,
      runtimeFacadeFactory,
    });
    await offAdapter.getOperation('op-1');
    await offAdapter.getOperation('op-2');
    await offAdapter.cancelOperation('op-3');
    expect(legacyPortFactory).toHaveBeenCalledTimes(1);

    // On-path memoization with a separate adapter instance.
    configureRuntimeV1AgentOpsFlag(true);
    const onAdapter = createScopedLegacyAgentCompatAdapter(baseScope(), {
      legacyPortFactory,
      runtimeFacadeFactory,
    });
    await onAdapter.getOperation('op-1');
    await onAdapter.getOperation('op-2');
    await onAdapter.cancelOperation('op-3');
    expect(runtimeFacadeFactory).toHaveBeenCalledTimes(1);
    expect(facade.handle).toHaveBeenCalledTimes(3);
  });

  it('normalizes factory failures: coded errors pass through, unknown ones get the stable compat code', async () => {
    const codedFactory = vi.fn(() => {
      throw Object.assign(new Error('no scoped facade configured'), {
        code: 'RUNTIME_FACADE_UNAVAILABLE',
      });
    });
    configureRuntimeV1AgentOpsFlag(true);
    const codedAdapter = createScopedLegacyAgentCompatAdapter(baseScope(), {
      legacyPortFactory: vi.fn(),
      runtimeFacadeFactory: codedFactory,
    });
    await expect(codedAdapter.getOperation('op-1')).rejects.toMatchObject({
      code: 'RUNTIME_FACADE_UNAVAILABLE',
    });

    const brokenLegacyFactory = vi.fn(() => {
      throw new Error('legacy construction exploded');
    });
    configureRuntimeV1AgentOpsFlag(false);
    const brokenAdapter = createScopedLegacyAgentCompatAdapter(baseScope(), {
      legacyPortFactory: brokenLegacyFactory,
      runtimeFacadeFactory: vi.fn(),
    });
    await expect(brokenAdapter.getOperation('op-1')).rejects.toMatchObject({
      code: 'LEGACY_COMPAT_RUNTIME_FAILED',
    });
  });

  it('rejects structurally invalid factory outputs instead of executing anything', async () => {
    const garbageFacadeFactory = vi.fn(
      () => ({ nope: true }) as unknown as RuntimeFacadeFactoryResult,
    );
    configureRuntimeV1AgentOpsFlag(true);
    const garbageFacadeAdapter = createScopedLegacyAgentCompatAdapter(baseScope(), {
      legacyPortFactory: vi.fn(),
      runtimeFacadeFactory: garbageFacadeFactory,
    });
    await expect(garbageFacadeAdapter.getOperation('op-1')).rejects.toMatchObject({
      code: 'LEGACY_COMPAT_RUNTIME_FAILED',
      message: /RuntimeFacadeFactory/,
    });

    const garbagePortFactory = vi.fn(
      () => ({ start: 'not-a-function' }) as unknown as LegacyAgentOperationPort,
    );
    configureRuntimeV1AgentOpsFlag(false);
    const garbagePortAdapter = createScopedLegacyAgentCompatAdapter(baseScope(), {
      legacyPortFactory: garbagePortFactory,
      runtimeFacadeFactory: vi.fn(),
    });
    await expect(garbagePortAdapter.getOperation('op-1')).rejects.toMatchObject({
      code: 'LEGACY_COMPAT_RUNTIME_FAILED',
      message: /legacyPortFactory/,
    });
  });

  it('keeps the default flag behavior and per-adapter overrides working through the scoped construction', async () => {
    // Default (global env flag, unset) → legacy path, runtime untouched.
    const port = makeLegacyPort();
    const runtimeFacadeFactory = vi.fn();
    const defaultAdapter = createScopedLegacyAgentCompatAdapter(baseScope(), {
      legacyPortFactory: vi.fn(async () => port),
      runtimeFacadeFactory,
    });
    await defaultAdapter.getOperation('op-1');
    expect(runtimeFacadeFactory).not.toHaveBeenCalled();

    // Explicit per-adapter override wins over the global flag without env access.
    configureRuntimeV1AgentOpsFlag(false);
    const overriddenAdapter = createScopedLegacyAgentCompatAdapter(baseScope(), {
      legacyPortFactory: vi.fn(),
      runtimeFacadeFactory: vi.fn(() => facadeReturningSnapshot()),
      isEnabled: () => true,
    });
    await expect(overriddenAdapter.getOperation('op-1')).resolves.toMatchObject({
      source: 'runtime.v1',
    });

    // Reverse override: global on, adapter forces the legacy path.
    configureRuntimeV1AgentOpsFlag(true);
    const legacyForcedAdapter = createScopedLegacyAgentCompatAdapter(baseScope(), {
      legacyPortFactory: vi.fn(async () => port),
      runtimeFacadeFactory: vi.fn(),
      isEnabled: () => false,
    });
    await expect(legacyForcedAdapter.getOperation('op-1')).resolves.toMatchObject({
      source: 'legacy',
    });
  });

  it('forwards every adapter operation with arguments intact, including resume fallbacks', async () => {
    configureRuntimeV1AgentOpsFlag(false);
    const port = makeLegacyPort();
    const adapter = createScopedLegacyAgentCompatAdapter(baseScope(), {
      legacyPortFactory: vi.fn(async () => port),
      runtimeFacadeFactory: vi.fn(),
    });

    const startInput = {
      userId: 'user-1',
      userMessage: 'hello',
      agentId: 'agent-1',
      sessionId: 'session-1',
      operationId: 'op-legacy-1',
    };
    await adapter.startOperation(startInput);
    expect(port.start).toHaveBeenCalledWith(startInput);

    await adapter.resumeOperation('op-legacy-1', { input: 'continue' });
    expect(port.resume).toHaveBeenCalledWith('op-legacy-1', { input: 'continue' });

    // A legacy port without resume surfaces the stable compat error, lazily.
    const resumeless = createScopedLegacyAgentCompatAdapter(baseScope(), {
      legacyPortFactory: vi.fn(async () => makeLegacyPort({ resume: undefined })),
      runtimeFacadeFactory: vi.fn(),
    });
    await expect(resumeless.resumeOperation('op-legacy-1', { input: 'x' })).rejects.toMatchObject({
      code: 'LEGACY_COMPAT_RUNTIME_FAILED',
    });
  });
});
