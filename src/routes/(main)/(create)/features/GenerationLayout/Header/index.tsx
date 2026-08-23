'use client';

import { Flexbox } from '@lobehub/ui';
import { MessageSquarePlusIcon, SearchIcon } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import NavItem from '@/features/NavPanel/components/NavItem';
import SideBarHeaderLayout from '@/features/NavPanel/SideBarHeaderLayout';
import { useGlobalStore } from '@/store/global';

import type { GenerationLayoutCommonProps } from '../types';

const Header = memo<GenerationLayoutCommonProps>((props) => {
  const { t } = useTranslation('common');
  const { t: tGeneration } = useTranslation(props.namespace);
  const { breadcrumb, headerExtra, useStore } = props;
  const navigate = useNavigate();
  const toggleCommandMenu = useGlobalStore((s) => s.toggleCommandMenu);
  const openNewGenerationTopic = useStore((s: any) => s.openNewGenerationTopic);
  const rootPath = breadcrumb[0]?.href;

  return (
    <>
      <SideBarHeaderLayout breadcrumb={breadcrumb} />
      <Flexbox paddingInline={4}>
        <NavItem
          icon={MessageSquarePlusIcon}
          key={'new-topic'}
          title={tGeneration('topic.createNew')}
          onClick={() => {
            openNewGenerationTopic();
            if (rootPath) navigate(rootPath);
          }}
        />
        <NavItem
          icon={SearchIcon}
          key={'search'}
          title={t('tab.search')}
          onClick={() => toggleCommandMenu(true)}
        />
        {headerExtra}
      </Flexbox>
    </>
  );
});

Header.displayName = 'GenerationLayoutHeader';

export default Header;
