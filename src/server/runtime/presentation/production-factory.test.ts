import { describe, expect, it, vi } from 'vitest';

import type {
  PresentationJobInput,
  PresentationPort,
  PresentationRunner,
} from '../../../../packages/cordis-kernel/src/presentation';
import { PresentationError } from '../../../../packages/cordis-kernel/src/presentation';
import type { PptMasterPortFactoryOptions, PptMasterPresentationScope } from './production-factory';
import { createPptMasterPresentationPortFactory } from './production-factory';

const baseScope = (
  overrides: Partial<PptMasterPresentationScope> = {},
): PptMasterPresentationScope => ({
  userId: 'user-1',
  sessionId: 'session-1',
  serverDB: { handle: 'db-stub' } as unknown,
  request: new Request('https://example.test/api/runtime/presentation/jobs', { method: 'POST' }),
  ...overrides,
});

let runnerSequence = 0;

const makeRunner = (overrides: Partial<PresentationRunner> = {}): PresentationRunner => {
  runnerSequence += 1;
  return {
    id: 'ppt-master-runner',
    spawn: vi.fn(() => {
      throw new Error(`runner must not be invoked by factory assembly (${runnerSequence})`);
    }),
    ...overrides,
  };
};

let jobSequence = 0;

const baseOptions = (
  overrides: Partial<PptMasterPortFactoryOptions> = {},
): PptMasterPortFactoryOptions => {
  jobSequence += 1;
  const sequence = jobSequence;
  return {
    provider: 'ppt-master',
    runner: makeRunner(),
    idFactory: () => `job-${sequence}`,
    now: () => '2026-08-27T00:00:00.000Z',
    workspaceFactory: (jobId: string) => ({
      path: `/ws/${jobId}`,
      cleanup: async () => undefined,
    }),
    buildArgs: () => ['--out', 'deck.pptx'],
    ...overrides,
  };
};

const input: PresentationJobInput = {
  notebookId: 'nb-1',
  sourceVersionIds: ['v-1'],
  title: 'Deck',
};

/** Minimal OOXML-shaped bytes the kernel's PPTX validator accepts. */
const makePptxBytes = (): Uint8Array => {
  const name = '[Content_Types].xml';
  const header = new Uint8Array(30 + name.length + 8);
  header.set([0x50, 0x4b, 0x03, 0x04], 0); // local file header signature
  header[26] = name.length & 0xff; // file name length (LE)
  header[27] = 0;
  header[28] = 0; // extra field length (LE)
  header[29] = 0;
  header.set(new TextEncoder().encode(name), 30);
  return header;
};

const pptxBytes = makePptxBytes();

/** Deterministic runner: materializes deck.pptx inside whatever workspace it gets. */
const workingRunner = (): PresentationRunner => ({
  id: 'ppt-master-runner',
  spawn: (request) => {
    const artifactPath = `${request.cwd}/deck.pptx`;
    return {
      result: Promise.resolve({
        exitCode: 0,
        stdout: '',
        stderr: '',
        artifacts: [{ path: artifactPath, bytes: pptxBytes, name: 'deck.pptx', type: 'pptx' }],
      }),
      cancel: () => undefined,
    };
  },
});

