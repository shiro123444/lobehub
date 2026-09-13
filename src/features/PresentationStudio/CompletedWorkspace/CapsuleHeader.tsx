import { Button, Flexbox, Icon } from '@lobehub/ui';
import { Dropdown, Input, type MenuProps, Popover, Tooltip } from 'antd';
import {
  ArrowUp,
  Check,
  ChevronDown,
  Download,
  FileSpreadsheet,
  FileText,
  History,
  Layers,
  LayoutGrid,
  PanelRightOpen,
  PanelsTopLeft,
  Pause,
  Plus,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  PresentationExportFormat,
  PresentationJob,
} from '../../../../packages/runtime-contracts/src/index';
import { styles } from './style';
import TemplateLibraryButton from './TemplateLibraryButton';
import type { CompletedViewMode } from './types';

export interface CapsuleHeaderProps {
  availableFormats?: string[];
  canExport: boolean;
  canQuickExport?: boolean;
  creating?: boolean;
  currentIndex: number;
  drawerOpen: boolean;
  exported: { artifactId: string; format: PresentationExportFormat; uri?: string } | null;
  exporting: boolean | string | null;
  job: PresentationJob;
  jobs?: PresentationJob[];
  jobTitle?: string;
  onAiModify: (prompt: string) => Promise<void>;
  onExport: (format: PresentationExportFormat) => void;
  onJobChanged?: () => Promise<void>;
  onNewPresentation?: () => void;
  onQuickExport: () => void;
  onRetryJob: () => void;
  onSelectJob?: (jobId: string) => void;
  onToggleDrawer: () => void;
  onToggleViewMode: () => void;
  presentationStyle?: string;
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
    availableFormats,
    canExport,
    canQuickExport = canExport,
    creating = false,
    drawerOpen,
    exporting,
    job,
    jobTitle,
    jobs,
    onSelectJob,
    onAiModify,
    onExport,
    onJobChanged,
    onNewPresentation,
    onQuickExport,
    onRetryJob,
    onToggleDrawer,
    onToggleViewMode,
    viewMode,
  }) => {
    const { t } = useTranslation('common');
    const [aiPopoverOpen, setAiPopoverOpen] = useState(false);
    const [aiPrompt, setAiPrompt] = useState('');

    const working = job.state === 'running' || job.state === 'queued';
    const statusText = working ? '正在修改' : job.state === 'completed' ? '已完成' : '已暂停';
    const viewLabel = viewMode === 'lightbox' ? '单页精研' : '全景网格';

    const handleAiSubmit = async () => {
      if (!aiPrompt.trim() || creating) return;
      await onAiModify(aiPrompt.trim());
      setAiPrompt('');
      setAiPopoverOpen(false);
    };

    const moreExportMenu: MenuProps['items'] = MORE_EXPORT_FORMATS.filter(
      ({ format }) => !availableFormats || availableFormats.includes(format),
    ).map(({ format, icon, label }) => ({
      icon: <Icon aria-hidden icon={icon} size={18} />,
      key: format,
      label: (
        <span>
          导出 {label}
          <span style={{ display: 'none' }}>Export {label}</span>
        </span>
      ),
      onClick: () => onExport(format),
    }));

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

          <span
            className={styles.capsuleStatus}
            data-testid="presentation-completed-tag"
            role="status"
          >
            <Icon
              aria-hidden
              icon={working ? RefreshCw : job.state === 'completed' ? Check : Pause}
              size={14}
              spin={working}
            />
            {statusText}
          </span>
        </div>

        <div className={styles.capsuleGroupRight}>
          {onNewPresentation && (
            <Tooltip title={t('presentationTemplates.newPresentation')}>
              <Button
                aria-label={t('presentationTemplates.newPresentation')}
                className={styles.iconButton}
                icon={<Icon aria-hidden icon={Plus} size={22} />}
                type="text"
                onClick={onNewPresentation}
              />
            </Tooltip>
          )}
          <Tooltip title={viewLabel}>
            <Button
              aria-label={viewLabel}
              aria-pressed={viewMode === 'lightbox'}
              className={styles.iconButton}
              type="text"
              icon={
                <Icon
                  aria-hidden
                  icon={viewMode === 'lightbox' ? PanelsTopLeft : LayoutGrid}
                  size={22}
                />
              }
              onClick={onToggleViewMode}
            />
          </Tooltip>

          <Tooltip title="架构与资产">
            <Button
              aria-label="查看架构与资产"
              aria-pressed={drawerOpen}
              className={styles.iconButton}
              icon={<Icon aria-hidden icon={PanelRightOpen} size={22} />}
              type="text"
              onClick={onToggleDrawer}
            />
          </Tooltip>

          {jobs && onSelectJob && (
            <Dropdown
              trigger={['click']}
              menu={{
                selectedKeys: [job.jobId],
                items: jobs.map((item) => ({
                  key: item.jobId,
                  label: item.title ?? '未命名演示文稿',
                })),
                onClick: ({ key }) => onSelectJob(key),
              }}
            >
              <Button
                aria-label={t('presentationTemplates.history')}
                className={styles.iconButton}
                icon={<Icon icon={History} size={22} />}
                type="text"
              />
            </Dropdown>
          )}
          <TemplateLibraryButton
            canLearn={job.state === 'completed'}
            jobId={job.jobId}
            jobTitle={jobTitle}
            onJobChanged={onJobChanged}
          />

          <Popover
            open={aiPopoverOpen}
            placement="bottomRight"
            trigger="click"
            content={
              <Flexbox gap={10} style={{ padding: 4, width: 280 }}>
                <Input.TextArea
                  aria-label="修改要求"
                  autoSize={{ maxRows: 6, minRows: 3 }}
                  placeholder="想改些什么？"
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                />
                <Flexbox horizontal gap={8} justify="flex-end">
                  <Tooltip title="取消">
                    <Button
                      aria-label="取消修改"
                      className={styles.iconButton}
                      icon={<Icon aria-hidden icon={X} size={22} />}
                      type="text"
                      onClick={() => setAiPopoverOpen(false)}
                    />
                  </Tooltip>
                  <Tooltip title="提交修改">
                    <Button
                      aria-label="提交修改"
                      className={styles.iconButton}
                      disabled={!aiPrompt.trim() || creating}
                      icon={<Icon aria-hidden icon={ArrowUp} size={22} />}
                      loading={creating}
                      type="primary"
                      onClick={() => void handleAiSubmit()}
                    />
                  </Tooltip>
                </Flexbox>
              </Flexbox>
            }
            onOpenChange={setAiPopoverOpen}
          >
            <Tooltip title={aiPopoverOpen ? undefined : 'AI 修改'}>
              <Button
                aria-expanded={aiPopoverOpen}
                aria-label="Continue prompting AI"
                className={styles.iconButton}
                icon={<Icon aria-hidden icon={Sparkles} size={24} />}
                type="text"
              />
            </Tooltip>
          </Popover>

          <Tooltip title="重新生成">
            <Button
              aria-label="Retry presentation job"
              className={styles.iconButton}
              icon={<Icon aria-hidden icon={RefreshCw} size={22} />}
              type="text"
              onClick={onRetryJob}
            />
          </Tooltip>

          <Flexbox horizontal align="center" className={styles.exportActions} gap={4}>
            <Tooltip title={exporting ? '导出中…' : '导出 PowerPoint'}>
              <Button
                aria-busy={Boolean(exporting)}
                aria-label="Quick export presentation"
                className={styles.iconButton}
                disabled={!canQuickExport}
                icon={<Icon aria-hidden icon={Download} size={22} />}
                loading={Boolean(exporting)}
                type="primary"
                onClick={onQuickExport}
              />
            </Tooltip>

            <Dropdown
              disabled={!canExport}
              menu={{ items: moreExportMenu }}
              placement="bottomRight"
              trigger={['click']}
            >
              <Tooltip title="其他格式">
                <Button
                  aria-busy={Boolean(exporting)}
                  aria-label="Export presentation artifact"
                  className={styles.iconButton}
                  disabled={!canExport}
                  icon={<Icon aria-hidden icon={ChevronDown} size={20} />}
                  type="text"
                />
              </Tooltip>
            </Dropdown>
          </Flexbox>
        </div>
      </header>
    );
  },
);

CapsuleHeader.displayName = 'CapsuleHeader';

export default CapsuleHeader;
