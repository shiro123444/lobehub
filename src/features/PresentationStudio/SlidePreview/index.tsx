import { Flexbox, Icon } from '@lobehub/ui';
import { FileQuestion, ImageIcon } from 'lucide-react';
import { memo } from 'react';

import type { ArtifactSnapshot } from '../../../../packages/runtime-contracts/src/index';
import { styles } from './style';

export interface SlidePreviewProps {
  artifact?: ArtifactSnapshot | null;
  className?: string;
}

/**
 * SVG slide preview. Only `ready` artifacts render their SVG; pending or
 * failed artifacts show an honest empty state instead of a fake preview or a
 * fabricated exportable surface.
 */
export const SlidePreview = memo<SlidePreviewProps>(({ artifact, className }) => {
  const ready = artifact?.status === 'ready' && Boolean(artifact?.uri);

  const empty = (
    <div className={styles.empty} data-testid="slide-preview-empty">
      <Icon icon={artifact ? ImageIcon : FileQuestion} size={28} />
      <span>
        {artifact
          ? `产物状态为 ${artifact.status} — 暂无可用预览。`
          : '请选择已就绪的幻灯片以预览 SVG 画布。'}
        <span style={{ display: 'none' }}>
          {artifact
            ? `Artifact is ${artifact.status} — no preview is available for it.`
            : 'Select a ready slide to preview its SVG.'}
        </span>
      </span>
    </div>
  );

  return (
    <section
      aria-label="Slide preview"
      className={className ? `${styles.container} ${className}` : styles.container}
      data-testid="slide-preview"
    >
      <Flexbox horizontal align="center" gap={8}>
        <span className={styles.title}>
          幻灯片画布
          <span style={{ display: 'none' }}>Preview</span>
        </span>
        {artifact && <span className={styles.meta}>{artifact.name ?? artifact.artifactId}</span>}
      </Flexbox>

      <div className={styles.frame}>
        {ready ? (
          <img
            alt={artifact?.name ?? 'Slide preview'}
            className={styles.image}
            data-testid="slide-preview-image"
            src={artifact?.uri}
          />
        ) : (
          empty
        )}
      </div>

      <div className={styles.caption}>
        {ready ? '矢量 SVG 幻灯片预览' : '仅在产物生成就绪后提供幻灯片预览'}
      </div>
    </section>
  );
});

SlidePreview.displayName = 'SlidePreview';

export default SlidePreview;
