import { Button, Flexbox, Icon, Tag } from '@lobehub/ui';
import { Input } from 'antd';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Copy,
  Lightbulb,
  MessageSquare,
  Minus,
  Plus,
  Sparkles,
  Target,
  Trash2,
} from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';

import { styles } from './style';

export interface OutlineSlide {
  id: string;
  keyPoints: string[];
  objective?: string;
  speakerNotes?: string;
  title: string;
  visualSuggestion?: string;
}

export interface OutlineWorkspaceProps {
  initialSlides: OutlineSlide[];
  onAiRewrite: (input: {
    allSlides: OutlineSlide[];
    index?: number;
    mode: 'all' | 'slide';
    slide?: OutlineSlide;
  }) => Promise<Partial<OutlineSlide> | OutlineSlide[] | void>;
  onBack: () => void;
  onConfirm: (data: { slides: OutlineSlide[]; versionId: string }) => void;
}

const mergeAiSlides = (
  current: readonly OutlineSlide[],
  candidate: readonly OutlineSlide[],
): OutlineSlide[] =>
  current.map((slide, index) => ({
    ...slide,
    ...candidate[index],
    id: slide.id,
    keyPoints:
      Array.isArray(candidate[index]?.keyPoints) && candidate[index].keyPoints.length > 0
        ? candidate[index].keyPoints
        : slide.keyPoints,
  }));

