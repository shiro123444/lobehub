// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { users } from '@lobechat/database/schemas';
import { getTestDB } from '@lobechat/database/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGenerateObject } = vi.hoisted(() => ({
  mockGenerateObject: vi.fn(),
}));

vi.mock('@/server/modules/ModelRuntime', () => ({
  initModelRuntimeFromDB: vi.fn().mockResolvedValue({
    generateObject: mockGenerateObject,
  }),
}));

import { analyzeRegistrySafety } from '../reviewSafety';

describe('analyzeRegistrySafety', () => {
  let db: LobeChatDatabase;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = await getTestDB();
    await db.insert(users).values({ id: 'user_1' }).onConflictDoNothing();
    await db.insert(users).values({ id: 'INTERNAL_SERVICE' }).onConflictDoNothing();
  });

  afterEach(async () => {
    await db.delete(users);
  });

  it('runs LLM safety analysis and returns scan results', async () => {
    mockGenerateObject.mockResolvedValue({
      verdict: 'pass',
      riskScore: 10,
      risks: [],
    });

    const result = await analyzeRegistrySafety(db, {
      identifier: 'test-skill',
      kind: 'skill',
      name: 'Test Skill',
      content: 'Clean and safe content.',
      submittedBy: 'user_1',
    });

    expect(mockGenerateObject).toHaveBeenCalled();
    expect(result).toEqual({
      verdict: 'pass',
      riskScore: 10,
      risks: [],
    });
  });

  it('returns review fallback when LLM runtime throws error', async () => {
    mockGenerateObject.mockRejectedValue(new Error('LLM model timeout'));

    const result = await analyzeRegistrySafety(db, {
      identifier: 'dangerous-skill',
      kind: 'skill',
      name: 'Dangerous Skill',
      content: 'rm -rf /',
      submittedBy: 'user_1',
    });

    expect(result).toMatchObject({
      verdict: 'review',
      riskScore: 50,
      risks: expect.arrayContaining([
        expect.objectContaining({
          type: 'other',
          severity: 'warning',
          detail: expect.stringContaining('Safety scanner failed to run'),
        }),
      ]),
    });
  });
});
