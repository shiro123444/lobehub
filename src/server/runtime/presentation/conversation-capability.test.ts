import { describe, expect, it, vi } from 'vitest';

import type { MultimodalChatPort } from './multimodal-chat-provider';
import { createPresentationConversationCapability } from './conversation-capability';

const chatPort = (content: unknown): MultimodalChatPort => ({
  chat: vi.fn(async () => ({
    choices: [
      { index: 0, message: { content: JSON.stringify(content), role: 'assistant' as const } },
    ],
    created: 1700000000,
    id: 'turn-1',
    model: 'test-model',
  })),
  manifest: {
    displayName: 'Test chat',
    model: 'test-model',
    providerId: 'test',
    supportsIdempotency: true,
    supportsVision: false,
  },
  providerId: 'test',
});

describe('PresentationConversationCapability', () => {
  it('lets the agent select the next question and merges its structured brief', async () => {
    const chat = chatPort({
      brief: { audience: '投资委员会', topic: '年度经营计划' },
      message: '这次汇报最需要推动哪项决策？',
      phase: 'intake',
      questionId: 'decision-goal',
    });
    const capability = createPresentationConversationCapability({ chat });

    const result = await capability.execute(
      {
        brief: { language: 'zh-CN' },
        messages: [{ content: '年度经营计划', role: 'user' }],
        operation: 'turn',
        threadId: 'thread-1',
      },
      { scope: { sessionId: 'session-1', userId: 'user-1' } },
    );

    expect(result).toEqual({
      brief: { audience: '投资委员会', language: 'zh-CN', topic: '年度经营计划' },
      message: '这次汇报最需要推动哪项决策？',
      phase: 'intake',
      questionId: 'decision-goal',
    });
    expect(chat.chat).toHaveBeenCalledOnce();
    expect(chat.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          { content: JSON.stringify({ brief: { language: 'zh-CN' } }), role: 'user' },
        ]),
      }),
      { scope: { sessionId: 'session-1', userId: 'user-1' } },
    );
  });
});
