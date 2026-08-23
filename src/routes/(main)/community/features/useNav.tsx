import { MCP } from '@lobehub/icons';
import { Icon } from '@lobehub/ui';
import {
  BarChart3,
  Bot,
  Brain,
  BrainCircuit,
  ClipboardList,
  House,
  ShieldCheck,
} from 'lucide-react';
import { type ReactNode } from 'react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';

import { type MenuProps } from '@/components/Menu';
import { DiscoverTab } from '@/types/discover';

const ICON_SIZE = 16;

export const useNav = () => {
  const location = useLocation();
  const { t } = useTranslation('discover');
  const activeKey = useMemo(() => {
    const pathname = location.pathname;
    for (const value of Object.values(DiscoverTab)) {
      if (pathname.includes(`/${DiscoverTab.Plugins}`)) {
        return DiscoverTab.Mcp;
      } else if (pathname.includes(`/${value}`)) {
        return value;
      }
    }
    return DiscoverTab.Home;
  }, [location.pathname]);

  const items: MenuProps['items'] = useMemo(
    () => [
      {
        icon: <Icon icon={House} size={ICON_SIZE} />,
        key: DiscoverTab.Home,
        label: <div style={{ color: 'inherit', display: 'inline' }}>{t('tab.home')}</div>,
      },
      {
        icon: <Icon icon={BarChart3} size={ICON_SIZE} />,
        key: DiscoverTab.Analytics,
        label: <div style={{ color: 'inherit', display: 'inline' }}>{t('tab.analytics')}</div>,
      },
      {
        icon: <Icon icon={ClipboardList} size={ICON_SIZE} />,
        key: DiscoverTab.Submissions,
        label: <div style={{ color: 'inherit', display: 'inline' }}>{t('tab.submissions')}</div>,
      },
      {
        icon: <Icon icon={ShieldCheck} size={ICON_SIZE} />,
        key: DiscoverTab.Review,
        label: <div style={{ color: 'inherit', display: 'inline' }}>{t('tab.review')}</div>,
      },
      {
        icon: <Icon icon={Bot} size={ICON_SIZE} />,
        key: DiscoverTab.Assistants,
        label: <div style={{ color: 'inherit', display: 'inline' }}>{t('tab.assistant')}</div>,
      },
      {
        icon: <MCP className={'anticon'} size={ICON_SIZE} />,
        key: DiscoverTab.Mcp,
        label: (
          <div style={{ color: 'inherit', display: 'inline' }}>{`MCP ${t('tab.plugin')}`}</div>
        ),
      },
      {
        icon: <Icon icon={Brain} size={ICON_SIZE} />,
        key: DiscoverTab.Models,
        label: <div style={{ color: 'inherit', display: 'inline' }}>{t('tab.model')}</div>,
      },
      {
        icon: <Icon icon={BrainCircuit} size={ICON_SIZE} />,
        key: DiscoverTab.Providers,
        label: <div style={{ color: 'inherit', display: 'inline' }}>{t('tab.provider')}</div>,
      },
    ],
    [t],
  );

  const activeItem = items.find((item: any) => item.key === activeKey) as {
    icon: ReactNode;
    key: string;
    label: string;
  };

  return {
    activeItem,
    activeKey,
    items,
  };
};
