/**
 * C-31 Safe PPT Master PresentationRunner process adapter.
 *
 * A production-grade `PresentationRunner` implementation for the kernel's
 * `PptMasterAdapter`, preparing real provider wiring. Safety invariants:
 *
 * - commands are always argv arrays with `shell: false` — shell concatenation
 *   is impossible by construction and rejected by runtime validation;
 * - the provider command/runner id are explicitly configurable; with no
 *   configured command the runner never launches anything and fails honestly
 *   with `PROVIDER_UNAVAILABLE`;
 * - stdout/stderr/artifacts share one output budget (`maxOutputBytes`); the
 *   process is killed and the result rejects with `PRESENTATION_OUTPUT_LIMIT`
 *   when exceeded — never fabricating a completed result;
 * - artifacts (and input artifacts) must stay inside the job workspace —
 *   escapes reject with `PRESENTATION_PATH_OUT_OF_SCOPE`;
 * - `cancel()` is idempotent, terminates the process group exactly once, and
 *   is safe to call before spawn, while running, or after completion;
 * - spawn failures, non-zero exits and budget overruns surface as real
 *   failures (the result carries the true exit code / rejects).
 *
 * Testability: the process launcher and filesystem are injected ports. The
 * production defaults wrap `node:child_process.spawn` (detached process group,
 * `SIGKILL` on cancel) and `node:fs/promises`; tests inject memory ports and
 * never run ppt-master.
 */

import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve as pathResolve, sep } from 'node:path';

import type {
  PresentationRunner,
  PresentationRunnerArtifact,
  PresentationRunnerProcess,
  PresentationRunnerRequest,
  PresentationRunnerResult,
} from '../../../../packages/cordis-kernel/src/presentation';
import { PresentationError } from '../../../../packages/cordis-kernel/src/presentation';

// ---------------------------------------------------------------------------
// Injectable ports
// ---------------------------------------------------------------------------

/** Filesystem surface the runner needs; inject a memory port in tests. */
export interface PresentationRunnerFsPort {
  mkdir?: (path: string) => Promise<void>;
  readdir: (path: string) => Promise<readonly string[]>;
  readFile: (path: string) => Promise<Uint8Array>;
  writeFile: (path: string, bytes: Uint8Array) => Promise<void>;
}

/** The running child process surface; inject a fake in tests. */
export interface PresentationChildProcessPort {
  /** Settles with the real exit facts once the process is gone. */
  readonly exit: Promise<{ readonly code: number | null; readonly signal: string | null }>;
  /** Terminate the process group; must tolerate repeated calls. */
  kill: (signal?: string) => void;
  /**
   * Settles `undefined` on a clean lifecycle or with the spawn error when the
   * process failed to start (e.g. ENOENT).
   */
  readonly startError: Promise<unknown | undefined>;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly stdout: AsyncIterable<Uint8Array>;
  /** Optional stdin writer used by JSONL workers; absent for argv-only fakes. */
  readonly stdin?: {
    end: (input?: string | Uint8Array) => void;
  };
}

/** Launcher surface; inject a fake in tests, defaults to node:child_process. */
export interface PresentationProcessLauncherPort {
  spawn: (argv: readonly string[], cwd: string, shell: false) => PresentationChildProcessPort;
}

export interface ProcessPresentationRunnerOptions {
  /**
   * Configurable provider command argv (e.g. ['node', '/…/ppt-master/cli.mjs']).
   * REQUIRED for spawning: without it the runner never launches anything.
   */
  readonly command?: readonly string[];
  /** Extra static argv inserted between the command and the request args. */
  readonly commandArgs?: readonly string[];
  /**
   * Declares artifact paths the provider will produce inside the workspace.
   * Defaults to scanning the workspace root for *.pptx / *.svg files.
   */
  readonly declareArtifacts?: (request: PresentationRunnerRequest) => readonly string[];
  readonly fs?: PresentationRunnerFsPort;
  /** Configurable runner id (surfaced to the kernel's allow-list). */
  readonly id?: string;
  readonly launcher?: PresentationProcessLauncherPort;
  /** Optional JSONL/stdin payload builder, evaluated only after spawn. */
  readonly stdinBuilder?: (
    request: PresentationRunnerRequest,
  ) => string | Uint8Array | Promise<string | Uint8Array>;
  /** Upper bound on collected artifacts (default 32). */
  readonly maxArtifacts?: number;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const DEFAULT_RUNNER_ID = 'process';
const DEFAULT_MAX_ARTIFACTS = 32;

const validatePositiveInt = (value: number, path: string, jobId: string): number => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new PresentationError('PRESENTATION_INVALID', `${path} must be a positive integer`, {
      jobId,
      path,
    });
  }
  return value;
};

