import { Alert } from 'antd';
import { memo, useEffect, useState } from 'react';

import { runtimeSelectors, useRuntimeStore } from '@/store/runtime';

import DecorativeLayer from './DecorativeLayer';
import EventStream from './EventStream';
import Header from './Header';
import PluginPanel from './PluginPanel';
import PluginSlotHost, { RUNTIME_SLOT_IDS } from './PluginSlotHost';
import PresentationPanel, { type PresentationPanelProps } from './PresentationPanel';
import RunComposer from './RunComposer';
import Sidebar from './Sidebar';
import { styles } from './style';

export interface RuntimeWorkspaceProps {
  className?: string;
  presentation?: PresentationPanelProps;
  showComposer?: boolean;
  showPlugins?: boolean;
  showSlots?: boolean;
}

export const RuntimeWorkspace = memo<RuntimeWorkspaceProps>(
  ({ className, presentation, showComposer = true, showPlugins = true, showSlots = true }) => {
    const activeRunId = useRuntimeStore((s) => s.activeRunId);
    const activeRun = useRuntimeStore(runtimeSelectors.activeRun);
    const subscribeRun = useRuntimeStore((s) => s.subscribeRun);

    const [subscriptionError, setSubscriptionError] = useState<string | null>(null);

    useEffect(() => {
      if (!activeRunId) {
        setSubscriptionError(null);
        return;
      }

      const isTerminal =
        activeRun?.state === 'completed' ||
        activeRun?.state === 'failed' ||
        activeRun?.state === 'cancelled';

      if (isTerminal) {
        setSubscriptionError(null);
        return;
      }

      const controller = new AbortController();
      setSubscriptionError(null);
      let isSubscribed = true;

      const runSubscription = async () => {
        try {
          await subscribeRun(activeRunId, undefined, controller.signal);
        } catch (err: unknown) {
          if (controller.signal.aborted || !isSubscribed) return;
          const message = err instanceof Error ? err.message : 'Failed to establish event stream';
          setSubscriptionError(message);
        }
      };

      runSubscription();

      return () => {
        isSubscribed = false;
        controller.abort();
      };
    }, [activeRun?.state, activeRunId, subscribeRun]);

    return (
      <div
        className={className ? `${styles.workspace} ${className}` : styles.workspace}
        data-testid="runtime-workspace"
      >
        <DecorativeLayer />
        <Header />
        {showSlots && (
          <PluginSlotHost hideWhenEmpty showHeader={false} slotId={RUNTIME_SLOT_IDS.header} />
        )}
        <div className={styles.body}>
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <Sidebar />
            {showSlots && (
              <PluginSlotHost hideWhenEmpty showHeader={false} slotId={RUNTIME_SLOT_IDS.sidebar} />
            )}
          </div>
          <div className={styles.mainContent} data-testid="workspace-main-content">
            {subscriptionError && (
              <div data-testid="subscription-error-alert" style={{ margin: '8px 16px' }}>
                <Alert
                  closable
                  showIcon
                  description={subscriptionError}
                  message="Live Event Stream Error"
                  type="warning"
                  onClose={() => setSubscriptionError(null)}
                />
              </div>
            )}
            {presentation && (
              <div data-testid="workspace-presentation-slot" style={{ padding: '0 16px 12px' }}>
                <PresentationPanel {...presentation} />
              </div>
            )}
            <EventStream />
            {showSlots && (
              <>
                <PluginSlotHost
                  hideWhenEmpty
                  showHeader={false}
                  slotId={RUNTIME_SLOT_IDS.presentation}
                />
                <PluginSlotHost hideWhenEmpty showHeader={false} slotId={RUNTIME_SLOT_IDS.main} />
              </>
            )}
            {showComposer && <RunComposer />}
          </div>
          {showPlugins && (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              <PluginPanel />
              {showSlots && (
                <PluginSlotHost
                  hideWhenEmpty
                  showHeader={false}
                  slotId={RUNTIME_SLOT_IDS.plugins}
                />
              )}
            </div>
          )}
        </div>
      </div>
    );
  },
);

RuntimeWorkspace.displayName = 'RuntimeWorkspace';

export default RuntimeWorkspace;
export type { PluginSlotHostProps } from './PluginSlotHost';
export { default as PluginSlotHost } from './PluginSlotHost';
export * from './PluginSlotHost/registry';
export * from './PluginSlotHost/usePluginSlot';
export type { PresentationPanelProps } from './PresentationPanel';
export { default as PresentationPanel } from './PresentationPanel';
export type { RunComposerProps } from './RunComposer';
export { default as RunComposer } from './RunComposer';
