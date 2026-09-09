import { Button, Flexbox, Icon, Tag } from '@lobehub/ui';
import { Image as ImageIcon, RefreshCw } from 'lucide-react';
import { memo, useCallback } from 'react';

import type { PresentationSlotState } from '../store/presentationStore';
import { styles } from './style';

export interface AssetSlotPanelProps {
  className?: string;
  /** Clears a slot's error affordance after the user saw it. */
  onDismissError?: (slideId: string, slotId: string) => void;
  /** Re-runs exactly one slot; the panel only forwards the key triple. */
  onRetry?: (slideId: string, slotId: string) => void;
  /**
   * Explicit artifact URI resolver (C-92): maps an artifact id to a safe
   * `https:`/`data:` URI for the slot thumbnail. Only the resolver's return
   * value can reach `src` — refs, paths, prompts and vendor metadata never do.
   */
  resolveArtifactUri?: (artifactId: string) => string | undefined;
  /** Slot keys (slideId:slotId) with an in-flight retry. */
  retryPendingKeys?: Record<string, boolean>;
  /** Flat slot list for the selected job (store projection). */
  slots?: PresentationSlotState[];
}

const STATUS_TAG: Record<
  PresentationSlotState['status'],
  { color: 'default' | 'error' | 'processing' | 'success' | 'warning'; label: string }
> = {
  cancelled: { color: 'default', label: 'Cancelled' },
  failed: { color: 'error', label: 'Failed' },
  generating: { color: 'processing', label: 'Generating' },
  queued: { color: 'warning', label: 'Queued' },
  ready: { color: 'success', label: 'Ready' },
};

const SLOT_TEST_IDS: Record<PresentationSlotState['status'], string> = {
  cancelled: 'slot-status-cancelled',
  failed: 'slot-status-failed',
  generating: 'slot-status-generating',
  queued: 'slot-status-queued',
  ready: 'slot-status-ready',
};

const shortSlide = (slideId: string): string =>
  slideId.length > 12 ? `${slideId.slice(0, 12)}…` : slideId;

/**
 * Only safe image URIs may reach a thumbnail `src`: a well-formed remote
 * `https:` URL (non-empty hostname) or a `data:image/*` URI. Everything else —
 * malformed https, file:, javascript:, paths, raw refs — falls back to the
 * honest placeholder.
 */
const isSafeImageUri = (uri: string): boolean => {
  if (uri.startsWith('data:')) {
    return /^data:image\/[a-z0-9.+-]+(?:[;,]|$)/i.test(uri);
  }
  try {
    const parsed = new URL(uri);
    return parsed.protocol === 'https:' && parsed.hostname.length > 0;
  } catch {
    return false;
  }
};

