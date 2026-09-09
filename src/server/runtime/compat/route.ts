/**
 * C-35 Legacy aiAgent route selection seam.
 *
 * A framework-agnostic, request-boundary helper that picks exactly one route
 * for legacy agent operation calls: the strict legacy path (a
 * `LegacyAgentCompatAdapter` forced onto the injected legacy port) or the
 * runtime.v1 path (the same adapter surface forced onto an injected
 * RuntimeFacade). Selection is driven by the ALREADY-RESOLVED central
 * `runtime_v1_agent_ops` flag supplied by the caller — the seam deliberately
 * never imports the central flag config itself, and `select()` is fully
 * synchronous: async flag sources (central config, user allow-list lookups)
 * must be awaited by the caller BEFORE calling `select()`.
 *
 * Guarantees:
 * - flag off (default) → strictly legacy: the runtime factory is never
 *   touched; flag on → only runtime: the legacy factory is never touched;
 * - both factories are lazy (materialize on first operation) and memoized per
 *   selection — never invoked at `select()` time, never double-executed;
 * - the boundary decision is frozen per selection: later global/env flag
 *   changes cannot flip a request mid-flight (rollback = next request picks
 *   the other route);
 * - scope fields are validated (`LEGACY_COMPAT_INVALID_INPUT`), the scope is
 *   forwarded by identity to whichever factory materializes, and failures
 *   keep their real error codes (no silent faking, no swallowing).
 */

import type { RuntimeFacadePort } from '../adapter';
import type { RuntimeFacadeFactoryResult } from '../factory';
import { createLegacyAgentCompatAdapter } from './adapter';
import type { LegacyAgentCompatAdapter } from './adapter';
import { isRuntimeV1AgentOpsEnabled } from './feature-flag';
import { toLegacyCompatError } from './mapper';
import { LegacyCompatError, type LegacyAgentOperationPort, type MaybePromise } from './types';

/** The authenticated request scope a route selection must carry. */
export interface LegacyAgentRouteScope {
  readonly userId: string;
  readonly sessionId: string;
  /** Opaque database handle; forwarded to factories, never read here. */
  readonly serverDB: unknown;
  readonly request: Request;
}

export interface LegacyAgentRouteFlagContext {
  readonly userId: string;
  readonly sessionId: string;
}

/**
 * Synchronous, already-resolved central flag evaluation. Central-config
 * sources (`boolean | string[]` with user allow-lists) must be awaited and
 * evaluated by the caller at the request boundary before selection.
 */
export type LegacyAgentRouteFlagResolver = (context: LegacyAgentRouteFlagContext) => boolean;

/**
 * Adapts a central-config flag value (`boolean | string[] | undefined`) to a
 * per-user decision, mirroring the central `evaluateFeatureFlag` semantics
 * without importing it: booleans pass through, allow-lists match by userId,
 * and the absent sentinel stays honestly OFF (strict legacy by default).
 */
export const evaluateRuntimeV1AgentOpsFlag = (
  flagValue: boolean | readonly string[] | undefined,
  userId: string,
): boolean => {
  if (typeof flagValue === 'boolean') return flagValue;
  if (Array.isArray(flagValue)) return flagValue.includes(userId);
  return false;
};

export interface LegacyAgentRouteSelectorOptions {
  /** Lazy legacy side; materialized only while the legacy route serves ops. */
  readonly legacyFactory: (scope: LegacyAgentRouteScope) => MaybePromise<LegacyAgentOperationPort>;
  /**
   * Lazy runtime side; materialized only while the runtime route serves ops.
   * May return a RuntimeFacadePort or a `{ facade }` binding.
   */
  readonly runtimeFactory: (
    scope: LegacyAgentRouteScope,
  ) => MaybePromise<RuntimeFacadeFactoryResult>;
  /** Already-resolved central flag; defaults to the C-21 env-backed flag. */
  readonly resolveFlag?: LegacyAgentRouteFlagResolver;
  readonly createRequestId?: () => string;
}

