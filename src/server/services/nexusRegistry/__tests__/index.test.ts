// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { nexusRegistryItems, users } from '@lobechat/database/schemas';
import { getTestDB } from '@lobechat/database/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLoadGitHubSkillSource } = vi.hoisted(() => ({
  mockLoadGitHubSkillSource: vi.fn(),
}));
const { mockAnalyzeNexusRegistrySkill } = vi.hoisted(() => ({
  mockAnalyzeNexusRegistrySkill: vi.fn(),
}));

vi.mock('../skillSource', () => ({
  loadGitHubSkillSource: mockLoadGitHubSkillSource,
}));
vi.mock('../skillIntelligence', () => ({
  analyzeNexusRegistrySkill: mockAnalyzeNexusRegistrySkill,
}));

import { NexusRegistryService } from '../index';

describe('NexusRegistryService', () => {
  let db: LobeChatDatabase;
  let service: NexusRegistryService;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = await getTestDB();
    await db.insert(users).values({ id: 'user_1' }).onConflictDoNothing();
    await db.insert(users).values({ id: 'INTERNAL_SERVICE' }).onConflictDoNothing();
    service = new NexusRegistryService(db);
    mockAnalyzeNexusRegistrySkill.mockResolvedValue({
      category: 'web-frontend-development',
      installation: {
        agent: 'Use the skill and read the repository instructions.',
        human: 'Install the skill through the repository flow.',
      },
      related: [
        {
          identifier: 'related-skill',
          name: 'Related Skill',
          reason: 'Similar automation workflow.',
        },
      ],
      summary: 'A concise skill summary.',
      tags: ['automation', 'workflow'],
    });
  });

  afterEach(async () => {
    await db.delete(nexusRegistryItems);
    await db.delete(users);
  });

  it('hydrates GitHub skill content on submit', async () => {
    mockLoadGitHubSkillSource.mockResolvedValue({
      content: '# Skill Title\n\nSkill body.',
      manifest: {
        description: 'Skill body.',
        name: 'Skill Title',
      },
      resources: {
        'NOTICE.md': { size: 128 },
      },
    });

    const result = await service.submit({
      kind: 'skill',
      name: 'Repository Skill',
      repositoryUrl: 'https://github.com/acme/repository-skill',
      submittedBy: 'user_1',
    });

    expect(mockLoadGitHubSkillSource).toHaveBeenCalledWith(
      'https://github.com/acme/repository-skill',
    );
    expect(mockAnalyzeNexusRegistrySkill).toHaveBeenCalled();
    expect(result.item.raw).toMatchObject({
      content: '# Skill Title\n\nSkill body.',
      ai: {
        category: 'web-frontend-development',
        installation: {
          agent: 'Use the skill and read the repository instructions.',
          human: 'Install the skill through the repository flow.',
        },
        summary: 'A concise skill summary.',
        tags: ['automation', 'workflow'],
      },
      resources: {
        'NOTICE.md': { size: 128 },
      },
      summary: 'A concise skill summary.',
    });
    expect(result.item.category).toBe('web-frontend-development');
    expect(result.item.description).toBe('A concise skill summary.');
    expect(result.item.manifest).toMatchObject({
      description: 'Skill body.',
      name: 'Skill Title',
    });
  });

  it('backfills empty skill content when approving', async () => {
    const [created] = await db
      .insert(nexusRegistryItems)
      .values({
        identifier: 'acme-repository-skill',
        kind: 'skill',
        manifest: {},
        name: 'Repository Skill',
        raw: {},
        repositoryUrl: 'https://github.com/acme/repository-skill',
        source: 'user',
        status: 'pending',
        tags: [],
      })
      .returning();

    mockLoadGitHubSkillSource.mockResolvedValue({
      content: '# Skill Title\n\nSkill body.',
      manifest: {
        description: 'Skill body.',
        name: 'Skill Title',
      },
      resources: {
        'NOTICE.md': { size: 128 },
      },
    });

    await service.updateStatus(
      created.id,
      {
        id: created.id,
        status: 'active',
      },
      {
        userId: 'user_1',
      },
    );

    const updated = await service.getById(created.id);
    expect(mockLoadGitHubSkillSource).toHaveBeenCalledWith(
      'https://github.com/acme/repository-skill',
    );
    expect(mockAnalyzeNexusRegistrySkill).toHaveBeenCalled();
    expect(updated?.raw).toMatchObject({
      content: '# Skill Title\n\nSkill body.',
      ai: {
        category: 'web-frontend-development',
        installation: {
          agent: 'Use the skill and read the repository instructions.',
          human: 'Install the skill through the repository flow.',
        },
        summary: 'A concise skill summary.',
        tags: ['automation', 'workflow'],
      },
      resources: {
        'NOTICE.md': { size: 128 },
      },
      summary: 'A concise skill summary.',
    });
    expect(updated?.category).toBe('web-frontend-development');
    expect(updated?.description).toBe('A concise skill summary.');
    expect(updated?.manifest).toMatchObject({
      description: 'Skill body.',
      name: 'Skill Title',
    });
    expect(updated?.status).toBe('active');
  });

  it('resolves related skills from the stored AI hints', async () => {
    mockLoadGitHubSkillSource.mockResolvedValue({
      content: '# Skill Title\n\nSkill body.',
      manifest: {
        description: 'Skill body.',
        name: 'Skill Title',
      },
      resources: {},
    });

    await db
      .insert(nexusRegistryItems)
      .values({
        category: 'web-frontend-development',
        identifier: 'related-skill',
        kind: 'skill',
        manifest: {},
        name: 'Related Skill',
        raw: {
          ai: {
            summary: 'Related skill summary.',
          },
        },
        source: 'user',
        status: 'active',
        tags: ['automation'],
      })
      .returning();

    const submitted = await service.submit({
      kind: 'skill',
      name: 'Repository Skill',
      repositoryUrl: 'https://github.com/acme/repository-skill',
      submittedBy: 'user_1',
    });

    await service.updateStatus(
      submitted.item.id,
      {
        id: submitted.item.id,
        status: 'active',
      },
      {
        userId: 'user_1',
      },
    );

    const detail = await service.getSkillDetail('acme-repository-skill');
    expect(detail?.related?.[0]).toMatchObject({
      identifier: 'related-skill',
      name: 'Related Skill',
    });
    expect(detail?.installation?.agent).toContain('Use the skill');
    expect(detail?.overview?.summary).toBe('A concise skill summary.');
  });

  it('hydrates official skills without a submittedBy user', async () => {
    mockLoadGitHubSkillSource.mockResolvedValue({
      content: '# Skill Title\n\nSkill body.',
      manifest: {
        description: 'Skill body.',
        name: 'Skill Title',
      },
      resources: {},
    });

    const result = await service.submit({
      kind: 'skill',
      name: 'Repository Skill',
      repositoryUrl: 'https://github.com/acme/repository-skill',
    });

    expect(mockAnalyzeNexusRegistrySkill).toHaveBeenCalled();
    expect(result.item.raw).toMatchObject({
      ai: {
        category: 'web-frontend-development',
        installation: {
          agent: 'Use the skill and read the repository instructions.',
          human: 'Install the skill through the repository flow.',
        },
        summary: 'A concise skill summary.',
        tags: ['automation', 'workflow'],
      },
      summary: 'A concise skill summary.',
    });
  });

  it('backfills existing skill records with missing AI metadata', async () => {
    const [missing] = await db
      .insert(nexusRegistryItems)
      .values({
        identifier: 'needs-ai',
        kind: 'skill',
        manifest: {},
        name: 'Needs AI',
        raw: {
          content: '# Needs AI\n\nSkill body.',
        },
        source: 'user',
        status: 'active',
        tags: [],
      })
      .returning();

    await db.insert(nexusRegistryItems).values({
      category: 'web-frontend-development',
      description: 'Existing summary.',
      identifier: 'already-filled',
      kind: 'skill',
      manifest: {},
      name: 'Already Filled',
      raw: {
        ai: {
          category: 'web-frontend-development',
          installation: {
            agent: 'Existing agent prompt.',
            human: 'Existing human instructions.',
          },
          summary: 'Existing summary.',
          tags: ['existing'],
        },
        category: 'web-frontend-development',
        content: '# Already Filled\n\nSkill body.',
        installation: {
          agent: 'Existing agent prompt.',
          human: 'Existing human instructions.',
        },
        summary: 'Existing summary.',
      },
      source: 'user',
      status: 'active',
      tags: ['existing'],
    });

    const result = await service.backfillSkills({ limit: 10, userId: 'user_1' });
    const updated = await service.getById(missing.id);

    expect(result).toMatchObject({
      failedCount: 0,
      processedCount: 1,
      skippedCount: 1,
      totalCount: 2,
      updatedCount: 1,
    });
    expect(mockAnalyzeNexusRegistrySkill).toHaveBeenCalledTimes(1);
    expect(updated?.raw).toMatchObject({
      ai: {
        category: 'web-frontend-development',
        installation: {
          agent: 'Use the skill and read the repository instructions.',
          human: 'Install the skill through the repository flow.',
        },
        summary: 'A concise skill summary.',
      },
      installation: {
        agent: 'Use the skill and read the repository instructions.',
        human: 'Install the skill through the repository flow.',
      },
      summary: 'A concise skill summary.',
    });
  });
});
