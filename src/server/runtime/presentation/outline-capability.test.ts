import { describe, expect, it, vi } from 'vitest';

import type { MultimodalChatPort } from './multimodal-chat-provider';
import { createPresentationOutlineCapability } from './outline-capability';

describe('PresentationOutlineCapability', () => {
  it('returns a validated editable outline without generating slide SVG', async () => {
    const chat: MultimodalChatPort = {
      chat: vi.fn(async () => ({
        choices: [
          {
            index: 0,
            message: {
              content: JSON.stringify({
                slides: [
                  {
                    id: 'slide-1',
                    keyPoints: ['年度目标', '关键假设'],
                    objective: '建立决策背景',
                    title: '经营目标与关键判断',
                    visualSuggestion: '关键指标与趋势图',
                  },
                ],
              }),
              role: 'assistant' as const,
            },
          },
        ],
        created: 1700000000,
        id: 'outline-1',
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
    };
    const capability = createPresentationOutlineCapability({ chat });

    const result = await capability.execute(
      { brief: { topic: '年度经营计划' }, operation: 'propose' },
      { scope: { sessionId: 'session-1', userId: 'user-1' } },
    );

    expect(result.slides[0]).toMatchObject({
      id: 'slide-1',
      title: '经营目标与关键判断',
    });
    expect(result.slides[0]).not.toHaveProperty('svg');
  });
});
