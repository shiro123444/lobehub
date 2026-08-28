import { memo } from 'react';

import { useRuntimeStore } from '@/store/runtime';

import { RunItem } from './RunItem';
import { styles } from './style';

export const Sidebar = memo(() => {
  const runs = useRuntimeStore((s) => s.runs);
  const activeRunId = useRuntimeStore((s) => s.activeRunId);
  const setActiveRunId = useRuntimeStore((s) => s.setActiveRunId);

  const runList = Object.values(runs);

  return (
    <aside className={styles.sidebar} data-testid="workspace-sidebar">
      <div className={styles.header}>Runs ({runList.length})</div>
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
    </aside>
  );
});

Sidebar.displayName = 'WorkspaceSidebar';

export default Sidebar;
