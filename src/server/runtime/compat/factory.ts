/**
 * C-29 Scoped legacy agent compat construction.
 *
 * Builds the C-21 `LegacyAgentCompatAdapter` per authenticated
 * `{ userId, sessionId, serverDB, request }` scope. The injected
 * `legacyPortFactory` and `RuntimeFacadeFactory` are lazy and mutually
 * exclusive per call: while the feature flag is off only the legacy side
 * materializes (the runtime factory is never touched), and while it is on only
 * the runtime side materializes (the legacy factory is never touched). Both
 * memoize their first successful result per scope instance.
 *
 * Hard constraints: the bridge never reads the database (serverDB is opaque
 * passthrough into the runtime factory scope), never executes a provider
 * itself, and forwards the original request object unchanged. Missing scope
 * fields fail fast with `LEGACY_COMPAT_INVALID_INPUT` — no scope is invented.
 */

import type { RuntimeFacadePort } from '../adapter';
import type { RuntimeFacadeFactory, RuntimeFacadeFactoryResult } from '../factory';
import type { LegacyAgentCompatAdapter } from './adapter';
import { createLegacyAgentCompatAdapter } from './adapter';
import { toLegacyCompatError } from './mapper';
import { type LegacyAgentOperationPort, LegacyCompatError, type MaybePromise } from './types';

/** The authenticated scope every scoped compat construction must carry. */
export interface LegacyAgentCompatScope {
  readonly request: Request;
  /** Opaque database handle; forwarded to the runtime factory, never read here. */
  readonly serverDB: unknown;
  readonly sessionId: string;
  readonly userId: string;
}

/** Per-scope legacy port source; invoked lazily, only while the flag is off. */
export type LegacyAgentPortFactory = (scope: {
  userId: string;
  sessionId: string;
}) => MaybePromise<LegacyAgentOperationPort>;

export interface LegacyAgentScopedCompatOptions {
  readonly createRequestId?: () => string;
  /** Optional per-adapter flag override; defaults to the C-21 feature flag. */
  readonly isEnabled?: () => boolean;
  readonly legacyPortFactory: LegacyAgentPortFactory;
  /** Existing runtime facade factory; invoked lazily with the request scope. */
  readonly runtimeFacadeFactory: RuntimeFacadeFactory;
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

const requireScopeField = (
  value: unknown,
  field: 'userId' | 'sessionId' | 'serverDB' | 'request',
): void => {
  if (field === 'request') {
    if (!(value instanceof Request)) {
      throw new LegacyCompatError(
        'LEGACY_COMPAT_INVALID_INPUT',
        'request must be a valid Request',
        'request',
      );
    }
    return;
  }
  if (field === 'serverDB') {
    if (value === undefined || value === null) {
      throw new LegacyCompatError(
        'LEGACY_COMPAT_INVALID_INPUT',
        'serverDB must be provided for scoped legacy compat construction',
        'serverDB',
      );
    }
    return;
  }
  if (!nonEmptyString(value)) {
    throw new LegacyCompatError(
      'LEGACY_COMPAT_INVALID_INPUT',
      `${field} must be a non-empty string`,
      field,
    );
  }
};

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
    'RuntimeFacadeFactory did not provide a RuntimeFacadePort',
  );
};

const legacyPortFrom = (result: unknown): LegacyAgentOperationPort => {
  if (isLegacyAgentOperationPort(result)) return result;
  throw new LegacyCompatError(
    'LEGACY_COMPAT_RUNTIME_FAILED',
    'legacyPortFactory did not provide a LegacyAgentOperationPort',
  );
};

/**
 * Builds the scoped adapter. Construction is pure validation — factories run
 * only when an operation actually needs their side of the flag boundary.
 */
export const createScopedLegacyAgentCompatAdapter = (
  scope: LegacyAgentCompatScope,
  options: LegacyAgentScopedCompatOptions,
): LegacyAgentCompatAdapter => {
  requireScopeField(scope?.userId, 'userId');
  requireScopeField(scope?.sessionId, 'sessionId');
  requireScopeField(scope?.serverDB, 'serverDB');
  requireScopeField(scope?.request, 'request');
  if (typeof options?.legacyPortFactory !== 'function') {
    throw new LegacyCompatError(
      'LEGACY_COMPAT_INVALID_INPUT',
      'legacyPortFactory must be a function',
      'legacyPortFactory',
    );
  }
  if (typeof options.runtimeFacadeFactory !== 'function') {
    throw new LegacyCompatError(
      'LEGACY_COMPAT_INVALID_INPUT',
      'runtimeFacadeFactory must be a function',
      'runtimeFacadeFactory',
    );
  }

  const { userId, sessionId, serverDB, request } = scope;
  const legacyScope = { userId, sessionId };

  let legacyPortMemo: LegacyAgentOperationPort | undefined;
  const materializeLegacyPort = async (): Promise<LegacyAgentOperationPort> => {
    if (legacyPortMemo) return legacyPortMemo;
    try {
      const materialized = legacyPortFrom(await options.legacyPortFactory(legacyScope));
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
      const materialized = facadePortFrom(
        await options.runtimeFacadeFactory({ userId, serverDB, request }),
      );
      facadePortMemo = materialized;
      return materialized;
    } catch (error) {
      facadePortMemo = undefined;
      throw toLegacyCompatError(error);
    }
  };

  // Lazy side proxies: the adapter resolves flags per call and only touches
  // the side it actually needs, so factories stay dormant otherwise.
  const lazyLegacyPort: LegacyAgentOperationPort = {
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
  };

  const lazyRuntimeFacade: RuntimeFacadePort = {
    handle: (envelope) => materializeFacadePort().then((port) => port.handle(envelope)),
  };

  return createLegacyAgentCompatAdapter({
    legacyPort: lazyLegacyPort,
    runtimeFacade: lazyRuntimeFacade,
    ...(options.isEnabled ? { isEnabled: options.isEnabled } : {}),
    ...(options.createRequestId ? { createRequestId: options.createRequestId } : {}),
  });
};