const SlotCard = memo<{
  onDismissError?: (slideId: string, slotId: string) => void;
  onRetry?: (slideId: string, slotId: string) => void;
  resolveArtifactUri?: (artifactId: string) => string | undefined;
  retryPending: boolean;
  slot: PresentationSlotState;
}>(({ onDismissError, onRetry, resolveArtifactUri, retryPending, slot }) => {
  const meta = STATUS_TAG[slot.status];
  const canRetry = slot.status === 'failed' || slot.status === 'cancelled';
  // C-92: the thumbnail renders a real image only when the slot is ready, an
  // artifact id exists and the injected resolver returns a safe URI. Any other
  // case keeps the honest placeholder — refs/paths/prompts never become src.
  const firstArtifact = slot.status === 'ready' ? slot.artifactIds[0] : undefined;
  const resolvedUri = firstArtifact ? resolveArtifactUri?.(firstArtifact) : undefined;
  const thumbSrc = resolvedUri && isSafeImageUri(resolvedUri) ? resolvedUri : undefined;

  const handleRetry = useCallback(() => {
    if (retryPending || !canRetry) return;
    onRetry?.(slot.slideId, slot.slotId);
  }, [canRetry, onRetry, retryPending, slot.slotId, slot.slideId]);

  return (
    <div
      aria-busy={slot.status === 'generating' || retryPending}
      className={slot.errorCode ? `${styles.slot} ${styles.slotError}` : styles.slot}
      data-error-code={slot.errorCode ?? undefined}
      data-slide-id={slot.slideId}
      data-slot-id={slot.slotId}
      data-testid={`slot-${slot.slideId}-${slot.slotId}`}
    >
      <div aria-hidden="true" className={styles.thumbnail}>
        {/* C-92: real image only via the injected resolver's safe URI; the
            honest placeholder covers every other case. */}
        {thumbSrc ? (
          <img
            alt={`Generated material for slide ${slot.slideId} slot ${slot.slotId}`}
            data-testid={`slot-thumb-${slot.slideId}-${slot.slotId}`}
            loading="lazy"
            src={thumbSrc}
          />
        ) : (
          <Icon
            icon={ImageIcon}
            size={20}
            style={{ opacity: slot.status === 'ready' ? 0.7 : 0.4 }}
          />
        )}
      </div>
      <div className={styles.slotMeta}>
        <span className={styles.slotName}>Slide {shortSlide(slot.slideId)}</span>
        <Flexbox horizontal align="center" gap={6}>
          <Tag color={meta.color} data-testid={SLOT_TEST_IDS[slot.status]} size="small">
            {meta.label}
          </Tag>
          <span style={{ fontSize: 11, opacity: 0.65 }}>{slot.label}</span>
        </Flexbox>
      </div>
      {slot.errorCode && (
        <Flexbox horizontal align="center" gap={6}>
          <span role="alert" style={{ fontSize: 11, color: 'var(--ant-color-error)' }}>
            {slot.errorCode}
          </span>
        </Flexbox>
      )}
      {(canRetry || retryPending) && (
        <Button
          aria-busy={retryPending}
          aria-label={`Retry slot ${slot.slotId} on slide ${slot.slideId}`}
          data-testid={`slot-retry-${slot.slideId}-${slot.slotId}`}
          disabled={retryPending}
          icon={<Icon icon={RefreshCw} size={12} />}
          loading={retryPending}
          size="small"
          onClick={handleRetry}
        >
          重新生成
        </Button>
      )}
      {slot.errorCode && onDismissError && (
        <Button
          aria-label="Dismiss error"
          size="small"
          type="text"
          onClick={() => onDismissError(slot.slideId, slot.slotId)}
        >
          忽略错误
        </Button>
      )}
    </div>
  );
});

SlotCard.displayName = 'SlotCard';

/**
 * Material slot grid (C-87): per slideId/slotId status, honest placeholders,
 * single-slot retry/regenerate with keyboard-reachable buttons and aria-busy.
 * Prompts are never part of the slot state, so nothing here can leak them.
 */
export const AssetSlotPanel = memo<AssetSlotPanelProps>(
  ({
    className,
    onDismissError,
    onRetry,
    resolveArtifactUri,
    slots = [],
    retryPendingKeys = {},
  }) => {
    if (slots.length === 0) {
      return (
        <section aria-label="Material slots" className={className} data-testid="asset-slot-panel">
          <p className={styles.hint}>
            当前任务暂无素材插图槽位
            <span style={{ display: 'none' }}>No material slots for this job yet.</span>
          </p>
        </section>
      );
    }

    return (
      <section aria-label="Material slots" className={className} data-testid="asset-slot-panel">
        <div className={styles.grid}>
          {slots.map((slot) => {
            const key = `${slot.slideId}:${slot.slotId}`;
            return (
              <SlotCard
                key={key}
                resolveArtifactUri={resolveArtifactUri}
                retryPending={Boolean(retryPendingKeys[key])}
                slot={slot}
                onDismissError={onDismissError}
                onRetry={onRetry}
              />
            );
          })}
        </div>
      </section>
    );
  },
);

AssetSlotPanel.displayName = 'AssetSlotPanel';

export default AssetSlotPanel;
