import { Flexbox, Tag } from '@lobehub/ui';
import { cx } from 'antd-style';
import React, { memo, useCallback } from 'react';

import type { RunSnapshot } from '../../../../packages/runtime-contracts/src/index';
import { styles } from './style';

interface RunItemProps {
  isActive: boolean;
  onSelect: (runId: string) => void;
  run: RunSnapshot;
}

const getStateColor = (state: string) => {
  switch (state) {
    case 'running': {
      return 'processing';
    }
    case 'completed': {
      return 'success';
    }
    case 'failed': {
      return 'error';
    }
    case 'cancelled': {
      return 'default';
    }
    default: {
      return 'warning';
    }
  }
};

export const RunItem = memo<RunItemProps>(({ run, isActive, onSelect }) => {
  const handleClick = useCallback(() => {
    onSelect(run.runId);
  }, [onSelect, run.runId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect(run.runId);
      }
    },
    [onSelect, run.runId],
  );

  return (
    <div
      aria-label={`Run ${run.runId}, state: ${run.state}`}
      aria-pressed={isActive}
      className={cx(styles.item, isActive && styles.itemActive)}
      data-testid={`run-item-${run.runId}`}
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      <Flexbox horizontal align="center" justify="space-between" style={{ marginBottom: 4 }}>
        <span className={styles.runId}>{run.runId}</span>
        <Tag color={getStateColor(run.state)} size="small">
          {run.state}
        </Tag>
      </Flexbox>
      <Flexbox horizontal align="center" justify="space-between">
        <span className={styles.time}>{new Date(run.createdAt).toLocaleTimeString()}</span>
        {run.profileId && <span className={styles.time}>{run.profileId}</span>}
      </Flexbox>
    </div>
  );
});

RunItem.displayName = 'RunItem';
