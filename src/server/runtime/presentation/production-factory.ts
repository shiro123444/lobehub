/**
 * C-33 PresentationPort production factory adapter.
 *
 * Assembles a kernel `PptMasterAdapter` per authenticated
 * `{ userId, sessionId, serverDB, request }` scope. Assembly-only guarantees:
 *
 * - `runner`, `provider`, `allowedRunnerIds`, `workspaceFactory` and
 *   `buildArgs` are all explicitly injected through the options; the factory
 *   itself never launches an external command, never touches the database
 *   (serverDB is opaque scope passthrough) and never executes a provider —
 *   provider execution only ever happens later through the returned port's
 *   own methods, driven by the kernel adapter;
 * - every resolve creates an independent adapter instance per scope: no
 *   state is shared between scopes, and the factory holds no global state;
 * - the returned port carries an idempotent `dispose()` lifecycle hook (also
 *   mirrored on the binding) which awaits an optionally injected `onDispose`
 *   callback — resources can be released by the deployer without the factory
 *   inventing cleanup behavior;
 * - missing/invalid scope fields or provider config fail with stable
 *   `PRESENTATION_INVALID` / `PROVIDER_UNAVAILABLE` /
 *   `PRESENTATION_RUNNER_NOT_ALLOWED` codes. Nothing is ever fabricated to
 *   `ready`/`completed`.
 */

import type {
  PresentationArgsBuilder,
  PresentationPort,
  PresentationRunner,
  PresentationWorkspaceFactory,
} from '../../../../packages/cordis-kernel/src/presentation';
import {
  PptMasterAdapter,
  PresentationError,
} from '../../../../packages/cordis-kernel/src/presentation';

/** The authenticated scope every port resolution must carry. */
export interface PptMasterPresentationScope {
  readonly request: Request;
  /** Opaque database handle; scope passthrough only, never read here. */
  readonly serverDB: unknown;
  readonly sessionId: string;
  readonly userId: string;
}

export type PptMasterDisposeHook = (
  port: PresentationPort,
  scope: PptMasterPresentationScope,
) => void | Promise<void>;

export interface PptMasterPortFactoryOptions {
  /**
   * Explicit runner allow-list. When omitted it defaults to `[runner.id]`
   * (kernel semantics); a runner id outside the list fails construction.
   */
  readonly allowedRunnerIds?: readonly string[];
  /** Explicit argv builder for the runner command — no built-in default here. */
  readonly buildArgs?: PresentationArgsBuilder;
  readonly idFactory?: () => string;
  readonly maxOutputBytes?: number;
  /** Determinism hooks for tests; otherwise kernel defaults apply. */
  readonly now?: () => string;
  /** Awaited by the returned port's `dispose()`; inject real resource cleanup. */
  readonly onDispose?: PptMasterDisposeHook;
  /** Explicit provider identifier; required. */
  readonly provider: string;
  /** Explicit runner implementation; required, structurally validated. */
  readonly runner: PresentationRunner;
  readonly timeoutMs?: number;
  /** Explicit workspace strategy (temp dirs, cleanup) — no built-in default here. */
  readonly workspaceFactory?: PresentationWorkspaceFactory;
}

export interface PptMasterPresentationPortBinding {
  /** Idempotent lifecycle hook; awaits the injected `onDispose` once. */
  dispose: () => Promise<void>;
  /** Kernel adapter delegate; carries the six port methods plus `dispose()`. */
  readonly port: PresentationPort & { readonly dispose: () => Promise<void> };
  /** Echoes the authenticated scope the port was assembled for. */
  readonly scope: PptMasterPresentationScope;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isPresentationRunner = (value: unknown): value is PresentationRunner =>
  isRecord(value) && nonEmptyString(value.id) && typeof value.spawn === 'function';

const invalid = (message: string, path: string): PresentationError =>
  new PresentationError('PRESENTATION_INVALID', message, { path });

/** Validates the injected provider configuration once, at factory creation. */
const validateFactoryOptions = (options: PptMasterPortFactoryOptions): void => {
  if (!options || typeof options !== 'object') {
    throw invalid('PptMasterPortFactoryOptions must be provided', 'options');
  }
  if (!nonEmptyString(options.provider)) {
    throw invalid('provider must be a non-empty string', 'provider');
  }
  if (!isPresentationRunner(options.runner)) {
    throw new PresentationError(
      'PROVIDER_UNAVAILABLE',
      'runner must provide a PresentationRunner (id + spawn)',
      { path: 'runner' },
    );
  }
  if (options.allowedRunnerIds !== undefined) {
    if (
      !Array.isArray(options.allowedRunnerIds) ||
      options.allowedRunnerIds.some((id) => !nonEmptyString(id))
    ) {
      throw invalid('allowedRunnerIds must be a string array', 'allowedRunnerIds');
    }
    if (!options.allowedRunnerIds.includes(options.runner.id)) {
      throw new PresentationError(
        'PRESENTATION_RUNNER_NOT_ALLOWED',
        `Runner is not allow-listed: ${options.runner.id}`,
        { path: 'runner' },
      );
    }
  }
};

const validateScope = (scope: PptMasterPresentationScope): void => {
  if (!isRecord(scope)) {
    throw invalid('An authenticated session scope is required', 'scope');
  }
  if (!nonEmptyString(scope.userId)) {
    throw invalid('userId must be a non-empty string', 'userId');
  }
  if (!nonEmptyString(scope.sessionId)) {
    throw invalid('sessionId must be a non-empty string', 'sessionId');
  }
  if (scope.serverDB === undefined || scope.serverDB === null) {
    throw invalid('serverDB must be provided', 'serverDB');
  }
  if (!(scope.request instanceof Request)) {
    throw invalid('request must be a valid Request', 'request');
  }
};

/**
 * Builds the per-scope port factory. Creation validates configuration only —
 * nothing external runs until the returned port's methods are used.
 */
export const createPptMasterPresentationPortFactory = (
  options: PptMasterPortFactoryOptions,
): ((scope: PptMasterPresentationScope) => PptMasterPresentationPortBinding) => {
  validateFactoryOptions(options);
  const {
    provider,
    runner,
    allowedRunnerIds,
    workspaceFactory,
    buildArgs,
    timeoutMs,
    maxOutputBytes,
    now,
    idFactory,
    onDispose,
  } = options;

  return (scope: PptMasterPresentationScope): PptMasterPresentationPortBinding => {
    validateScope(scope);

    // Independent assembly per scope: fresh adapter, no shared state anywhere.
    const adapter = new PptMasterAdapter({
      provider,
      runner,
      allowedRunnerIds: allowedRunnerIds ?? [runner.id],
      ...(workspaceFactory ? { workspaceFactory } : {}),
      ...(buildArgs ? { buildArgs } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
      ...(now ? { now } : {}),
      ...(idFactory ? { idFactory } : {}),
    });

    let disposed = false;
    const dispose = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      if (onDispose) await onDispose(port, scope);
    };

    const port = {
      createJob: adapter.createJob.bind(adapter),
      getJob: adapter.getJob.bind(adapter),
      cancelJob: adapter.cancelJob.bind(adapter),
      retryJob: adapter.retryJob.bind(adapter),
      getArtifact: adapter.getArtifact.bind(adapter),
      exportArtifact: adapter.exportArtifact.bind(adapter),
      dispose,
    } as PresentationPort & { readonly dispose: () => Promise<void> };

    return { port, scope, dispose };
  };
};
