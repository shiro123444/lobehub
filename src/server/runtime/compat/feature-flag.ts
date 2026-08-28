/**
 * C-21/C-30 Legacy Agent compatibility seam — explicit feature-flag boundary.
 *
 * The flag decides whether legacy agent operation calls are served by the
 * injected legacy port (off, default) or translated to runtime.v1 commands
 * through the injected RuntimeFacadePort (on). It defaults to a dedicated
 * server env var as a compatibility fallback. The async user-scoped resolver
 * reads the central RuntimeConfig feature flags first; the synchronous API is
 * intentionally kept free of hidden awaits for LegacyAgentCompatAdapter.
 */

import type { IFeatureFlags } from '@/config/featureFlags';
import { evaluateFeatureFlag } from '@/config/featureFlags';

export const RUNTIME_V1_AGENT_OPS_ENV_KEY = 'RUNTIME_V1_AGENT_OPS';

export const RUNTIME_V1_AGENT_OPS_ENV_TRUE_VALUES = ['true', '1', 'on'] as const;

type FlagProvider = () => boolean;

export type RuntimeV1AgentOpsRuntimeConfigResolver = (
  userId?: string,
) => Promise<Partial<IFeatureFlags> | undefined>;

export interface RuntimeV1AgentOpsResolutionOptions {
  /** Optional central resolver override for tests or an alternate RuntimeConfig seam. */
  readonly resolveFeatureFlags?: RuntimeV1AgentOpsRuntimeConfigResolver;
}

const readEnvFlag = (): boolean => {
  if (typeof process === 'undefined' || typeof process.env !== 'object') return false;
  const raw = process.env[RUNTIME_V1_AGENT_OPS_ENV_KEY];
  return typeof raw === 'string'
    ? (RUNTIME_V1_AGENT_OPS_ENV_TRUE_VALUES as readonly string[]).includes(raw.trim().toLowerCase())
    : false;
};

let configuredProvider: FlagProvider | undefined;

/** Reads the flag once per call so tests and callers can flip it mid-flight. */
export const isRuntimeV1AgentOpsEnabled = (): boolean =>
  configuredProvider ? configuredProvider() === true : readEnvFlag();

/**
 * Overrides the provider for later production wiring (e.g. the zod-based
 * FEATURE_FLAGS system). Accepts a boolean or a zero-arg predicate.
 */
export const configureRuntimeV1AgentOpsFlag = (provider: FlagProvider | boolean): void => {
  configuredProvider = typeof provider === 'function' ? provider : () => provider;
};

export const resetRuntimeV1AgentOpsFlag = (): void => {
  configuredProvider = undefined;
};

let configuredRuntimeConfigResolver: RuntimeV1AgentOpsRuntimeConfigResolver | undefined;

const resolveCentralFeatureFlags = async (
  userId?: string,
): Promise<Partial<IFeatureFlags> | undefined> => {
  const { getServerFeatureFlagsFromRuntimeConfig } = await import('@/server/featureFlags');
  return await getServerFeatureFlagsFromRuntimeConfig(userId);
};

const isFeatureFlagRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readCompatFallback = (): boolean => {
  try {
    return configuredProvider ? configuredProvider() === true : readEnvFlag();
  } catch {
    return false;
  }
};

/**
 * Resolves RuntimeConfig (including its user override merge) asynchronously.
 * A present central value always wins over the legacy env/provider fallback;
 * resolver failures and malformed central values fail closed.
 */
export const isRuntimeV1AgentOpsEnabledForUser = async (
  userId?: string,
  options: RuntimeV1AgentOpsResolutionOptions = {},
): Promise<boolean> => {
  const resolver = options.resolveFeatureFlags ?? configuredRuntimeConfigResolver;

  try {
    const flags = await (resolver ? resolver(userId) : resolveCentralFeatureFlags(userId));
    if (flags === undefined) return readCompatFallback();
    if (!isFeatureFlagRecord(flags)) return false;

    const value = flags.runtime_v1_agent_ops;
    if (value === undefined) return readCompatFallback();
    if (typeof value === 'boolean') return value;
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
      return evaluateFeatureFlag(value, userId) === true;
    }
    return false;
  } catch {
    // A broken RuntimeConfig/provider must never turn the migration path on.
    return false;
  }
};

/** Injects an async central RuntimeConfig resolver without changing the sync API. */
export const configureRuntimeV1AgentOpsRuntimeConfig = (
  resolver: RuntimeV1AgentOpsRuntimeConfigResolver,
): void => {
  configuredRuntimeConfigResolver = resolver;
};

export const resetRuntimeV1AgentOpsRuntimeConfig = (): void => {
  configuredRuntimeConfigResolver = undefined;
};
