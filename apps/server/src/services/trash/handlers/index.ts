import type { TrashResourceType } from '@lobechat/types';

import { agentHandler } from './agent';
import { messageHandler } from './message';
import { topicHandler } from './topic';
import type { TrashHandler } from './types';

export const TRASH_HANDLERS: Record<TrashResourceType, TrashHandler> = {
  agent: agentHandler,
  message: messageHandler,
  topic: topicHandler,
};

export { softDeleteAgent } from './agent';
export { softDeleteMessages } from './message';
export { topicCascades } from './topic';
export * from './types';
