import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type {
  PresentationChildProcessPort,
  PresentationProcessLauncherPort,
  PresentationRunnerFsPort,
  PresentationRunnerRequest,
} from './runner';
import { createProcessPresentationRunner } from './runner';

// ---------------------------------------------------------------------------
// Memory fixtures (no real ppt-master, no real processes)
// ---------------------------------------------------------------------------

const memoryFs = (files: Record<string, Uint8Array> = {}) => {
  const store = new Map<string, Uint8Array>(
    Object.entries(files).map(([path, bytes]) => [resolve(path), bytes]),
  );
  const writes: Array<{ path: string; bytes: Uint8Array }> = [];
  const port: PresentationRunnerFsPort = {
    writeFile: async (path, bytes) => {
      writes.push({ path: resolve(path), bytes });
      store.set(resolve(path), bytes);
    },
    readFile: async (path) => {
      const bytes = store.get(resolve(path));
      if (!bytes) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return bytes;
    },
    readdir: async (dir) => {
      const prefix = resolve(dir) + '/';
      return [...store.keys()]
        .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
        .map((key) => key.slice(prefix.length));
    },
    mkdir: vi.fn(async () => undefined),
  };
  return { port, store, writes };
};

const deferred = <T>() => {
  let resolveFn!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolveFn = res;
  });
  return { promise, resolve: resolveFn };
};

interface FakeChild {
  child: PresentationChildProcessPort;
  exitDeferred: deferred<{ code: number | null; signal: string | null }> extends never
    ? never
    : ReturnType<typeof deferred<{ code: number | null; signal: string | null }>>;
  kill: ReturnType<typeof vi.fn>;
  settle: (exit?: { code: number | null; signal: string | null }) => void;
}

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

const fakeChild = (
  overrides: {
    stdout?: Uint8Array[];
    stderr?: Uint8Array[];
    exit?: { code: number | null; signal: string | null };
    startError?: unknown;
    hang?: boolean;
  } = {},
): FakeChild => {
  const kill = vi.fn();
  const exitDeferred = deferred<{ code: number | null; signal: string | null }>();
  const startErrorDeferred = deferred<unknown | undefined>();

  const streamBody = async function* (): AsyncGenerator<Uint8Array> {
    for (const chunk of overrides.stdout ?? []) yield chunk;
    if (overrides.hang) {
      while (!kill.mock.calls.length) await new Promise((r) => setTimeout(r, 1));
    }
  };
  const stderrBody = async function* (): AsyncGenerator<Uint8Array> {
    for (const chunk of overrides.stderr ?? []) yield chunk;
    if (overrides.hang) {
      while (!kill.mock.calls.length) await new Promise((r) => setTimeout(r, 1));
    }
  };

  const child: PresentationChildProcessPort = {
    stdout: streamBody(),
    stderr: stderrBody(),
    exit: exitDeferred.promise,
    startError: startErrorDeferred.promise,
    kill,
  };
  const settle = (exit?: { code: number | null; signal: string | null }): void => {
    exitDeferred.resolve(exit ?? overrides.exit ?? { code: 0, signal: null });
    startErrorDeferred.resolve(overrides.startError);
  };
  if (!overrides.hang) settle();
  return { child, kill, exitDeferred, settle };
};

const fakeLauncher = (child: PresentationChildProcessPort) => {
  const spawnSpy = vi.fn(() => child);
  const launcher: PresentationProcessLauncherPort = { spawn: spawnSpy };
  return { launcher, spawnSpy };
};

const baseRequest = (
  overrides: Partial<PresentationRunnerRequest> = {},
): PresentationRunnerRequest => ({
  operation: 'create',
  jobId: 'job-1',
  provider: 'ppt-master',
  args: ['--out', 'deck.pptx'],
  cwd: '/ws/job-1',
  timeoutMs: 1000,
  maxOutputBytes: 1024,
  shell: false,
  ...overrides,
});