export interface LegacyAgentRouteSelection {
  /** Which route this selection is frozen onto. */
  readonly route: 'legacy' | 'runtime.v1';
  /** The authenticated scope (identity echo). */
  readonly scope: LegacyAgentRouteScope;
  /**
   * Uniform operation surface for the aiAgent boundary. Strictly single-sided:
   * only the selected route's factory can ever materialize.
   */
  readonly adapter: LegacyAgentCompatAdapter;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isLegacyAgentOperationPort = (value: unknown): value is LegacyAgentOperationPort =>
  isRecord(value) &&
  typeof value.start === 'function' &&
  typeof value.get === 'function' &&
  typeof value.cancel === 'function';

const hasFacadeHandle = (value: unknown): value is RuntimeFacadePort =>
  isRecord(value) && typeof value.handle === 'function';

const facadePortFrom = (result: RuntimeFacadeFactoryResult): RuntimeFacadePort => {
  if (isRecord(result) && hasFacadeHandle(result.facade)) {
    return result.facade;
  }
  if (hasFacadeHandle(result)) {
    return result;
  }
  throw new LegacyCompatError(
    'LEGACY_COMPAT_RUNTIME_FAILED',
    'runtimeFactory did not provide a RuntimeFacadePort',
  );
};

const legacyPortFrom = (result: unknown): LegacyAgentOperationPort => {
  if (isLegacyAgentOperationPort(result)) return result;
  throw new LegacyCompatError(
    'LEGACY_COMPAT_RUNTIME_FAILED',
    'legacyFactory did not provide a LegacyAgentOperationPort',
  );
};

const requireRequest = (value: unknown): Request => {
  if (!(value instanceof Request)) {
    throw new LegacyCompatError(
      'LEGACY_COMPAT_INVALID_INPUT',
      'request must be a valid Request',
      'request',
    );
  }
  return value;
};

const validateScope = (scope: LegacyAgentRouteScope): void => {
  if (!isRecord(scope)) {
    throw new LegacyCompatError(
      'LEGACY_COMPAT_INVALID_INPUT',
      'An authenticated request scope is required',
      'scope',
    );
  }
  if (!nonEmptyString(scope.userId)) {
    throw new LegacyCompatError(
      'LEGACY_COMPAT_INVALID_INPUT',
      'userId must be a non-empty string',
      'userId',
    );
  }
  if (!nonEmptyString(scope.sessionId)) {
    throw new LegacyCompatError(
      'LEGACY_COMPAT_INVALID_INPUT',
      'sessionId must be a non-empty string',
      'sessionId',
    );
  }
  if (scope.serverDB === undefined || scope.serverDB === null) {
    throw new LegacyCompatError(
      'LEGACY_COMPAT_INVALID_INPUT',
      'serverDB must be provided',
      'serverDB',
    );
  }
  requireRequest(scope.request);
};

export interface LegacyAgentRouteSelector {
  /**
   * Fully synchronous boundary decision. Never awaits, never invokes either
   * factory, and freezes the flag outcome for the returned selection.
   */
  select(scope: LegacyAgentRouteScope): LegacyAgentRouteSelection;
}

export const createLegacyAgentRouteSelector = (
  options: LegacyAgentRouteSelectorOptions,
): LegacyAgentRouteSelector => {
  if (!options || typeof options !== 'object') {
    throw new LegacyCompatError(
      'LEGACY_COMPAT_INVALID_INPUT',
      'LegacyAgentRouteSelectorOptions must be provided',
      'options',
    );
  }
  if (typeof options.legacyFactory !== 'function') {
    throw new LegacyCompatError(
      'LEGACY_COMPAT_INVALID_INPUT',
      'legacyFactory must be a function',
      'legacyFactory',
    );
  }
  if (typeof options.runtimeFactory !== 'function') {
    throw new LegacyCompatError(
      'LEGACY_COMPAT_INVALID_INPUT',
      'runtimeFactory must be a function',
      'runtimeFactory',
    );
  }

  const resolveFlag: LegacyAgentRouteFlagResolver =
    options.resolveFlag ?? (() => isRuntimeV1AgentOpsEnabled());

  return {
    select(scope: LegacyAgentRouteScope): LegacyAgentRouteSelection {
      validateScope(scope);

      // One synchronous, already-resolved decision per request boundary.
      const enabled = resolveFlag({ userId: scope.userId, sessionId: scope.sessionId });
      if (typeof enabled !== 'boolean') {
        throw new LegacyCompatError(
          'LEGACY_COMPAT_INVALID_INPUT',
          'resolveFlag must return a boolean',
          'resolveFlag',
        );
      }

      // Lazy, memoized per selection: the unused side stays dormant forever.
      let legacyPortMemo: LegacyAgentOperationPort | undefined;
      const materializeLegacyPort = async (): Promise<LegacyAgentOperationPort> => {
        if (legacyPortMemo) return legacyPortMemo;
        try {
          const materialized = legacyPortFrom(await options.legacyFactory(scope));
          legacyPortMemo = materialized;
          return materialized;
        } catch (error) {
          legacyPortMemo = undefined;
          throw toLegacyCompatError(error);
        }
      };

      let facadePortMemo: RuntimeFacadePort | undefined;
      const materializeFacadePort = async (): Promise<RuntimeFacadePort> => {
        if (facadePortMemo) return facadePortMemo;
        try {
          const materialized = facadePortFrom(await options.runtimeFactory(scope));
          facadePortMemo = materialized;
          return materialized;
        } catch (error) {
          facadePortMemo = undefined;
          throw toLegacyCompatError(error);
        }
      };

      const adapter = createLegacyAgentCompatAdapter({
        legacyPort: {
          start: (input) => materializeLegacyPort().then((port) => port.start(input)),
          get: (operationId) => materializeLegacyPort().then((port) => port.get(operationId)),
          cancel: (operationId) => materializeLegacyPort().then((port) => port.cancel(operationId)),
          resume: (operationId, resumeInput) =>
            materializeLegacyPort().then((port) => {
              if (!port.resume) {
                throw new LegacyCompatError(
                  'LEGACY_COMPAT_RUNTIME_FAILED',
                  'Injected legacy port does not support resume',
                );
              }
              return port.resume(operationId, resumeInput);
            }),
        },
        runtimeFacade: {
          handle: (envelope) => materializeFacadePort().then((port) => port.handle(envelope)),
        },
        // Freeze the boundary decision for this selection's lifetime.
        isEnabled: () => enabled,
        ...(options.createRequestId ? { createRequestId: options.createRequestId } : {}),
      });

      return {
        route: enabled ? 'runtime.v1' : 'legacy',
        scope,
        adapter,
      };
    },
  };
};
