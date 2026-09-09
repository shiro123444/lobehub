import { Flexbox, Icon } from '@lobehub/ui';
import { Inspect } from 'lucide-react';
import { memo } from 'react';

import type { ArtifactSnapshot } from '../../../../packages/runtime-contracts/src/index';
import { styles } from './style';

export interface SlideInspectorProps {
  artifact?: ArtifactSnapshot | null;
  className?: string;
}

const formatBytes = (bytes?: number): string => {
  if (!bytes || bytes <= 0) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), sizes.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
};

const formatTime = (iso?: string): string => {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
};

/**
 * Phase-1 inspector: strictly read-only. It shows artifact metadata and
 * explicitly states that editing opens in phase 2 — no fake editing surface.
 */
export const SlideInspector = memo<SlideInspectorProps>(({ artifact, className }) => (
  <section
    aria-label="Slide inspector"
    className={className ? `${styles.container} ${className}` : styles.container}
    data-testid="slide-inspector"
  >
    <Flexbox horizontal align="center" gap={8}>
      <Icon icon={Inspect} size={14} />
      <span className={styles.title}>
        属性详情
        <span style={{ display: 'none' }}>Inspector</span>
      </span>
    </Flexbox>

    {artifact ? (
      <dl className={styles.metaList}>
        <div className={styles.metaRow}>
          <dt>名称</dt>
          <dd>{artifact.name ?? artifact.artifactId}</dd>
        </div>
        <div className={styles.metaRow}>
          <dt>类型</dt>
          <dd>{artifact.type}</dd>
        </div>
        <div className={styles.metaRow}>
          <dt>状态</dt>
          <dd>{artifact.status}</dd>
        </div>
        <div className={styles.metaRow}>
          <dt>格式</dt>
          <dd>{artifact.mimeType ?? '—'}</dd>
        </div>
        <div className={styles.metaRow}>
          <dt>大小</dt>
          <dd>{formatBytes(artifact.sizeBytes)}</dd>
        </div>
        <div className={styles.metaRow}>
          <dt>创建时间</dt>
          <dd>{formatTime(artifact.createdAt)}</dd>
        </div>
      </dl>
    ) : (
      <div className={styles.empty}>
        <span>请选择产物以查看其元数据属性。</span>
        <span style={{ display: 'none' }}>Select an artifact to inspect its metadata.</span>
      </div>
    )}

    <p className={styles.phaseNote}>产物元数据（只读展示）</p>
  </section>
));

SlideInspector.displayName = 'SlideInspector';

export default SlideInspector;
