import { Flexbox, Icon } from '@lobehub/ui';
import { Button, Input, Tooltip } from 'antd';
import { MessageSquareText, Send } from 'lucide-react';
import { memo } from 'react';

import { styles } from './style';

export interface AnnotationBarProps {
  className?: string;
  /** Phase 1 keeps annotation editing disabled — no fake edit surface. */
  disabled?: boolean;
}

/**
 * Phase-1 annotation bar. It exists so the studio layout slot is stable, but
 * the annotation editor is disabled until phase 2 ships real edit jobs.
 */
export const AnnotationBar = memo<AnnotationBarProps>(({ className, disabled = true }) => (
  <section
    aria-label="Slide annotation editor"
    className={className ? `${styles.container} ${className}` : styles.container}
    data-testid="annotation-bar"
  >
    <Flexbox horizontal align="center" gap={8}>
      <Icon icon={MessageSquareText} size={14} />
      <span className={styles.title}>Annotate</span>
      <span className={styles.phaseTag}>phase 2</span>
    </Flexbox>

    <Input.TextArea
      aria-disabled={disabled}
      disabled={disabled}
      placeholder="Annotation editing arrives in phase 2 — send natural-language change requests here later."
      rows={2}
      value=""
      onChange={() => undefined}
    />

    <div className={styles.actions}>
      <Tooltip title={disabled ? 'Annotation editing opens in phase 2.' : undefined}>
        <Button
          aria-disabled={disabled}
          disabled={disabled}
          icon={<Icon icon={Send} size={12} />}
          size="small"
        >
          Annotate
        </Button>
      </Tooltip>
    </div>
  </section>
));

AnnotationBar.displayName = 'AnnotationBar';

export default AnnotationBar;
