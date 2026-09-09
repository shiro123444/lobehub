import { Button, Flexbox, Icon } from '@lobehub/ui';
import { Alert, Input, InputNumber, Select } from 'antd';
import { Presentation, Send } from 'lucide-react';
import { memo, useCallback, useState } from 'react';

import type { PresentationJobInput } from '../../../../packages/runtime-contracts/src/index';
import { styles } from './style';

export interface PresentationComposerProps {
  busy?: boolean;
  className?: string;
  defaultLanguage?: string;
  defaultNotebookId?: string;
  defaultSourceVersionIds?: string[];
  onCreate: (input: PresentationJobInput) => Promise<string | null>;
}

const ASPECT_RATIOS = [
  { label: '16:9', value: '16:9' },
  { label: '4:3', value: '4:3' },
  { label: '3:2', value: '3:2' },
  { label: '1:1', value: '1:1' },
] as const;

const LANGUAGES = [
  { label: '中文', value: 'zh-CN' },
  { label: 'English', value: 'en-US' },
] as const;

export const PresentationComposer = memo<PresentationComposerProps>(
  ({
    busy = false,
    className,
    defaultLanguage = 'zh-CN',
    defaultNotebookId = '',
    defaultSourceVersionIds = [],
    onCreate,
  }) => {
    const [title, setTitle] = useState('');
    const [prompt, setPrompt] = useState('');
    const [slideCount, setSlideCount] = useState<number | null>(10);
    const [aspectRatio, setAspectRatio] = useState('16:9');
    const [language, setLanguage] = useState(defaultLanguage);
    const [submitting, setSubmitting] = useState(false);
    const [validationError, setValidationError] = useState<string | null>(null);

    const isBusy = busy || submitting;

    const handleCreate = useCallback(async () => {
      if (isBusy) return;

      const trimmedTitle = title.trim();
      setValidationError(null);

      if (!trimmedTitle) {
        setValidationError('Title is required to start a presentation job.');
        return;
      }
      if (slideCount === null || slideCount < 1 || slideCount > 50) {
        setValidationError('Slide count must be between 1 and 50.');
        return;
      }

      const input: PresentationJobInput = {
        aspectRatio,
        language,
        notebookId: defaultNotebookId.trim() || 'studio',
        options: { prompt: prompt.trim() || undefined },
        prompt: prompt.trim() || undefined,
        slideCount,
        sourceVersionIds: defaultSourceVersionIds,
        title: trimmedTitle,
      };

      setSubmitting(true);
      try {
        const jobId = await onCreate(input);
        if (jobId) {
          setPrompt('');
        }
      } finally {
        setSubmitting(false);
      }
    }, [
      aspectRatio,
      defaultNotebookId,
      defaultSourceVersionIds,
      isBusy,
      language,
      onCreate,
      prompt,
      slideCount,
      title,
    ]);

    return (
      <section
        aria-label="Presentation creator"
        className={className ? `${styles.container} ${className}` : styles.container}
        data-testid="presentation-composer"
      >
        <Flexbox horizontal align="center" gap={8}>
          <Icon icon={Presentation} size={16} />
          <h2 className={styles.title}>创建演示文稿</h2>
        </Flexbox>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="presentation-composer-title">
            标题
          </label>
          <Input
            aria-label="Presentation title"
            id="presentation-composer-title"
            placeholder="例如：第三季度市场报告"
            status={validationError ? 'error' : undefined}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              if (validationError) setValidationError(null);
            }}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="presentation-composer-prompt">
            描述（可选）
          </label>
          <Input.TextArea
            aria-label="Presentation prompt"
            autoSize={{ maxRows: 5, minRows: 3 }}
            id="presentation-composer-prompt"
            placeholder="描述主题、受众和风格，系统会据此规划幻灯片。"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>

        <Flexbox horizontal gap={12} wrap="wrap">
          <div className={styles.compactField}>
            <label className={styles.label} htmlFor="presentation-composer-slide-count">
              页数
            </label>
            <InputNumber
              aria-label="Slide count"
              disabled={isBusy}
              id="presentation-composer-slide-count"
              max={50}
              min={1}
              value={slideCount}
              onChange={(value) => setSlideCount(typeof value === 'number' ? value : null)}
            />
          </div>
          <div className={styles.compactField}>
            <label className={styles.label} htmlFor="presentation-composer-aspect-ratio">
              比例
            </label>
            <Select
              aria-label="Aspect ratio"
              id="presentation-composer-aspect-ratio"
              options={[...ASPECT_RATIOS]}
              value={aspectRatio}
              onChange={setAspectRatio}
            />
          </div>
          <div className={styles.compactField}>
            <label className={styles.label} htmlFor="presentation-composer-language">
              语言
            </label>
            <Select
              aria-label="Output language"
              id="presentation-composer-language"
              options={[...LANGUAGES]}
              value={language}
              onChange={setLanguage}
            />
          </div>
        </Flexbox>

        {validationError && (
          <Alert
            showIcon
            className={styles.errorBox}
            message={validationError}
            role="alert"
            type="error"
          />
        )}

        <div className={styles.actions}>
          <Button
            aria-busy={isBusy}
            aria-label="Create Job"
            disabled={isBusy}
            icon={<Icon icon={Send} size={13} />}
            loading={isBusy}
            size="small"
            type="primary"
            onClick={() => void handleCreate()}
          >
            创建 PPT
          </Button>
        </div>

        <p className={styles.hint}>提交后会进入生成队列，进度、预览和导出由运行时统一处理。</p>
      </section>
    );
  },
);

PresentationComposer.displayName = 'PresentationComposer';

export default PresentationComposer;
