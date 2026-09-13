import { Center, Flexbox } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import { ChevronDownIcon } from 'lucide-react';
import { memo, useCallback } from 'react';

import { JUMI_CHAT_MODEL_NAME } from '@/const/jumi';
import ModelSwitchPanel from '@/features/ModelSwitchPanel';
import { useJumiChatModel } from '@/hooks/useJumiChatModel';
import { useAgentStore } from '@/store/agent';

import { useAgentId } from '../../hooks/useAgentId';
import { useActionBarContext } from '../context';

const styles = createStaticStyles(({ css, cssVar }) => ({
  chevron: css`
    color: ${cssVar.colorTextQuaternary};
  `,
  name: css`
    overflow: hidden;

    max-width: 160px;

    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  trigger: css`
    cursor: pointer;
    border-radius: 6px;

    :hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
}));

const ModelLabel = memo(() => {
  const { dropdownPlacement } = useActionBarContext();

  const agentId = useAgentId();
  const { model, provider } = useJumiChatModel(agentId);
  const updateAgentConfigById = useAgentStore((s) => s.updateAgentConfigById);

  const displayName = JUMI_CHAT_MODEL_NAME;

  const handleModelChange = useCallback(
    async (params: { model: string; provider: string }) => {
      if (agentId !== 'ppt-agent') await updateAgentConfigById(agentId, params);
    },
    [agentId, updateAgentConfigById],
  );

  return (
    <ModelSwitchPanel
      model={model}
      openOnHover={false}
      placement={dropdownPlacement}
      provider={provider}
      onModelChange={handleModelChange}
    >
      <Center horizontal className={styles.trigger} height={28} paddingInline={6}>
        <Flexbox horizontal align={'center'} gap={2}>
          <span className={styles.name}>{displayName}</span>
          <ChevronDownIcon className={styles.chevron} size={12} />
        </Flexbox>
      </Center>
    </ModelSwitchPanel>
  );
});

ModelLabel.displayName = 'ModelLabel';

export default ModelLabel;
