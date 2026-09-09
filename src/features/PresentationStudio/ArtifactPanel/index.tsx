import { Flexbox, Icon, Tag } from '@lobehub/ui';
import { Archive } from 'lucide-react';
import { memo } from 'react';

import type {
  ArtifactSnapshot,
  PresentationExportFormat,
  PresentationJobState,
} from '../../../../packages/runtime-contracts/src/index';
import ExportMenu from '../ExportMenu';
import { styles } from './style';

export interface ArtifactPanelProps {
  artifacts: ArtifactSnapshot[];
  className?: string;
  exporting?: boolean;
  jobState?: PresentationJobState | null;
  onExport: (artifactId: string, format: PresentationExportFormat) => void;
  onSelect: (artifactId: string) => void;
  selectedArtifactId: string | null;
}

const formatBytes = (bytes?: number): string => {
  if (!bytes || bytes <= 0) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), sizes.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
};

const ARTIFACT_STATUS_COLOR = {
  failed: 'error',
  pending: 'default',
  ready: 'success',
} as const;

/**
 * Artifact selection + export. All artifacts stay visible; only `ready`
 * artifacts are selectable and only `ready` artifacts of a completed job can
 * be exported. Failed exports stay honest — the disable reason is exposed.
 */
export const ArtifactPanel = memo<ArtifactPanelProps>(
  ({
    artifacts,
    className,
    exporting = false,
    jobState = null,
    onExport,
    onSelect,
    selectedArtifactId,
  }) => {
    const readyArtifacts = artifacts.filter((a) => a.status === 'ready');
    const selected =
      (selectedArtifactId
        ? artifacts.find((a) => a.artifactId === selectedArtifactId)
        : undefined) ??
      readyArtifacts[0] ??
      artifacts[0];
    const selectedReady = selected?.status === 'ready';

    const jobCompleted = jobState === 'completed';
    const canExport = jobCompleted && selectedReady && !exporting;
    const disabledReason = !jobCompleted
      ? '仅在任务完成后支持导出。'
      : !selectedReady
        ? '所选产物尚未就绪 — 失败产物无法导出。'
        : '正在导出中…';

    return (
      <section
        aria-label="Artifacts"
        className={className ? `${styles.container} ${className}` : styles.container}
        data-testid="artifact-panel"
      >
        <div className={styles.header}>
          <Flexbox horizontal align="center" gap={8}>
            <Icon icon={Archive} size={14} />
            <span className={styles.title}>
              导出文件与产物
              <span style={{ display: 'none' }}>Artifacts</span>
            </span>
          </Flexbox>

          {artifacts.length > 0 && (
            <ExportMenu
              disabled={!canExport}
              disabledReason={disabledReason}
              loading={exporting}
              onExport={(format) => {
                if (selectedReady && jobCompleted && selected) {
                  onExport(selected.artifactId, format);
                }
              }}
            />
          )}
        </div>

        {artifacts.length === 0 ? (
          <div className={styles.empty} data-testid="artifact-panel-empty">
            <span>任务完成后将在此展示生成的导出文件。</span>
            <span style={{ display: 'none' }}>
              Artifacts will appear here when the job completes.
            </span>
          </div>
        ) : (
          <div
            aria-label="Generated artifacts"
            className={styles.list}
            data-testid="artifact-panel-list"
            role="radiogroup"
          >
            {artifacts.map((artifact) => {
              const ready = artifact.status === 'ready';
              const isSelected =
                ready && artifact.artifactId === (selected?.artifactId ?? selectedArtifactId);
              return (
                <div
                  aria-checked={isSelected}
                  aria-disabled={!ready}
                  aria-label={`Artifact ${artifact.name ?? artifact.artifactId}, status: ${artifact.status}${isSelected ? ', selected' : ''}`}
                  className={styles.card}
                  data-ready={ready ? 'true' : 'false'}
                  data-selected={isSelected ? 'true' : 'false'}
                  data-testid={`artifact-card-${artifact.artifactId}`}
                  key={artifact.artifactId}
                  role="radio"
                  tabIndex={ready ? 0 : -1}
                  onClick={() => {
                    if (ready) onSelect(artifact.artifactId);
                  }}
                  onKeyDown={(event) => {
                    if (!ready || (event.key !== 'Enter' && event.key !== ' ')) return;
                    event.preventDefault();
                    onSelect(artifact.artifactId);
                  }}
                >
                  <div className={styles.cardHeader}>
                    <span className={styles.cardName}>{artifact.name ?? artifact.artifactId}</span>
                    <Tag color={ARTIFACT_STATUS_COLOR[artifact.status]} size="small">
                      {artifact.status}
                    </Tag>
                  </div>
                  <div className={styles.cardMeta}>
                    <span>{artifact.type}</span>
                    {artifact.sizeBytes && <span>{formatBytes(artifact.sizeBytes)}</span>}
                    {artifact.mimeType && <span>{artifact.mimeType}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {readyArtifacts.length === 0 && artifacts.length > 0 && (
          <p className={styles.hint}>
            <span>暂无就绪产物 — 失败或生成中的文件暂不支持导出。</span>
            <span style={{ display: 'none' }}>
              No ready artifacts — failed or pending ones cannot be exported.
            </span>
          </p>
        )}
      </section>
    );
  },
);

ArtifactPanel.displayName = 'ArtifactPanel';

export default ArtifactPanel;
