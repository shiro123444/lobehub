import { Flexbox, Icon, Tag } from '@lobehub/ui';
import { Alert, Spin } from 'antd';
import { AlertCircle, Inbox, Terminal } from 'lucide-react';
import { memo } from 'react';

import { runtimeSelectors, useRuntimeStore } from '@/store/runtime';

import { EventItem } from './EventItem';
import { styles } from './style';

export const EventStream = memo(() => {
  const activeRun = useRuntimeStore(runtimeSelectors.activeRun);
  const activeEvents = useRuntimeStore(runtimeSelectors.activeEvents);

  if (!activeRun) {
    return (
      <div
        aria-label="Event Stream Empty State"
        className={styles.container}
        data-testid="event-stream-empty"
        role="region"
      >
        <div className={styles.emptyState}>
          <Icon icon={Inbox} size={36} style={{ marginBottom: 12, opacity: 0.5 }} />
          <div style={{ fontSize: 14, fontWeight: 500 }}>No Active Run Selected</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>
            Select a run from the sidebar to inspect its lifecycle events and live state.
          </div>
        </div>
      </div>
    );
  }

  const isRunning =
    activeRun.state === 'running' ||
    activeRun.state === 'queued' ||
    activeRun.state?.startsWith('waiting_');

  return (
    <div
      aria-label={`Event Stream for Run ${activeRun.runId}`}
      className={styles.container}
      data-testid="event-stream-panel"
      role="region"
    >
      <div className={styles.metaCard}>
        <Flexbox horizontal align="center" justify="space-between" style={{ marginBottom: 6 }}>
          <Flexbox horizontal align="center" gap={8}>
            <Icon icon={Terminal} size={16} />
            <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{activeRun.runId}</span>
            <Tag
              color={
                activeRun.state === 'completed' ? 'success' : isRunning ? 'processing' : 'default'
              }
            >
              {activeRun.state}
            </Tag>
          </Flexbox>
          {isRunning && (
            <Flexbox
              horizontal
              align="center"
              aria-label="Streaming events in real time"
              aria-live="polite"
              gap={6}
              role="status"
            >
              <Spin size="small" />
              <span style={{ fontSize: 12, opacity: 0.8 }}>Streaming events</span>
            </Flexbox>
          )}
        </Flexbox>

        <Flexbox horizontal gap={16} style={{ fontSize: 12, opacity: 0.7 }}>
          <span>Session: {activeRun.sessionId}</span>
          {activeRun.profileId && <span>Profile: {activeRun.profileId}</span>}
          <span>Created: {new Date(activeRun.createdAt).toLocaleString()}</span>
        </Flexbox>
      </div>

      {activeRun.error && (
        <div className={styles.errorBox} data-testid="run-error-alert">
          <Alert
            showIcon
            description={activeRun.error.message}
            message={`Run Error: ${activeRun.error.code}`}
            type="error"
          />
        </div>
      )}

      <div
        aria-label="Runtime Events Log"
        aria-live="polite"
        className={styles.eventsList}
        data-testid="events-list"
        role="log"
      >
        {activeEvents.length === 0 ? (
          <div className={styles.emptyState}>
            <Icon icon={AlertCircle} size={24} style={{ marginBottom: 8, opacity: 0.4 }} />
            <div>
              {isRunning
                ? 'Run is starting. Waiting for incoming events...'
                : 'No runtime events recorded for this run.'}
            </div>
          </div>
        ) : (
          activeEvents.map((event, index) => (
            <EventItem event={event} key={`${event.seq}-${index}`} />
          ))
        )}
      </div>
    </div>
  );
});

EventStream.displayName = 'EventStream';

export default EventStream;
