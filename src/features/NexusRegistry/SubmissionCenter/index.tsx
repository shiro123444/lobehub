'use client';

import { ActionIcon, Block, Button, Flexbox, Icon, Tag, Text } from '@lobehub/ui';
import { App, Checkbox, Empty, Modal, Table, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { createStaticStyles } from 'antd-style';
import dayjs from 'dayjs';
import { Check, ExternalLink, RefreshCw, ShieldCheck, Sparkles, X } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useClientDataSWR } from '@/libs/swr';
import { nexusRegistryService } from '@/services/nexusRegistry';
import type { NexusRegistryItem } from '@lobechat/database/schemas';
import type { NexusRegistryKind, NexusRegistryStatus } from '@/types/nexusRegistry';

const styles = createStaticStyles(({ css, cssVar }) => ({
  page: css`
    overflow: auto;
    height: 100%;
    padding: 24px;
  `,
  source: css`
    max-width: 280px;
    color: ${cssVar.colorTextSecondary};
  `,
}));

interface SubmissionCenterProps {
  mode: 'mine' | 'review';
}

const statusColor: Record<NexusRegistryStatus, string> = {
  active: 'success',
  archived: 'default',
  hidden: 'default',
  pending: 'warning',
  rejected: 'error',
};

const kindLabel: Record<NexusRegistryKind, string> = {
  agent: 'Agent',
  blog: 'Blog',
  group_agent: 'Group',
  mcp: 'MCP',
  plugin: 'Plugin',
  skill: 'Skill',
};

const statusLabelKey: Record<NexusRegistryStatus, string> = {
  active: 'registry.status.active',
  archived: 'registry.status.archived',
  hidden: 'registry.status.hidden',
  pending: 'registry.status.pending',
  rejected: 'registry.status.rejected',
};

const getSourceUrl = (item: NexusRegistryItem) => item.repositoryUrl || item.homepageUrl;

const ApproveConfirmContent = ({ item, t }: { item: any; t: any }) => {
  const reviewFlags: string[] = item.metadata?.organizer?.reviewFlags ?? [];
  const latestScan = item.latestScan;
  const isHighRisk = reviewFlags.includes('possible-secret') || (latestScan && latestScan.verdict === 'block');
  const hasRisks = reviewFlags.length > 0 || (latestScan && latestScan.verdict !== 'pass');

  if (!hasRisks) {
    return <Text>{t('registry.review.confirmDesc', { name: item.name })}</Text>;
  }

  return (
    <Flexbox gap={12} style={{ marginTop: 12 }}>
      <Text>{t('registry.review.confirmDesc', { name: item.name })}</Text>
      
      <Block
        variant="outlined"
        style={{
          borderColor: isHighRisk ? 'var(--ant-color-error-border)' : 'var(--ant-color-warning-border)',
          background: isHighRisk ? 'var(--ant-color-error-bg)' : 'var(--ant-color-warning-bg)',
          padding: 12,
          borderRadius: 8,
        }}
      >
        <Flexbox gap={8}>
          <Text strong style={{ color: isHighRisk ? 'var(--ant-color-error)' : 'var(--ant-color-warning)' }}>
            ⚠️ 警告：检测到安全隐患 (Security Warnings)
          </Text>
          
          {reviewFlags.length > 0 && (
            <Flexbox gap={4}>
              <Text type="secondary" fontSize={12}>静态标记 (Static Flags):</Text>
              <Flexbox horizontal gap={4} wrap="wrap">
                {reviewFlags.map(flag => (
                  <Tag key={flag} color={flag === 'possible-secret' ? 'error' : 'warning'}>
                    {flag}
                  </Tag>
                ))}
              </Flexbox>
            </Flexbox>
          )}

          {latestScan && latestScan.risks && latestScan.risks.length > 0 && (
            <Flexbox gap={4} style={{ marginTop: 4 }}>
              <Text type="secondary" fontSize={12}>AI 安全审查风险点 (Risks):</Text>
              {latestScan.risks.map((risk: any, i: number) => (
                <Text key={i} fontSize={12} style={{ color: risk.severity === 'critical' ? 'var(--ant-color-error)' : 'var(--ant-color-warning)' }}>
                  • [{risk.type.toUpperCase()}] {risk.detail}
                </Text>
              ))}
            </Flexbox>
          )}
        </Flexbox>
      </Block>
      
      {isHighRisk && (
        <Text type="danger" strong fontSize={12}>
          注意：此项目包含高危隐患（如可能泄露密钥或严重安全漏洞），请仔细核实！
        </Text>
      )}
    </Flexbox>
  );
};

