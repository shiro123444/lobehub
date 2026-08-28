import { Flexbox, Icon, Tag } from '@lobehub/ui';
import { Plug } from 'lucide-react';
import { memo } from 'react';

import { useRuntimeStore } from '@/store/runtime';

import { styles } from './style';

const getPluginStateColor = (state: string) => {
  switch (state) {
    case 'active': {
      return 'success';
    }
    case 'installed': {
      return 'processing';
    }
    case 'pending': {
      return 'warning';
    }
    case 'failed': {
      return 'error';
    }
    case 'disabled':
    case 'unloading': {
      return 'default';
    }
    default: {
      return 'default';
    }
  }
};

export const PluginPanel = memo(() => {
  const pluginStates = useRuntimeStore((s) => s.pluginStates);
  const pluginEntries = Object.entries(pluginStates);

  return (
    <aside className={styles.panel} data-testid="workspace-plugin-panel">
      <div className={styles.header}>
        <Flexbox horizontal align="center" gap={6}>
          <Icon icon={Plug} size={{ fontSize: 14 }} />
          <span>Plugins ({pluginEntries.length})</span>
        </Flexbox>
      </div>
      <div className={styles.list}>
        {pluginEntries.length === 0 ? (
          <div className={styles.empty}>No plugins mounted</div>
        ) : (
          pluginEntries.map(([id, state]) => (
            <div className={styles.pluginItem} data-testid={`plugin-item-${id}`} key={id}>
              <span className={styles.pluginId}>{id}</span>
              <Tag color={getPluginStateColor(state)} size="small">
                {state}
              </Tag>
            </div>
          ))
        )}
      </div>
    </aside>
  );
});

PluginPanel.displayName = 'WorkspacePluginPanel';

export default PluginPanel;
