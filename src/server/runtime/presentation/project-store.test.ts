import { describe, expect, it } from 'vitest';

import { InMemoryPresentationProjectStore, PresentationProjectStoreError } from './project-store';

const scope = { userId: 'user-1', sessionId: 'session-1' } as const;
const otherUser = { userId: 'user-2', sessionId: 'session-1' } as const;
const otherSession = { userId: 'user-1', sessionId: 'session-2' } as const;

const input = {
  title: 'Course deck',
  metadata: { presentation: { theme: 'light', tags: ['intro'] } },
  sourceVersion: { id: 'source-1', metadata: { notebookId: 'nb-1', nested: { locked: true } } },
  designSpecVersion: { id: 'design-1', parentVersionId: 'source-1' },
} as const;

const expectStoreError = async (operation: Promise<unknown>, code: string) => {
  await expect(operation).rejects.toMatchObject({
    code,
    name: 'PresentationProjectStoreError',
  });
};

describe('C-48 presentation project/version store', () => {
  it('creates a project with source and design-spec roots and supports async reads', async () => {
    const store = new InMemoryPresentationProjectStore(() => '2026-08-29T00:00:00.000Z');

    const project = await store.create(scope, input);

    expect(project).toMatchObject({
      id: 'project-1',
      title: 'Course deck',
      currentVersion: 'design-1',
      sourceVersion: { id: 'source-1', kind: 'source' },
      designSpecVersion: { id: 'design-1', kind: 'design-spec', parentVersionId: 'source-1' },
    });
    expect(store.get(scope, project.id)).toBeInstanceOf(Promise);
    await expect(store.get(scope, project.id)).resolves.toMatchObject({ id: project.id });
    await expect(store.get(scope, 'missing-project')).resolves.toBeNull();
  });

  it('appends versions without changing the selected version or deleting history', async () => {
    const store = new InMemoryPresentationProjectStore(() => '2026-08-29T00:00:00.000Z');
    const created = await store.create(scope, input);
    const appended = await store.appendVersion(scope, created.id, {
      id: 'artifact-version-1',
      kind: 'artifact',
      parentVersionId: 'design-1',
      artifactIds: ['artifact-1'],
    });

    expect(appended.currentVersion).toBe('design-1');
    expect(appended.artifactVersions).toHaveLength(1);
    expect(appended.artifactVersions[0]).toMatchObject({
      id: 'artifact-version-1',
      artifactIds: ['artifact-1'],
    });
    await expect(store.get(scope, created.id)).resolves.toMatchObject({
      currentVersion: 'design-1',
      artifactVersions: [{ id: 'artifact-version-1' }],
    });

    const selected = await store.selectVersion(scope, created.id, 'artifact-version-1');
    expect(selected.currentVersion).toBe('artifact-version-1');
    expect(selected.sourceVersion.id).toBe('source-1');
    expect(selected.designSpecVersion.id).toBe('design-1');
    expect(selected.artifactVersions).toHaveLength(1);
  });

  it('isolates projects by both user and session scope', async () => {
    const store = new InMemoryPresentationProjectStore();
    const created = await store.create(scope, input);

    await expectStoreError(store.get(otherUser, created.id), 'PROJECT_SCOPE_MISMATCH');
    await expectStoreError(store.get(otherSession, created.id), 'PROJECT_SCOPE_MISMATCH');
    await expectStoreError(
      store.appendVersion(otherUser, created.id, {
        parentVersionId: 'design-1',
        artifactIds: ['artifact-2'],
      }),
      'PROJECT_SCOPE_MISMATCH',
    );
  });

  it('rejects unknown parents, duplicate versions, and artifact overwrites', async () => {
    const store = new InMemoryPresentationProjectStore();
    const created = await store.create(scope, {
      ...input,
      artifactVersions: [
        { id: 'artifact-version-1', parentVersionId: 'design-1', artifactIds: ['artifact-1'] },
      ],
    });

    await expectStoreError(
      store.appendVersion(scope, created.id, {
        id: 'orphan',
        parentVersionId: 'unknown',
        artifactIds: ['artifact-2'],
      }),
      'PROJECT_INVALID_VERSION',
    );
    await expectStoreError(
      store.appendVersion(scope, created.id, {
        id: 'artifact-version-1',
        parentVersionId: 'design-1',
        artifactIds: ['artifact-3'],
      }),
      'PROJECT_INVALID_VERSION',
    );
    await expectStoreError(
      store.appendVersion(scope, created.id, {
        id: 'artifact-version-2',
        parentVersionId: 'design-1',
        artifactIds: ['artifact-1'],
      }),
      'PROJECT_INVALID_VERSION',
    );
    await expectStoreError(
      store.selectVersion(scope, created.id, 'unknown'),
      'PROJECT_INVALID_VERSION',
    );
    await expectStoreError(
      store.appendVersion(scope, 'missing-project', {
        parentVersionId: 'design-1',
        artifactIds: ['artifact-4'],
      }),
      'PROJECT_NOT_FOUND',
    );
  });

  it('returns defensive copies and exposes the stable error class', async () => {
    const store = new InMemoryPresentationProjectStore();
    const created = await store.create(scope, input);
    created.sourceVersion.artifactIds.push('mutated');
    (created.metadata?.presentation as { tags: string[] }).tags.push('changed');
    (created.sourceVersion.metadata?.nested as { locked: boolean }).locked = false;
    created.metadata = { changed: true };

    const stored = await store.get(scope, created.id);
    expect(stored?.sourceVersion.artifactIds).toEqual([]);
    expect(stored?.metadata).toEqual({ presentation: { theme: 'light', tags: ['intro'] } });
    expect(stored?.sourceVersion.metadata).toEqual({
      notebookId: 'nb-1',
      nested: { locked: true },
    });
    expect(PresentationProjectStoreError).toBeDefined();
  });
});
