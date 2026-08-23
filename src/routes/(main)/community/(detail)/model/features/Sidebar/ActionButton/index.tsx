'use client';

import { ModelIcon } from '@lobehub/icons';
import { Flexbox } from '@lobehub/ui';
import { memo } from 'react';
import urlJoin from 'url-join';

import { useAppOrigin } from '@/hooks/useAppOrigin';

import ShareButton from '../../../../features/ShareButton';
import { useDetailContext } from '../../DetailProvider';
import ChatWithModel from './ChatWithModel';

const ActionButton = memo(() => {
  const { description, providers, displayName, identifier } = useDetailContext();
  const appOrigin = useAppOrigin();
  return (
    <Flexbox horizontal align={'center'} gap={8}>
      <ChatWithModel />
      <ShareButton
        meta={{
          avatar: <ModelIcon model={identifier} size={64} type={'avatar'} />,
          desc: description,
          hashtags: providers?.map((item) => item.name) || [],
          title: displayName || identifier,
          url: new URL(urlJoin('/community/model', identifier as string), appOrigin).toString(),
        }}
      />
    </Flexbox>
  );
});

export default ActionButton;
