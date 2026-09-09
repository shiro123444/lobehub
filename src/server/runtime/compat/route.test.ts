import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createLegacyAgentRouteSelector,
  evaluateRuntimeV1AgentOpsFlag,
  type LegacyAgentRouteScope,
} from './route';
import { configureRuntimeV1AgentOpsFlag, resetRuntimeV1AgentOpsFlag } from './feature-flag';
import { LegacyCompatError } from './types';
import type { LegacyAgentOperationPort, LegacyAgentOperationView } from './types';
import type { RuntimeFacadePort } from '../adapter';

afterEach(() => {
  resetRuntimeV1AgentOpsFlag();
});

const baseScope = (overrides: Partial<LegacyAgentRouteScope> = {}): LegacyAgentRouteScope => ({
  userId: 'user-1',
  sessionId: 'session-1',
  serverDB: { handle: 'db-stub' } as unknown,
  request: new Request('https://example.test/api/agent/operations', { method: 'POST' }),
  ...overrides,
});

const legacyView = (
  overrides: Partial<LegacyAgentOperationView> = {},
): LegacyAgentOperationView => ({
  operationId: 'op-legacy-1',
  status: 'running',
  source: 'legacy',
  ...overrides,
});

const makeLegacyPort = (): LegacyAgentOperationPort => ({
  start: vi.fn(async () => legacyView()),
  get: vi.fn(async () => legacyView({ status: 'idle' })),
  cancel: vi.fn(async () => legacyView({ status: 'interrupted' })),
  resume: vi.fn(async () => legacyView({ status: 'done' })),
});

const makeFacade = (): { facade: RuntimeFacadePort; handle: ReturnType<typeof vi.fn> } => {
  const handle = vi.fn(async () => ({
    runId: 'run-42',
    sessionId: 'session-1',
    state: 'completed',
    profileId: 'agent-1',
    metadata: { operationId: 'op-legacy-1' },
  }));
  return { facade: { handle }, handle };
};

const startInput = () => ({
  userId: 'user-1',
  userMessage: 'hello',
  agentId: 'agent-1',
  sessionId: 'session-1',
  operationId: 'op-legacy-1',
});

