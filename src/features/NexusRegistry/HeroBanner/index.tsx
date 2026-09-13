'use client';

import { Button } from '@lobehub/ui';
import { Plus } from 'lucide-react';
import { memo, useEffect, useState } from 'react';

import SubmitRepoModal from '../SubmitRepoModal';
import { styles } from './style';

const title = '让灵感，遇见同路人。';
const HeroBanner = memo(() => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [length, setLength] = useState(0);
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (reduced.matches) {
      setLength(title.length);
      return;
    }
    const timer = window.setInterval(
      () =>
        setLength((value) => {
          if (value >= title.length) window.clearInterval(timer);
          return Math.min(title.length, value + 1);
        }),
      130,
    );
    return () => window.clearInterval(timer);
  }, []);
  return (
    <section className={styles.banner}>
      <span className={styles.tag}>jumi · 共创</span>
      <h1 aria-label={title} className={styles.title}>
        <span aria-hidden>
          {title.slice(0, length)}
          <span className={styles.cursor}>▏</span>
        </span>
      </h1>
      <p className={styles.subtitle}>发现好用的智能体与技能，把喜欢的想法，慢慢做出来。</p>
      <Button
        className={styles.publish}
        icon={<Plus size={18} />}
        type="text"
        onClick={() => setIsModalOpen(true)}
      >
        分享创作
      </Button>
      <SubmitRepoModal open={isModalOpen} onClose={() => setIsModalOpen(false)} />
    </section>
  );
});
HeroBanner.displayName = 'HeroBanner';
export default HeroBanner;
