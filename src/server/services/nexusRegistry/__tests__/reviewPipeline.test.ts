// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import {
  nexusRegistryItems,
  nexusRegistryReviewActions,
  nexusRegistrySafetyScans,
  users,
} from '@lobechat/database/schemas';
import { getTestDB } from '@lobechat/database/test-utils';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockAnalyzeRegistrySafety } = vi.hoisted(() => ({
  mockAnalyzeRegistrySafety: vi.fn(),
}));
const { mockAnalyzeNexusRegistrySkill } = vi.hoisted(() => ({
  mockAnalyzeNexusRegistrySkill: vi.fn(),
}));
const { mockLoadGitHubSkillSource } = vi.hoisted(() => ({
  mockLoadGitHubSkillSource: vi.fn(),
}));

vi.mock('../reviewSafety', () => ({
  analyzeRegistrySafety: mockAnalyzeRegistrySafety,
}));
vi.mock('../skillIntelligence', () => ({
  analyzeNexusRegistrySkill: mockAnalyzeNexusRegistrySkill,
}));
vi.mock('../skillSource', () => ({
  loadGitHubSkillSource: mockLoadGitHubSkillSource,
}));

import { NexusRegistryService } from '../index';

describe('NexusRegistryService review pipeline (decideAndApply)', () => {
  let db: LobeChatDatabase;
  let service: NexusRegistryService;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = await getTestDB();
    await db.insert(users).values({ id: 'user_1' }).onConflictDoNothing();
    await db.insert(users).values({ id: 'INTERNAL_SERVICE' }).onConflictDoNothing();
    service = new NexusRegistryService(db);
    // Default hydration mock so approve→ensureSkillContent does not reach a real LLM.
    mockAnalyzeNexusRegistrySkill.mockResolvedValue({
      category: 'productivity-tasks',
      installation: { agent: 'agent prompt', human: 'human note' },
      summary: 'A safe official skill.',
      tags: ['safe'],
    });
    mockLoadGitHubSkillSource.mockResolvedValue({
      content: '# Safe skill',
      manifest: {},
      resources: {},
    });
  });

  afterEach(async () => {
    await db.delete(nexusRegistryReviewActions);
    await db.delete(nexusRegistrySafetyScans);
    await db.delete(nexusRegistryItems);
    await db.delete(users);
  });

  it('auto-rejects a possible-secret WITHOUT invoking the LLM safety scan', async () => {
    mockAnalyzeRegistrySafety.mockResolvedValue({ verdict: 'pass', riskScore: 5, risks: [] });

    const [item] = await db
      .insert(nexusRegistryItems)
      .values({
        identifier: 'leaky-skill',
        kind: 'skill',
        manifest: {},
        metadata: { organizer: { reviewFlags: ['possible-secret'] } },
        name: 'Leaky Skill',
        raw: {},
        source: 'user',
        status: 'pending',
        tags: [],
      })
      .returning();

    const { decision } = await service.decideAndApply(item.id, { trigger: 'cron' });

    expect(decision).toMatchObject({ action: 'reject', automated: true });
    // Hard rule short-circuits before any LLM call.
    expect(mockAnalyzeRegistrySafety).not.toHaveBeenCalled();

    const updated = await service.getById(item.id);
    expect(updated?.status).toBe('rejected');

    const actions = await db
      .select()
      .from(nexusRegistryReviewActions)
      .where(eq(nexusRegistryReviewActions.itemId, item.id));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      action: 'reject',
      actor: 'auto',
      reviewerId: 'AUTO_REVIEWER',
    });
  });

  it('leaves a medium-risk untrusted item pending for human review', async () => {
    mockAnalyzeRegistrySafety.mockResolvedValue({ verdict: 'review', riskScore: 50, risks: [] });

    const [item] = await db
      .insert(nexusRegistryItems)
      .values({
        identifier: 'risky-skill',
        kind: 'skill',
        manifest: {},
        name: 'Risky Skill',
        raw: {},
        source: 'user',
        status: 'pending',
        tags: [],
      })
      .returning();

    const { decision } = await service.decideAndApply(item.id);

    expect(decision.automated).toBe(false);

    const updated = await service.getById(item.id);
    expect(updated?.status).toBe('pending');

    const actions = await db
      .select()
      .from(nexusRegistryReviewActions)
      .where(eq(nexusRegistryReviewActions.itemId, item.id));
    expect(actions).toHaveLength(0);
  });

  it('auto-approves an official skill that passes the safety scan', async () => {
    mockAnalyzeRegistrySafety.mockResolvedValue({ verdict: 'pass', riskScore: 10, risks: [] });

    const [item] = await db
      .insert(nexusRegistryItems)
      .values({
        description: 'A safe official skill.',
        identifier: 'safe-official-skill',
        kind: 'skill',
        manifest: {},
        name: 'Safe Official Skill',
        raw: { content: '# Safe skill' },
        source: 'official',
        status: 'pending',
        tags: [],
      })
      .returning();

    const { decision } = await service.decideAndApply(item.id);

    expect(decision).toMatchObject({ action: 'approve', automated: true });

    const updated = await service.getById(item.id);
    expect(updated?.status).toBe('active');

    const actions = await db
      .select()
      .from(nexusRegistryReviewActions)
      .where(eq(nexusRegistryReviewActions.itemId, item.id));
    expect(actions[0]).toMatchObject({ action: 'approve', actor: 'auto' });

    const scans = await db
      .select()
      .from(nexusRegistrySafetyScans)
      .where(eq(nexusRegistrySafetyScans.itemId, item.id));
    expect(scans).toHaveLength(1);
    expect(scans[0]).toMatchObject({ verdict: 'pass', riskScore: 10 });
  });

  it('getLatestScansForItems returns only the newest scan per item in one query', async () => {
    const [itemA] = await db
      .insert(nexusRegistryItems)
      .values({
        identifier: 'scan-a',
        kind: 'skill',
        manifest: {},
        name: 'Scan A',
        raw: {},
        source: 'user',
        status: 'pending',
        tags: [],
      })
      .returning();
    const [itemB] = await db
      .insert(nexusRegistryItems)
      .values({
        identifier: 'scan-b',
        kind: 'skill',
        manifest: {},
        name: 'Scan B',
        raw: {},
        source: 'user',
        status: 'pending',
        tags: [],
      })
      .returning();

    // itemA has two scans; the rescan (pass/10) is newer than the original (review/50).
    await db.insert(nexusRegistrySafetyScans).values({
      createdAt: new Date('2024-01-01'),
      itemId: itemA.id,
      risks: [],
      riskScore: 50,
      trigger: 'submit',
      verdict: 'review',
    });
    await db.insert(nexusRegistrySafetyScans).values({
      createdAt: new Date('2024-06-01'),
      itemId: itemA.id,
      risks: [],
      riskScore: 10,
      trigger: 'rescan',
      verdict: 'pass',
    });
    // itemB has a single scan.
    await db.insert(nexusRegistrySafetyScans).values({
      itemId: itemB.id,
      risks: [],
      riskScore: 90,
      trigger: 'submit',
      verdict: 'block',
    });

    expect((await service.getLatestScansForItems([])).size).toBe(0);

    const latest = await service.getLatestScansForItems([itemA.id, itemB.id]);
    expect(latest.size).toBe(2);
    expect(latest.get(itemA.id)).toMatchObject({ verdict: 'pass', riskScore: 10 });
    expect(latest.get(itemB.id)).toMatchObject({ verdict: 'block', riskScore: 90 });
  });
});
