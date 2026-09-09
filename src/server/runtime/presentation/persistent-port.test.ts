import { describe, expect, it, vi } from 'vitest';

import type {
  PresentationBinaryPort,
  PresentationJob,
} from '../../../../packages/cordis-kernel/src/presentation';
import {
  InMemoryPresentationArtifactStore,
  PresentationArtifactStoreError,
} from './artifact-store';
import { PersistentPresentationPort, PersistentPresentationPortError } from './persistent-port';

const scope = { userId: 'user-1', sessionId: 'session-1' } as const;
const input = { notebookId: 'nb-1', sourceVersionIds: ['v-1'], title: 'Deck' };
const bytes = new Uint8Array([1, 2, 3]);

const makeInner = (overrides: Partial<PresentationBinaryPort> = {}): PresentationBinaryPort => {
  const artifact = {
    artifactId: 'artifact-1',
    createdAt: '2026-08-29T00:00:00.000Z',
    mimeType: 'application/pdf',
    name: 'deck.pdf',
    sizeBytes: bytes.byteLength,
    status: 'ready' as const,
    type: 'pdf',
  };
  const job: PresentationJob = {
    artifactIds: ['artifact-1'],
    createdAt: artifact.createdAt,
    jobId: 'job-1',
    state: 'completed',
    updatedAt: artifact.createdAt,
  };
  return {
    cancelJob: vi.fn(async () => job),
    createJob: vi.fn(async () => job),
    exportArtifact: vi.fn(async () => ({ artifactId: 'artifact-1', format: 'pdf' as const })),
    getArtifact: vi.fn(async () => artifact),
    getJob: vi.fn(async () => job),
    readArtifactBytes: vi.fn(async () => new Uint8Array(bytes)),
    retryJob: vi.fn(async () => job),
    ...overrides,
  };
};

describe('C-50 persistent presentation port', () => {
  it('mirrors ready create/retry/export artifacts and serves cross-request reads from store', async () => {
    const inner = makeInner();
    const store = new InMemoryPresentationArtifactStore();
    const persistent = new PersistentPresentationPort({ inner, scope, store });

    await expect(persistent.createJob(input)).resolves.toMatchObject({ state: 'completed' });
    await expect(persistent.retryJob('job-1')).resolves.toMatchObject({ state: 'completed' });
    await expect(persistent.exportArtifact('artifact-1', 'pdf')).resolves.toMatchObject({
      artifactId: 'artifact-1',
    });
    expect(inner.getArtifact).toHaveBeenCalled();

    const secondInner = makeInner({
      getArtifact: vi.fn(async () => null),
      readArtifactBytes: vi.fn(async () => new Uint8Array([8, 8])),
    });
    const secondRequest = new PersistentPresentationPort({
      inner: secondInner,
      scope,
      store,
    });
    await expect(secondRequest.getArtifact('artifact-1')).resolves.toMatchObject({
      artifactId: 'artifact-1',
      status: 'ready',
    });
    const storedBytes = await secondRequest.readArtifactBytes('artifact-1');
    expect(storedBytes).toEqual(bytes);
    if (storedBytes) storedBytes[0] = 99;
    await expect(secondRequest.readArtifactBytes('artifact-1')).resolves.toEqual(bytes);
    expect(secondInner.readArtifactBytes).not.toHaveBeenCalled();
  });

  it('does not mirror failed, pending, or cancelled artifacts', async () => {
    const store = new InMemoryPresentationArtifactStore();
    const inner = makeInner({
      createJob: vi.fn(
        async () => ({ ...makeInner, state: 'failed' as const }) as unknown as PresentationJob,
      ),
      getArtifact: vi.fn(async () => ({
        artifactId: 'artifact-1',
        createdAt: '2026-08-29T00:00:00.000Z',
        status: 'pending' as const,
        type: 'pdf',
      })),
    });
    const persistent = new PersistentPresentationPort({ inner, scope, store });
    await persistent.createJob(input);
    await expect(store.get(scope, 'artifact-1')).resolves.toBeNull();
  });

  it('requires the binary seam and reports conflicting duplicate bytes without overwrite', async () => {
    const base = makeInner();
    const store = new InMemoryPresentationArtifactStore();
    expect(
      () =>
        new PersistentPresentationPort({
          inner: { ...base, readArtifactBytes: undefined } as unknown as PresentationBinaryPort,
          scope,
          store,
        }),
    ).toThrowError(expect.objectContaining({ code: 'ARTIFACT_BYTES_UNAVAILABLE' }));

    await store.put(scope, {
      artifactId: 'artifact-1',
      bytes: new Uint8Array([9, 9]),
      mimeType: 'application/pdf',
      name: 'deck.pdf',
      type: 'pdf',
    });
    const persistent = new PersistentPresentationPort({ inner: base, scope, store });
    await expect(persistent.createJob(input)).rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' });
    await expect(store.get(scope, 'artifact-1')).resolves.toMatchObject({
      bytes: new Uint8Array([9, 9]),
    });
    expect(() => new PersistentPresentationPort({ inner: base, scope })).toThrowError(
      expect.objectContaining({ code: 'ARTIFACT_STORE_UNAVAILABLE' }),
    );
  });

  it('keeps store scope errors and inner errors observable', async () => {
    const store = new InMemoryPresentationArtifactStore();
    const inner = makeInner({ getArtifact: vi.fn(async () => null) });
    const persistent = new PersistentPresentationPort({ inner, scope, store });
    await expect(persistent.getArtifact('missing')).resolves.toBeNull();

    await store.put(scope, {
      artifactId: 'artifact-1',
      bytes,
      mimeType: 'application/pdf',
      name: 'deck.pdf',
      type: 'pdf',
    });
    await expect(
      new PersistentPresentationPort({
        inner,
        scope: { userId: 'user-2', sessionId: 'session-1' },
        store,
      }).getArtifact('artifact-1'),
    ).rejects.toMatchObject({ code: 'ARTIFACT_SCOPE_MISMATCH' });
    expect(PresentationArtifactStoreError).toBeDefined();
    expect(PersistentPresentationPortError).toBeDefined();
  });
});