describe('C-35 legacy aiAgent route selection', () => {
  it('flag off (default): strictly legacy — runtime factory is never touched', async () => {
    const port = makeLegacyPort();
    const legacyFactory = vi.fn(async (_scope: LegacyAgentRouteScope) => port);
    const runtimeFactory = vi.fn(() => {
      throw new Error('runtime must not be touched while the flag is off');
    });
    const selector = createLegacyAgentRouteSelector({
      legacyFactory,
      runtimeFactory,
      resolveFlag: () => false,
    });

    const selection = selector.select(baseScope());
    expect(selection.route).toBe('legacy');
    // Laziness: nothing materializes at select() time.
    expect(legacyFactory).not.toHaveBeenCalled();
    expect(runtimeFactory).not.toHaveBeenCalled();

    const view = await selection.adapter.startOperation(startInput());
    expect(view).toMatchObject({ operationId: 'op-legacy-1', status: 'running', source: 'legacy' });
    expect(legacyFactory).toHaveBeenCalledTimes(1);
    expect(legacyFactory.mock.calls[0]?.[0]).toBe(selection.scope);
    expect(runtimeFactory).not.toHaveBeenCalled();
  });

  it('flag on: only runtime — legacy factory is never touched and the facade gets runtime.v1 envelopes', async () => {
    const { facade, handle } = makeFacade();
    const legacyFactory = vi.fn(() => {
      throw new Error('legacy must not be touched while the flag is on');
    });
    const runtimeFactory = vi.fn(async () => facade);
    const selector = createLegacyAgentRouteSelector({
      legacyFactory,
      runtimeFactory,
      resolveFlag: () => true,
    });

    const selection = selector.select(baseScope());
    expect(selection.route).toBe('runtime.v1');
    expect(legacyFactory).not.toHaveBeenCalled();

    const view = await selection.adapter.startOperation(startInput());
    expect(view).toMatchObject({
      operationId: 'op-legacy-1',
      agentId: 'agent-1',
      status: 'done',
      runId: 'run-42',
      source: 'runtime.v1',
    });
    expect(handle).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'run.start', protocol_version: 'runtime.v1' }),
    );
    expect(legacyFactory).not.toHaveBeenCalled();
  });

  it('supports central user allow-lists via evaluateRuntimeV1AgentOpsFlag', async () => {
    // Allow-list semantics mirror the central config shape.
    const allowlist = ['user-1', 'user-3'];
    expect(evaluateRuntimeV1AgentOpsFlag(allowlist, 'user-1')).toBe(true);
    expect(evaluateRuntimeV1AgentOpsFlag(allowlist, 'user-2')).toBe(false);
    expect(evaluateRuntimeV1AgentOpsFlag(true, 'user-2')).toBe(true);
    expect(evaluateRuntimeV1AgentOpsFlag(false, 'user-1')).toBe(false);
    expect(evaluateRuntimeV1AgentOpsFlag(undefined, 'user-1')).toBe(false); // absent = off

    const port = makeLegacyPort();
    const legacyFactory = vi.fn(async () => port);
    const { facade } = makeFacade();
    const runtimeFactory = vi.fn(async () => facade);
    const selector = createLegacyAgentRouteSelector({
      legacyFactory,
      runtimeFactory,
      resolveFlag: ({ userId }) => evaluateRuntimeV1AgentOpsFlag(allowlist, userId),
    });

    const runtimeSelection = selector.select(baseScope({ userId: 'user-1' }));
    expect(runtimeSelection.route).toBe('runtime.v1');
    await runtimeSelection.adapter.getOperation('op-1');
    expect(legacyFactory).not.toHaveBeenCalled();

    const legacySelection = selector.select(
      baseScope({ userId: 'user-2', sessionId: 'session-2' }),
    );
    expect(legacySelection.route).toBe('legacy');
    await legacySelection.adapter.getOperation('op-1');
    expect(runtimeFactory).toHaveBeenCalledTimes(1); // untouched by user-2's selection
  });

  it('factories are lazy and memoized per selection — never double-executed', async () => {
    const port = makeLegacyPort();
    const legacyFactory = vi.fn(async () => port);
    const { facade, handle } = makeFacade();
    const runtimeFactory = vi.fn(async () => facade);
    const selector = createLegacyAgentRouteSelector({
      legacyFactory,
      runtimeFactory,
      resolveFlag: () => false,
    });

    const selection = selector.select(baseScope());
    await selection.adapter.getOperation('op-1');
    await selection.adapter.cancelOperation('op-2');
    await selection.adapter.startOperation(startInput());
    expect(legacyFactory).toHaveBeenCalledTimes(1);
    expect(port.get).toHaveBeenCalledTimes(1);
    expect(port.cancel).toHaveBeenCalledTimes(1);
    expect(port.start).toHaveBeenCalledTimes(1);
    expect(runtimeFactory).not.toHaveBeenCalled();

    const runtimeSelector = createLegacyAgentRouteSelector({
      legacyFactory,
      runtimeFactory,
      resolveFlag: () => true,
    });
    const runtimeSelection = runtimeSelector.select(baseScope());
    await runtimeSelection.adapter.getOperation('op-1');
    await runtimeSelection.adapter.getOperation('op-2');
    expect(runtimeFactory).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledTimes(2);
    expect(legacyFactory).toHaveBeenCalledTimes(1); // unchanged by runtime selections
  });

  it('preserves real error codes from both factories (no swallowing, no re-wrapping of coded errors)', async () => {
    const codedLegacyFactory = vi.fn(() => {
      throw Object.assign(new Error('legacy port unavailable'), { code: 'LEGACY_PORT_DOWN' });
    });
    const selector = createLegacyAgentRouteSelector({
      legacyFactory: codedLegacyFactory,
      runtimeFactory: vi.fn(),
      resolveFlag: () => false,
    });
    await expect(selector.select(baseScope()).adapter.getOperation('op-1')).rejects.toMatchObject({
      code: 'LEGACY_PORT_DOWN',
    });

    const codedRuntimeFactory = vi.fn(() => {
      throw Object.assign(new Error('no scoped facade'), { code: 'RUNTIME_FACADE_UNAVAILABLE' });
    });
    const runtimeSelector = createLegacyAgentRouteSelector({
      legacyFactory: vi.fn(),
      runtimeFactory: codedRuntimeFactory,
      resolveFlag: () => true,
    });
    await expect(
      runtimeSelector.select(baseScope()).adapter.getOperation('op-1'),
    ).rejects.toMatchObject({
      code: 'RUNTIME_FACADE_UNAVAILABLE',
    });
  });

  it('rejects structurally invalid factory outputs with the stable compat code', async () => {
    const selector = createLegacyAgentRouteSelector({
      legacyFactory: vi.fn(async () => ({ start: 'nope' }) as unknown as LegacyAgentOperationPort),
      runtimeFactory: vi.fn(),
      resolveFlag: () => false,
    });
    await expect(selector.select(baseScope()).adapter.getOperation('op-1')).rejects.toMatchObject({
      code: 'LEGACY_COMPAT_RUNTIME_FAILED',
      message: /legacyFactory/,
    });

    const runtimeSelector = createLegacyAgentRouteSelector({
      legacyFactory: vi.fn(),
      runtimeFactory: vi.fn(async () => ({ nope: true }) as never),
      resolveFlag: () => true,
    });
    await expect(
      runtimeSelector.select(baseScope()).adapter.getOperation('op-1'),
    ).rejects.toMatchObject({
      code: 'LEGACY_COMPAT_RUNTIME_FAILED',
      message: /runtimeFactory/,
    });
  });

  it('keeps selections scope-isolated: factories receive their own scope by identity', async () => {
    const portA = makeLegacyPort();
    const portB = makeLegacyPort();
    const legacyFactory = vi.fn(async (scope: LegacyAgentRouteScope) =>
      scope.userId === 'user-a' ? portA : portB,
    );
    const selector = createLegacyAgentRouteSelector({
      legacyFactory,
      runtimeFactory: vi.fn(),
      resolveFlag: () => false,
    });

    const scopeA = baseScope({ userId: 'user-a', sessionId: 'session-a' });
    const scopeB = baseScope({ userId: 'user-b', sessionId: 'session-b' });
    const selectionA = selector.select(scopeA);
    const selectionB = selector.select(scopeB);
    expect(selectionA.scope).toBe(scopeA);
    expect(selectionB.scope).toBe(scopeB);

    await selectionB.adapter.getOperation('op-b');
    expect(legacyFactory).toHaveBeenCalledTimes(1);
    expect(legacyFactory.mock.calls[0]?.[0]).toBe(scopeB); // identity, not a copy
    expect(portB.get).toHaveBeenCalledTimes(1);
    expect(portA.get).not.toHaveBeenCalled();

    await selectionA.adapter.getOperation('op-a');
    expect(legacyFactory).toHaveBeenCalledTimes(2);
    expect(legacyFactory.mock.calls[1]?.[0]).toBe(scopeA);
    expect(portA.get).toHaveBeenCalledTimes(1);
    expect(portB.get).toHaveBeenCalledTimes(1); // A's op did not re-invoke B's memo
  });

  it('rollback: closing the flag routes new requests strictly to legacy while env flag stays on', async () => {
    configureRuntimeV1AgentOpsFlag(true); // env/global flag says ON
    const port = makeLegacyPort();
    const legacyFactory = vi.fn(async () => port);
    const runtimeFactory = vi.fn(async () => makeFacade().facade);
    const flagState = { on: true };
    const selector = createLegacyAgentRouteSelector({
      legacyFactory,
      runtimeFactory,
      resolveFlag: () => flagState.on,
    });

    const runtimeSelection = selector.select(baseScope());
    expect(runtimeSelection.route).toBe('runtime.v1');
    await runtimeSelection.adapter.getOperation('op-1');
    expect(runtimeFactory).toHaveBeenCalledTimes(1);

    // Rollback: central flag off → new requests strictly legacy, env ignored.
    flagState.on = false;
    const legacySelection = selector.select(baseScope());
    expect(legacySelection.route).toBe('legacy');
    await legacySelection.adapter.getOperation('op-2');
    expect(runtimeFactory).toHaveBeenCalledTimes(1); // untouched
    expect(port.get).toHaveBeenCalledTimes(1);
  });

  it('freezes the boundary decision: later env flag flips cannot flip a live selection mid-flight', async () => {
    configureRuntimeV1AgentOpsFlag(false);
    const { facade } = makeFacade();
    const runtimeFactory = vi.fn(async () => facade);
    const legacyFactory = vi.fn(() => {
      throw new Error('legacy must not be touched after a runtime selection');
    });
    const selector = createLegacyAgentRouteSelector({
      legacyFactory,
      runtimeFactory,
      resolveFlag: () => true,
    });

    const selection = selector.select(baseScope());
    await selection.adapter.getOperation('op-1');
    expect(runtimeFactory).toHaveBeenCalledTimes(1);

    // Global env flag flips off after selection; the frozen decision holds.
    configureRuntimeV1AgentOpsFlag(true);
    resetRuntimeV1AgentOpsFlag();
    await selection.adapter.getOperation('op-2');
    expect(legacyFactory).not.toHaveBeenCalled();
    expect(runtimeFactory).toHaveBeenCalledTimes(1);
  });

  it('propagates flag resolver failures untouched and rejects non-boolean outcomes', () => {
    const resolverError = Object.assign(new Error('central config unavailable'), {
      code: 'CENTRAL_FLAG_DOWN',
    });
    const selector = createLegacyAgentRouteSelector({
      legacyFactory: vi.fn(),
      runtimeFactory: vi.fn(),
      resolveFlag: () => {
        throw resolverError;
      },
    });
    try {
      selector.select(baseScope());
      throw new Error('expected resolver error to propagate');
    } catch (error) {
      expect(error).toBe(resolverError); // identity passthrough, untouched
    }

    const lyingResolver = createLegacyAgentRouteSelector({
      legacyFactory: vi.fn(),
      runtimeFactory: vi.fn(),
      resolveFlag: () => 'yes' as unknown as boolean,
    });
    try {
      lyingResolver.select(baseScope());
      throw new Error('expected non-boolean flag to throw');
    } catch (error) {
      expect((error as LegacyCompatError).code).toBe('LEGACY_COMPAT_INVALID_INPUT');
      expect((error as LegacyCompatError).path).toBe('resolveFlag');
    }
  });

  it('validates the scope and selector options before any decision or materialization', () => {
    const legacyFactory = vi.fn(async () => makeLegacyPort());
    const runtimeFactory = vi.fn(async () => makeFacade().facade);
    const resolveFlag = vi.fn(() => false);

    expect(() =>
      createLegacyAgentRouteSelector({
        legacyFactory: undefined as never,
        runtimeFactory,
        resolveFlag,
      }),
    ).toThrowError(LegacyCompatError);
    expect(() =>
      createLegacyAgentRouteSelector({
        legacyFactory,
        runtimeFactory: undefined as never,
        resolveFlag,
      }),
    ).toThrowError(LegacyCompatError);

    const selector = createLegacyAgentRouteSelector({ legacyFactory, runtimeFactory, resolveFlag });
    for (const broken of [
      baseScope({ userId: '' }),
      baseScope({ sessionId: '' }),
      baseScope({ serverDB: undefined }),
      baseScope({ request: 'nope' as unknown as Request }),
    ]) {
      try {
        selector.select(broken);
        throw new Error('expected scope validation to throw');
      } catch (error) {
        expect((error as LegacyCompatError).code).toBe('LEGACY_COMPAT_INVALID_INPUT');
      }
    }
    expect(resolveFlag).not.toHaveBeenCalled();
    expect(legacyFactory).not.toHaveBeenCalled();
    expect(runtimeFactory).not.toHaveBeenCalled();
  });

  it('select() stays synchronous: no await surfaces, no default-flag fallback surprise', async () => {
    // Default resolver falls back to the C-21 env flag (off by default).
    const port = makeLegacyPort();
    const legacyFactory = vi.fn(async () => port);
    const runtimeFactory = vi.fn(async () => makeFacade().facade);
    const selector = createLegacyAgentRouteSelector({ legacyFactory, runtimeFactory });

    const selection = selector.select(baseScope()); // no await anywhere
    expect(selection).not.toBeInstanceOf(Promise);
    expect(selection.route).toBe('legacy');
    expect(legacyFactory).not.toHaveBeenCalled();
    await selection.adapter.getOperation('op-1');
    expect(port.get).toHaveBeenCalledTimes(1);
  });
});