describe('C-33 PptMaster presentation port production factory', () => {
  it('assembles a port per authenticated scope and echoes the scope verbatim', () => {
    const factory = createPptMasterPresentationPortFactory(baseOptions());
    const scope = baseScope();
    const binding = factory(scope);

    expect(binding.scope).toBe(scope);
    expect(binding.scope.request).toBe(scope.request);
    for (const method of [
      'createJob',
      'getJob',
      'cancelJob',
      'retryJob',
      'getArtifact',
      'exportArtifact',
      'dispose',
    ] as const) {
      expect(typeof binding.port[method]).toBe('function');
    }
  });

  it('keeps scope instances independent: jobs never leak across scopes or re-resolutions', async () => {
    const factory = createPptMasterPresentationPortFactory(
      baseOptions({
        runner: makeRunner({
          spawn: () => {
            throw new Error('provider exploded');
          },
        }),
      }),
    );
    const bindingA = factory(baseScope({ userId: 'user-a', sessionId: 'session-a' }));
    const bindingB = factory(baseScope({ userId: 'user-b', sessionId: 'session-b' }));

    const job = await bindingA.port.createJob(input);

    expect(job.state).toBe('failed'); // stub runner rejects; still scoped and honest
    await expect(bindingA.port.getJob(job.jobId)).resolves.toMatchObject({ jobId: job.jobId });
    await expect(bindingB.port.getJob(job.jobId)).resolves.toBe(null);

    // Assembly-only factory: every resolve is a fresh, independent instance.
    const bindingA2 = factory(baseScope({ userId: 'user-a', sessionId: 'session-a' }));
    await expect(bindingA2.port.getJob(job.jobId)).resolves.toBe(null);
    expect(bindingA2.port).not.toBe(bindingA.port);
  });

  it('honours the explicit runner allow-list and rejects mismatched runners at construction', () => {
    expect(() =>
      createPptMasterPresentationPortFactory(baseOptions({ allowedRunnerIds: ['other-runner'] })),
    ).toThrowError(PresentationError);

    try {
      createPptMasterPresentationPortFactory(baseOptions({ allowedRunnerIds: ['other-runner'] }));
    } catch (error) {
      expect((error as PresentationError).code).toBe('PRESENTATION_RUNNER_NOT_ALLOWED');
    }

    // Matching allow-list (including the kernel-compatible default [runner.id]) is fine.
    expect(() =>
      createPptMasterPresentationPortFactory(
        baseOptions({ allowedRunnerIds: ['ppt-master-runner'] }),
      ),
    ).not.toThrow();
    expect(() => createPptMasterPresentationPortFactory(baseOptions())).not.toThrow();
  });

  it('fails with stable codes when runner/provider/scope configuration is missing or forged', () => {
    // Missing runner → PROVIDER_UNAVAILABLE.
    try {
      createPptMasterPresentationPortFactory({
        provider: 'ppt-master',
      } as PptMasterPortFactoryOptions);
      throw new Error('expected missing runner to throw');
    } catch (error) {
      expect((error as PresentationError).code).toBe('PROVIDER_UNAVAILABLE');
    }

    // Shapeless runner object → PROVIDER_UNAVAILABLE.
    try {
      createPptMasterPresentationPortFactory({
        provider: 'ppt-master',
        runner: { nope: true } as unknown as PresentationRunner,
      });
      throw new Error('expected shapeless runner to throw');
    } catch (error) {
      expect((error as PresentationError).code).toBe('PROVIDER_UNAVAILABLE');
    }

    // Missing provider → PRESENTATION_INVALID.
    try {
      createPptMasterPresentationPortFactory({
        runner: makeRunner(),
      } as PptMasterPortFactoryOptions);
      throw new Error('expected missing provider to throw');
    } catch (error) {
      expect((error as PresentationError).code).toBe('PRESENTATION_INVALID');
      expect((error as PresentationError).path).toBe('provider');
    }

    // Forged scope fields → PRESENTATION_INVALID, per field.
    const factory = createPptMasterPresentationPortFactory(baseOptions());
    for (const broken of [
      baseScope({ userId: '' }),
      baseScope({ sessionId: '  ' }),
      baseScope({ serverDB: undefined }),
      baseScope({ request: 'not-a-request' as unknown as Request }),
    ]) {
      try {
        factory(broken);
        throw new Error('expected scope validation to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(PresentationError);
        expect((error as PresentationError).code).toBe('PRESENTATION_INVALID');
      }
    }
  });

  it('dispose() is idempotent, awaits the injected onDispose once, and stays mirrored on the port', async () => {
    const onDispose = vi.fn(async () => undefined);
    const factory = createPptMasterPresentationPortFactory(baseOptions({ onDispose }));
    const binding = factory(baseScope());

    await binding.dispose();
    await binding.dispose();
    await binding.port.dispose(); // same lifecycle hook, mirrored on the port
    expect(onDispose).toHaveBeenCalledTimes(1);
    expect(onDispose).toHaveBeenCalledWith(binding.port, binding.scope);
  });

  it('propagates real provider failures instead of faking ready/completed', async () => {
    const runner = makeRunner({
      spawn: vi.fn(() => {
        throw new Error('provider exploded');
      }),
    });
    const factory = createPptMasterPresentationPortFactory(baseOptions({ runner }));

    const job = await factory(baseScope()).port.createJob(input);

    expect(job.state).toBe('failed');
    expect(job.error).toMatchObject({ code: 'PPT_MASTER_FAILED' });
    expect(job.artifactIds).toBeUndefined();
    expect(runner.spawn).toHaveBeenCalledTimes(1);

    // No artifact can ever be ready without a real run.
    await expect(factory(baseScope()).port.getArtifact('job-1:0')).resolves.toBe(null);
  });

  it('injects workspace/buildArgs explicitly and the factory itself never executes the provider', async () => {
    const buildArgs = vi.fn(() => ['--out', 'deck.pptx']);
    const workspaceFactory = vi.fn((jobId: string) => ({
      path: `/ws/${jobId}`,
      cleanup: async () => undefined,
    }));
    const runner = makeRunner({
      spawn: vi.fn(() => {
        throw new Error('runner reached');
      }),
    });
    const factory = createPptMasterPresentationPortFactory(
      baseOptions({ runner, workspaceFactory, buildArgs }),
    );
    const binding = factory(baseScope());

    // Assembly touched nothing: no spawn, no workspace, no args yet.
    expect(runner.spawn).not.toHaveBeenCalled();
    expect(workspaceFactory).not.toHaveBeenCalled();
    expect(buildArgs).not.toHaveBeenCalled();

    const job = await binding.port.createJob(input);

    // Provider-side resources engage only through port usage, via the
    // explicitly injected hooks, inside the kernel adapter's own flow.
    expect(workspaceFactory).toHaveBeenCalledWith(job.jobId);
    expect(buildArgs).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: job.jobId, workspacePath: `/ws/${job.jobId}` }),
    );
    expect(runner.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'ppt-master',
        shell: false,
        args: ['--out', 'deck.pptx'],
      }),
    );
  });

  it('supports a real artifact flow end-to-end with honest completed/ready states', async () => {
    const factory = createPptMasterPresentationPortFactory(
      baseOptions({
        runner: workingRunner(),
        idFactory: () => 'job-e2e',
        workspaceFactory: (jobId: string) => ({
          path: `/ws/${jobId}`,
          cleanup: async () => undefined,
        }),
      }),
    );

    const port: PresentationPort = factory(baseScope()).port;
    const job = await port.createJob(input);

    expect(job.state).toBe('completed');
    expect(job.artifactIds).toEqual(['job-e2e:0']);
    await expect(port.getArtifact('job-e2e:0')).resolves.toMatchObject({
      status: 'ready',
      type: 'pptx',
      sizeBytes: pptxBytes.byteLength,
    });

    // Export flows through the same runner inside a fresh export workspace and
    // stores the exported artifact under its operation id.
    const exported = await port.exportArtifact('job-e2e:0', 'pptx');
    expect(exported).toMatchObject({
      artifactId: 'job-e2e:0:export:pptx',
      format: 'pptx',
    });
    await expect(port.getArtifact('job-e2e:0:export:pptx')).resolves.toMatchObject({
      status: 'ready',
      type: 'pptx',
    });
  });
});
