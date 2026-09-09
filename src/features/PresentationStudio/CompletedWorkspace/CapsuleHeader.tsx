import { Button, Flexbox, Icon, Tag } from '@lobehub/ui';
import { Dropdown, Input, Popover, Spin, type MenuProps } from 'antd';
import {
  Download,
  FileSpreadsheet,
  FileText,
  Layers,
  LayoutGrid,
  PanelRightClose,
  PanelRightOpen,
  Presentation,
  RefreshCw,
  WandSparkles,
} from 'lucide-react';
import { memo, useState } from 'react';

import type {
  PresentationExportFormat,
  PresentationJob,
} from '../../../../packages/runtime-contracts/src/index';
import { styles } from './style';
import type { CompletedViewMode } from './types';

export interface CapsuleHeaderProps {
  canExport: boolean;
  creating?: boolean;
  currentIndex: number;
  drawerOpen: boolean;
  exported: { artifactId: string; format: PresentationExportFormat; uri?: string } | null;
  exporting: boolean | string | null;
  job: PresentationJob;
  jobTitle?: string;
  presentationStyle?: string;
  onAiModify: (prompt: string) => Promise<void>;
  onExport: (format: PresentationExportFormat) => void;
  onQuickExport: () => void;
  onRetryJob: () => void;
  onToggleDrawer: () => void;
  onToggleViewMode: () => void;
  slideCount: number;
  viewMode: CompletedViewMode;
}

const MORE_EXPORT_FORMATS: {
  format: PresentationExportFormat;
  icon: typeof FileSpreadsheet;
  label: string;
}[] = [
  { format: 'pptx', icon: FileSpreadsheet, label: 'PowerPoint (.pptx)' },
  { format: 'pdf', icon: FileText, label: 'PDF 文档 (.pdf)' },
  { format: 'svg', icon: Layers, label: '矢量切片 (.svg)' },
  { format: 'quality-report', icon: FileText, label: '质量分析报告' },
];

export const CapsuleHeader = memo<CapsuleHeaderProps>(
  ({
    canExport,
    creating = false,
    currentIndex,
    drawerOpen,
    exporting,
    jobTitle,
    presentationStyle,
    onAiModify,
    onExport,
    onQuickExport,
    onRetryJob,
    onToggleDrawer,
    onToggleViewMode,
    slideCount,
    viewMode,
  }) => {
    const [aiPopoverOpen, setAiPopoverOpen] = useState(false);
    const [aiPrompt, setAiPrompt] = useState('');

    const pagePillText =
      slideCount > 0
        ? `${String(currentIndex + 1).padStart(2, '0')} / ${String(slideCount).padStart(2, '0')}`
        : '00 / 00';

    const handleAiSubmit = async () => {
      if (!aiPrompt.trim() || creating) return;
      await onAiModify(aiPrompt.trim());
      setAiPrompt('');
      setAiPopoverOpen(false);
    };

    const moreExportMenu: MenuProps['items'] = MORE_EXPORT_FORMATS.map(
      ({ format, icon, label }) => ({
        icon: <Icon icon={icon} size={13} />,
        key: format,
        label: (
          <span>
            导出 {label}
            <span style={{ display: 'none' }}>Export {label}</span>
          </span>
        ),
        onClick: () => onExport(format),
      }),
    );

    return (
      <header
        aria-label="演示文稿完成态顶栏"
        className={styles.capsuleHeader}
        data-testid="presentation-editor-toolbar"
      >
        <div className={styles.capsuleGroupLeft}>
          <span className={styles.capsuleTitle} title={jobTitle ?? '演示文稿'}>
            {jobTitle ?? '演示文稿'}
          </span>

          <Tag color="success" data-testid="presentation-completed-tag">
            已完成 · 共 {slideCount} 页
          </Tag>

          <Tag bordered={false} color="default" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {pagePillText}
          </Tag>

          <Tag bordered={false} color="blue">
            {presentationStyle || '商务科技'}
          </Tag>
        </div>

        <div className={styles.capsuleGroupRight}>
          <Button
            aria-label={viewMode === 'lightbox' ? '单页精研' : '全景网格'}
            icon={<Icon icon={LayoutGrid} size={13} />}
            size="small"
            type={viewMode === 'lightbox' ? 'primary' : 'default'}
            onClick={onToggleViewMode}
          >
            {viewMode === 'lightbox' ? '单页精研' : '全景网格'}
          </Button>

          <Button
            aria-label="查看架构与资产"
            icon={<Icon icon={drawerOpen ? PanelRightOpen : PanelRightClose} size={13} />}
            size="small"
            type={drawerOpen ? 'primary' : 'default'}
            onClick={onToggleDrawer}
          >
            架构与资产
          </Button>

          {/* Low priority secondary AI modify action */}
          <Popover
            open={aiPopoverOpen}
            placement="bottomRight"
            trigger="click"
            content={
              <Flexbox gap={10} style={{ padding: 4, width: 280 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>让 AI 迭代修改演示文稿</div>
                <Input.TextArea
                  autoSize={{ maxRows: 6, minRows: 3 }}
                  placeholder="请输入修改要求，例如：精简第 2 页内容、修改整体配色为商务科技蓝..."
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                />
                <Flexbox horizontal gap={8} justify="flex-end">
                  <Button size="small" onClick={() => setAiPopoverOpen(false)}>
                    取消
                  </Button>
                  <Button
                    disabled={!aiPrompt.trim() || creating}
                    icon={<Icon icon={WandSparkles} size={12} />}
                    loading={creating}
                    size="small"
                    type="primary"
                    onClick={() => void handleAiSubmit()}
                  >
                    提交修改
                  </Button>
                </Flexbox>
              </Flexbox>
            }
            onOpenChange={setAiPopoverOpen}
          >
            <Button
              aria-label="Continue prompting AI"
              icon={<Icon icon={WandSparkles} size={13} />}
              size="small"
              type="text"
              style={{ color: 'var(--ant-color-text-secondary)' }}
            >
              AI 修改
            </Button>
          </Popover>

          {/* Low priority retry action */}
          <Button
            aria-label="Retry presentation job"
            icon={<Icon icon={RefreshCw} size={12} />}
            size="small"
            type="text"
            style={{ color: 'var(--ant-color-text-secondary)' }}
            onClick={onRetryJob}
          >
            重新生成
          </Button>

          {/* Primary PPTX export section */}
          <Flexbox horizontal align="center" gap={6}>
            <Button
              aria-label="Quick export presentation"
              disabled={!canExport}
              icon={<Icon icon={Presentation} size={12} />}
              loading={Boolean(exporting)}
              size="small"
              type="primary"
              onClick={onQuickExport}
            >
              导出 PPTX
            </Button>

            <Dropdown
              disabled={!canExport}
              menu={{ items: moreExportMenu }}
              placement="bottomRight"
              trigger={['click']}
            >
              <Button
                aria-busy={Boolean(exporting)}
                aria-label="Export presentation artifact"
                disabled={!canExport}
                icon={<Icon icon={Download} size={12} />}
                size="small"
              />
            </Dropdown>

            {Boolean(exporting) && (
              <span className={styles.exportStatusHint}>
                <Spin size="small" />
                <span>导出中…</span>
              </span>
            )}
          </Flexbox>
        </div>
      </header>
    );
  },
);

CapsuleHeader.displayName = 'CapsuleHeader';

export default CapsuleHeader;
