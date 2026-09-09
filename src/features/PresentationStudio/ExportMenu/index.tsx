import { Button, Icon } from '@lobehub/ui';
import { Dropdown, type MenuProps, Tooltip } from 'antd';
import { Download, FileSpreadsheet, FileText, Layers } from 'lucide-react';
import { memo } from 'react';

import type { PresentationExportFormat } from '../../../../packages/runtime-contracts/src/index';

export interface ExportMenuProps {
  disabled?: boolean;
  disabledReason?: string;
  loading?: boolean;
  onExport: (format: PresentationExportFormat) => void;
}

const EXPORT_ITEMS: {
  format: PresentationExportFormat;
  icon: typeof FileSpreadsheet;
  label: string;
  zhLabel: string;
}[] = [
  {
    format: 'pptx',
    icon: FileSpreadsheet,
    label: 'Export PowerPoint (.pptx)',
    zhLabel: '导出 PowerPoint (.pptx)',
  },
  {
    format: 'pdf',
    icon: FileText,
    label: 'Export Document (.pdf)',
    zhLabel: '导出 PDF 文档 (.pdf)',
  },
  {
    format: 'svg',
    icon: Layers,
    label: 'Export Vector Slides (.svg)',
    zhLabel: '导出矢量幻灯片 (.svg)',
  },
  {
    format: 'quality-report',
    icon: FileText,
    label: 'Export Quality Report',
    zhLabel: '导出质量分析报告',
  },
];

export const ExportMenu = memo<ExportMenuProps>(
  ({ disabled = false, disabledReason, loading = false, onExport }) => {
    const menuItems: MenuProps['items'] = EXPORT_ITEMS.map(({ format, icon, label, zhLabel }) => ({
      icon: <Icon icon={icon} size={13} />,
      key: format,
      label: (
        <span>
          {zhLabel}
          <span style={{ display: 'none' }}>{label}</span>
        </span>
      ),
      onClick: () => onExport(format),
    }));

    const trigger = (
      <Button
        aria-busy={loading}
        aria-label="Export presentation artifact"
        disabled={disabled}
        icon={<Icon icon={Download} size={13} />}
        loading={loading}
        size="small"
        type="primary"
      >
        导出文件
      </Button>
    );

    if (!disabled) {
      return (
        <Dropdown menu={{ items: menuItems }} placement="bottomRight" trigger={['click']}>
          {trigger}
        </Dropdown>
      );
    }

    return <Tooltip title={disabledReason ?? '当前暂不可导出'}>{trigger}</Tooltip>;
  },
);

ExportMenu.displayName = 'ExportMenu';

export default ExportMenu;
