import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { PresentationError } from '../../../../packages/cordis-kernel/src/presentation';
import {
  createProductionPresentationProvider,
  defaultProductionBuildArgs,
  resolveProviderReadiness,
} from './production-command';

const createContext = () => ({
  operation: 'create' as const,
  jobId: 'job-1',
  workspacePath: '/tmp/job-1',
  input: {
    title: 'Deck',
    notebookId: 'nb-1',
    sourceVersionIds: ['v-1'],
    options: { z: 2, a: 1 },
  },
});

describe('C-40 production presentation command seam', () => {
  it('maps create context to stable argv without shell concatenation', () => {
    const provider = createProductionPresentationProvider({
      provider: 'ppt-master',
      command: ['node', '/opt/ppt-master/cli.mjs'],
      commandArgs: ['--quiet'],
      runnerId: 'ppt-master-runner',
      allowedRunnerIds: ['ppt-master-runner'],
    });

    expect(provider.available).toBe(true);
    expect(provider.buildArgv(createContext())).toEqual([
      'node',
      '/opt/ppt-master/cli.mjs',
      '--quiet',
      'create',
      '--job-id',
      'job-1',
      '--workspace',
      '/tmp/job-1',
      '--input-file',
      '/tmp/job-1/input.json',
    ]);
    expect(provider.buildArgv(createContext())).not.toContain('node /opt/ppt-master/cli.mjs');
    expect(provider.buildArgv(createContext())).not.toContain(
      JSON.stringify(createContext().input),
    );
    const inputPath = provider.buildArgv(createContext()).at(-1)!;
    expect(path.relative(path.resolve('/tmp/job-1'), inputPath)).toBe('input.json');
  });

  it('maps export context deterministically and does not mutate input arrays', () => {
    const provider = createProductionPresentationProvider({
      provider: 'ppt-master',
      command: ['python', '-m', 'ppt_master'],
      allowedRunnerIds: ['ppt-master'],
    });
    const context = {
      operation: 'export' as const,
      jobId: 'artifact-1:export:pptx',
      workspacePath: '/tmp/export-1',
      artifactId: 'artifact-1',
      format: 'pptx' as const,
    };

    const first = provider.buildArgv(context);
    const second = provider.buildArgv(context);
    expect(first).toEqual(second);
    expect(first).toEqual([
      'python',
      '-m',
      'ppt_master',
      'export',
      '--job-id',
      'artifact-1:export:pptx',
      '--workspace',
      '/tmp/export-1',
      '--input-file',
      '/tmp/export-1/input.pptx',
      '--artifact-id',
      'artifact-1',
      '--format',
      'pptx',
    ]);
    expect(path.relative(path.resolve('/tmp/export-1'), provider.buildArgv(context)[9]!)).toBe(
      'input.pptx',
    );
  });

  it('keeps missing provider configuration as PROVIDER_UNAVAILABLE', () => {
    const missing = createProductionPresentationProvider();
    expect(missing.available).toBe(false);
    expect(() => missing.buildArgv(createContext())).toThrowError(PresentationError);
    expect(() => missing.buildArgv(createContext())).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE' }),
    );

    const missingCommand = createProductionPresentationProvider({ provider: 'ppt-master' });
    expect(() => missingCommand.buildArgv(createContext())).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE' }),
    );
  });

  it('validates command, buildArgs, and runner allow-list', () => {
    expect(() =>
      createProductionPresentationProvider({ provider: 'ppt-master', command: [] }),
    ).toThrowError(expect.objectContaining({ code: 'PRESENTATION_INVALID' }));
    expect(() =>
      createProductionPresentationProvider({
        provider: 'ppt-master',
        command: ['node'],
        runnerId: 'trusted',
        allowedRunnerIds: ['untrusted'],
      }),
    ).toThrowError(expect.objectContaining({ code: 'PRESENTATION_RUNNER_NOT_ALLOWED' }));

    const invalidArgs = createProductionPresentationProvider({
      provider: 'ppt-master',
      command: ['node'],
      buildArgs: () => ['--ok', 1 as never],
    });
    expect(() => invalidArgs.buildArgv(createContext())).toThrowError(
      expect.objectContaining({ code: 'PRESENTATION_INVALID' }),
    );
  });

  it('allows an injected operation builder while preserving the command seam', () => {
    const provider = createProductionPresentationProvider({
      provider: 'ppt-master',
      command: ['node', 'runner.js'],
      buildArgs: (context) => [context.operation, context.jobId, context.workspacePath],
    });
    expect(provider.buildArgs).not.toBe(defaultProductionBuildArgs);
    expect(provider.buildArgv(createContext())).toEqual([
      'node',
      'runner.js',
      'create',
      'job-1',
      '/tmp/job-1',
    ]);
  });
});

