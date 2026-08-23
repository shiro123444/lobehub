'use client';

import { Flexbox, ScrollShadow } from '@lobehub/ui';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';

import { useAppOrigin } from '@/hooks/useAppOrigin';

import ShareButton from '../../../features/ShareButton';
import { useDetailContext } from '../DetailProvider';
import { SkillNavKey } from '../types';
import FileTree from './FileTree';
import InstallationConfig from './InstallationConfig';

const Sidebar = memo<{ activeTab?: SkillNavKey; mobile?: boolean }>(
  ({ mobile, activeTab = SkillNavKey.Overview }) => {
    const { description, tags, name, icon } = useDetailContext();
    const { t } = useTranslation('common');
    const appOrigin = useAppOrigin();
    const { hash, pathname, search } = useLocation();
    const showInstallationConfig = activeTab !== SkillNavKey.Installation;
    const showFileTree = activeTab !== SkillNavKey.Resources;
    const shareUrl = useMemo(
      () => new URL(`${pathname}${search}${hash}`, appOrigin).toString(),
      [appOrigin, hash, pathname, search],
    );

    const shareButton = (
      <ShareButton
        block
        size={'large'}
        meta={{
          avatar: icon,
          desc: description,
          hashtags: tags,
          title: name,
          url: shareUrl,
        }}
      >
        {t('share')}
      </ShareButton>
    );

    if (mobile) {
      if (activeTab !== SkillNavKey.Overview && activeTab !== SkillNavKey.Resources) return null;

      return (
        <Flexbox gap={24} width={'100%'}>
          {showInstallationConfig && <InstallationConfig />}
          {shareButton}
          {showFileTree && <FileTree />}
        </Flexbox>
      );
    }

    return (
      <ScrollShadow
        hideScrollBar
        flex={'none'}
        gap={24}
        size={4}
        width={360}
        style={{
          maxHeight: 'calc(100vh - 114px)',
          paddingBottom: 24,
          position: 'sticky',
          top: 114,
        }}
      >
        {showInstallationConfig && <InstallationConfig />}
        {shareButton}
        {showFileTree && <FileTree />}
      </ScrollShadow>
    );
  },
);

export default Sidebar;