const SubmissionCenter = memo<SubmissionCenterProps>(({ mode }) => {
  const { t } = useTranslation('discover');
  const { message, modal } = App.useApp();
  const [backfilling, setBackfilling] = useState(false);
  const [updatingId, setUpdatingId] = useState<string>();
  
  const [approveItem, setApproveItem] = useState<NexusRegistryItem | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  const isReview = mode === 'review';
  const swrKey = isReview ? ['nexusRegistry.reviewQueue'] : ['nexusRegistry.mine'];
  const { data, isLoading, mutate } = useClientDataSWR(swrKey, () =>
    isReview
      ? nexusRegistryService.listReviewQueue({ pageSize: 50 })
      : nexusRegistryService.listMine({ pageSize: 50 }),
  );

  const handleStatus = useCallback(
    async (item: NexusRegistryItem, status: 'active' | 'rejected') => {
      if (status === 'active') {
        setApproveItem(item);
        setAcknowledged(false);
        return;
      }

      const actionLabel = t('registry.review.reject');

      modal.confirm({
        centered: true,
        content: t('registry.review.confirmDesc', { name: item.name }),
        okText: actionLabel,
        title: t('registry.review.confirmTitle'),
        onOk: async () => {
          setUpdatingId(item.id);
          try {
            await nexusRegistryService.updateStatus({
              id: item.id,
              metadata: {
                reviewedAt: new Date().toISOString(),
                reviewAction: status,
              },
              status,
            });
            message.success(t('registry.review.updated'));
            await mutate();
          } finally {
            setUpdatingId(undefined);
          }
        },
      });
    },
    [message, modal, mutate, t],
  );

  const handleApproveOk = useCallback(async () => {
    if (!approveItem) return;
    setUpdatingId(approveItem.id);
    const id = approveItem.id;
    setApproveItem(null);
    try {
      await nexusRegistryService.updateStatus({
        id,
        metadata: {
          reviewedAt: new Date().toISOString(),
          reviewAction: 'active',
        },
        status: 'active',
      });
      message.success(t('registry.review.updated'));
      await mutate();
    } finally {
      setUpdatingId(undefined);
    }
  }, [approveItem, message, mutate, t]);

  const handleBackfillSkills = useCallback(() => {
    modal.confirm({
      centered: true,
      content: t('registry.review.backfillConfirmDesc'),
      okText: t('registry.review.backfill'),
      title: t('registry.review.backfillConfirmTitle'),
      onOk: async () => {
        setBackfilling(true);
        try {
          const result = await nexusRegistryService.backfillSkills({ limit: 50 });
          if (result.failedCount > 0) {
            message.warning(
              t('registry.review.backfillPartial', {
                failed: result.failedCount,
                updated: result.updatedCount,
              }),
            );
          } else {
            message.success(
              t('registry.review.backfillDone', {
                processed: result.processedCount,
                updated: result.updatedCount,
              }),
            );
          }
          await mutate();
        } finally {
          setBackfilling(false);
        }
      },
    });
  }, [message, modal, mutate, t]);

  const columns: ColumnsType<NexusRegistryItem> = useMemo(
    () => [
      {
        render: (_, item) => (
          <Flexbox gap={4}>
            <Flexbox horizontal align="center" gap={8}>
              <Text strong>{item.name}</Text>
              <Tag>{kindLabel[item.kind]}</Tag>
            </Flexbox>
            {item.description ? (
              <Text className={styles.source} ellipsis type="secondary">
                {item.description}
              </Text>
            ) : null}
          </Flexbox>
        ),
        title: t('registry.table.item'),
      },
      {
        dataIndex: 'status',
        render: (status: NexusRegistryStatus) => (
          <Tag color={statusColor[status]}>{t(statusLabelKey[status] as any)}</Tag>
        ),
        title: t('registry.table.status'),
        width: 120,
      },
      {
        render: (_, item) => {
          const url = getSourceUrl(item);
          if (!url) return <Text type="secondary">-</Text>;

          return (
            <Flexbox horizontal align="center" gap={4}>
              <Text className={styles.source} ellipsis type="secondary">
                {url}
              </Text>
              <Tooltip title={t('registry.table.openSource')}>
                <ActionIcon
                  icon={ExternalLink}
                  size="small"
                  onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
                />
              </Tooltip>
            </Flexbox>
          );
        },
        title: t('registry.table.source'),
      },
      {
        render: (_, item: any) => {
          const reviewFlags: string[] = item.metadata?.organizer?.reviewFlags ?? [];
          const latestScan = item.latestScan;
          const hasFlags = reviewFlags.length > 0;
          const hasScan = !!latestScan;

          if (!hasFlags && !hasScan) return <Text type="secondary">-</Text>;

          return (
            <Flexbox gap={4} wrap="wrap" horizontal align="center">
              {reviewFlags.map((flag) => {
                const color = flag === 'possible-secret' ? 'error' : 'warning';
                return (
                  <Tag key={flag} color={color} style={{ margin: 0 }}>
                    {flag}
                  </Tag>
                );
              })}
              {latestScan ? (
                <Tooltip
                  title={
                    <Flexbox gap={4}>
                      <Text strong style={{ color: '#fff' }}>
                        Verdict: {latestScan.verdict.toUpperCase()} (Score: {latestScan.riskScore}/100)
                      </Text>
                      {latestScan.risks?.map((risk: any, i: number) => (
                        <Text key={i} fontSize={12} style={{ color: '#eee' }}>
                          • [{risk.severity.toUpperCase()}] {risk.detail}
                        </Text>
                      ))}
                    </Flexbox>
                  }
                >
                  <Tag
                    color={
                      latestScan.verdict === 'block'
                        ? 'error'
                        : latestScan.verdict === 'review'
                          ? 'warning'
                          : 'success'
                    }
                    style={{ cursor: 'pointer', margin: 0 }}
                  >
                    Risk: {latestScan.riskScore}
                  </Tag>
                </Tooltip>
              ) : null}
            </Flexbox>
          );
        },
        title: '安全审计 (Safety)',
        width: 220,
      },
      {
        render: (_, item) => dayjs(item.createdAt).format('YYYY-MM-DD HH:mm'),
        title: t('registry.table.createdAt'),
        width: 160,
      },
      ...(isReview
        ? [
            {
              render: (_: unknown, item: NexusRegistryItem) => (
                <Flexbox horizontal gap={8}>
                  <Button
                    icon={Check}
                    loading={updatingId === item.id}
                    size="small"
                    type="primary"
                    onClick={() => handleStatus(item, 'active')}
                  >
                    {t('registry.review.approve')}
                  </Button>
                  <Button
                    icon={X}
                    loading={updatingId === item.id}
                    size="small"
                    onClick={() => handleStatus(item, 'rejected')}
                  >
                    {t('registry.review.reject')}
                  </Button>
                </Flexbox>
              ),
              title: t('registry.table.actions'),
              width: 190,
            },
          ]
        : []),
    ],
    [handleStatus, isReview, t, updatingId],
  );

  const items = data?.items ?? [];

  const isApproveItemHighRisk = useMemo(() => {
    if (!approveItem) return false;
    const reviewFlags: string[] = (approveItem.metadata as any)?.organizer?.reviewFlags ?? [];
    const latestScan = (approveItem as any).latestScan;
    return reviewFlags.includes('possible-secret') || (latestScan && latestScan.verdict === 'block');
  }, [approveItem]);

  return (
    <Flexbox className={styles.page} gap={16}>
      <Flexbox horizontal align="center" justify="space-between">
        <Flexbox gap={4}>
          <Flexbox horizontal align="center" gap={8}>
            {isReview ? <Icon icon={ShieldCheck} /> : null}
            <Text strong fontSize={24}>
              {isReview ? t('registry.review.title') : t('registry.mine.title')}
            </Text>
          </Flexbox>
          <Text type="secondary">
            {isReview ? t('registry.review.desc') : t('registry.mine.desc')}
          </Text>
        </Flexbox>
        <Flexbox horizontal gap={8}>
          {isReview ? (
            <Button icon={Sparkles} loading={backfilling} onClick={handleBackfillSkills}>
              {t('registry.review.backfill')}
            </Button>
          ) : null}
          <Button icon={RefreshCw} loading={isLoading} onClick={() => mutate()}>
            {t('registry.refresh')}
          </Button>
        </Flexbox>
      </Flexbox>

      <Block padding={0} variant="outlined">
        <Table
          columns={columns}
          dataSource={items}
          loading={isLoading}
          locale={{
            emptyText: (
              <Empty
                description={isReview ? t('registry.review.empty') : t('registry.mine.empty')}
                image={Empty.PRESENTED_IMAGE_SIMPLE}
              />
            ),
          }}
          pagination={false}
          rowKey="id"
        />
      </Block>

      <Modal
        centered
        open={!!approveItem}
        title={t('registry.review.confirmTitle')}
        okText={t('registry.review.approve')}
        cancelText={t('cancel', { defaultValue: '取消' })}
        okButtonProps={{
          danger: isApproveItemHighRisk,
          disabled: isApproveItemHighRisk && !acknowledged,
        }}
        onOk={handleApproveOk}
        onCancel={() => setApproveItem(null)}
      >
        {approveItem && (
          <Flexbox gap={12} style={{ paddingBlock: 8 }}>
            <ApproveConfirmContent item={approveItem} t={t} />
            
            {isApproveItemHighRisk && (
              <Checkbox
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                style={{ marginTop: 8 }}
              >
                <Text type="danger" strong>我已知晓潜在高危安全隐患，确认强行批准上线。</Text>
              </Checkbox>
            )}
          </Flexbox>
        )}
      </Modal>
    </Flexbox>
  );
});

SubmissionCenter.displayName = 'SubmissionCenter';

export default SubmissionCenter;