describe('C-73 production provider readiness seam', () => {
  it('reports a configured provider without exposing command details', () => {
    const readiness = resolveProviderReadiness({
      provider: 'ppt-master',
      command: ['node', '/opt/ppt-master/cli.mjs'],
      commandArgs: ['--api-key', 'secret-token'],
      runnerId: 'ppt-master-runner',
      allowedRunnerIds: ['ppt-master-runner'],
    });

    expect(readiness).toEqual({
      available: true,
      commandAvailable: true,
      provider: 'ppt-master',
      runnerId: 'ppt-master-runner',
      state: 'configured',
    });
  });

  it('reports missing provider configuration as unavailable without executing anything', () => {
    const buildArgs = vi.fn(() => ['never-called']);
    const readiness = resolveProviderReadiness({ buildArgs });

    expect(readiness).toEqual({
      available: false,
      commandAvailable: false,
      state: 'unavailable',
      code: 'PROVIDER_UNAVAILABLE',
    });
    expect(buildArgs).not.toHaveBeenCalled();
  });

  it('preserves existing invalid configuration errors', () => {
    expect(() =>
      resolveProviderReadiness({
        provider: 'ppt-master',
        command: ['node'],
        runnerId: 'trusted-runner',
        allowedRunnerIds: ['other-runner'],
      }),
    ).toThrowError(expect.objectContaining({ code: 'PRESENTATION_RUNNER_NOT_ALLOWED' }));

    expect(() =>
      resolveProviderReadiness({
        provider: 'ppt-master',
        command: ['node', 'runner.js'],
        commandArgs: [''],
      }),
    ).toThrowError(expect.objectContaining({ code: 'PRESENTATION_INVALID' }));
  });

  it('never returns secrets, full argv, or the injected argv builder', () => {
    const secret = 'super-secret-token';
    const command = ['node', '/private/secret/runner.js', '--token', secret];
    const buildArgs = vi.fn(() => ['--token', secret]);
    const readiness = resolveProviderReadiness({
      provider: 'ppt-master',
      command,
      commandArgs: ['--secret', secret],
      runnerId: 'safe-runner',
      allowedRunnerIds: ['safe-runner'],
      buildArgs,
    });
    const serialized = JSON.stringify(readiness);

    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('/private/secret/runner.js');
    expect(readiness).not.toHaveProperty('command');
    expect(readiness).not.toHaveProperty('commandArgs');
    expect(readiness).not.toHaveProperty('buildArgv');
    expect(buildArgs).not.toHaveBeenCalled();
  });

  it('does not alter the existing buildArgv seam after readiness inspection', () => {
    const options = {
      provider: 'ppt-master',
      command: ['node', 'runner.js'],
      runnerId: 'ppt-master',
      allowedRunnerIds: ['ppt-master'],
    } as const;
    const provider = createProductionPresentationProvider(options);
    const before = provider.buildArgv(createContext());

    expect(resolveProviderReadiness(options)).toMatchObject({
      available: true,
      commandAvailable: true,
    });
    expect(provider.buildArgv(createContext())).toEqual(before);
  });
});
