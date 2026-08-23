'use client';

import { memo } from 'react';

import Loading from '@/routes/(main)/community/components/Loading';

const CommunityAnalyticsLoading = memo(() => {
  return <Loading title="社区数据看板" />;
});

export default CommunityAnalyticsLoading;
