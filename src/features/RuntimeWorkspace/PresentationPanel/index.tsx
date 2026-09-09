import { Button, Flexbox, Icon, Tag } from '@lobehub/ui';
import { Alert, Dropdown, type MenuProps, Spin } from 'antd';
import { cx } from 'antd-style';
import {
  Download,
  FileSpreadsheet,
  FileText,
  Layers,
  Presentation,
  RefreshCw,
  Square,
} from 'lucide-react';
import React, { memo, useCallback, useState } from 'react';

import type {
  ArtifactSnapshot,
  PresentationExportFormat,
  PresentationJob,
  PresentationJobState,
} from '../../../../packages/runtime-contracts/src/index';
import { styles } from './style';

export interface PresentationPanelProps {
  artifact?: ArtifactSnapshot | null;
  artifacts?: ArtifactSnapshot[];
  cancelling?: boolean;
  className?: string;
  exporting?: boolean;
  job?: PresentationJob | null;
  onArtifactSelect?: (artifactId: string) => void;
  onCancel?: (jobId: string) => void;
  onExport?: (artifactId: string, format: PresentationExportFormat) => void;
  onRetry?: (jobId: string) => void;
  retrying?: boolean;
  selectedArtifactId?: string;
}

const getJobStateTag = (state: PresentationJobState) => {
  switch (state) {
    case 'queued': {
      return <Tag color="default">queued</Tag>;
    }
    case 'running': {
      return <Tag color="processing">running</Tag>;
    }
    case 'completed': {
      return <Tag color="success">completed</Tag>;
    }
    case 'failed': {
      return <Tag color="error">failed</Tag>;
    }
    case 'cancelled': {
      return <Tag color="default">cancelled</Tag>;
    }
    default: {
      return <Tag>{state}</Tag>;
    }
  }
};

const formatBytes = (bytes?: number) => {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
};

