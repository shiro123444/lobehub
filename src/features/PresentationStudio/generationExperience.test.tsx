import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PresentationJob } from '../../../packages/runtime-contracts/src/index';
import PresentationGenerationWorkspace from './PresentationGenerationWorkspace';

const baseJob: PresentationJob = {
  artifactIds: ['slide-1', 'slide-2', 'slide-3'],
  createdAt: '2026-09-02T10:00:00.000Z',
  jobId: 'job-c112',
  state: 'running',
  updatedAt: '2026-09-02T10:00:05.000Z',
  ...({ currentSlide: 2, totalSlides: 4 } as Record<string, unknown>),
};

describe('generationExperience (C-112-01, C-112-02, C-112-03, R3-B)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('C-112-01: Active Card Highlighting and Flowing Light Structure', () => {
    it('marks the current active card with active attributes and styling', () => {
      render(<PresentationGenerationWorkspace job={baseJob} title="AI 商业架构" />);

      const activeCards = screen.getAllByLabelText(/第 \d+ 页正在制作/);
      expect(activeCards.length).toBeGreaterThanOrEqual(3);

      const activeCard = activeCards.find((card) => card.getAttribute('data-active') === 'true');
      expect(activeCard).toBeDefined();
      expect(activeCard).toHaveTextContent('第 2 页');
    });

    it('keeps real generation cards moving instead of freezing after planning', () => {
      const movingJob: PresentationJob = {
        ...baseJob,
        ...({ currentSlide: undefined, totalSlides: 3 } as Record<string, unknown>),
      };
      render(<PresentationGenerationWorkspace job={movingJob} />);

      expect(screen.getByTestId('presentation-card-slide-1')).toHaveAttribute(
        'data-active',
        'true',
      );
      act(() => vi.advanceTimersByTime(2600));
      expect(screen.getByTestId('presentation-card-slide-2')).toHaveAttribute(
        'data-active',
        'true',
      );
    });

    it('displays single waiting card without fake page numbers when no real slides exist (R3-B)', () => {
      const queuedJob: PresentationJob = {
        ...baseJob,
        artifactIds: [],
        state: 'queued',
        ...({ currentSlide: undefined, totalSlides: undefined } as Record<string, unknown>),
      };
      const { unmount } = render(<PresentationGenerationWorkspace job={queuedJob} />);

      expect(screen.getByTestId('generation-waiting-card')).toBeInTheDocument();
      expect(screen.queryByLabelText(/第 \d+ 页正在制作/)).not.toBeInTheDocument();

      unmount();
    });
  });

  describe('C-112-02: Centered Enlarged Cards and Lower Section Layout', () => {
    it('places the preview cards rail as the first visual center and content section below it', () => {
      const { container } = render(
        <PresentationGenerationWorkspace job={baseJob} title="AI 商业架构" />,
      );

      const workspace = screen.getByTestId('presentation-generation-workspace');
      expect(workspace).toBeInTheDocument();

      const cardsRail = screen.getByTestId('generation-cards-rail');
      const centerSection =
        container.querySelector('.generation-center') ??
        screen.getByTestId('presentation-generation-stage').parentElement;

      expect(cardsRail).toBeInTheDocument();
      expect(centerSection).toBeInTheDocument();

      // Verify DOM ordering: cardsRail precedes the lower information panel
      expect(cardsRail.compareDocumentPosition(centerSection!)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
      expect(screen.getByRole('heading', { name: '正在制作 PPT' })).toBeInTheDocument();
      expect(screen.queryByText('AI 商业架构')).not.toBeInTheDocument();
    });
  });

  describe('C-112-03: Real Event Actions, Page Count, Timestamps, and Waiting Prompts', () => {
    it('displays only the projected AI action while keeping page ratio accessible', () => {
      const jobWithAction: PresentationJob = {
        ...baseJob,
        artifactIds: ['art-1', 'art-2', 'art-3'],
        ...({
          currentSlide: 3,
          lastAction: '正在整理第 3 页的架构流程图与排版',
          totalSlides: 10,
        } as Record<string, unknown>),
      };

      render(<PresentationGenerationWorkspace job={jobWithAction} />);

      expect(screen.getByTestId('presentation-generation-action')).toHaveTextContent(
        '正在整理第 3 页的架构流程图与排版',
      );
      expect(screen.getByTestId('presentation-generation-pages')).toHaveTextContent('第 3 / 10 页');
      expect(screen.queryByTestId('presentation-generation-time')).not.toBeInTheDocument();
    });

    it('does not add elapsed-time explanations while the focused animation is running', () => {
      render(<PresentationGenerationWorkspace job={baseJob} />);

      // Initially no prolonged waiting notice (< 10 seconds)
      expect(screen.queryByTestId('presentation-generation-waiting')).not.toBeInTheDocument();

      // Advance timer by 12 seconds
      act(() => {
        vi.advanceTimersByTime(12000);
      });

      expect(screen.queryByTestId('presentation-generation-waiting')).not.toBeInTheDocument();
    });
  });

  describe('C-112-R4B: Final Lifecycle, Motion Reduction and Responsive Invariants', () => {
    it('consumes projected phase, activity, and stream status without fake 18%/55% progress', () => {
      const r4bJob: PresentationJob = {
        ...baseJob,
        artifactIds: ['art-1', 'art-2'],
        ...({
          activity: '正在打磨第 2 页图表排版',
          currentSlide: 2,
          phase: 'polishing',
          totalSlides: 4,
        } as Record<string, unknown>),
      };

      const { rerender } = render(
        <PresentationGenerationWorkspace job={r4bJob} streamStatus="live" />,
      );

      expect(screen.getByTestId('presentation-generation-action')).toHaveTextContent(
        '正在打磨第 2 页图表排版',
      );
      expect(screen.getByTestId('presentation-generation-stage')).toHaveTextContent('polishing');
      expect(screen.getByTestId('job-stream-status')).toHaveTextContent('live');

      // Reconnecting stream status
      rerender(<PresentationGenerationWorkspace job={r4bJob} streamStatus="reconnecting" />);
      expect(screen.getByTestId('job-stream-status')).toHaveTextContent('reconnecting');
    });

    it('suppresses long prompt (>30 chars or multi-line) from polluting the visual center', () => {
      const longPrompt = '这是一段非常长、超过三十个字且包含\n换行符的完整用户提示词需求说明';
      render(<PresentationGenerationWorkspace job={baseJob} title={longPrompt} />);

      expect(screen.queryByText(longPrompt)).not.toBeInTheDocument();
      expect(screen.getByTestId('generation-cards-rail')).toBeInTheDocument();
    });
  });
});