export const OutlineWorkspace = memo<OutlineWorkspaceProps>(
  ({ initialSlides, onAiRewrite, onBack, onConfirm }) => {
    const [versionCount, setVersionCount] = useState(1);
    const [aiBusy, setAiBusy] = useState<'all' | number | null>(null);
    const [aiError, setAiError] = useState<string | null>(null);
    const [slides, setSlides] = useState<OutlineSlide[]>(() => initialSlides);

    const bumpVersion = useCallback(() => {
      setVersionCount((v) => v + 1);
    }, []);

    const handleUpdateTitle = useCallback(
      (index: number, newTitle: string) => {
        setSlides((prev) => {
          const next = [...prev];
          next[index] = { ...next[index], title: newTitle };
          return next;
        });
        bumpVersion();
      },
      [bumpVersion],
    );

    const handleUpdateObjective = useCallback(
      (index: number, newObjective: string) => {
        setSlides((prev) => {
          const next = [...prev];
          next[index] = { ...next[index], objective: newObjective };
          return next;
        });
        bumpVersion();
      },
      [bumpVersion],
    );

    const handleUpdateVisual = useCallback(
      (index: number, newVisual: string) => {
        setSlides((prev) => {
          const next = [...prev];
          next[index] = { ...next[index], visualSuggestion: newVisual };
          return next;
        });
        bumpVersion();
      },
      [bumpVersion],
    );

    const handleUpdateSpeakerNotes = useCallback(
      (index: number, newNotes: string) => {
        setSlides((prev) => {
          const next = [...prev];
          next[index] = { ...next[index], speakerNotes: newNotes };
          return next;
        });
        bumpVersion();
      },
      [bumpVersion],
    );

    const handleUpdatePoint = useCallback(
      (slideIndex: number, pointIndex: number, newPoint: string) => {
        setSlides((prev) => {
          const next = [...prev];
          const updatedPoints = [...next[slideIndex].keyPoints];
          updatedPoints[pointIndex] = newPoint;
          next[slideIndex] = { ...next[slideIndex], keyPoints: updatedPoints };
          return next;
        });
        bumpVersion();
      },
      [bumpVersion],
    );

    const handleAddPoint = useCallback(
      (slideIndex: number) => {
        setSlides((prev) => {
          const next = [...prev];
          next[slideIndex] = {
            ...next[slideIndex],
            keyPoints: [...next[slideIndex].keyPoints, ''],
          };
          return next;
        });
        bumpVersion();
      },
      [bumpVersion],
    );

    const handleRemovePoint = useCallback(
      (slideIndex: number, pointIndex: number) => {
        setSlides((prev) => {
          const next = [...prev];
          const updatedPoints = next[slideIndex].keyPoints.filter((_, idx) => idx !== pointIndex);
          next[slideIndex] = { ...next[slideIndex], keyPoints: updatedPoints };
          return next;
        });
        bumpVersion();
      },
      [bumpVersion],
    );

    const handleMoveSlide = useCallback(
      (index: number, direction: -1 | 1) => {
        const targetIndex = index + direction;
        if (targetIndex < 0 || targetIndex >= slides.length) return;
        setSlides((prev) => {
          const next = [...prev];
          const temp = next[index];
          next[index] = next[targetIndex];
          next[targetIndex] = temp;
          return next;
        });
        bumpVersion();
      },
      [slides.length, bumpVersion],
    );

    const handleDuplicateSlide = useCallback(
      (index: number) => {
        setSlides((prev) => {
          const next = [...prev];
          const source = next[index];
          const duplicated: OutlineSlide = {
            ...source,
            id: `slide-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            keyPoints: [...source.keyPoints],
            title: `${source.title} (副本)`,
          };
          next.splice(index + 1, 0, duplicated);
          return next;
        });
        bumpVersion();
      },
      [bumpVersion],
    );

    const handleDeleteSlide = useCallback(
      (index: number) => {
        if (slides.length <= 1) return;
        setSlides((prev) => prev.filter((_, idx) => idx !== index));
        bumpVersion();
      },
      [slides.length, bumpVersion],
    );

    const handleAddSlide = useCallback(() => {
      setSlides((prev) => [
        ...prev,
        {
          id: `slide-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          keyPoints: [''],
          objective: '',
          speakerNotes: '',
          title: `新幻灯片 ${prev.length + 1}`,
          visualSuggestion: '',
        },
      ]);
      bumpVersion();
    }, [bumpVersion]);

    const handleAiRewriteSlide = useCallback(
      async (index: number) => {
        if (aiBusy !== null) return;
        setAiBusy(index);
        try {
          const result = await onAiRewrite({
            allSlides: slides,
            index,
            mode: 'slide',
            slide: slides[index],
          });
          if (result && !Array.isArray(result)) {
            setSlides((prev) => {
              const next = [...prev];
              next[index] = { ...next[index], ...result };
              return next;
            });
            bumpVersion();
          } else {
            setAiError('AI 未返回可用的单页改写结果，请重试。');
          }
        } catch {
          setAiError('AI 大纲服务暂时不可用，请检查配置后重试。');
        } finally {
          setAiBusy(null);
        }
      },
      [aiBusy, bumpVersion, onAiRewrite, slides],
    );

    const handleAiOptimizeAll = useCallback(async () => {
      if (aiBusy !== null) return;
      setAiBusy('all');
      try {
        const result = await onAiRewrite({ allSlides: slides, mode: 'all' });
        if (Array.isArray(result) && result.length > 0) {
          setSlides((current) => mergeAiSlides(current, result));
          bumpVersion();
        } else {
          setAiError('AI 未返回可用的大纲结果，请重试。');
        }
      } catch {
        setAiError('AI 大纲服务暂时不可用，请检查配置后重试。');
      } finally {
        setAiBusy(null);
      }
    }, [aiBusy, bumpVersion, onAiRewrite, slides]);

    const versionId = useMemo(() => `v${versionCount}`, [versionCount]);

    return (
      <div
        aria-label="逐页大纲编辑工作区"
        className={styles.outlineWorkspace}
        data-testid="presentation-agent-outline"
        role="region"
      >
        <div className={styles.outlineWorkspaceHeader}>
          <Flexbox horizontal align="center" gap={12}>
            <Button
              aria-label="返回对话"
              icon={<Icon icon={ArrowLeft} size={14} />}
              size="middle"
              onClick={onBack}
            >
              返回对话
            </Button>
            <Flexbox gap={2}>
              <span style={{ fontSize: 16, fontWeight: 700 }}>逐页大纲规划</span>
              <span style={{ color: 'var(--ant-color-text-description)', fontSize: 12 }}>
                共 {slides.length} 页 · 版本 {versionId}
              </span>
            </Flexbox>
          </Flexbox>

          <Flexbox horizontal align="center" gap={10}>
            <Tag color="processing">可自由增删修改</Tag>
            <Button
              aria-label="确认大纲，继续生成"
              icon={<Icon icon={ArrowRight} size={14} />}
              size="middle"
              type="primary"
              onClick={() => onConfirm({ slides, versionId })}
            >
              确认大纲，继续生成
            </Button>
          </Flexbox>
        </div>
        {aiError && (
          <div role="alert" style={{ color: 'var(--ant-color-error)', fontSize: 12 }}>
            {aiError}
          </div>
        )}

        <div
          aria-label="大纲总览"
          className={styles.outlineOverview}
          data-testid="outline-overview"
        >
          {slides.map((slide, index) => (
            <button
              className={styles.outlineOverviewItem}
              key={slide.id}
              type="button"
              onClick={() => {
                document
                  .querySelector(`[data-testid="outline-slide-${index + 1}"]`)
                  ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
            >
              <span className={styles.outlineOverviewIndex}>
                {String(index + 1).padStart(2, '0')}
              </span>
              <span className={styles.outlineOverviewTitle}>
                {`第 ${index + 1} 页 · ${slide.title || '未命名页面'}`}
              </span>
              <span className={styles.outlineOverviewMeta}>{slide.keyPoints.length} 个要点</span>
            </button>
          ))}
        </div>

        <div aria-label="幻灯片大纲列表" className={styles.outlineList}>
          {slides.map((slide, index) => (
            <div
              className={styles.outlineSlideCard}
              data-testid={`outline-slide-${index + 1}`}
              key={slide.id}
            >
              <div className={styles.outlineSlideCardHeader}>
                <span className={styles.outlineIndex}>{String(index + 1).padStart(2, '0')}</span>

                <Input
                  aria-label={`第 ${index + 1} 页标题`}
                  placeholder="请输入页面标题..."
                  style={{ flex: 1, fontSize: 14, fontWeight: 600, minWidth: 200 }}
                  value={slide.title}
                  onChange={(e) => handleUpdateTitle(index, e.target.value)}
                />

                <Flexbox horizontal align="center" gap={6}>
                  <Button
                    aria-label={`上移第 ${index + 1} 页`}
                    disabled={index === 0}
                    icon={<Icon icon={ArrowUp} size={12} />}
                    size="small"
                    onClick={() => handleMoveSlide(index, -1)}
                  />
                  <Button
                    aria-label={`下移第 ${index + 1} 页`}
                    disabled={index === slides.length - 1}
                    icon={<Icon icon={ArrowDown} size={12} />}
                    size="small"
                    onClick={() => handleMoveSlide(index, 1)}
                  />
                  <Button
                    aria-label={`复制第 ${index + 1} 页`}
                    icon={<Icon icon={Copy} size={12} />}
                    size="small"
                    onClick={() => handleDuplicateSlide(index)}
                  />
                  <Button
                    aria-label={`优化第 ${index + 1} 页`}
                    icon={<Icon icon={Sparkles} size={12} />}
                    loading={aiBusy === index}
                    size="small"
                    onClick={() => void handleAiRewriteSlide(index)}
                  >
                    AI 优化
                  </Button>
                  <Button
                    danger
                    aria-label={`删除第 ${index + 1} 页`}
                    disabled={slides.length <= 1}
                    icon={<Icon icon={Trash2} size={12} />}
                    size="small"
                    onClick={() => handleDeleteSlide(index)}
                  />
                </Flexbox>
              </div>

              <div className={styles.outlineSlideCardBody}>
                {/* Key Points List */}
                <Flexbox gap={6}>
                  <span
                    style={{
                      color: 'var(--ant-color-text-secondary)',
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    关键要点：
                  </span>
                  {slide.keyPoints.map((point, pIdx) => (
                    <div className={styles.outlinePointItem} key={pIdx}>
                      <span style={{ color: 'var(--ant-color-primary)', fontSize: 13 }}>•</span>
                      <Input
                        aria-label={`第 ${index + 1} 页要点 ${pIdx + 1}`}
                        size="small"
                        style={{ flex: 1 }}
                        value={point}
                        onChange={(e) => handleUpdatePoint(index, pIdx, e.target.value)}
                      />
                      <Button
                        danger
                        aria-label={`删除第 ${index + 1} 页要点 ${pIdx + 1}`}
                        disabled={slide.keyPoints.length <= 1}
                        icon={<Icon icon={Minus} size={10} />}
                        size="small"
                        onClick={() => handleRemovePoint(index, pIdx)}
                      />
                    </div>
                  ))}
                  <Flexbox horizontal style={{ marginTop: 2 }}>
                    <Button
                      aria-label={`为第 ${index + 1} 页添加要点`}
                      icon={<Icon icon={Plus} size={10} />}
                      size="small"
                      onClick={() => handleAddPoint(index)}
                    >
                      添加要点
                    </Button>
                  </Flexbox>
                </Flexbox>

                {/* Objective & Visual Suggestion */}
                <Flexbox horizontal gap={16} wrap="wrap">
                  <Flexbox flex={1} gap={4} style={{ minWidth: 240 }}>
                    <Flexbox horizontal align="center" gap={4}>
                      <Icon icon={Target} size={12} />
                      <span style={{ color: 'var(--ant-color-text-secondary)', fontSize: 12 }}>
                        页面目标：
                      </span>
                    </Flexbox>
                    <Input
                      aria-label={`第 ${index + 1} 页页面目标`}
                      placeholder="本页要达成的沟通与传达目标..."
                      size="small"
                      value={slide.objective ?? ''}
                      onChange={(e) => handleUpdateObjective(index, e.target.value)}
                    />
                  </Flexbox>

                  <Flexbox flex={1} gap={4} style={{ minWidth: 240 }}>
                    <Flexbox horizontal align="center" gap={4}>
                      <Icon icon={Lightbulb} size={12} />
                      <span style={{ color: 'var(--ant-color-text-secondary)', fontSize: 12 }}>
                        视觉建议：
                      </span>
                    </Flexbox>
                    <Input
                      aria-label={`第 ${index + 1} 页视觉建议`}
                      placeholder="建议的视觉构图、图表或布局形式..."
                      size="small"
                      value={slide.visualSuggestion ?? ''}
                      onChange={(e) => handleUpdateVisual(index, e.target.value)}
                    />
                  </Flexbox>
                </Flexbox>

                {/* Speaker Notes */}
                <Flexbox gap={4}>
                  <Flexbox horizontal align="center" gap={4}>
                    <Icon icon={MessageSquare} size={12} />
                    <span style={{ color: 'var(--ant-color-text-secondary)', fontSize: 12 }}>
                      演讲备注：
                    </span>
                  </Flexbox>
                  <Input.TextArea
                    aria-label={`第 ${index + 1} 页演讲备注`}
                    autoSize={{ maxRows: 3, minRows: 1 }}
                    placeholder="为演讲者提示本页阐述重点或过渡语..."
                    size="small"
                    value={slide.speakerNotes ?? ''}
                    onChange={(e) => handleUpdateSpeakerNotes(index, e.target.value)}
                  />
                </Flexbox>
              </div>
            </div>
          ))}
        </div>

        <div className={styles.outlineWorkspaceFooter}>
          <Flexbox horizontal align="center" gap={10}>
            <Button
              aria-label="添加页面"
              icon={<Icon icon={Plus} size={13} />}
              size="middle"
              onClick={handleAddSlide}
            >
              添加页面
            </Button>
            <Button
              aria-label="AI 整体优化"
              icon={<Icon icon={Sparkles} size={13} />}
              loading={aiBusy === 'all'}
              size="middle"
              onClick={() => void handleAiOptimizeAll()}
            >
              AI 整体优化
            </Button>
          </Flexbox>

          <Flexbox horizontal align="center" gap={10}>
            <Button size="middle" onClick={onBack}>
              返回修改风格
            </Button>
            <Button
              aria-label="确认大纲并生成"
              icon={<Icon icon={ArrowRight} size={14} />}
              size="middle"
              type="primary"
              onClick={() => onConfirm({ slides, versionId })}
            >
              确认大纲并生成
            </Button>
          </Flexbox>
        </div>
      </div>
    );
  },
);

OutlineWorkspace.displayName = 'OutlineWorkspace';

export default OutlineWorkspace;
