'use client';

import { memo } from 'react';

import Loading from '@/routes/(main)/community/components/Loading';

const CommunityReviewLoading = memo(() => {
  return <Loading title="审核队列" />;
});

export default CommunityReviewLoading;
