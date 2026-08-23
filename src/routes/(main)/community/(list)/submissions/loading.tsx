'use client';

import { memo } from 'react';

import Loading from '@/routes/(main)/community/components/Loading';

const CommunitySubmissionsLoading = memo(() => {
  return <Loading title="我的提交" />;
});

export default CommunitySubmissionsLoading;
