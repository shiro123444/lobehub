import { Icon } from '@lobehub/ui';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { memo, useCallback, useState } from 'react';

import { useRuntimeStore } from '@/store/runtime';

import { RunItem } from './RunItem';
import { styles } from './style';

export interface SidebarProps {
  defaultCollapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}

export const Sidebar = memo<SidebarProps>(({ defaultCollapsed = false, onCollapsedChange }) => {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const runs = useRuntimeStore((s) => s.runs);
  const activeRunId = useRuntimeStore((s) => s.activeRunId);
  const setActiveRunId = useRuntimeStore((s) => s.setActiveRunId);

  const runList = Object.values(runs);

  const handleToggle = useCallback(
    (next: boolean) => {
      setCollapsed(next);
      onCollapsedChange?.(next);
    },
    [onCollapsedChange],
  );

  return (
    <aside
      className={collapsed ? `${styles.sidebar} ${styles.sidebarCollapsed}` : styles.sidebar}
      data-collapsed={collapsed ? 'true' : 'false'}
      data-testid="workspace-sidebar"
    >
      {collapsed ? (
        <div className={styles.collapsedBar}>
          <button
            aria-label="展开侧栏"
            className={styles.expandButton}
            data-testid="workspace-sidebar-expand-btn"
            tabIndex={0}
            title="展开侧栏"
            type="button"
            onClick={() => handleToggle(false)}
          >
            <Icon icon={PanelLeftOpen} size={18} />
          </button>
        </div>
      ) : (
        <div className={styles.expandedContent}>
          <div className={styles.header}>
            <div
              style={{
                alignItems: 'center',
                display: 'flex',
                justifyContent: 'space-between',
                width: '100%',
              }}
            >
              <span>Runs ({runList.length})</span>
              <button
                aria-label="收起侧栏"
                className={styles.collapseButton}
                data-testid="workspace-sidebar-collapse-btn"
                tabIndex={0}
                title="收起侧栏"
                type="button"
                onClick={() => handleToggle(true)}
              >
                <Icon icon={PanelLeftClose} size={16} />
              </button>
            </div>
          </div>
          <div className={styles.list}>
            {runList.length === 0 ? (
              <div className={styles.empty}>No runs recorded</div>
            ) : (
              runList.map((run) => (
                <RunItem
                  isActive={run.runId === activeRunId}
                  key={run.runId}
                  run={run}
                  onSelect={setActiveRunId}
                />
              ))
            )}
          </div>
        </div>
      )}
    </aside>
  );
});

Sidebar.displayName = 'WorkspaceSidebar';

export default Sidebar;
