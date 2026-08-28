import { Flexbox, Tag } from '@lobehub/ui';
import { memo } from 'react';

import type { RuntimeEvent } from '../../../../packages/runtime-contracts/src/index';
import { styles } from './style';

interface EventItemProps {
  event: RuntimeEvent;
}

const getEventTypeColor = (type: string) => {
  if (type.includes('error') || type.includes('fail')) return 'error';
  if (type.includes('state') || type.includes('status')) return 'processing';
  if (type.includes('done') || type.includes('complete')) return 'success';
  if (type.includes('tool')) return 'warning';
  return 'default';
};

export const EventItem = memo<EventItemProps>(({ event }) => {
  const dataString =
    typeof event.data === 'string' ? event.data : JSON.stringify(event.data, null, 2);

  return (
    <div className={styles.eventItem} data-testid={`event-item-${event.seq}`}>
      <div className={styles.eventHeader}>
        <Flexbox horizontal align="center" gap={8}>
          <span className={styles.seqBadge}>#{event.seq}</span>
          <Tag color={getEventTypeColor(event.type)} size="small">
            {event.type}
          </Tag>
        </Flexbox>
      </div>
      <div className={styles.eventContent}>{dataString}</div>
    </div>
  );
});

EventItem.displayName = 'EventItem';
