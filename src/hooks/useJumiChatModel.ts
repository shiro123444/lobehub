import { useEffect } from 'react';

import { JUMI_CHAT_MODEL, JUMI_CHAT_PROVIDER } from '@/const/jumi';
import { useAgentStore } from '@/store/agent';

/** Persist the supported model for real agents; PPT intake uses its server-pinned provider. */
export function useJumiChatModel(agentId: string) {
  const config = useAgentStore((s) => s.agentMap[agentId]);
  const update = useAgentStore((s) => s.updateAgentConfigById);
  useEffect(() => {
    if (!config || agentId === 'ppt-agent') return;
    if (config.model === JUMI_CHAT_MODEL && config.provider === JUMI_CHAT_PROVIDER) return;
    void update(agentId, { model: JUMI_CHAT_MODEL, provider: JUMI_CHAT_PROVIDER });
  }, [agentId, config?.model, config?.provider, update]);
  return { model: JUMI_CHAT_MODEL, provider: JUMI_CHAT_PROVIDER };
}
