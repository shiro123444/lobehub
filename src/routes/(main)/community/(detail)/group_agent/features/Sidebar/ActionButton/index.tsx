'use client';

import { Flexbox } from '@lobehub/ui';
import { memo } from 'react';
import urlJoin from 'url-join';

import { useAppOrigin } from '@/hooks/useAppOrigin';

import ShareButton from '../../../../features/ShareButton';
import { useDetailContext } from '../../DetailProvider';
import ForkGroupAndChat from './ForkGroupAndChat';

const ActionButton = memo<{ mobile?: boolean }>(({ mobile }) => {
  const { avatar, title, description, tags, identifier } = useDetailContext();
  const appOrigin = useAppOrigin();

  return (
    <Flexbox horizontal align={'center'} gap={8}>
      <ForkGroupAndChat mobile={mobile} />
      {identifier && (
        <ShareButton
          meta={{
            avatar,
            desc: description,
            hashtags: tags,
            title,
            url: new URL(urlJoin('/community/group_agent', identifier), appOrigin).toString(),
          }}
        />
      )}
    </Flexbox>
  );
});

export default ActionButton;
