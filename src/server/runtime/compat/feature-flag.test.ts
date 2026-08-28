// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getServerFeatureFlagsFromRuntimeConfig } from '@/server/featureFlags';

import {
  configureRuntimeV1AgentOpsFlag,
  configureRuntimeV1AgentOpsRuntimeConfig,
  isRuntimeV1AgentOpsEnabled,
  isRuntimeV1AgentOpsEnabledForUser,
  resetRuntimeV1AgentOpsFlag,
  resetRuntimeV1AgentOpsRuntimeConfig,
} from './feature-flag';

vi.mock('@/server/featureFlags', () => ({
  getServerFeatureFlagsFromRuntimeConfig: vi.fn(),
}));

const centralResolver = vi.mocked(getServerFeatureFlagsFromRuntimeConfig);

afterEach(() => {
  resetRuntimeV1AgentOpsFlag();
  resetRuntimeV1AgentOpsRuntimeConfig();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('C-30 runtime_v1_agent_ops feature flag', () => {
  it('defaults to disabled when central config and the compatibility env are absent', async () => {
    centralResolver.mockResolvedValue({});

    await expect(isRuntimeV1AgentOpsEnabledForUser('user-1')).resolves.toBe(false);
    expect(isRuntimeV1AgentOpsEnabled()).toBe(false);
  });

  it('uses RUNTIME_V1_AGENT_OPS as the fallback when central config omits the flag', async () => {
    vi.stubEnv('RUNTIME_V1_AGENT_OPS', 'on');
    centralResolver.mockResolvedValue({});

    await expect(isRuntimeV1AgentOpsEnabledForUser('user-1')).resolves.toBe(true);
    expect(isRuntimeV1AgentOpsEnabled()).toBe(true);
  });

  it('uses the production default resolver absence as the env fallback sentinel', async () => {
    vi.stubEnv('RUNTIME_V1_AGENT_OPS', '1');
    // This is the shape returned after DEFAULT_FEATURE_FLAGS is merged when
    // RuntimeConfig has no explicit runtime_v1_agent_ops value.
    centralResolver.mockResolvedValue({});

    await expect(isRuntimeV1AgentOpsEnabledForUser('user-default')).resolves.toBe(true);
  });

  it('does not let the compatibility env override an explicit central false', async () => {
    vi.stubEnv('RUNTIME_V1_AGENT_OPS', 'on');
    centralResolver.mockResolvedValue({ runtime_v1_agent_ops: false });

    await expect(isRuntimeV1AgentOpsEnabledForUser('user-explicitly-off')).resolves.toBe(false);
  });

  it('honours a central global boolean before the compatibility env', async () => {
    vi.stubEnv('RUNTIME_V1_AGENT_OPS', 'false');
    centralResolver.mockResolvedValue({ runtime_v1_agent_ops: true });

    await expect(isRuntimeV1AgentOpsEnabledForUser('user-1')).resolves.toBe(true);
    expect(centralResolver).toHaveBeenCalledWith('user-1');
  });

  it('evaluates a central user allowlist with the existing FeatureFlagValue semantics', async () => {
    centralResolver.mockImplementation(async (userId) => ({
      runtime_v1_agent_ops: ['user-allowed'],
      requestedUser: userId,
    }));

    await expect(isRuntimeV1AgentOpsEnabledForUser('user-allowed')).resolves.toBe(true);
    await expect(isRuntimeV1AgentOpsEnabledForUser('user-denied')).resolves.toBe(false);
    expect(centralResolver).toHaveBeenLastCalledWith('user-denied');
  });

  it('honours a user override returned by the central RuntimeConfig merge', async () => {
    vi.stubEnv('RUNTIME_V1_AGENT_OPS', 'on');
    centralResolver.mockImplementation(async (userId) => ({
      runtime_v1_agent_ops: userId === 'user-disabled' ? false : true,
    }));

    await expect(isRuntimeV1AgentOpsEnabledForUser('user-enabled')).resolves.toBe(true);
    await expect(isRuntimeV1AgentOpsEnabledForUser('user-disabled')).resolves.toBe(false);
  });

  it('fails closed when RuntimeConfig rejects or returns a malformed value', async () => {
    vi.stubEnv('RUNTIME_V1_AGENT_OPS', 'on');
    centralResolver.mockRejectedValueOnce(new Error('runtime config unavailable'));
    await expect(isRuntimeV1AgentOpsEnabledForUser('user-1')).resolves.toBe(false);

    centralResolver.mockResolvedValue({ runtime_v1_agent_ops: 'yes' } as never);
    await expect(isRuntimeV1AgentOpsEnabledForUser('user-1')).resolves.toBe(false);
  });

  it('supports an injected async resolver without making the sync adapter API await', async () => {
    const resolver = vi.fn(async () => ({ runtime_v1_agent_ops: true }));
    const result = isRuntimeV1AgentOpsEnabledForUser('user-async', {
      resolveFeatureFlags: resolver,
    });

    expect(isRuntimeV1AgentOpsEnabled()).toBe(false);
    await expect(result).resolves.toBe(true);
    expect(resolver).toHaveBeenCalledWith('user-async');
  });

  it('keeps the existing synchronous provider override behavior', () => {
    configureRuntimeV1AgentOpsFlag(true);
    expect(isRuntimeV1AgentOpsEnabled()).toBe(true);
    configureRuntimeV1AgentOpsFlag(false);
    expect(isRuntimeV1AgentOpsEnabled()).toBe(false);
  });

  it('uses a configured async central resolver and does not let its error enable the flag', async () => {
    const resolver = vi.fn<Parameters<typeof configureRuntimeV1AgentOpsRuntimeConfig>[0]>(
      async () => ({ runtime_v1_agent_ops: true }),
    );
    configureRuntimeV1AgentOpsRuntimeConfig(resolver);
    await expect(isRuntimeV1AgentOpsEnabledForUser('user-configured')).resolves.toBe(true);
    expect(resolver).toHaveBeenCalledWith('user-configured');

    configureRuntimeV1AgentOpsRuntimeConfig(async () => {
      throw new Error('provider failure');
    });
    await expect(isRuntimeV1AgentOpsEnabledForUser('user-configured')).resolves.toBe(false);
  });
});
