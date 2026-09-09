import { Tag } from '@lobehub/ui';
import { memo } from 'react';

import type { PresentationJobState } from '../../../packages/runtime-contracts/src/index';

export interface JobStateTagProps {
  state: PresentationJobState;
}

export const JOB_STATE_COLORS: Record<
  PresentationJobState,
  'default' | 'processing' | 'success' | 'error'
> = {
  cancelled: 'default',
  completed: 'success',
  failed: 'error',
  queued: 'default',
  running: 'processing',
};

const JOB_STATE_LABELS: Record<PresentationJobState, string> = {
  cancelled: 'cancelled',
  completed: 'completed',
  failed: 'failed',
  queued: 'queued',
  running: 'running',
};

export const JobStateTag = memo<JobStateTagProps>(({ state }) => (
  <Tag color={JOB_STATE_COLORS[state]}>{JOB_STATE_LABELS[state]}</Tag>
));

JobStateTag.displayName = 'JobStateTag';

export default JobStateTag;
