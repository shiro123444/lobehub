import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { buildPresentationImageSlots, PresentationAgentFlow } from './index';
import type { PresentationAgentClient } from './presentationAgentClient';

const outlineSlides = (count: number, topic: string) =>
  Array.from({ length: count }, (_, index) => ({
    id: `slide-${index + 1}`,
    keyPoints: [`${topic}要点 ${index + 1}`],
    objective: `目标 ${index + 1}`,
    title: index === 0 ? topic : `${topic}章节 ${index + 1}`,
    visualSuggestion: '现代构图',
  }));

const readyClient = (
  brief: Awaited<ReturnType<PresentationAgentClient['turn']>>['brief'],
): PresentationAgentClient => ({
  outline: vi.fn(async () => ({
    slides: outlineSlides(brief.slideCount ?? 3, brief.topic ?? '演示文稿'),
  })),
  turn: vi.fn(async () => ({
    brief,
    message: '信息已经足够，我来整理逐页大纲。',
    phase: 'outline' as const,
  })),
});

const rewriteOutline = vi.fn(async ({ allSlides }) => allSlides);

describe('buildPresentationImageSlots', () => {
  it('creates at most four page-bound prompts for the real image provider', () => {
    const slots = buildPresentationImageSlots(
      Array.from({ length: 12 }, (_, index) => ({
        id: `outline-${index + 1}`,
        keyPoints: [`要点 ${index + 1}`],
        objective: `目标 ${index + 1}`,
        title: index === 3 ? '核心数据与案例' : `第 ${index + 1} 页`,
        visualSuggestion: '现代构图',
      })),
      '人工智能前沿',
      '高校师生',
      '学术简约',
    );

    expect(slots).toHaveLength(4);
    expect(slots[0]).toMatchObject({ slideId: 'slide-1', slotId: 'hero-visual' });
    expect(slots[0].prompt).toContain('人工智能前沿');
    expect(slots.map(({ slideId }) => slideId)).toContain('slide-4');
  });
});