export const PresentationPanel = memo<PresentationPanelProps>(
  ({
    artifact,
    artifacts,
    cancelling = false,
    className,
    exporting = false,
    job,
    onArtifactSelect,
    onCancel,
    onExport,
    onRetry,
    retrying = false,
    selectedArtifactId,
  }) => {
    const displayArtifacts = artifacts ?? (artifact ? [artifact] : []);
    const [internalSelectedId, setInternalSelectedId] = useState<string | undefined>(
      () => displayArtifacts[0]?.artifactId,
    );

    const activeSelectedId =
      selectedArtifactId ?? internalSelectedId ?? displayArtifacts[0]?.artifactId;
    const selectedArtifact =
      displayArtifacts.find((a) => a.artifactId === activeSelectedId) ?? displayArtifacts[0];

    const handleSelectArtifact = useCallback(
      (artId: string) => {
        setInternalSelectedId(artId);
        onArtifactSelect?.(artId);
      },
      [onArtifactSelect],
    );

    const handleCancel = useCallback(() => {
      if (job?.jobId && onCancel) {
        onCancel(job.jobId);
      }
    }, [job?.jobId, onCancel]);

    const handleRetry = useCallback(() => {
      if (job?.jobId && onRetry) {
        onRetry(job.jobId);
      }
    }, [job?.jobId, onRetry]);

    if (!job) {
      return (
        <div
          aria-label="Presentation Status Panel"
          className={className ? `${styles.container} ${className}` : styles.container}
          data-testid="presentation-panel-empty"
          role="region"
        >
          <div className={styles.emptyState}>
            <Icon icon={Presentation} size={32} style={{ marginBottom: 8, opacity: 0.4 }} />
            <div style={{ fontWeight: 500 }}>No Active Presentation Job</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>
              Start a presentation strategy run or job to view slide generation progress and
              artifacts.
            </div>
          </div>
        </div>
      );
    }

    const isRunning = job.state === 'running';
    const isQueued = job.state === 'queued';
    const isFailed = job.state === 'failed';
    const isCancelled = job.state === 'cancelled';
    const isCompleted = job.state === 'completed';

    const showCancel = isRunning || isQueued;
    const showRetry = isFailed || isCancelled;
    const canCancel = showCancel && !cancelling;
    const canRetry = showRetry && !retrying;

    const isSelectedReady = Boolean(selectedArtifact && selectedArtifact.status === 'ready');
    const canExport = isSelectedReady && !exporting;

    const exportMenuItems: MenuProps['items'] = [
      {
        icon: <Icon icon={FileSpreadsheet} size={13} />,
        key: 'pptx',
        label: 'Export PowerPoint (.pptx)',
        onClick: () => selectedArtifact && onExport?.(selectedArtifact.artifactId, 'pptx'),
      },
      {
        icon: <Icon icon={FileText} size={13} />,
        key: 'pdf',
        label: 'Export Document (.pdf)',
        onClick: () => selectedArtifact && onExport?.(selectedArtifact.artifactId, 'pdf'),
      },
      {
        icon: <Icon icon={Layers} size={13} />,
        key: 'svg',
        label: 'Export Vector Slides (.svg)',
        onClick: () => selectedArtifact && onExport?.(selectedArtifact.artifactId, 'svg'),
      },
      {
        icon: <Icon icon={FileText} size={13} />,
        key: 'quality-report',
        label: 'Export Quality Report',
        onClick: () =>
          selectedArtifact && onExport?.(selectedArtifact.artifactId, 'quality-report'),
      },
    ];

    return (
      <div
        aria-busy={isRunning || isQueued}
        aria-label="Presentation Status Panel"
        className={className ? `${styles.container} ${className}` : styles.container}
        data-testid="presentation-panel"
        role="region"
      >
        <div className={styles.header}>
          <Flexbox horizontal align="center" gap={8}>
            <Icon icon={Presentation} size={16} />
            <span className={styles.title}>Presentation Job</span>
            <span className={styles.jobId}>({job.jobId})</span>
          </Flexbox>
          <Flexbox horizontal align="center" gap={6}>
            {getJobStateTag(job.state)}
          </Flexbox>
        </div>

        <div className={styles.metaRow}>
          <span>Created: {new Date(job.createdAt).toLocaleTimeString()}</span>
          <span>Updated: {new Date(job.updatedAt).toLocaleTimeString()}</span>
          {displayArtifacts.length > 0 && <span>Artifacts: {displayArtifacts.length}</span>}
        </div>

        {isRunning && (
          <div
            aria-live="polite"
            role="status"
            style={{
              alignItems: 'center',
              display: 'flex',
              gap: 8,
              marginTop: 12,
            }}
          >
            <Spin size="small" />
            <span style={{ fontSize: 12, opacity: 0.8 }}>Generating presentation slides...</span>
          </div>
        )}

        {isQueued && (
          <div
            aria-live="polite"
            role="status"
            style={{
              alignItems: 'center',
              display: 'flex',
              gap: 8,
              marginTop: 12,
            }}
          >
            <span style={{ fontSize: 12, opacity: 0.7 }}>Job queued in runner queue...</span>
          </div>
        )}

        {job.error && (
          <div className={styles.errorBox} data-testid="presentation-error-alert">
            <Alert
              showIcon
              description={job.error.message}
              message={`Presentation Error: ${job.error.code}`}
              type="error"
            />
          </div>
        )}

        {displayArtifacts.length > 0 && (
          <div
            aria-label="Generated Artifacts Selection"
            className={styles.artifactsGroup}
            role="radiogroup"
          >
            {displayArtifacts.map((art) => {
              const isSelected = art.artifactId === selectedArtifact?.artifactId;
              return (
                <div
                  aria-checked={isSelected}
                  aria-label={`Artifact ${art.name || art.artifactId}, status: ${art.status}${isSelected ? ', selected' : ''}`}
                  className={cx(styles.artifactCard, isSelected && styles.artifactCardSelected)}
                  data-selected={isSelected ? 'true' : 'false'}
                  data-testid={`presentation-artifact-${art.artifactId}`}
                  key={art.artifactId}
                  role="radio"
                  tabIndex={0}
                  onClick={() => handleSelectArtifact(art.artifactId)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleSelectArtifact(art.artifactId);
                    }
                  }}
                >
                  <div className={styles.artifactHeader}>
                    <Flexbox horizontal align="center" gap={6}>
                      <span style={{ fontWeight: isSelected ? 600 : 500 }}>
                        {art.name || art.artifactId}
                      </span>
                      {isSelected && (
                        <Tag color="blue" size="small">
                          Selected
                        </Tag>
                      )}
                    </Flexbox>
                    <Tag
                      color={
                        art.status === 'ready'
                          ? 'success'
                          : art.status === 'failed'
                            ? 'error'
                            : 'default'
                      }
                    >
                      {art.status}
                    </Tag>
                  </div>
                  <div className={styles.artifactMeta}>
                    <span>Type: {art.type}</span>
                    {art.sizeBytes && <span>Size: {formatBytes(art.sizeBytes)}</span>}
                    {art.mimeType && <span>MIME: {art.mimeType}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className={styles.actionRow}>
          {showCancel && (
            <Button
              danger
              aria-label="Cancel Presentation Job"
              disabled={!canCancel}
              icon={<Icon icon={Square} size={12} />}
              loading={cancelling}
              size="small"
              onClick={handleCancel}
            >
              Cancel Job
            </Button>
          )}

          {showRetry && (
            <Button
              aria-label="Retry Presentation Job"
              disabled={!canRetry}
              icon={<Icon icon={RefreshCw} size={12} />}
              loading={retrying}
              size="small"
              onClick={handleRetry}
            >
              Retry Job
            </Button>
          )}

          {isCompleted && (
            <Dropdown
              disabled={!canExport}
              menu={{ items: exportMenuItems }}
              placement="bottomRight"
            >
              <Button
                aria-label="Export Presentation Artifact"
                disabled={!canExport}
                icon={<Icon icon={Download} size={13} />}
                loading={exporting}
                size="small"
                type="primary"
              >
                Export Deck
              </Button>
            </Dropdown>
          )}
        </div>
      </div>
    );
  },
);

PresentationPanel.displayName = 'PresentationPanel';

export default PresentationPanel;
