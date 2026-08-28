import { describe, expect, it } from 'vitest';

import { AgentStrategyRegistry } from './index';
import type { RuntimeEvent } from './run';
import type { AgentStrategyPlugin, RunContext, StrategyInput } from './strategy';

const context: RunContext = { runId: 'run-1', sessionId: 'session-1' };
const input: StrategyInput = { runId: 'run-1', userMessage: 'hello' };

const event = (seq: number, type = 'run.token'): RuntimeEvent => ({
  protocol_version: 'runtime.v1',
  session_id: 'session-1',
  run_id: 'run-1',
  seq,
  type,
  data: { seq },
});

const collect = async (stream: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> => {
  const events: RuntimeEvent[] = [];
  for await (const value of stream) events.push(value);
  return events;
};

describe('@lobechat/cordis-kernel AgentStrategyRegistry', () => {
  it('registers a strategy and creates its driver with the RunContext', () => {
    let received: RunContext | undefined;
    const plugin: AgentStrategyPlugin = {
      id: 'general-chat',
      createDriver: (value) => {
        received = value;
        return { execute: async function* () {} };
      },
    };
    const registry = new AgentStrategyRegistry();

    registry.register(plugin);
    const driver = registry.createDriver('general-chat', context);

    expect(registry.list()).toEqual(['general-chat']);
    expect(registry.get('general-chat')).toBe(plugin);
    expect(received).toBe(context);
    expect(driver).toBeDefined();
  });

  it('rejects duplicate strategy ids with STRATEGY_DUPLICATE', () => {
    const registry = new AgentStrategyRegistry();
    const plugin: AgentStrategyPlugin = {
      id: 'duplicate',
      createDriver: () => ({ execute: async function* () {} }),
    };

    registry.register(plugin);
    expect(() => registry.register(plugin)).toThrow(
      expect.objectContaining({ code: 'STRATEGY_DUPLICATE' }),
    );
  });

  it('reports STRATEGY_NOT_FOUND for an unknown strategy', () => {
    const registry = new AgentStrategyRegistry();

    expect(() => registry.createDriver('missing', context)).toThrow(
      expect.objectContaining({ code: 'STRATEGY_NOT_FOUND' }),
    );
  });

  it('executes a selected driver as an AsyncIterable of RuntimeEvent', async () => {
    const registry = new AgentStrategyRegistry();
    registry.register({
      id: 'streaming',
      createDriver: () => ({
        execute: async function* (value) {
          expect(value).toBe(input);
          yield event(1);
          yield event(2, 'run.completed');
        },
      }),
    });

    const events = await collect(registry.execute('streaming', context, input));

    expect(events.map(({ seq }) => seq)).toEqual([1, 2]);
    expect(events[1]?.type).toBe('run.completed');
  });

  it('preserves the original createDriver error', () => {
    const failure = new Error('driver creation failed');
    const registry = new AgentStrategyRegistry();
    registry.register({
      id: 'broken-driver',
      createDriver: () => {
        throw failure;
      },
    });

    try {
      registry.createDriver('broken-driver', context);
      throw new Error('expected createDriver to fail');
    } catch (error) {
      expect(error).toBe(failure);
    }
  });

  it('preserves the original asynchronous driver error', async () => {
    const failure = new Error('driver execution failed');
    const registry = new AgentStrategyRegistry();
    registry.register({
      id: 'broken-execution',
      createDriver: () => ({
        // eslint-disable-next-line require-yield -- rejection-on-iteration is the behavior under test
        execute: async function* () {
          throw failure;
        },
      }),
    });

    await expect(collect(registry.execute('broken-execution', context, input))).rejects.toBe(
      failure,
    );
  });

  it('passes the strategy input to the selected driver without wrapping the stream', async () => {
    const stream: AsyncIterable<RuntimeEvent> = {
      async *[Symbol.asyncIterator]() {
        yield event(7, 'run.waiting_tool');
      },
    };
    let received: StrategyInput | undefined;
    const registry = new AgentStrategyRegistry();
    registry.register({
      id: 'identity',
      createDriver: () => ({
        execute: (value) => {
          received = value;
          return stream;
        },
      }),
    });

    const result = registry.execute('identity', context, input);

    expect(result).toBe(stream);
    expect(received).toBe(input);
  });
});
