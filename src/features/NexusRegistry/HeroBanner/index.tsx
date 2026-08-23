'use client';

import { Button, Flexbox, Icon } from '@lobehub/ui';
import { cx } from 'antd-style';
import { BookOpen, Plus, Sparkles } from 'lucide-react';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useIsDark } from '@/hooks/useIsDark';
import SubmitRepoModal from '../SubmitRepoModal';
import { styles } from './style';

const HeroBanner = memo(() => {
  const { t } = useTranslation('discover');
  const isDark = useIsDark();
  const [isModalOpen, setIsModalOpen] = useState(false);

  return (
    <Flexbox
      className={cx(styles.banner, isDark ? styles.bannerDark : styles.bannerLight)}
      width={'100%'}
    >
      {/* Dynamic flowing neon background blobs */}
      <div className={styles.orbsContainer}>
        <div className={cx(styles.orb1, isDark ? styles.orb1Dark : styles.orb1Light)} />
        <div className={cx(styles.orb2, isDark ? styles.orb2Dark : styles.orb2Light)} />
      </div>

      <div className={styles.content}>
        <div className={cx(styles.tag, isDark ? styles.tagDark : styles.tagLight)}>
          <Flexbox horizontal align={'center'} gap={6}>
            <Icon icon={Sparkles} size={12} />
            <span>{t('home.hero.tag', 'NEXUS CREATIVE HUB')}</span>
          </Flexbox>
        </div>

        <h1 className={cx(styles.title, isDark ? styles.titleDark : styles.titleLight)}>
          {t('home.hero.title', 'Explore the New Frontiers of AI')}
        </h1>

        <p className={cx(styles.subtitle, isDark ? styles.subtitleDark : styles.subtitleLight)}>
          {t(
            'home.hero.subtitle',
            'A unified community repository for cutting-edge AI agents, models, custom skills, and MCP servers. Collaborate with global creators to build the future of intelligence.',
          )}
        </p>

        <div className={styles.actionWrapper}>
          <Button
            icon={<Plus size={16} />}
            type={'primary'}
            onClick={() => setIsModalOpen(true)}
          >
            {t('home.hero.actions.publish', 'Publish Project')}
          </Button>
          <a 
            href={'https://github.com/shiro123444/New-Nexus'} 
            rel={'noopener noreferrer'} 
            target={'_blank'}
          >
            <Button icon={<BookOpen size={16} />} variant={'text'}>
              {t('home.hero.actions.docs', 'Documentation')}
            </Button>
          </a>
        </div>
      </div>

      {/* Unified Submission Modal */}
      <SubmitRepoModal open={isModalOpen} onClose={() => setIsModalOpen(false)} />
    </Flexbox>
  );
});

HeroBanner.displayName = 'HeroBanner';

export default HeroBanner;
