'use client';

import { Button } from '@lobehub/ui';
import { App } from 'antd';
import { createStaticStyles } from 'antd-style';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { SESSION_CHAT_URL } from '@/const/url';
import { agentService } from '@/services/agent';
import { discoverService } from '@/services/discover';
import { useAgentStore } from '@/store/agent';
import { useHomeStore } from '@/store/home';

import { useDetailContext } from '../../DetailProvider';

const styles = createStaticStyles(({ css }) => ({
  buttonGroup: css`
    width: 100%;
  `,
}));

const ForkAndChat = memo<{ mobile?: boolean }>(({ mobile }) => {
  const { identifier, title, config, avatar, backgroundColor, description, tags, editorData } =
    useDetailContext();
  const [isLoading, setIsLoading] = useState(false);
  const createAgent = useAgentStore((s) => s.createAgent);
  const refreshAgentList = useHomeStore((s) => s.refreshAgentList);
  const { message } = App.useApp();
  const navigate = useNavigate();
  const { t } = useTranslation('discover');

  const meta = {
    avatar,
    backgroundColor,
    description,
    tags,
    title,
  };

  const handleForkAndChat = async () => {
    try {
      setIsLoading(true);

      // Step 1: Check if user has already forked this agent
      const existingAgentId = await agentService.getAgentByForkedFromIdentifier(identifier!);

      if (existingAgentId) {
        // User has already forked this agent, navigate to existing fork
        message.info(t('fork.alreadyForked'));
        navigate(SESSION_CHAT_URL(existingAgentId, mobile));
        return;
      }

      // Step 2: Create a local fork owned by the current Nexus user.
      if (!config) throw new Error('Agent config is missing');

      const agentData = {
        config: {
          ...config,
          editorData,
          ...meta,
          params: {
            ...config.params,
            forkedFromIdentifier: identifier, // Store the source agent identifier
          },
        },
      };

      // Step 3: Add to local agent list
      const result = await createAgent(agentData);
      await refreshAgentList();

      // Step 4: Report local install/fork against the source marketplace item.
      discoverService.reportAgentEvent({
        event: 'add',
        identifier: identifier!,
        source: location.pathname,
      });

      message.success(t('fork.success'));

      // Step 5: Navigate to chat
      navigate(SESSION_CHAT_URL(result!.agentId, mobile));
    } catch (error: any) {
      console.error('Fork failed:', error);
      message.error(t('fork.failed'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Button
      block
      className={styles.buttonGroup}
      loading={isLoading}
      size={'large'}
      type={'primary'}
      onClick={handleForkAndChat}
    >
      {t('fork.forkAndChat')}
    </Button>
  );
});

export default ForkAndChat;
