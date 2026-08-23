'use client';

import type { ReactNode } from 'react';

export interface GenerationLayoutCommonProps {
  breadcrumb: { href: string; title: string }[];
  generationTopicsSelector: (s: any) => any;
  headerExtra?: ReactNode;
  namespace: 'image' | 'video';
  navKey: string;
  useStore: (selector: (s: any) => any) => any;
  viewModeStatusKey: 'imageTopicViewMode' | 'videoTopicViewMode';
}
