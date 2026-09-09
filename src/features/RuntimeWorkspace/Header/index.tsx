import { Button, Flexbox, Icon, Tag } from '@lobehub/ui';
import { Activity, Radio, Square } from 'lucide-react';
import { memo, useCallback } from 'react';

import { runtimeSelectors, useRuntimeStore } from '@/store/runtime';

import { styles } from './style';

const getStateColor = (state?: string) => {
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
    case 'waiting_tool':
    case 'waiting_human':
    case 'waiting_child': {
      return 'warning';
    }
    default: {
      return 'default';
    }
  }
};

export const Header = memo(() => {
  const activeRun = useRuntimeStore(runtimeSelectors.activeRun);
  const cancelRun = useRuntimeStore((s) => s.cancelRun);

  const isRunning =
    activeRun?.state === 'running' ||
    activeRun?.state === 'queued' ||
    activeRun?.state?.startsWith('waiting_');

  const handleCancel = useCallback(() => {
    if (activeRun?.runId) {
      cancelRun(activeRun.runId);
    }
  }, [activeRun?.runId, cancelRun]);

  return (
    <header
      aria-label="Workspace Header"
      className={styles.header}
      data-testid="workspace-header"
      role="banner"
    >
      <Flexbox horizontal align="center" gap={12}>
        <Icon icon={Activity} size={18} />
        <span className={styles.title}>Cordis Runtime Workspace</span>
        {activeRun && (
          <div className={styles.meta}>
            <span className={styles.runId}>({activeRun.runId})</span>
            <Tag color={getStateColor(activeRun.state)}>{activeRun.state}</Tag>
          </div>
        )}
      </Flexbox>

      <Flexbox horizontal align="center" gap={8}>
        {isRunning && (
          <Button
            danger
            aria-label={`Cancel active run ${activeRun?.runId || ''}`}
            icon={<Icon icon={Square} size={12} />}
            size="small"
            onClick={handleCancel}
          >
            Cancel Run
          </Button>
        )}
        <Flexbox
          horizontal
          align="center"
          aria-label={`Stream status: ${isRunning ? 'Streaming active' : 'Idle'}`}
          aria-live="polite"
          gap={4}
          role="status"
        >
          <Icon
            icon={Radio}
            size={14}
            style={{ color: isRunning ? 'var(--color-primary)' : 'inherit' }}
          />
          <span style={{ fontSize: 12, opacity: 0.7 }}>
            {isRunning ? 'Streaming active' : 'Idle'}
          </span>
        </Flexbox>
      </Flexbox>
    </header>
  );
});

Header.displayName = 'WorkspaceHeader';

export default Header;
