import { describe, expect, it, vi } from 'vitest';

import type {
  PresentationJobInput,
  RuntimeScope,
} from '../../../../packages/runtime-contracts/src';
import type { GLMMultimodalChatPort } from './multimodal-chat-provider-glm';
import { createGLMPresentationPlanner } from './multimodal-planner-glm';

const mockScope: RuntimeScope = {
  sessionId: 'test-session',
  userId: 'test-user',
};

describe('GLMPresentationPlanner (C-106)', () => {
  it('fails closed when authenticated planner scope is missing', async () => {
    const chat = vi.fn();
    const planner = createGLMPresentationPlanner({
      chatPort: {
        chat,
        manifest: {
          displayName: 'test',
          model: 'test-model',
          providerId: 'test-provider',
          supportsIdempotency: true,
          supportsVision: true,
        },
        providerId: 'test-provider',
      },
    });

    await expect(
      planner.plan({ notebookId: 'notebook-1', sourceVersionIds: [], title: 'Scope test' }, {}),
    ).rejects.toThrow('authenticated planner scope is required');
    expect(chat).not.toHaveBeenCalled();
  });

  it('generates a validated presentation plan from user job input', async () => {
    let capturedRequest: any;

    const mockChatPort: GLMMultimodalChatPort = {
      chat: vi.fn(async (req) => {
        capturedRequest = req;
        return {
          choices: [
            {
              index: 0,
              message: {
                content: JSON.stringify({
                  aspectRatio: '16:9',
                  planId: 'plan-123',
                  slides: [
                    {
                      order: 1,
                      slideId: 'slide-1',
                      svg: '<svg viewBox="0 0 960 540" xmlns="http://www.w3.org/2000/svg"><rect width="960" height="540" fill="#ffffff"/><text x="100" y="200">Title Slide</text></svg>',
                    },
                    {
                      order: 2,
                      slideId: 'slide-2',
                      svg: '<svg viewBox="0 0 960 540" xmlns="http://www.w3.org/2000/svg"><rect width="960" height="540" fill="#ffffff"/><text x="100" y="200">Agenda Slide</text></svg>',
                    },
                  ],
                  title: '2026 商业规划',
                }),
                role: 'assistant' as const,
              },
            },
          ],
          created: 1700000000,
          id: 'chatcmpl-plan-1',
          model: 'glm-5.3-flash',
        };
      }),
      manifest: {
        displayName: 'GLM Multimodal Chat',
        model: 'glm-5.3-flash',
        providerId: 'glm-chat',
        supportsIdempotency: true,
        supportsVision: true,
      },
      providerId: 'glm-chat',
    };

    const planner = createGLMPresentationPlanner({ chatPort: mockChatPort });

    const input: PresentationJobInput = {
      aspectRatio: '16:9',
      language: 'zh-CN',
      notebookId: 'nb-1',
      options: {
        references: [{ name: 'logo.png', url: 'https://cdn.example.com/logo.png' }],
      },
      prompt: '为高管汇报准备的商业计划书',
      slideCount: 2,
      sourceVersionIds: ['v1'],
      title: '2026 商业规划',
    };

    const plan = await planner.plan(input, { scope: mockScope });

    expect(plan.title).toBe('2026 商业规划');
    expect(plan.aspectRatio).toBe('16:9');
    expect(plan.slides).toHaveLength(2);
    expect(plan.slides[0].slideId).toBe('slide-1');
    expect(plan.slides[1].slideId).toBe('slide-2');

    // Verify chat port received vision input for reference image
    const userMessage = capturedRequest.messages[1];
    expect(userMessage.content).toEqual([
      {
        text: '主题：2026 商业规划\n详细需求：为高管汇报准备的商业计划书\n目标页数：2\n画幅比例：16:9\n主语言：zh-CN',
        type: 'text',
      },
      {
        image_url: { url: 'https://cdn.example.com/logo.png' },
        type: 'image_url',
      },
    ]);
  });

  it('passes generated https image assets to the multimodal planner and names their slide slots', async () => {
    let capturedRequest: any;
    const mockChatPort: GLMMultimodalChatPort = {
      chat: vi.fn(async (req) => {
        capturedRequest = req;
        return {
          choices: [
            {
              index: 0,
              message: {
                content: JSON.stringify({
                  planId: 'plan-image',
                  slides: [
                    {
                      order: 1,
                      slideId: 'slide-1',
                      svg: '<svg viewBox="0 0 960 540" xmlns="http://www.w3.org/2000/svg"><image href="https://cdn.example.com/hero.png" width="960" height="540"/></svg>',
                    },
                  ],
                  title: '带视觉素材的演示文稿',
                }),
                role: 'assistant' as const,
              },
            },
          ],
          created: 1,
          id: 'chatcmpl-image',
          model: 'glm-5.3-flash',
        };
      }),
      manifest: {
        displayName: 'GLM Multimodal Chat',
        model: 'glm-5.3-flash',
        providerId: 'glm-chat',
        supportsIdempotency: true,
        supportsVision: true,
      },
      providerId: 'glm-chat',
    };
    const planner = createGLMPresentationPlanner({ chatPort: mockChatPort });

    await planner.plan(
      {
        notebookId: 'nb-image',
        options: {
          generatedImageSlots: [
            {
              assetRefs: [{ ref: 'https://cdn.example.com/hero.png' }],
              slideId: 'slide-1',
              slotId: 'hero-visual',
              state: 'ready',
            },
          ],
        },
        slideCount: 1,
        sourceVersionIds: [],
        title: '带视觉素材的演示文稿',
      },
      { scope: mockScope },
    );

    const parts = capturedRequest.messages[1].content;
    expect(parts[0].text).toContain('页面: slide-1, 槽位: hero-visual');
    expect(parts[0].text).toContain('https://cdn.example.com/hero.png');
    expect(parts).toContainEqual({
      image_url: { url: 'https://cdn.example.com/hero.png' },
      type: 'image_url',
    });
  });

  it('injects page-bound asset references into the reserved visual area', async () => {
    const mockChatPort: GLMMultimodalChatPort = {
      chat: vi.fn(async () => ({
        choices: [
          {
            index: 0,
            message: {
              content: JSON.stringify({
                aspectRatio: '16:9',
                planId: 'plan-inject',
                slides: [
                  {
                    order: 1,
                    slideId: 'slide-1',
                    svg: '<svg viewBox="0 0 960 540" xmlns="http://www.w3.org/2000/svg"><text x="20" y="40">正文</text></svg>',
                  },
                ],
                title: '素材注入',
              }),
              role: 'assistant' as const,
            },
          },
        ],
        created: 1,
        id: 'chatcmpl-inject',
        model: 'glm-5.3-flash',
      })),
      manifest: {
        displayName: 'GLM Multimodal Chat',
        model: 'glm-5.3-flash',
        providerId: 'glm-chat',
        supportsIdempotency: true,
        supportsVision: true,
      },
      providerId: 'glm-chat',
    };

    const plan = await createGLMPresentationPlanner({ chatPort: mockChatPort }).plan(
      {
        notebookId: 'nb-inject',
        options: {
          generatedImageSlots: [
            {
              assetRefs: [{ ref: 'https://cdn.example.com/hero.png' }],
              slideId: 'slide-1',
              slotId: 'hero-visual',
              state: 'ready',
            },
          ],
        },
        slideCount: 1,
        sourceVersionIds: [],
        title: '素材注入',
      },
      { scope: mockScope },
    );

    const svg = plan.slides[0].svg;
    expect(svg).toContain('href="https://cdn.example.com/hero.png"');
    expect(svg.indexOf('<image')).toBeLessThan(svg.indexOf('<text'));
    expect(svg).toContain('x="58%"');
  });

  it('fails honestly when the model omits a requested slide or returns invalid SVG', async () => {
    const mockChatPort: GLMMultimodalChatPort = {
      chat: vi.fn(async () => ({
        choices: [
          {
            index: 0,
            message: {
              content: JSON.stringify({ planId: 'bad', slides: [], title: '坏计划' }),
              role: 'assistant' as const,
            },
          },
        ],
        created: 1,
        id: 'chatcmpl-bad',
        model: 'glm-5.3-flash',
      })),
      manifest: {
        displayName: 'GLM Multimodal Chat',
        model: 'glm-5.3-flash',
        providerId: 'glm-chat',
        supportsIdempotency: true,
        supportsVision: true,
      },
      providerId: 'glm-chat',
    };

    await expect(
      createGLMPresentationPlanner({ chatPort: mockChatPort }).plan(
        { notebookId: 'nb-bad', slideCount: 1, sourceVersionIds: [], title: '坏计划' },
        { scope: mockScope },
      ),
    ).rejects.toMatchObject({ code: 'PLAN_INVALID' });
  });
});
