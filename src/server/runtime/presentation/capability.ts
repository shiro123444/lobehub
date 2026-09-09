/** C-46 framework-agnostic Agent strategy -> PresentationPort seam. */

import type {
  PresentationCapabilityCommand,
  PresentationCapabilityMetadata,
  PresentationCapabilityResult,
  PresentationJobInput,
} from '../../../../packages/runtime-contracts/src';
import {
  PRESENTATION_OPERATIONS,
  type PresentationOperation,
} from '../../../../packages/runtime-contracts/src';
import type { PresentationPort } from '../../../../packages/cordis-kernel/src/presentation';

export interface PresentationCapabilityScope {
  readonly sessionId: string;
  readonly userId: string;
}

export type PresentationCapabilityAuthorizer = (
  capability: `presentation.${PresentationOperation}`,
  scope: PresentationCapabilityScope,
  command: PresentationCapabilityCommand,
) => boolean | Promise<boolean>;

export interface PresentationCapabilityOptions {
  readonly authorize?: PresentationCapabilityAuthorizer;
  readonly port: PresentationPort;
  readonly scope: PresentationCapabilityScope;
}

export interface PresentationCapability {
  execute(command: PresentationCapabilityCommand): Promise<PresentationCapabilityResult>;
}

export type PresentationCapabilityErrorCode =
  | 'PRESENTATION_CAPABILITY_UNAUTHORIZED'
  | 'PRESENTATION_INVALID';

export class PresentationCapabilityError extends Error {
  constructor(
    public readonly code: PresentationCapabilityErrorCode,
    message: string,
    public readonly path?: string,
  ) {
    super(message);
    this.name = 'PresentationCapabilityError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const invalid = (message: string, path?: string): PresentationCapabilityError =>
  new PresentationCapabilityError('PRESENTATION_INVALID', message, path);

const validateScope = (scope: PresentationCapabilityScope): void => {
  if (!isRecord(scope)) throw invalid('scope is required', 'scope');
  if (!nonEmptyString(scope.userId)) throw invalid('userId must be non-empty', 'scope.userId');
  if (!nonEmptyString(scope.sessionId)) {
    throw invalid('sessionId must be non-empty', 'scope.sessionId');
  }
};

const validateCommand = (command: PresentationCapabilityCommand): PresentationOperation => {
  if (!isRecord(command)) throw invalid('command must be an object', 'command');
  if (
    typeof command.operation !== 'string' ||
    !PRESENTATION_OPERATIONS.includes(command.operation as PresentationOperation)
  ) {
    throw invalid('operation is not supported', 'operation');
  }
  return command.operation as PresentationOperation;
};

const requireJobId = (command: PresentationCapabilityCommand): string => {
  if (!nonEmptyString(command.jobId)) throw invalid('jobId is required', 'jobId');
  return command.jobId;
};

const requireArtifactId = (command: PresentationCapabilityCommand): string => {
  if (!nonEmptyString(command.artifactId)) throw invalid('artifactId is required', 'artifactId');
  return command.artifactId;
};

const requireInput = (command: PresentationCapabilityCommand): PresentationJobInput => {
  if (!isRecord(command.input)) throw invalid('input is required', 'input');
  return command.input as PresentationJobInput;
};

const hasMetadata = (metadata: PresentationCapabilityMetadata | undefined): boolean =>
  Boolean(
    metadata &&
    Object.values(metadata).some((value) => typeof value === 'string' && value.trim().length > 0),
  );

/** Add edit intent metadata without mutating input or replacing existing options. */
const inputForEdit = (
  input: PresentationJobInput,
  metadata: PresentationCapabilityMetadata,
): PresentationJobInput => {
  const existing = input.options ?? {};
  const existingMetadata = isRecord(existing.presentationMetadata)
    ? existing.presentationMetadata
    : {};
  return {
    ...input,
    options: {
      ...existing,
      presentationMetadata: { ...existingMetadata, ...metadata },
    },
  };
};

const executeOperation = async (
  port: PresentationPort,
  command: PresentationCapabilityCommand,
  operation: PresentationOperation,
): Promise<PresentationCapabilityResult> => {
  switch (operation) {
    case 'create': {
      const job = await port.createJob(requireInput(command));
      return { operation, job };
    }
    case 'edit': {
      if (!hasMetadata(command.metadata)) {
        throw invalid('edit metadata must include parent/version or annotation data', 'metadata');
      }
      const job = await port.createJob(inputForEdit(requireInput(command), command.metadata!));
      return { operation, job };
    }
    case 'inspect': {
      if (nonEmptyString(command.jobId)) {
        return { operation, job: await port.getJob(command.jobId) };
      }
      return { operation, artifact: await port.getArtifact(requireArtifactId(command)) };
    }
    case 'preview': {
      if (nonEmptyString(command.artifactId)) {
        return { operation, artifact: await port.getArtifact(command.artifactId) };
      }
      return { operation, job: await port.getJob(requireJobId(command)) };
    }
    case 'export': {
      const artifactId = requireArtifactId(command);
      if (!nonEmptyString(command.format)) throw invalid('format is required', 'format');
      const result = await port.exportArtifact(artifactId, command.format);
      return { operation, export: result };
    }
    case 'cancel': {
      const job = await port.cancelJob(requireJobId(command));
      return { operation, job };
    }
    case 'retry': {
      const job = await port.retryJob(requireJobId(command));
      return { operation, job };
    }
  }
};

/**
 * Build a scoped capability adapter. The adapter is deliberately unaware of
 * AgentRuntimeService, persistence, React, workers, or provider processes.
 */
export const createPresentationCapability = (
  options: PresentationCapabilityOptions,
): PresentationCapability => {
  if (!options || typeof options !== 'object' || !options.port) {
    throw invalid('PresentationPort is required', 'port');
  }
  validateScope(options.scope);
  return {
    async execute(command) {
      const operation = validateCommand(command);
      if (options.authorize) {
        const allowed = await options.authorize(
          `presentation.${operation}`,
          options.scope,
          command,
        );
        if (!allowed) {
          throw new PresentationCapabilityError(
            'PRESENTATION_CAPABILITY_UNAUTHORIZED',
            `Capability presentation.${operation} is not authorized`,
            'operation',
          );
        }
      }
      // Deliberately do not catch: downstream PresentationError identity and
      // provider failure codes must reach the strategy/runtime unchanged.
      return executeOperation(options.port, command, operation);
    },
  };
};
