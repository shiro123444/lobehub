import { Button, Icon } from '@lobehub/ui';
import { ChevronLeft, ChevronRight, FileQuestion, ImageIcon, Layers } from 'lucide-react';
import { memo, useEffect } from 'react';

import type { ArtifactSnapshot } from '../../../../packages/runtime-contracts/src/index';
import { styles } from './style';

export interface SlideFocusStageProps {
  currentIndex: number;
  onNext: () => void;
  onOpenDrawer: () => void;
  onPrev: () => void;
  selectedSlide: ArtifactSnapshot | null;
  totalSlides: number;
}

const getSlideStatusZh = (status?: string): string => {
  switch (status) {
    case 'ready':
      return '已就绪';
    case 'generating':
      return '生成中';
    case 'failed':
      return '生成失败';
    case 'cancelled':
      return '已取消';
    case 'pending':
    default:
      return '排队中';
  }
};

export const SlideFocusStage = memo<SlideFocusStageProps>(
  ({ currentIndex, onNext, onOpenDrawer, onPrev, selectedSlide, totalSlides }) => {
    const ready = selectedSlide?.status === 'ready' && Boolean(selectedSlide?.uri);

    const pagePillText =
      totalSlides > 0
        ? `${String(currentIndex + 1).padStart(2, '0')} / ${String(totalSlides).padStart(2, '0')}`
        : '00 / 00';

    // Keyboard navigation (ArrowLeft/ArrowRight)
    useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
        const target = e.target as HTMLElement | null;
        if (
          target &&
          (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
        ) {
          return;
        }

        if (e.key === 'ArrowLeft' && currentIndex > 0) {
          e.preventDefault();
          onPrev();
        } else if (e.key === 'ArrowRight' && currentIndex < totalSlides - 1) {
          e.preventDefault();
          onNext();
        }
      };

      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }, [currentIndex, onNext, onPrev, totalSlides]);

    return (
      <section aria-label="幻灯片单页预览" className={styles.stageArea} data-testid="slide-preview">
        <div className={styles.focusCanvas}>
          <div
            aria-label={`第 ${currentIndex + 1} 页 16:9 大预览`}
            className={styles.focusFrame169}
            role="button"
            tabIndex={0}
            onClick={onOpenDrawer}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpenDrawer();
              }
            }}
          >
            {ready ? (
              <img
                alt={selectedSlide?.name ?? `第 ${currentIndex + 1} 页`}
                className={styles.focusImage}
                data-testid="slide-preview-image"
                src={selectedSlide?.uri}
              />
            ) : (
              <div className={styles.focusEmpty} data-testid="slide-preview-empty">
                <Icon icon={selectedSlide ? ImageIcon : FileQuestion} size={32} />
                <span>
                  {selectedSlide
                    ? `产物状态为【${getSlideStatusZh(selectedSlide.status)}】— 暂无可用预览。`
                    : '请选择已就绪的幻灯片以预览 SVG 画布。'}
                </span>
              </div>
            )}

            <div className={styles.hoverCue} data-role="hover-cue">
              <Icon icon={Layers} size={12} />
              <span>点击查看架构与资产</span>
            </div>
          </div>
        </div>

        <nav aria-label="幻灯片分页导航" className={styles.bottomPaginator}>
          <Button
            aria-label="上一页"
            disabled={currentIndex <= 0}
            icon={<Icon icon={ChevronLeft} size={14} />}
            size="small"
            onClick={onPrev}
          >
            上一页
          </Button>

          <span className={styles.pageCounter} data-testid="slide-page-counter">
            {pagePillText}
          </span>

          <Button
            aria-label="下一页"
            disabled={currentIndex >= totalSlides - 1}
            icon={<Icon icon={ChevronRight} size={14} />}
            size="small"
            onClick={onNext}
          >
            下一页
          </Button>
        </nav>
      </section>
    );
  },
);

SlideFocusStage.displayName = 'SlideFocusStage';

export default SlideFocusStage;
