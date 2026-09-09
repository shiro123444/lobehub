import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import OutlineWorkspace, { type OutlineSlide } from './OutlineWorkspace';

const providerSlides = (): OutlineSlide[] =>
  Array.from({ length: 4 }, (_, index) => ({
    id: `slide-${index + 1}`,
    keyPoints: [`要点 ${index + 1}.1`, `要点 ${index + 1}.2`, `要点 ${index + 1}.3`],
    objective: `目标 ${index + 1}`,
    speakerNotes: `备注 ${index + 1}`,
    title: index === 0 ? '智能新零售' : `章节 ${index + 1}`,
    visualSuggestion: `视觉 ${index + 1}`,
  }));

const noRewrite = vi.fn(async () => undefined);

describe('OutlineWorkspace (A-5 / C-107)', () => {
  it('renders provider slides verbatim without automatically requesting a rewrite', () => {
    const onAiRewrite = vi.fn(async () => undefined);
    render(
      <OutlineWorkspace
        initialSlides={providerSlides()}
        onAiRewrite={onAiRewrite}
        onBack={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByDisplayValue('智能新零售')).toBeInTheDocument();
    expect(screen.getByText(/共 4 页 · 版本 v1/)).toBeInTheDocument();
    expect(onAiRewrite).not.toHaveBeenCalled();
  }, 60000);

  it('renders all slide cards and supports editing titles and points', () => {
    const onConfirm = vi.fn();
    const onBack = vi.fn();

    render(
      <OutlineWorkspace
        initialSlides={providerSlides()}
        onAiRewrite={noRewrite}
        onBack={onBack}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByTestId('presentation-agent-outline')).toBeInTheDocument();
    expect(screen.getByText(/共 4 页 · 版本 v1/)).toBeInTheDocument();

    // Edit slide title
    const firstTitleInput = screen.getByLabelText('第 1 页标题');
    fireEvent.change(firstTitleInput, { target: { value: '封面：智能新零售数字化全景' } });
    expect(firstTitleInput).toHaveValue('封面：智能新零售数字化全景');
    expect(screen.getByText(/版本 v2/)).toBeInTheDocument();

    // Edit key point
    const firstPointInput = screen.getByLabelText('第 1 页要点 1');
    fireEvent.change(firstPointInput, { target: { value: '重点聚焦智能供应链与门店协同' } });
    expect(firstPointInput).toHaveValue('重点聚焦智能供应链与门店协同');

    // Add point
    const addPointButton = screen.getByRole('button', { name: '为第 1 页添加要点' });
    fireEvent.click(addPointButton);
    expect(screen.getByLabelText('第 1 页要点 4')).toBeInTheDocument();

    // Delete point
    const deletePointButton = screen.getByRole('button', { name: '删除第 1 页要点 4' });
    fireEvent.click(deletePointButton);
    expect(screen.queryByLabelText('第 1 页要点 4')).not.toBeInTheDocument();
  }, 60000);

  it('supports moving, duplicating, adding, and deleting slides', () => {
    const onConfirm = vi.fn();
    const onBack = vi.fn();

    render(
      <OutlineWorkspace
        initialSlides={providerSlides()}
        onAiRewrite={noRewrite}
        onBack={onBack}
        onConfirm={onConfirm}
      />,
    );

    // Duplicate slide 1
    const duplicateButton = screen.getByRole('button', { name: '复制第 1 页' });
    fireEvent.click(duplicateButton);
    expect(screen.getByText(/共 5 页/)).toBeInTheDocument();
    expect(screen.getByDisplayValue(/智能新零售 \(副本\)/)).toBeInTheDocument();

    // Add new slide
    const addSlideButton = screen.getByRole('button', { name: '添加页面' });
    fireEvent.click(addSlideButton);
    expect(screen.getByText(/共 6 页/)).toBeInTheDocument();

    // Delete slide 2
    const deleteButton = screen.getByRole('button', { name: '删除第 2 页' });
    fireEvent.click(deleteButton);
    expect(screen.getByText(/共 5 页/)).toBeInTheDocument();

    // Move slide down
    const moveDownButton = screen.getByRole('button', { name: '下移第 1 页' });
    fireEvent.click(moveDownButton);

    // Move slide up
    const moveUpButton = screen.getByRole('button', { name: '上移第 2 页' });
    fireEvent.click(moveUpButton);
  }, 60000);

  it('delegates single-slide and overall AI rewriting to the server callback', async () => {
    const onConfirm = vi.fn();
    const onBack = vi.fn();
    const onAiRewrite = vi.fn(async ({ mode }: { mode: 'all' | 'slide' }) =>
      mode === 'slide'
        ? { title: '服务端单页优化结果' }
        : providerSlides().map((slide, index) => ({
            ...slide,
            title: `服务端整体优化 ${index + 1}`,
          })),
    );

    render(
      <OutlineWorkspace
        initialSlides={providerSlides()}
        onAiRewrite={onAiRewrite}
        onBack={onBack}
        onConfirm={onConfirm}
      />,
    );

    // AI rewrite slide 1
    const aiRewriteButton = screen.getByRole('button', { name: '优化第 1 页' });
    fireEvent.click(aiRewriteButton);
    expect(await screen.findByDisplayValue('服务端单页优化结果')).toBeInTheDocument();

    // AI optimize all
    const aiOptimizeAllButton = screen.getByRole('button', { name: 'AI 整体优化' });
    fireEvent.click(aiOptimizeAllButton);
    await waitFor(() => expect(screen.getByDisplayValue('服务端整体优化 1')).toBeInTheDocument());
    expect(screen.getByText(/版本 v3/)).toBeInTheDocument();
    expect(onAiRewrite).toHaveBeenCalledTimes(2);
  }, 60000);

  it('submits confirmed outline on confirmation and triggers back', () => {
    const onConfirm = vi.fn();
    const onBack = vi.fn();

    render(
      <OutlineWorkspace
        initialSlides={providerSlides()}
        onAiRewrite={noRewrite}
        onBack={onBack}
        onConfirm={onConfirm}
      />,
    );

    // Confirm
    const confirmButton = screen.getByRole('button', { name: '确认大纲，继续生成' });
    fireEvent.click(confirmButton);

    expect(onConfirm).toHaveBeenCalledWith({
      slides: expect.arrayContaining([
        expect.objectContaining({
          title: '智能新零售',
        }),
      ]),
      versionId: 'v1',
    });

    // Back
    const backButton = screen.getByRole('button', { name: '返回对话' });
    fireEvent.click(backButton);
    expect(onBack).toHaveBeenCalled();
  }, 60000);
});
