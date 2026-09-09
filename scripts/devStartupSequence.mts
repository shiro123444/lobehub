import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';
import dotenvExpand from 'dotenv-expand';
import net from 'node:net';

const env = process.env.NODE_ENV || 'development';

const shellEnv = Object.entries(process.env).reduce<Record<string, string>>((acc, [key, value]) => {
  if (typeof value === 'string') acc[key] = value;
  return acc;
}, {});
const dotenvEnv: Record<string, string> = {};
const dotenvResult = dotenv.config({
  override: true,
  path: ['.env', `.env.${env}`, `.env.${env}.local`],
  processEnv: dotenvEnv,
});

if (dotenvResult.parsed) {
  const expanded = dotenvExpand.expand({
    parsed: dotenvResult.parsed,
    processEnv: { ...dotenvEnv, ...shellEnv },
  });

  Object.assign(process.env, expanded.parsed, shellEnv);
}

/**
 * Optionally expose the local image-generation relay to child dev processes.
 *
 * This file is intentionally outside the repository. Values already present
 * in the environment (including an explicitly empty value) always win, so a
 * developer can opt out or point at another provider without this bootstrap
 * changing their configuration. Read failures are ignored to preserve the
 * existing startup path on machines without the local skill configuration.
 */
const loadOptionalImagegenEnv = () => {
  let parsed: Record<string, string>;

  try {
    parsed = dotenv.parse(readFileSync('/home/shiro/.codex/imagegen_o10.env', 'utf8'));
  } catch {
    return;
  }

  for (const key of ['OPENAI_BASE_URL', 'OPENAI_API_KEY']) {
    if (Object.prototype.hasOwnProperty.call(process.env, key)) continue;
    const value = parsed[key];
    if (typeof value === 'string' && value.trim()) process.env[key] = value;
  }
};

loadOptionalImagegenEnv();

const NEXT_HOST = 'localhost';

/**
 * Resolve the Next.js dev port.
 * Priority: -p CLI flag > PORT env var > 3010.
 */
const resolveNextPort = (): number => {
  const pIndex = process.argv.indexOf('-p');
  if (pIndex !== -1 && process.argv[pIndex + 1]) {
    return Number(process.argv[pIndex + 1]);
  }
  if (process.env.PORT) return Number(process.env.PORT);
  return 3010;
};

const NEXT_PORT = resolveNextPort();
const NEXT_ROOT_URL = `http://${NEXT_HOST}:${NEXT_PORT}/`;
const NEXT_READY_TIMEOUT_MS = 180_000;
const NEXT_READY_RETRY_MS = 400;

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

let nextProcess: ChildProcess | undefined;
let viteProcess: ChildProcess | undefined;
let shuttingDown = false;

const runNpmScript = (scriptName: string) =>
  spawn(npmCommand, ['run', scriptName], {
    env: process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isPortOpen = (host: string, port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port });
    const onDone = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    socket.once('connect', () => onDone(true));
    socket.once('error', () => onDone(false));
    socket.setTimeout(1_000, () => onDone(false));
  });

const waitForNextReady = async () => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < NEXT_READY_TIMEOUT_MS) {
    if (await isPortOpen(NEXT_HOST, NEXT_PORT)) return;
    await wait(NEXT_READY_RETRY_MS);
  }

  throw new Error(
    `Next server was not ready within ${NEXT_READY_TIMEOUT_MS / 1000}s on ${NEXT_HOST}:${NEXT_PORT}`,
  );
};

const prewarmNextRootCompile = async () => {
  const startedAt = Date.now();
  const response = await fetch(NEXT_ROOT_URL, { signal: AbortSignal.timeout(120_000) });
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
  console.log(
    `✅ Next prewarm request finished (${response.status}) in ${elapsed}s ${NEXT_ROOT_URL}`,
  );
};

/**
 * Compile the Better Auth catch-all route before the browser can submit a login form.
 *
 * In dev mode Turbopack may briefly serve the global not-found page while a dynamic
 * route is compiling. The sign-in page is usually ready first, so prewarming the
 * session endpoint removes that cold-start race without creating a session or touching
 * credentials.
 */
const prewarmAuthRoute = async () => {
  const authUrl = `${NEXT_ROOT_URL}api/auth/get-session`;
  const startedAt = Date.now();
  const response = await fetch(authUrl, { signal: AbortSignal.timeout(120_000) });
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
  console.log(`✅ Next auth prewarm finished (${response.status}) in ${elapsed}s ${authUrl}`);
};

const runNextBackgroundTasks = () => {
  setTimeout(() => {
    console.log(`🔁 Next server URL: ${NEXT_ROOT_URL}`);
  }, 2_000);

  void (async () => {
    try {
      await waitForNextReady();
      await prewarmNextRootCompile();
      await prewarmAuthRoute();
    } catch (error) {
      console.warn('⚠️ Next prewarm skipped:', error);
    }
  })();
};

const terminateChild = (child?: ChildProcess) => {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
};

const shutdownAll = (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;

  terminateChild(viteProcess);
  terminateChild(nextProcess);

  process.exitCode = signal === 'SIGINT' ? 130 : 143;
};

const watchChildExit = (child: ChildProcess, name: 'next' | 'vite') => {
  child.once('exit', (code, signal) => {
    if (!shuttingDown) {
      console.error(
        `❌ ${name} exited unexpectedly (code: ${code ?? 'null'}, signal: ${signal ?? 'null'})`,
      );
      shutdownAll('SIGTERM');
    }
  });
};

const main = async () => {
  process.once('SIGINT', () => shutdownAll('SIGINT'));
  process.once('SIGTERM', () => shutdownAll('SIGTERM'));

  nextProcess = spawn('npx', ['next', 'dev', '-p', String(NEXT_PORT)], {
    env: process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  watchChildExit(nextProcess, 'next');

  viteProcess = runNpmScript('dev:spa');
  watchChildExit(viteProcess, 'vite');
  runNextBackgroundTasks();

  await Promise.race([
    new Promise((resolve) => nextProcess?.once('exit', resolve)),
    new Promise((resolve) => viteProcess?.once('exit', resolve)),
  ]);
};

void main().catch((error) => {
  console.error('❌ dev startup sequence failed:', error);
  shutdownAll('SIGTERM');
});
