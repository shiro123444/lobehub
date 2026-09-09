import { describe, expect, it, vi } from 'vitest';

import { Context } from './context';
import { CapabilityRegistry, CapabilityRegistryError, type CapabilityPort } from './capability';

const port = (id: string, value: unknown): CapabilityPort => ({
  id,
  descriptor: { id, capabilities: [`${id}.execute`], version: '1.0.0' },
  execute: vi.fn(async () => value),
});

describe('CapabilityRegistry', () => {
  it('registers, lists, gets and executes a capability through one deep port', async () => {
    const registry = new CapabilityRegistry();
    const context = new Context();
    const external = port('ppt-master', { jobId: 'job-1' });

    registry.register(context, external);
    expect(registry.list()).toEqual([
      { id: 'ppt-master', capabilities: ['ppt-master.execute'], version: '1.0.0' },
    ]);
    expect(registry.get('ppt-master')).toBe(external);
    await expect(
      registry.execute('ppt-master', { operation: 'create' }, { scope: 'user-1' }),
    ).resolves.toEqual({
      jobId: 'job-1',
    });
    expect(external.execute).toHaveBeenCalledWith({ operation: 'create' }, { scope: 'user-1' });
  });

  it('returns a Fiber-managed disposable and allows a different port to replace the old one', async () => {
    const registry = new CapabilityRegistry();
    const context = new Context();
    const first = port('external', 'first');
    const second = port('external', 'second');

    const dispose = registry.register(context, first);
    await dispose();
    registry.register(context, second);
    await expect(registry.execute('external', { operation: 'inspect' }, {})).resolves.toBe(
      'second',
    );
    expect(first.execute).not.toHaveBeenCalled();
    expect(second.execute).toHaveBeenCalledOnce();
  });

  it('rejects duplicates, missing ids and invalid structured commands with stable errors', async () => {
    const registry = new CapabilityRegistry();
    const context = new Context();
    registry.register(context, port('external', 'ok'));

    expect(() => registry.register(context, port('external', 'duplicate'))).toThrowError(
      expect.objectContaining({ code: 'CAPABILITY_DUPLICATE' }),
    );
    expect(() =>
      registry.register(context, {
        ...port('external-mismatch', 'invalid'),
        descriptor: { id: 'different-id' },
      }),
    ).toThrowError(expect.objectContaining({ code: 'CAPABILITY_INVALID_COMMAND' }));
    expect(() => registry.get('missing')).toThrowError(
      expect.objectContaining({ code: 'CAPABILITY_NOT_FOUND' }),
    );
    await expect(registry.unregister('missing')).rejects.toMatchObject({
      code: 'CAPABILITY_NOT_FOUND',
    });
    await expect(registry.execute('external', undefined, {})).rejects.toMatchObject({
      code: 'CAPABILITY_INVALID_COMMAND',
    });
  });

  it('passes adapter errors through unchanged and awaits asynchronous unregister disposal', async () => {
    const registry = new CapabilityRegistry();
    const context = new Context();
    const error = new Error('external provider failed');
    let released = false;
    const failing: CapabilityPort = {
      id: 'failing',
      execute: vi.fn(async () => Promise.reject(error)),
      dispose: async () => {
        await Promise.resolve();
        released = true;
      },
    };
    registry.register(context, failing);

    await expect(registry.execute('failing', { operation: 'run' }, {})).rejects.toBe(error);
    await registry.unregister('failing');
    expect(released).toBe(true);
    expect(registry.list()).toEqual([]);
    await expect(registry.unregister('failing')).rejects.toMatchObject({
      code: 'CAPABILITY_NOT_FOUND',
    });
  });
});