const flush = async (ms = 5): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms));
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('C-31 process presentation runner', () => {
  it('spawns with argv arrays and shell:false, inserting commandArgs before request args', async () => {
    const { child } = fakeChild();
    const { launcher, spawnSpy } = fakeLauncher(child);
    const runner = createProcessPresentationRunner({
      id: 'ppt-master-runner',
      command: ['node', '/opt/ppt-master/cli.mjs'],
      commandArgs: ['--serve'],
      launcher,
      fs: memoryFs().port,
    });

    const result = await runner.spawn(baseRequest({ args: ['--out', 'deck.pptx', '--quiet'] }))
      .result;

    expect(runner.id).toBe('ppt-master-runner');
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy).toHaveBeenCalledWith(
      ['node', '/opt/ppt-master/cli.mjs', '--serve', '--out', 'deck.pptx', '--quiet'],
      '/ws/job-1',
      false,
    );
    expect(result.exitCode).toBe(0);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('never launches anything by default and rejects malformed requests before launcher contact', async () => {
    const { child } = fakeChild();
    const { launcher, spawnSpy } = fakeLauncher(child);
    const unconfigured = createProcessPresentationRunner({ launcher, fs: memoryFs().port });

    await expect(unconfigured.spawn(baseRequest()).result).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
    expect(spawnSpy).not.toHaveBeenCalled();

    const configured = createProcessPresentationRunner({
      command: ['node', 'cli.mjs'],
      launcher,
      fs: memoryFs().port,
    });
    // Contract note: request-shape validation throws synchronously from
    // spawn(), so callers never receive a process for malformed requests.
    expect(() => configured.spawn(baseRequest({ shell: true as never }))).toThrowError(
      /shell: false/,
    );
    expect(() => configured.spawn(baseRequest({ args: ['--x', 5] as never }))).toThrowError(
      /string array/,
    );
    expect(() => configured.spawn(baseRequest({ timeoutMs: 0 }))).toThrowError(/positive integer/);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('collects real stdout and stderr alongside the true exit code', async () => {
    const { child } = fakeChild({
      stdout: [bytesOf('deck '), bytesOf('rendered')],
      stderr: [bytesOf('warn: slow slide')],
      exit: { code: 0, signal: null },
    });
    const runner = createProcessPresentationRunner({
      command: ['node', 'cli.mjs'],
      launcher: fakeLauncher(child).launcher,
      fs: memoryFs().port,
    });

    const result = await runner.spawn(baseRequest()).result;

    expect(result.stdout).toBe('deck rendered');
    expect(result.stderr).toBe('warn: slow slide');
    expect(result.exitCode).toBe(0);
  });

  it('resolves non-zero exits truthfully instead of fabricating completion', async () => {
    const { child } = fakeChild({
      stdout: [bytesOf('partial output')],
      stderr: [bytesOf('boom: template missing')],
      exit: { code: 3, signal: null },
    });
    const runner = createProcessPresentationRunner({
      command: ['node', 'cli.mjs'],
      launcher: fakeLauncher(child).launcher,
      fs: memoryFs().port,
    });

    const result = await runner.spawn(baseRequest()).result;

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe('boom: template missing');
  });

  it('surfaces start failures as real failures (spawn error and synchronous launcher throw)', async () => {
    const failing = fakeChild({
      startError: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    });
    const runner = createProcessPresentationRunner({
      command: ['node', 'cli.mjs'],
      launcher: fakeLauncher(failing.child).launcher,
      fs: memoryFs().port,
    });
    await expect(runner.spawn(baseRequest()).result).rejects.toMatchObject({
      code: 'PPT_MASTER_FAILED',
      message: 'Runner failed to start',
      cause: expect.objectContaining({ code: 'ENOENT' }),
    });

    const throwingLauncher: PresentationProcessLauncherPort = {
      spawn: () => {
        throw new Error('spawn exploded');
      },
    };
    const runner2 = createProcessPresentationRunner({
      command: ['node', 'cli.mjs'],
      launcher: throwingLauncher,
      fs: memoryFs().port,
    });
    await expect(runner2.spawn(baseRequest()).result).rejects.toMatchObject({
      code: 'PPT_MASTER_FAILED',
      cause: expect.objectContaining({ message: 'spawn exploded' }),
    });
  });

  it('cancel() is idempotent, terminates the process group exactly once, and is safe after completion', async () => {
    const hanging = fakeChild({ hang: true });
    const runner = createProcessPresentationRunner({
      command: ['node', 'cli.mjs'],
      launcher: fakeLauncher(hanging.child).launcher,
      fs: memoryFs().port,
    });
    const proc = runner.spawn(baseRequest());
    await flush();

    proc.cancel();
    proc.cancel();
    proc.cancel();
    expect(hanging.kill).toHaveBeenCalledTimes(1);
    expect(hanging.kill).toHaveBeenCalledWith('SIGKILL');

    // Let the killed process report its exit, then confirm the settled process
    // absorbs further cancels without touching the (already terminated) group.
    hanging.settle({ code: null, signal: 'SIGKILL' });
    await proc.result;
    proc.cancel();
    proc.cancel();
    expect(hanging.kill).toHaveBeenCalledTimes(1);
  });

  it('cancel during a running process terminates it and the result keeps real exit facts', async () => {
    const hanging = fakeChild({ hang: true });
    const runner = createProcessPresentationRunner({
      command: ['node', 'cli.mjs'],
      launcher: fakeLauncher(hanging.child).launcher,
      fs: memoryFs().port,
    });
    const proc = runner.spawn(baseRequest());
    await flush();

    proc.cancel();
    // The OS reports the killed group; signal terminations never read as success.
    hanging.settle({ code: null, signal: 'SIGKILL' });
    const result = await proc.result;

    expect(result.exitCode).not.toBe(0);
    expect(hanging.kill).toHaveBeenCalledTimes(1);
  });

  it('rejects declared artifacts and input artifacts outside the workspace', async () => {
    const escapeRunner = createProcessPresentationRunner({
      command: ['node', 'cli.mjs'],
      launcher: fakeLauncher(fakeChild().child).launcher,
      fs: memoryFs().port,
      declareArtifacts: () => ['../evil.pptx'],
    });
    await expect(escapeRunner.spawn(baseRequest()).result).rejects.toMatchObject({
      code: 'PRESENTATION_PATH_OUT_OF_SCOPE',
    });

    const { spawnSpy } = fakeLauncher(fakeChild().child);
    const inputEscape = createProcessPresentationRunner({
      command: ['node', 'cli.mjs'],
      launcher: { spawn: spawnSpy },
      fs: memoryFs().port,
    });
    await expect(
      inputEscape.spawn(
        baseRequest({
          inputArtifact: { artifactId: 'a1', path: '../outside.pptx', bytes: bytesOf('x') },
        }),
      ).result,
    ).rejects.toMatchObject({ code: 'PRESENTATION_PATH_OUT_OF_SCOPE' });
    expect(spawnSpy).not.toHaveBeenCalled(); // rejected before any process starts
  });

  it('enforces the shared output budget: oversized streams and artifacts kill the process and fail honestly', async () => {
    const oversized = fakeChild({ stdout: [bytesOf('a'.repeat(64))], hang: true });
    const runner = createProcessPresentationRunner({
      command: ['node', 'cli.mjs'],
      launcher: fakeLauncher(oversized.child).launcher,
      fs: memoryFs().port,
    });
    await expect(runner.spawn(baseRequest({ maxOutputBytes: 16 })).result).rejects.toMatchObject({
      code: 'PRESENTATION_OUTPUT_LIMIT',
    });
    expect(oversized.kill).toHaveBeenCalledWith('SIGKILL');
    oversized.settle({ code: null, signal: 'SIGKILL' }); // unblock fixture timers

    const artifactRunner = createProcessPresentationRunner({
      command: ['node', 'cli.mjs'],
      launcher: fakeLauncher(fakeChild().child).launcher,
      fs: memoryFs({ '/ws/job-1/deck.pptx': bytesOf('z'.repeat(64)) }).port,
      declareArtifacts: () => ['deck.pptx'],
    });
    await expect(
      artifactRunner.spawn(baseRequest({ maxOutputBytes: 16 })).result,
    ).rejects.toMatchObject({ code: 'PRESENTATION_OUTPUT_LIMIT' });
  });

  it('collects declared PPTX/SVG artifacts from the workspace and materializes input artifacts inside it', async () => {
    const fs = memoryFs({
      '/ws/job-1/b.svg': bytesOf('<svg/>'),
      '/ws/job-1/a.pptx': bytesOf('PK\x03\x04fake-zip'),
      '/ws/job-1/notes.txt': bytesOf('ignored'),
    });
    const runner = createProcessPresentationRunner({
      command: ['node', 'cli.mjs'],
      launcher: fakeLauncher(fakeChild().child).launcher,
      fs: fs.port,
    });

    const result = await runner.spawn(
      baseRequest({
        inputArtifact: { artifactId: 'a-in', path: 'inputs/source.json', bytes: bytesOf('{}') },
      }),
    ).result;

    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts?.map((artifact) => artifact.name)).toEqual(['a.pptx', 'b.svg']);
    expect(result.artifacts?.map((artifact) => artifact.type)).toEqual(['pptx', 'svg']);
    expect(new TextDecoder().decode(result.artifacts?.[0]?.bytes ?? new Uint8Array())).toBe(
      'PK\x03\x04fake-zip',
    );
    // Input artifact written inside the workspace, never outside it.
    expect(fs.writes).toHaveLength(1);
    expect(fs.writes[0]?.path).toBe(resolve('/ws/job-1/inputs/source.json'));
  });

  it('times out honestly, killing the process and rejecting with PRESENTATION_TIMEOUT', async () => {
    const hanging = fakeChild({ hang: true });
    const runner = createProcessPresentationRunner({
      command: ['node', 'cli.mjs'],
      launcher: fakeLauncher(hanging.child).launcher,
      fs: memoryFs().port,
    });

    await expect(runner.spawn(baseRequest({ timeoutMs: 20 })).result).rejects.toMatchObject({
      code: 'PRESENTATION_TIMEOUT',
    });
    expect(hanging.kill).toHaveBeenCalledWith('SIGKILL');
    hanging.settle({ code: null, signal: 'SIGKILL' }); // unblock fixture timers
  });
});
