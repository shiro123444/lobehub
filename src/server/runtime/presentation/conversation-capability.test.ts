import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { AtomicRuntime } from '../atomic-runtime';
import { createPresentationContextRuntime } from './context-tools';
import { createPresentationConversationCapability } from './conversation-capability';
import type { MultimodalChatPort } from './multimodal-chat-provider';

const scope = { userId: 'alice', sessionId: 'account' };
const plan = {
  goal: '管理层决定试点范围',
  narrative: '从约束到方案再到验收',
  rationale: '目前只有计划，不能声称经营成果',
  steps: [{ action: '分析材料', reason: '先核实预算与范围' }],
  successCriteria: ['数字可追溯'],
};
const slide = { id: 's1', title: '试点计划', keyPoints: ['预算37万元'] };
const response = (value: unknown) => ({
  choices: [{ index: 0, message: { content: JSON.stringify(value), role: 'assistant' as const } }],
  created: 1,
  id: 'test',
  model: 'test',
});
const chatPort = (...decisions: unknown[]): MultimodalChatPort => {
  const chat = vi.fn();
  for (const decision of decisions) chat.mockResolvedValueOnce(response(decision));
  return {
    chat,
    manifest: {
      displayName: 'Test',
      model: 'test',
      providerId: 'test',
      supportsIdempotency: true,
      supportsVision: true,
    },
    providerId: 'test',
  };
};
const command = {
  operation: 'turn' as const,
  threadId: 't',
  messages: [{ role: 'user' as const, content: '根据材料设计汇报' }],
};
const op = (operation: string, input: unknown = {}) => ({ operation, input });