const validateRequest = (request: PresentationRunnerRequest): void => {
  if (request.shell !== false) {
    // Non-negotiable: this runner only ever speaks argv arrays.
    throw new PresentationError('PRESENTATION_INVALID', 'Runner requests must use shell: false', {
      jobId: request?.jobId,
      path: 'shell',
    });
  }
  for (const field of ['jobId', 'provider', 'cwd'] as const) {
    const value = request[field];
    if (typeof value !== 'string' || !value.trim()) {
      throw new PresentationError('PRESENTATION_INVALID', `${field} must be a non-empty string`, {
        jobId: request?.jobId,
        path: field,
      });
    }
  }
  if (!Array.isArray(request.args) || request.args.some((arg) => typeof arg !== 'string')) {
    throw new PresentationError('PRESENTATION_INVALID', 'args must be a string array', {
      jobId: request.jobId,
      path: 'args',
    });
  }
  validatePositiveInt(request.timeoutMs, 'timeoutMs', request.jobId);
  validatePositiveInt(request.maxOutputBytes, 'maxOutputBytes', request.jobId);
};

/** Resolves a workspace-relative/absolute path, rejecting workspace escapes. */
const pathInsideWorkspace = (cwd: string, candidate: string, jobId: string): string => {
  if (typeof candidate !== 'string' || !candidate.trim()) {
    throw new PresentationError('PRESENTATION_PATH_OUT_OF_SCOPE', 'Artifact path is empty', {
      jobId,
      path: candidate,
    });
  }
  const root = pathResolve(cwd);
  const resolved = pathResolve(root, candidate);
  const pathFromRoot = relative(root, resolved);
  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new PresentationError(
      'PRESENTATION_PATH_OUT_OF_SCOPE',
      `Artifact path is outside the job workspace: ${candidate}`,
      { jobId, path: candidate },
    );
  }
  return resolved;
};

const concatBytes = (chunks: readonly Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
};

const decodeUtf8 = (bytes: Uint8Array): string =>
  new TextDecoder('utf-8', { fatal: false }).decode(bytes);

