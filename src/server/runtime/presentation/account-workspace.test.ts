import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { migratePresentationSessions, presentationAccountScope } from './account-workspace';
import { FilePresentationStorage } from './file-storage';
import { FilePresentationTemplateLibrary } from './templates';
import { nativeTemplateOperations } from './templates/native-operations';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe('account presentation recovery', () => {
  it('recovers owned jobs, assets and templates across logins without crossing accounts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ppt-account-'));
    roots.push(root);
    const storage = new FilePresentationStorage(root);
    const templates = new FilePresentationTemplateLibrary({ root: join(root, 'templates') });
    const old = { userId: 'alice', sessionId: 'old-login' };
    const stranger = { userId: 'bob', sessionId: 'bobs-login' };
    const record = {
      input: { notebookId: 'studio', sourceVersionIds: [], title: 'Persisted work' },
      job: {
        jobId: 'job',
        state: 'completed' as const,
        createdAt: '2026-01-01',
        updatedAt: '2026-01-02',
        title: 'Persisted work',
      },
    };
    await storage.saveJob(old, record);
    await storage.saveJob(stranger, { ...record, job: { ...record.job, jobId: 'private-bob' } });
    await storage.put(old, {
      artifactId: 'picture',
      name: 'picture.png',
      type: 'image',
      mimeType: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
    });
    const profile = await templates.learnFromPlan(old, {
      name: 'Owned template',
      plan: {
        planId: 'p',
        title: 'p',
        aspectRatio: '16:9',
        sourceVersionIds: [],
        slides: [
          {
            slideId: 's',
            order: 1,
            svg: '<svg viewBox="0 0 960 540"><text x="10" y="30">Title</text></svg>',
          },
        ],
      },
    });
    await storage.put(old, {
      artifactId: 'native-output',
      name: 'native.pptx',
      type: 'pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      bytes: new Uint8Array([4, 5, 6]),
      metadata: {
        fidelity: 'native',
        templateId: profile.templateId,
        templateVersionId: profile.versionId,
      },
    });
    await migratePresentationSessions(root, 'alice', ['old-login', 'bobs-login']);
    const account = presentationAccountScope('alice');
    expect((await storage.listJobs(account)).map((j) => j.jobId)).toEqual(['job']);
    expect((await storage.get(account, 'picture'))?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(await templates.get(account, profile.templateId)).not.toBeNull();
    const freshStorage = new FilePresentationStorage(root);
    const freshTemplates = new FilePresentationTemplateLibrary({ root: join(root, 'templates') });
    const recoverOutputs = nativeTemplateOperations(freshTemplates, freshStorage).find(
      (tool) => tool.name === 'presentation.template.listNativeOutputs',
    )!;
    expect(
      await recoverOutputs.execute({ templateId: profile.templateId }, { scope: account }),
    ).toMatchObject({ outputs: [{ artifactId: 'native-output' }] });
    await expect(
      recoverOutputs.execute(
        { templateId: profile.templateId },
        { scope: presentationAccountScope('bob') },
      ),
    ).rejects.toThrow('Owned template');
    expect(await storage.get(presentationAccountScope('bob'), 'picture')).toBeNull();
    expect(await storage.getJob(account, 'private-bob')).toBeNull();
    await storage.saveJob(account, {
      ...record,
      job: { ...record.job, title: 'Newer account version', updatedAt: '2026-02-01' },
    });
    await migratePresentationSessions(root, 'alice', ['old-login']);
    expect((await storage.getJob(account, 'job'))?.job.title).toBe('Newer account version');
    expect(await storage.getJob(old, 'job')).not.toBeNull();
  });
});
