import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import OutlineWorkspace, { type OutlineSlide } from './OutlineWorkspace';

const providerSlides = (): OutlineSlide[] =>
  Array.from({ length: 4 }, (_, index) => ({
    id: `slide-${index + 1}`,
    title: index === 0 ? '智能新零售' : `章节 ${index + 1}`,
    keyPoints: [`要点 ${index + 1}.1`, `要点 ${index + 1}.2`],
    objective: `目标 ${index + 1}`,
    claim: `结论 ${index + 1}`,
    speakerNotes: `备注 ${index + 1}`,
    visualSuggestion: `视觉 ${index + 1}`,
  }));
const setup = (onAiRewrite = vi.fn(async () => undefined) as any) => {
  const onConfirm = vi.fn();
  const onBack = vi.fn();
  render(
    <OutlineWorkspace
      initialSlides={providerSlides()}
      onAiRewrite={onAiRewrite}
      onBack={onBack}
      onConfirm={onConfirm}
    />,
  );
  return { onConfirm, onBack, onAiRewrite };
};

describe('Outline storyboard', () => {
  it('shows only titles and conclusions until a page is opened, without an automatic rewrite', () => {
    const { onAiRewrite } = setup();
    const overview = within(screen.getByTestId('outline-overview'));
    expect(overview.getAllByRole('button')).toHaveLength(4);
    expect(overview.getByText('智能新零售')).toBeInTheDocument();
    expect(overview.getByText('结论 1')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('要点 1.1')).not.toBeInTheDocument();
    expect(onAiRewrite).not.toHaveBeenCalled();
    fireEvent.click(overview.getByRole('button', { name: '第 1 页 · 智能新零售' }));
    expect(screen.getByLabelText('第 1 页标题')).toHaveValue('智能新零售');
    expect(screen.getByLabelText('第 1 页要点 1')).toHaveValue('要点 1.1');
    expect(screen.queryByLabelText('第 2 页标题')).not.toBeInTheDocument();
  });
  it('preserves page content and selection when editing and reordering, then confirms directly', () => {
    const { onConfirm } = setup();
    fireEvent.click(screen.getByTestId('outline-slide-1'));
    fireEvent.change(screen.getByLabelText('第 1 页标题'), { target: { value: '新标题' } });
    fireEvent.change(screen.getByLabelText('第 1 页要点 1'), { target: { value: '新要点' } });
    fireEvent.click(screen.getByRole('button', { name: '下移第 1 页' }));
    expect(screen.getByLabelText('第 2 页标题')).toHaveValue('新标题');
    fireEvent.click(screen.getByRole('button', { name: /close|关闭/i }));
    fireEvent.click(screen.getByRole('button', { name: '确认大纲，继续生成' }));
    expect(onConfirm.mock.calls[0][0].slides[1]).toEqual({
      ...providerSlides()[0],
      title: '新标题',
      keyPoints: ['新要点', '要点 1.2'],
    });
    expect(onConfirm.mock.calls[0][0].slides[0]).toEqual(providerSlides()[1]);
  });
  it('delegates single-page editing and keeps the remaining pages intact', async () => {
    const rewrite = vi.fn(async () => ({ title: '服务端单页优化结果' }));
    const { onConfirm } = setup(rewrite);
    fireEvent.click(screen.getByTestId('outline-slide-1'));
    fireEvent.click(screen.getByRole('button', { name: '优化第 1 页' }));
    await waitFor(() =>
      expect(screen.getByLabelText('第 1 页标题')).toHaveValue('服务端单页优化结果'),
    );
    fireEvent.click(screen.getByRole('button', { name: /close|关闭/i }));
    fireEvent.click(screen.getByRole('button', { name: '确认大纲，继续生成' }));
    expect(rewrite).toHaveBeenCalledOnce();
    expect(onConfirm.mock.calls[0][0].slides.slice(1)).toEqual(providerSlides().slice(1));
  });
});
