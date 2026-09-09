import { describe, expect, it, vi } from 'vitest';

import type {
  ArtifactSnapshot,
  PresentationCapabilityCommand,
  PresentationJob,
  PresentationJobInput,
  PresentationPort,
} from '../../../../packages/runtime-contracts/src';
import { PresentationError } from '../../../../packages/cordis-kernel/src/presentation';
import { createPresentationCapability, PresentationCapabilityError } from './capability';

const input: PresentationJobInput = {
  notebookId: 'nb-1',
  sourceVersionIds: ['v-1'],
  title: 'Deck',
};

const job: PresentationJob = {
  jobId: 'job-1',
  state: 'completed',
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z',
};

const artifact: ArtifactSnapshot = {
  artifactId: 'artifact-1',
  type: 'pptx',
  status: 'ready',
  createdAt: '2026-08-28T00:00:00.000Z',
};

const makePort = () => {
  const port: PresentationPort = {
    createJob: vi.fn(async () => job),
    getJob: vi.fn(async () => job),
    cancelJob: vi.fn(async () => ({ ...job, state: 'cancelled' as const })),
    retryJob: vi.fn(async () => job),
    getArtifact: vi.fn(async () => artifact),
    exportArtifact: vi.fn(async () => ({ artifactId: 'export-1', format: 'pptx' as const })),
  };
  return port;
};

const command = (
  overrides: Partial<PresentationCapabilityCommand>,
): PresentationCapabilityCommand => ({
  operation: 'create',
  input,
  ...overrides,
});

describe('C-46 presentation capability adapter', () => {
  it('routes every operation to its mutually exclusive PresentationPort method', async () => {
    const port = makePort();
    const capability = createPresentationCapability({
      port,
      scope: { userId: 'user-1', sessionId: 'session-1' },
    });

    await expect(capability.execute(command({ operation: 'create' }))).resolves.toMatchObject({
      operation: 'create',
      job,
    });
    await expect(
      capability.execute(
        command({ operation: 'inspect', jobId: 'job-1', artifactId: 'artifact-1' }),
      ),
    ).resolves.toMatchObject({ operation: 'inspect', job });
    await expect(
      capability.execute(
        command({ operation: 'preview', jobId: 'job-1', artifactId: 'artifact-1' }),
      ),
    ).resolves.toMatchObject({ operation: 'preview', artifact });
    await expect(
      capability.execute(
        command({ operation: 'export', artifactId: 'artifact-1', format: 'pptx' }),
      ),
    ).resolves.toMatchObject({ operation: 'export', export: { artifactId: 'export-1' } });
    await expect(
      capability.execute(command({ operation: 'cancel', jobId: 'job-1' })),
    ).resolves.toMatchObject({ operation: 'cancel', job: { state: 'cancelled' } });
    await expect(
      capability.execute(command({ operation: 'retry', jobId: 'job-1' })),
    ).resolves.toMatchObject({ operation: 'retry', job });

    expect(port.createJob).toHaveBeenCalledTimes(1);
    expect(port.getJob).toHaveBeenCalledTimes(1);
    expect(port.getArtifact).toHaveBeenCalledTimes(1);
    expect(port.exportArtifact).toHaveBeenCalledTimes(1);
    expect(port.cancelJob).toHaveBeenCalledTimes(1);
    expect(port.retryJob).toHaveBeenCalledTimes(1);
  });

  it('creates a new edit job while retaining parent/version/annotation metadata', async () => {
    const port = makePort();
    const original: PresentationJobInput = {
      ...input,
      options: { theme: 'dark', presentationMetadata: { existing: 'keep' } },
    };
    const capability = createPresentationCapability({
      port,
      scope: { userId: 'user-1', sessionId: 'session-1' },
    });

    await capability.execute({
      operation: 'edit',
      input: original,
      metadata: { parentVersionId: 'version-1', slideId: 'slide-2', annotation: 'Rewrite title' },
    });

    expect(port.createJob).toHaveBeenCalledWith({
      ...original,
      options: {
        theme: 'dark',
        presentationMetadata: {
          existing: 'keep',
          parentVersionId: 'version-1',
          slideId: 'slide-2',
          annotation: 'Rewrite title',
        },
      },
    });
    expect(original.options).toEqual({
      theme: 'dark',
      presentationMetadata: { existing: 'keep' },
    });
  });

  it('rejects malformed commands and unauthorized capabilities before touching the port', async () => {
    const port = makePort();
    const capability = createPresentationCapability({
      port,
      scope: { userId: 'user-1', sessionId: 'session-1' },
      authorize: vi.fn(async () => false),
    });

    await expect(capability.execute({ operation: 'unknown' } as never)).rejects.toMatchObject({
      code: 'PRESENTATION_INVALID',
    });
    await expect(capability.execute(command({ operation: 'create' }))).rejects.toMatchObject({
      code: 'PRESENTATION_CAPABILITY_UNAUTHORIZED',
    });
    expect(port.createJob).not.toHaveBeenCalled();
    expect(port.getJob).not.toHaveBeenCalled();
  });

  it('requires ids/input and edit metadata according to the operation', async () => {
    const port = makePort();
    const capability = createPresentationCapability({
      port,
      scope: { userId: 'user-1', sessionId: 'session-1' },
    });

    await expect(capability.execute({ operation: 'create' })).rejects.toMatchObject({
      code: 'PRESENTATION_INVALID',
    });
    await expect(capability.execute({ operation: 'edit', input })).rejects.toMatchObject({
      code: 'PRESENTATION_INVALID',
    });
    await expect(capability.execute({ operation: 'inspect' })).rejects.toMatchObject({
      code: 'PRESENTATION_INVALID',
    });
    await expect(capability.execute({ operation: 'export', format: 'pptx' })).rejects.toMatchObject(
      {
        code: 'PRESENTATION_INVALID',
      },
    );
  });

  it('passes the exact downstream PresentationError through unchanged', async () => {
    const error = new PresentationError('PROVIDER_UNAVAILABLE', 'provider missing');
    const port = makePort();
    vi.mocked(port.createJob).mockRejectedValueOnce(error);
    const capability = createPresentationCapability({
      port,
      scope: { userId: 'user-1', sessionId: 'session-1' },
    });

    await expect(capability.execute(command({ operation: 'create' }))).rejects.toBe(error);
    expect(error).toBeInstanceOf(PresentationError);
    expect(error).not.toBeInstanceOf(PresentationCapabilityError);
  });
});