describe('PresentationAgentFlow (A-1 / A-2 / A-3)', () => {
  it('renders Cordis thinking state and delegates outline generation after a real agent turn', async () => {
    let resolveTurn!: (value: Awaited<ReturnType<PresentationAgentClient['turn']>>) => void;
    const turnPromise = new Promise((resolve) => {
      resolveTurn = resolve;
    });
    const client: PresentationAgentClient = {
      outline: vi.fn(async () => ({
        slides: [
          {
            id: 'slide-1',
            keyPoints: ['关键判断'],
            objective: '支持管理层决策',
            title: 'AI 生成的决策大纲',
            visualSuggestion: '趋势图',
          },
        ],
      })),
      turn: vi.fn(() => turnPromise as ReturnType<PresentationAgentClient['turn']>),
    };
    const onOutlineAiRewrite = vi.fn(async ({ allSlides }) => allSlides);

    render(
      <PresentationAgentFlow
        agentClient={client}
        initialTopic="年度经营计划"
        onCreate={vi.fn()}
        onOutlineAiRewrite={onOutlineAiRewrite}
      />,
    );

    expect(await screen.findByTestId('presentation-agent-thinking')).toBeInTheDocument();
    expect(client.turn).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [expect.objectContaining({ content: '年度经营计划', role: 'user' })],
      }),
    );

    await act(async () => {
      resolveTurn({
        brief: { audience: '管理层', slideCount: 8, topic: '年度经营计划' },
        message: '信息已经足够，我来整理逐页大纲。',
        phase: 'outline',
      });
    });

    expect(await screen.findByDisplayValue('AI 生成的决策大纲')).toBeInTheDocument();
    expect(client.outline).toHaveBeenCalledWith({
      brief: { audience: '管理层', slideCount: 8, topic: '年度经营计划' },
    });
    expect(onOutlineAiRewrite).not.toHaveBeenCalled();
  });

  it('renders typewriter title, fills template without auto-submitting, and walks through the state machine', async () => {
    const onCreate = vi.fn();

    render(
      <PresentationAgentFlow
        agentClient={readyClient({ topic: '模板测试' })}
        onCreate={onCreate}
        onOutlineAiRewrite={rewriteOutline}
      />,
    );

    // Step 1: Typewriter title is present (A-1: No PPT icon or "PPT 创作专家")
    expect(screen.getByTestId('presentation-typewriter-title')).toBeInTheDocument();
    expect(screen.queryByText('PPT 创作专家')).not.toBeInTheDocument();
    expect(screen.getByTestId('presentation-chat-input-adapter')).toBeInTheDocument();

    // A-1 / A-3: Click template chip only fills the draft and DOES NOT auto-submit; no emoji prefix
    const templateChip = screen.getByText('企业战略规划 · 2026年企业数字化转型战略规划');
    expect(templateChip).toBeInTheDocument();
    fireEvent.click(templateChip);

    // Assert that we are still on the welcome / topic step (audience options have not appeared yet)
    expect(screen.queryByTestId('audience-options-group')).not.toBeInTheDocument();
    expect(screen.getByTestId('presentation-typewriter-title')).toBeInTheDocument();
  }, 60000);

  it('uses the Agent brief and outline as the only generation input', async () => {
    const onCreate = vi.fn();
    const client = readyClient({
      aspectRatio: '16:9',
      audience: '行业演讲',
      language: 'zh-CN',
      slideCount: 12,
      style: '科技极简',
      topic: '2026年企业数字化转型战略规划',
    });

    render(
      <PresentationAgentFlow
        agentClient={client}
        initialTopic="2026年企业数字化转型战略规划"
        onCreate={onCreate}
        onOutlineAiRewrite={rewriteOutline}
      />,
    );

    // User message for topic is shown
    await waitFor(() => {
      expect(screen.getByText('2026年企业数字化转型战略规划')).toBeInTheDocument();
    });

    // The capability result opens the editable outline directly; no fixed
    // audience/count/style questionnaire is rendered by React.
    await waitFor(() => {
      expect(screen.getByTestId('presentation-agent-outline')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('audience-options-group')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('2026年企业数字化转型战略规划')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /确认大纲，继续生成/ }));

    // User confirmation is the only transition from outline to generation.
    await waitFor(() => {
      expect(screen.getByTestId('presentation-agent-summary')).toBeInTheDocument();
    });
    expect(screen.getAllByText('2026年企业数字化转型战略规划').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('行业演讲')).toBeInTheDocument();
    expect(screen.getByText('12 页')).toBeInTheDocument();
    expect(screen.getByText(/科技极简 · 16:9 · 中文/)).toBeInTheDocument();

    // Click submit button
    const submitBtn = screen.getByRole('button', { name: /Start presentation generation/i });
    expect(submitBtn).toBeInTheDocument();
    fireEvent.click(submitBtn);

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        aspectRatio: '16:9',
        language: 'zh-CN',
        options: expect.objectContaining({
          imageSlots: expect.arrayContaining([
            expect.objectContaining({
              prompt: expect.stringContaining('2026年企业数字化转型战略规划'),
              slideId: 'slide-1',
              slotId: 'hero-visual',
            }),
          ]),
        }),
        prompt: expect.stringContaining('2026年企业数字化转型战略规划'),
        slideCount: 12,
        title: '2026年企业数字化转型战略规划',
      }),
    );
    const submitted = onCreate.mock.calls[0][0];
    expect(submitted.options.imageSlots).toHaveLength(3);
  }, 60000);

  it('forwards the notebook context required by the runtime contract', async () => {
    const onCreate = vi.fn();
    const client = readyClient({
      audience: '商务汇报',
      slideCount: 8,
      style: '科技极简',
      topic: '真实 Notebook 内容',
    });

    render(
      <PresentationAgentFlow
        agentClient={client}
        defaultNotebookId="notebook-real"
        defaultSourceVersionIds={['version-real']}
        initialTopic="真实 Notebook 内容"
        onCreate={onCreate}
        onOutlineAiRewrite={rewriteOutline}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /确认大纲，继续生成/ }));

    await waitFor(() => {
      expect(screen.getByTestId('presentation-agent-summary')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Start presentation generation/i }));

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        notebookId: 'notebook-real',
        sourceVersionIds: ['version-real'],
      }),
    );
  }, 60000);
});
