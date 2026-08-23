'use client';

import { Flexbox } from '@lobehub/ui';
import { memo } from 'react';
import urlJoin from 'url-join';

import { useAppOrigin } from '@/hooks/useAppOrigin';

import ShareButton from '../../../../features/ShareButton';
import { useDetailContext } from '../../DetailProvider';
import ForkAndChat from './ForkAndChat';

const ActionButton = memo<{ mobile?: boolean }>(({ mobile }) => {
  const { avatar, description, tags, title, identifier } = useDetailContext();
  const appOrigin = useAppOrigin();
  return (
    <Flexbox horizontal align={'center'} gap={8}>
      <ForkAndChat mobile={mobile} />
      <ShareButton
        meta={{
          avatar,
          desc: description,
          hashtags: tags,
          title,
          url: new URL(urlJoin('/community/agent', identifier as string), appOrigin).toString(),
        }}
      />
    </Flexbox>
  );
});

export default ActionButton;
