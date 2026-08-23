'use client';

import { ImagesIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';

import NavItem from '@/features/NavPanel/components/NavItem';
import GenerationLayout from '@/routes/(main)/(create)/features/GenerationLayout';
import { useImageStore } from '@/store/image';
import { generationTopicSelectors } from '@/store/image/slices/generationTopic/selectors';

import RegisterHotkeys from './RegisterHotkeys';

const ImageLayout = () => {
  const { t } = useTranslation(['common']);
  const { t: tImage } = useTranslation('image');
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <GenerationLayout
      breadcrumb={[{ href: '/image', title: t('tab.image') }]}
      extra={<RegisterHotkeys />}
      generationTopicsSelector={generationTopicSelectors.generationTopics}
      headerExtra={
        <NavItem
          active={location.pathname === '/image/gallery'}
          href="/image/gallery"
          icon={ImagesIcon}
          key="gallery"
          title={tImage('gallery.title')}
          onClick={() => navigate('/image/gallery')}
        />
      }
      namespace="image"
      navKey="image"
      useStore={useImageStore}
      viewModeStatusKey="imageTopicViewMode"
    />
  );
};

export default ImageLayout;