/** Recursively discover provider artifacts while retaining workspace bounds. */
const findArtifacts = async (
  fsPort: PresentationRunnerFsPort,
  root: string,
): Promise<readonly string[]> => {
  const found: string[] = [];
  const visit = async (relativeDir: string): Promise<void> => {
    const absoluteDir = relativeDir ? pathResolve(root, relativeDir) : pathResolve(root);
    let entries: readonly string[];
    try {
      entries = await fsPort.readdir(absoluteDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const relativePath = relativeDir ? `${relativeDir}/${entry}` : entry;
      if (/\.(?:pptx|svg)$/i.test(entry)) {
        found.push(relativePath);
        continue;
      }
      await visit(relativePath);
    }
  };
  await visit('');
  return found.sort();
};

// ---------------------------------------------------------------------------
// Production default ports
// ---------------------------------------------------------------------------

const defaultFsPort: PresentationRunnerFsPort = {
  writeFile: (path, bytes) => writeFile(path, bytes),
  readFile: (path) => readFile(path),
  readdir: (path) => readdir(path),
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
};

class NodeChildProcessPort implements PresentationChildProcessPort {
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly exit: Promise<{ readonly code: number | null; readonly signal: string | null }>;
  readonly startError: Promise<unknown | undefined>;
  readonly stdin: { end: (input?: string | Uint8Array) => void };
  private readonly child: ReturnType<typeof spawn>;
  private killed = false;

  constructor(command: readonly string[], cwd: string, shell: false) {
    this.child = spawn(command[0]!, command.slice(1), {
      cwd,
      shell,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const toChunks = async function* (stream: NodeJS.ReadableStream): AsyncGenerator<Uint8Array> {
      for await (const chunk of stream) {
        yield typeof chunk === 'string'
          ? new TextEncoder().encode(chunk)
          : new Uint8Array(chunk as Buffer);
      }
    };
    this.stdout = toChunks(this.child.stdout!);
    this.stderr = toChunks(this.child.stderr!);
    this.stdin = {
      end: (input) => {
        if (!this.child.stdin || this.child.stdin.destroyed) return;
        this.child.stdin.end(
          input === undefined
            ? undefined
            : input instanceof Uint8Array
              ? Buffer.from(input)
              : input,
        );
      },
    };
    this.exit = new Promise((resolveExit) => {
      // 'close' fires after stdio flushes; a spawn failure resolves honestly
      // with nulls instead of hanging the runner.
      this.child.once('close', (code, signal) => resolveExit({ code, signal }));
      this.child.once('error', () => resolveExit({ code: null, signal: null }));
    });
    this.startError = new Promise((resolveStart) => {
      this.child.once('error', (error) => resolveStart(error));
      this.child.once('close', () => resolveStart(undefined));
    });
  }

  kill(signal = 'SIGKILL'): void {
    if (this.killed) return;
    this.killed = true;
    // Detached process group: negative pid targets the whole group.
    if (this.child.pid !== undefined) {
      try {
        process.kill(-this.child.pid, signal);
        return;
      } catch {
        // Process group may already be gone; fall through to direct kill.
      }
    }
    try {
      this.child.kill(signal as NodeJS.Signals);
    } catch {
      // Already exited; cancellation remains idempotent.
    }
  }
}

const defaultLauncher: PresentationProcessLauncherPort = {
  spawn: (argv, cwd, shell) => new NodeChildProcessPort(argv, cwd, shell),
};

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

export function createProcessPresentationRunner(
  options: ProcessPresentationRunnerOptions = {},
): PresentationRunner {
  const id = options.id ?? DEFAULT_RUNNER_ID;
  const maxArtifacts = options.maxArtifacts ?? DEFAULT_MAX_ARTIFACTS;

  return {
    id,
    spawn(request: PresentationRunnerRequest): PresentationRunnerProcess {
      validateRequest(request);
      const { jobId, cwd, timeoutMs, maxOutputBytes } = request;
      const fsPort = options.fs ?? defaultFsPort;
      const launcher = options.launcher ?? defaultLauncher;

      let child: PresentationChildProcessPort | undefined;
      let childKilled = false;
      let cancelled = false;
      let aborted = false; // budget overrun or timeout already failed the result
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

      const killChild = (signal = 'SIGKILL'): void => {
        if (childKilled || !child) return;
        childKilled = true;
        try {
          child.kill(signal);
        } catch {
          // Cancellation must never throw.
        }
      };

      let resultReject: (error: PresentationError) => void = () => undefined;

      const fail = (error: PresentationError): void => {
        if (aborted) return;
        aborted = true;
        killChild();
        resultReject(error);
      };

      const result = new Promise<PresentationRunnerResult>((resolve, reject) => {
        resultReject = reject;

        const run = async (): Promise<void> => {
          if (!options.command || options.command.length === 0) {
            // Honest failure: no implicit external command, ever.
            throw new PresentationError(
              'PROVIDER_UNAVAILABLE',
              'Presentation runner has no provider command configured',
              { jobId },
            );
          }

          // 1. Materialize the declared input artifact inside the workspace.
          const input = request.inputArtifact;
          if (input) {
            const inputPath = pathInsideWorkspace(cwd, input.path, jobId);
            const inputDir = inputPath.slice(0, inputPath.lastIndexOf(sep)) || cwd;
            if (inputDir !== pathResolve(cwd) && fsPort.mkdir) await fsPort.mkdir(inputDir);
            await fsPort.writeFile(inputPath, input.bytes);
          }

          // 2. Spawn with argv array + shell:false through the launcher port.
          const argv = [...options.command, ...(options.commandArgs ?? []), ...request.args];
          try {
            child = launcher.spawn(argv, cwd, false);
          } catch (cause) {
            throw new PresentationError('PPT_MASTER_FAILED', 'Runner failed to start', {
              jobId,
              cause,
            });
          }
          if (options.stdinBuilder) {
            if (!child.stdin) {
              throw new PresentationError('PPT_MASTER_FAILED', 'Runner does not expose stdin', {
                jobId,
                path: 'stdin',
              });
            }
            const payload = await options.stdinBuilder(request);
            child.stdin.end(payload);
          }
          // A cancel() that raced ahead of spawn still terminates the group.
          if (cancelled) killChild();

          // 3. Shared output budget across stdout, stderr and artifacts.
          let usedBytes = 0;
          const withinBudget = (size: number, path: string): boolean => {
            if (usedBytes + size > maxOutputBytes) {
              fail(
                new PresentationError(
                  'PRESENTATION_OUTPUT_LIMIT',
                  `Runner output exceeds ${maxOutputBytes} bytes`,
                  { jobId, path },
                ),
              );
              return false;
            }
            usedBytes += size;
            return true;
          };

          const collectStream = async (
            stream: AsyncIterable<Uint8Array>,
            sink: Uint8Array[],
            streamPath: string,
          ): Promise<void> => {
            for await (const chunk of stream) {
              if (aborted) return;
              if (!withinBudget(chunk.byteLength, streamPath)) return;
              sink.push(chunk);
            }
          };

          const stdoutChunks: Uint8Array[] = [];
          const stderrChunks: Uint8Array[] = [];
          const [streamOutcome, exitOutcome, startError] = await Promise.all([
            Promise.allSettled([
              collectStream(child.stdout, stdoutChunks, 'stdout'),
              collectStream(child.stderr, stderrChunks, 'stderr'),
            ]),
            child.exit,
            child.startError,
          ]);
          void streamOutcome;
          if (aborted) return; // budget failure already rejected the result

          if (startError !== undefined) {
            throw new PresentationError('PPT_MASTER_FAILED', 'Runner failed to start', {
              jobId,
              cause: startError,
            });
          }

          const exit = exitOutcome ?? { code: null, signal: null };

          // 4. Collect declared PPTX/SVG artifacts from inside the workspace.
          const declared = (
            options.declareArtifacts
              ? options.declareArtifacts(request)
              : await findArtifacts(fsPort, cwd)
          ).slice(0, maxArtifacts);

          const artifacts: PresentationRunnerArtifact[] = [];
          for (const declaredPath of declared) {
            if (aborted) return;
            const artifactPath = pathInsideWorkspace(cwd, declaredPath, jobId);
            const bytes = await fsPort.readFile(artifactPath);
            if (aborted) return;
            if (!withinBudget(bytes.byteLength, artifactPath)) return;
            artifacts.push({
              path: artifactPath,
              bytes,
              name: basename(artifactPath),
              type: artifactPath.toLowerCase().endsWith('.svg') ? 'svg' : 'pptx',
            });
          }
          if (aborted) return;

          resolve({
            // Signal terminations map to a non-zero exit code: real facts, no
            // fabricated success; the kernel maps non-zero exits to failure.
            exitCode: exit.code ?? (exit.signal ? 143 : -1),
            stdout: decodeUtf8(concatBytes(stdoutChunks)),
            stderr: decodeUtf8(concatBytes(stderrChunks)),
            artifacts,
          });
        };

        void run().catch((error: unknown) => {
          reject(
            error instanceof PresentationError
              ? error
              : new PresentationError('PPT_MASTER_FAILED', 'Presentation runner failed', {
                  jobId,
                  cause: error,
                }),
          );
        });

        // Timeout: real failure plus process-group termination.
        timeoutTimer = setTimeout(() => {
          fail(
            new PresentationError('PRESENTATION_TIMEOUT', 'Presentation runner timed out', {
              jobId,
            }),
          );
        }, timeoutMs);
      });

      return {
        result: result.finally(() => {
          if (timeoutTimer) clearTimeout(timeoutTimer);
        }),
        cancel() {
          cancelled = true;
          killChild(); // idempotent: subsequent calls are no-ops
        },
      };
    },
  };
}