describe('autonomous presentation conversation', () => {
  it('lets the agent choose file, search, skill, plan and outline order and carries real evidence forward', async () => {
    const readFile = vi.fn(async () => ({ name: 'budget.txt', content: '预算37万元，12家门店。' }));
    const search = vi.fn(async () => ({ results: [{ url: 'https://example.com/source' }] }));
    const readSkill = vi.fn(async () => ({ name: 'Evidence', content: '每个数字标注来源' }));
    const runtime = createPresentationContextRuntime({
      readFile,
      search,
      readSkill,
      listSkills: async () => [],
    });
    const chat = chatPort(
      op('context.readFile', { id: 'owned' }),
      op('context.search', { query: '参考案例' }),
      op('context.readSkill', { id: 'evidence' }),
      op('planning.update', { topic: '门店试点', plan }),
      op('planning.outline'),
      { slides: [slide] },
      { phase: 'outline', message: '已按材料完成大纲' },
    );
    try {
      const result = await createPresentationConversationCapability({ chat }).execute(
        {
          ...command,
          references: [{ id: 'owned', kind: 'text', name: 'budget.txt', status: 'ready' }],
          tools: { search: true, skillIds: ['evidence'] },
        },
        { scope, tools: runtime },
      );
      expect(result.slides).toEqual([slide]);
      expect(result.brief.plan).toEqual(plan);
      expect(result.brief.research).toContain('37万元');
      expect(result.brief.research).toContain('https://example.com/source');
      expect(result.execution?.map((event) => event.operation)).toEqual([
        'context.readFile',
        'context.search',
        'context.readSkill',
        'planning.update',
        'planning.outline',
      ]);
      expect(JSON.stringify(vi.mocked(chat.chat).mock.calls[5])).toContain('每个数字标注来源');
    } finally {
      await runtime.dispose();
    }
  });

  it('can discuss a framework and revise it without invoking outline or imposing a template', async () => {
    const revised = { ...plan, narrative: '从使用者的一天展开', rationale: '用户要求故事式讲解' };
    const chat = chatPort(
      op('planning.update', { topic: '协作产品', plan }),
      op('planning.update', { plan: revised }),
      { phase: 'intake', message: '先按一天的使用旅程组织，暂不生成大纲。' },
    );
    const result = await createPresentationConversationCapability({ chat }).execute(command, {
      scope,
    });
    expect(result.brief.plan).toEqual(revised);
    expect(result.slides).toBeUndefined();
    expect(result.execution?.every((event) => event.operation === 'planning.update')).toBe(true);
  });

  it('discovers a newly installed atomic capability without changes to the agent dispatch loop', async () => {
    const execute = vi.fn(async (_input, ctx) => ({
      insight: '按时间叙事',
      owner: ctx.scope.userId,
    }));
    const runtime = new AtomicRuntime([
      {
        id: 'narrative',
        version: '1',
        operations: [
          {
            name: 'narrative.inspect',
            agent: { contexts: ['presentation.intake'] },
            description: 'Inspect narrative options',
            input: z.object({}).strict(),
            execute,
          },
        ],
      },
    ]);
    const chat = chatPort(
      op('narrative.inspect'),
      op('planning.update', { topic: '产品故事', plan }),
      { phase: 'intake', message: '采用时间叙事' },
    );
    try {
      const result = await createPresentationConversationCapability({ chat }).execute(command, {
        scope,
        capabilities: runtime,
      });
      expect(execute).toHaveBeenCalledWith({}, expect.objectContaining({ scope }));
      expect(result.brief.research).toContain('按时间叙事');
      expect(JSON.stringify(vi.mocked(chat.chat).mock.calls[0])).toContain('narrative.inspect');
    } finally {
      await runtime.dispose();
    }
  });

  it('rejects hidden capabilities and disabled search before any tool effect', async () => {
    const search = vi.fn();
    const runtime = createPresentationContextRuntime({
      readFile: vi.fn(),
      readSkill: vi.fn(),
      search,
      listSkills: async () => [],
    });
    try {
      await expect(
        createPresentationConversationCapability({
          chat: chatPort(op('context.search', { query: 'private' })),
        }).execute(command, { scope, tools: runtime }),
      ).rejects.toThrow('联网搜索不可用');
      await expect(
        createPresentationConversationCapability({
          chat: chatPort(op('presentation.job.delete')),
        }).execute(command, { scope, tools: runtime }),
      ).rejects.toThrow('unavailable');
      expect(search).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
    }
  });

  it('feeds tool errors back so the agent can revise the approach instead of running a fixed chain', async () => {
    const runtime = createPresentationContextRuntime({
      readFile: vi.fn(),
      readSkill: vi.fn(),
      search: vi.fn(async () => {
        throw new Error('No sources');
      }),
      listSkills: async () => [],
    });
    const chat = chatPort(
      op('context.search', { query: '试点' }),
      op('planning.update', { topic: '先做分析框架', plan }),
      { phase: 'intake', message: '暂缺可验证来源，先列待补数据。' },
    );
    try {
      const result = await createPresentationConversationCapability({ chat }).execute(
        { ...command, tools: { search: true } },
        { scope, tools: runtime },
      );
      expect(result.execution?.[0].state).toBe('failed');
      expect(JSON.stringify(vi.mocked(chat.chat).mock.calls[1])).toContain('No sources');
      expect(result.slides).toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  });

  it('repairs malformed model JSON once and never fabricates an outline receipt', async () => {
    const chat = chatPort(
      { phase: 'outline', message: 'fake completion' },
      { phase: 'intake', message: '先确认目标' },
    );
    vi.mocked(chat.chat).mockResolvedValueOnce({
      ...response(null),
      choices: [{ index: 0, message: { role: 'assistant', content: '{invalid}' } }],
    });
    // The queued valid decisions precede the malformed one, so prepend explicitly.
    vi.mocked(chat.chat)
      .mockReset()
      .mockResolvedValueOnce({
        ...response(null),
        choices: [{ index: 0, message: { role: 'assistant', content: '{invalid}' } }],
      })
      .mockResolvedValueOnce(response({ phase: 'outline', message: 'fake completion' }))
      .mockResolvedValueOnce(response({ phase: 'intake', message: '先确认目标' }));
    const result = await createPresentationConversationCapability({ chat }).execute(command, {
      scope,
    });
    expect(result.phase).toBe('intake');
    expect(result.slides).toBeUndefined();
    expect(chat.chat).toHaveBeenCalledTimes(3);
  });
});

it('streams actual tool events and preserves generated asset refs outside truncated prose', async () => {
  const runtime = new AtomicRuntime([
    {
      id: 'assets',
      version: '1',
      operations: [
        {
          name: 'assets.generate',
          description: 'Create artwork',
          input: z.object({ requestId: z.string() }),
          agent: { contexts: ['presentation.intake'] },
          execute: async () => ({ ref: 'owned-watercolor', artifactId: 'owned-watercolor' }),
        },
      ],
    },
  ]);
  const activities = vi.fn();
  try {
    const result = await createPresentationConversationCapability({
      chat: chatPort(op('assets.generate'), { phase: 'intake', message: '素材已就绪' }),
    }).execute(command, { scope, capabilities: runtime, onActivity: activities });
    expect(result.brief.assets).toEqual(['owned-watercolor']);
    expect(activities.mock.calls.map(([event]) => event.state)).toEqual(['started', 'completed']);
    expect(activities.mock.calls[0][0].text).toBe('正在生成视觉素材');
  } finally {
    await runtime.dispose();
  }
});
