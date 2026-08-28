import { describe, expect, it } from 'vitest';

import { PolicyEvaluator } from './index';

describe('@lobechat/cordis-kernel PolicyEvaluator', () => {
  it('allows an exact declared permission and reports the matched pattern', () => {
    const evaluator = new PolicyEvaluator({ network: ['https://api.example.test'] });

    expect(evaluator.evaluate('network', 'https://api.example.test')).toEqual({
      decision: 'allow',
      kind: 'network',
      resource: 'https://api.example.test',
      matchedPattern: 'https://api.example.test',
    });
    expect(evaluator.allow('network', 'https://api.example.test')).toBe(true);
    expect(evaluator.deny('network', 'https://api.example.test')).toBe(false);
  });

  it('denies undeclared permissions by default with an actionable error', () => {
    const evaluator = new PolicyEvaluator({ network: ['https://api.example.test'] });

    expect(evaluator.allow('tools', 'search')).toBe(false);
    expect(evaluator.deny('tools', 'search')).toBe(true);
    expect(() => evaluator.assertAllowed('tools', 'search')).toThrow(
      expect.objectContaining({
        code: 'POLICY_DENIED',
        kind: 'tools',
        path: 'permissions.tools',
        resource: 'search',
      }),
    );
  });

  it('matches wildcard permission patterns without allowing another prefix', () => {
    const evaluator = new PolicyEvaluator({ network: ['https://*.example.test/*'] });

    expect(evaluator.allow('network', 'https://api.example.test/v1/models')).toBe(true);
    expect(evaluator.allow('network', 'https://api.other.test/v1/models')).toBe(false);
  });

  it('matches every PermissionManifest capability category', () => {
    const evaluator = new PolicyEvaluator({
      network: ['network.example'],
      filesystem: ['/tmp/allowed/*'],
      tools: ['search'],
      device: ['camera:front'],
      uiSlots: ['canvas.main'],
    });

    expect(evaluator.allow('network', 'network.example')).toBe(true);
    expect(evaluator.allow('filesystem', '/tmp/allowed/file.txt')).toBe(true);
    expect(evaluator.allow('tools', 'search')).toBe(true);
    expect(evaluator.allow('device', 'camera:front')).toBe(true);
    expect(evaluator.allow('uiSlots', 'canvas.main')).toBe(true);
  });

  it('applies a deny overlay before the combined allow manifests', () => {
    const evaluator = new PolicyEvaluator(
      [{ network: ['https://api.example.test/*'], tools: ['search'] }, { tools: ['summarize'] }],
      { deny: { network: ['https://api.example.test/private/*'], tools: ['search'] } },
    );

    expect(evaluator.allow('network', 'https://api.example.test/public')).toBe(true);
    expect(evaluator.deny('network', 'https://api.example.test/private/token')).toBe(true);
    expect(evaluator.deny('tools', 'search')).toBe(true);
    expect(evaluator.allow('tools', 'summarize')).toBe(true);
  });

  it('keeps repeated allow and deny checks idempotent', () => {
    const evaluator = new PolicyEvaluator({ tools: ['search'] });
    const allowed = evaluator.evaluate('tools', 'search');
    const denied = evaluator.evaluate('tools', 'write');

    expect(evaluator.evaluate('tools', 'search')).toEqual(allowed);
    expect(evaluator.evaluate('tools', 'write')).toEqual(denied);
    expect([evaluator.allow('tools', 'search'), evaluator.allow('tools', 'search')]).toEqual([
      true,
      true,
    ]);
  });

  it('wraps a slow operation and reports POLICY_TIMEOUT with its target', async () => {
    const evaluator = new PolicyEvaluator({ tools: ['slow'] });
    const pending = new Promise<string>(() => {});

    await expect(
      evaluator.execute('tools', 'slow', () => pending, { timeoutMs: 10 }),
    ).rejects.toMatchObject({
      code: 'POLICY_TIMEOUT',
      kind: 'tools',
      resource: 'slow',
    });
  });

  it('resolves an operation that completes before the timeout', async () => {
    const evaluator = new PolicyEvaluator({ tools: ['fast'] });

    await expect(
      evaluator.execute('tools', 'fast', () => Promise.resolve('ok'), { timeoutMs: 50 }),
    ).resolves.toBe('ok');
  });

  it('truncates oversized results while retaining an explicit marker', async () => {
    const evaluator = new PolicyEvaluator({ tools: ['large'] });

    const result = await evaluator.execute('tools', 'large', () => 'abcdefgh', {
      maxResultBytes: 5,
    });

    expect(result).toMatchObject({
      truncated: true,
      value: 'abcde',
      result: 'abcde',
      maxBytes: 5,
      originalBytes: 8,
    });
  });

  it('returns an unmodified result when it is within the truncation limit', async () => {
    const evaluator = new PolicyEvaluator({ tools: ['small'] });
    const value = { ok: true, items: ['one'] };

    await expect(
      evaluator.execute('tools', 'small', () => value, { maxResultBytes: 100 }),
    ).resolves.toBe(value);
  });

  it('does not invoke a denied operation and preserves its permission path', async () => {
    const evaluator = new PolicyEvaluator({ tools: ['read'] });
    let invoked = false;

    await expect(
      evaluator.execute('tools', 'write', () => {
        invoked = true;
        return 'should not run';
      }),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED', path: 'permissions.tools' });
    expect(invoked).toBe(false);
  });

  it('preserves the original operation error', async () => {
    const evaluator = new PolicyEvaluator({ tools: ['broken'] });
    const failure = new Error('tool failed');

    await expect(evaluator.execute('tools', 'broken', () => Promise.reject(failure))).rejects.toBe(
      failure,
    );
  });

  it('reports invalid target paths without executing anything', () => {
    const evaluator = new PolicyEvaluator();

    expect(() => evaluator.allow('unknown' as never, 'resource')).toThrow(
      expect.objectContaining({ code: 'POLICY_INVALID', path: 'kind' }),
    );
    expect(() => evaluator.allow('tools', '')).toThrow(
      expect.objectContaining({ code: 'POLICY_INVALID', path: 'resource' }),
    );
  });
});
