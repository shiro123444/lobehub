'use client';

import {
  BarChart,
  BarList,
  CategoryBar,
  ChartTooltipFrame,
  ChartTooltipRow,
  DonutChart,
  useThemeColorRange,
} from '@lobehub/charts';
import { ModelIcon, ProviderIcon } from '@lobehub/icons';
import {
  ActionIcon,
  Collapse,
  DatePicker,
  Flexbox,
  FormGroup,
  Grid,
  Icon,
  Modal,
  Segmented,
  Skeleton,
  Tag,
  Text,
} from '@lobehub/ui';
import { type BarChartProps } from '@lobehub/charts';
import { Divider } from 'antd';
import { cssVar, createStaticStyles } from 'antd-style';
import dayjs from 'dayjs';
import {
  BarChart3,
  Bot,
  Brain,
  Coins,
  Globe2,
  ImageIcon,
  KeyRound,
  MousePointer2,
  Route,
  UserRound,
  Users,
  Video,
  Zap,
} from 'lucide-react';
import { memo, useMemo, useState, type ReactNode } from 'react';
import { type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import InlineTable from '@/components/InlineTable';
import StatisticCard from '@/components/StatisticCard';
import { useClientDataSWR } from '@/libs/swr';
import { communityAnalyticsService } from '@/services/communityAnalytics';
import {
  type CommunityUsageDailyRecord,
  type CommunityUsageMetric,
  type CommunityUsageModelBreakdownItem,
  type CommunityUsageOverview,
  type CommunityUsageRankItem,
  type CommunityUsageSource,
} from '@/types/communityAnalytics';
import { formatNumber, formatPrice, formatTokenNumber } from '@/utils/format';

const styles = createStaticStyles(({ css }) => ({
  chartFrame: css`
    min-height: 300px;
  `,
}));

const SOURCES: CommunityUsageSource[] = ['chat', 'agent', 'image', 'video', 'nexus'];

const EMPTY_METRIC: CommunityUsageMetric = {
  inputTokens: 0,
  outputTokens: 0,
  requests: 0,
  spend: 0,
  totalTokens: 0,
};

const sourceIconMap: Record<CommunityUsageSource, LucideIcon> = {
  agent: Bot,
  chat: Brain,
  image: ImageIcon,
  nexus: Globe2,
  video: Video,
};

const sourceLabelKey = (source: CommunityUsageSource) => `analytics.sources.${source}` as const;

const getSourceMetric = (
  sources: Partial<Record<CommunityUsageSource, CommunityUsageMetric>>,
  source: CommunityUsageSource,
) => sources[source] ?? EMPTY_METRIC;

const metricValue = (item: CommunityUsageMetric, metric: ShowMetric) => {
  if (metric === ShowMetric.Spend) return item.spend;
  if (metric === ShowMetric.Token) return item.totalTokens;
  return item.requests;
};

enum ShowMetric {
  Requests = 'requests',
  Spend = 'spend',
  Token = 'token',
}

const useSourceLabels = () => {
  const { t } = useTranslation('discover');
  return useMemo(
    () =>
      Object.fromEntries(SOURCES.map((source) => [source, t(sourceLabelKey(source))])) as Record<
        CommunityUsageSource,
        string
      >,
    [t],
  );
};

const getSourceByLabel = (
  label: string,
  sourceLabels: Record<CommunityUsageSource, string>,
): CommunityUsageSource => SOURCES.find((source) => sourceLabels[source] === label) ?? 'chat';

const formatMetricValue = (value: number, metric: ShowMetric) => {
  if (metric === ShowMetric.Spend) return `$${formatPrice(value, 2)}`;
  if (metric === ShowMetric.Token) return formatTokenNumber(value);
  return formatNumber(value, 0);
};

const createChartSeries = (
  data: CommunityUsageDailyRecord[],
  metric: ShowMetric,
  sourceLabels: Record<CommunityUsageSource, string>,
): { categories: string[]; data: BarChartProps['data'] } => {
  const categories = SOURCES.map((source) => sourceLabels[source]);
  const chartData = data.map((record) => {
    const row: Record<string, number | string> = {
      day: record.day,
      total: metricValue(record, metric),
    };
    for (const source of SOURCES) {
      row[sourceLabels[source]] = metricValue(getSourceMetric(record.sources, source), metric);
    }
    return row;
  });

  return {
    categories,
    data: chartData,
  };
};

const TrendChart = memo<{
  data: CommunityUsageDailyRecord[];
  isLoading?: boolean;
  metric: ShowMetric;
  onMetricChange: (metric: ShowMetric) => void;
}>(({ data, isLoading, metric, onMetricChange }) => {
  const { t } = useTranslation('discover');
  const sourceLabels = useSourceLabels();
  const { categories, data: chartData } = useMemo(
    () => createChartSeries(data, metric, sourceLabels),
    [data, metric, sourceLabels],
  );

  const chart = (
    <BarChart
      categories={categories}
      data={chartData}
      customTooltip={({ active, payload, label }) => {
        if (!active || !payload) return null;
        const sum = payload.reduce(
          (acc: number, cur: any) => (typeof cur.value === 'number' ? acc + cur.value : acc),
          0,
        );

        return (
          <ChartTooltipFrame>
            <Flexbox horizontal justify={'space-between'} paddingBlock={8} paddingInline={16}>
              <Text ellipsis as={'p'} style={{ margin: 0 }}>
                {label}
              </Text>
              {sum !== 0 && <span style={{ fontWeight: 600 }}>{formatMetricValue(sum, metric)}</span>}
            </Flexbox>
            {sum !== 0 && (
              <>
                <Divider style={{ margin: 0 }} />
                <Flexbox
                  gap={4}
                  paddingBlock={8}
                  paddingInline={16}
                  style={{ flexDirection: 'column-reverse', marginTop: 4 }}
                >
                  {payload.map(({ value, color, name }: any, idx: number) =>
                    typeof value === 'number' && value > 0 ? (
                      <ChartTooltipRow
                        color={color}
                        key={`trend-${idx}`}
                        name={name}
                        value={formatMetricValue(value, metric)}
                      />
                    ) : null,
                  )}
                </Flexbox>
              </>
            )}
          </ChartTooltipFrame>
        );
      }}
      index="day"
      stack
      valueFormatter={(value) => formatMetricValue(value, metric)}
    />
  );

  return (
    <FormGroup
      extra={
        <Segmented
          options={[
            { label: t('analytics.metric.requests'), value: ShowMetric.Requests },
            { label: t('analytics.metric.tokens'), value: ShowMetric.Token },
            { label: t('analytics.metric.spend'), value: ShowMetric.Spend },
          ]}
          value={metric}
          onChange={(value) => onMetricChange(value as ShowMetric)}
        />
      }
      title={t('analytics.trend.title')}
      variant={'filled'}
    >
      {isLoading ? <Skeleton.Block className={styles.chartFrame} /> : chart}
    </FormGroup>
  );
});

const OverviewCard = memo<{
  count: number;
  description: string;
  formatter?: (value: number) => string;
  icon: LucideIcon;
  isLoading?: boolean;
  title: string;
}>(({ count, description, formatter, icon, isLoading, title }) => {
  return (
    <StatisticCard
      loading={isLoading}
      statistic={{
        description,
        precision: 0,
        title: (
          <Flexbox horizontal align={'center'} gap={8} style={{ marginBottom: 4 }}>
            <Icon
              icon={icon}
              size={14}
              style={{ color: cssVar.colorTextDescription, opacity: 0.8 }}
            />
            <Text fontSize={13} style={{ color: cssVar.colorTextDescription }}>
              {title}
            </Text>
          </Flexbox>
        ),
        value: formatter ? formatter(count) : formatNumber(count, 0),
      }}
    />
  );
});

const SourceDistribution = memo<{
  data?: CommunityUsageOverview;
  isLoading?: boolean;
}>(({ data, isLoading }) => {
  const { t } = useTranslation('discover');
  const sourceLabels = useSourceLabels();
  const themeColorRange = useThemeColorRange();

  const chartData = useMemo(() => {
    if (!data) return [];
    return data.sourceSummary
      .map((item) => ({
        name: sourceLabels[item.source ?? 'chat'],
        value: item.requests,
      }))
      .filter((item) => item.value > 0);
  }, [data, sourceLabels]);

  return (
    <FormGroup title={t('analytics.source.title')} variant={'filled'}>
      {isLoading ? (
        <Skeleton.Block className={styles.chartFrame} />
      ) : (
        <Flexbox align={'center'} gap={16} horizontal justify={'space-around'} width={'100%'}>
          <DonutChart
            category="value"
            colors={themeColorRange}
            data={chartData}
            index="name"
            style={{ height: 200, width: 200 }}
            variant="pie"
          />
          <BarList
            data={chartData.map((item, index) => ({
              ...item,
              color: themeColorRange[index % themeColorRange.length],
              icon: (
                <Icon icon={sourceIconMap[getSourceByLabel(item.name, sourceLabels)]} size={16} />
              ),
            }))}
            style={{ flex: 1, maxWidth: 300 }}
          />
        </Flexbox>
      )}
    </FormGroup>
  );
});

const ModelUsageChart = memo<{
  data: CommunityUsageRankItem[];
  isLoading?: boolean;
  metric: ShowMetric;
}>(({ data, isLoading, metric }) => {
  const { t } = useTranslation('discover');

  const chartData = useMemo(() => {
    return data.slice(0, 10).map((item) => ({
      name: item.label,
      value: metricValue(item, metric),
    }));
  }, [data, metric]);

  return (
    <FormGroup title={t('analytics.rank.model')} variant={'filled'}>
      {isLoading ? (
        <Skeleton.Block className={styles.chartFrame} />
      ) : (
          <BarChart
            categories={['value']}
            data={chartData}
            index="name"
            layout="vertical"
          showLegend={false}
          valueFormatter={(value) => formatMetricValue(value, metric)}
        />
      )}
    </FormGroup>
  );
});

const RankingCard = memo<{
  data?: CommunityUsageRankItem[];
  icon: (item: CommunityUsageRankItem) => ReactNode;
  isLoading?: boolean;
  metric: ShowMetric;
  title: string;
  noDataTitle: string;
  noDataDesc: string;
}>(({ data, icon, isLoading, metric, title, noDataTitle, noDataDesc }) => {
  const { t } = useTranslation('discover');
  const [open, setOpen] = useState(false);

  const hasMore = Boolean(data && data.length > 5);
  const rows = (data || []).slice(0, 5).map((item) => ({
    icon: icon(item),
    id: item.id,
    name: item.label,
    value: metricValue(item, metric),
  }));
  const modalRows = (data || []).map((item) => ({
    icon: icon(item),
    id: item.id,
    name: item.label,
    value: metricValue(item, metric),
  }));

  return (
    <>
      <FormGroup
        extra={
          hasMore ? <ActionIcon icon={BarChart3} size={'small'} onClick={() => setOpen(true)} /> : null
        }
        title={title}
        variant={'filled'}
      >
        {isLoading ? (
          <Skeleton.Block className={styles.chartFrame} />
        ) : (
          <BarList
            data={rows}
            height={220}
            leftLabel={t('analytics.rank.left')}
            noDataText={{
              desc: noDataDesc,
              title: noDataTitle,
            }}
            rightLabel={t('analytics.rank.right')}
          />
        )}
      </FormGroup>
      {hasMore && (
        <Modal
          footer={null}
          loading={isLoading || !data}
          open={open}
          title={title}
          onCancel={() => setOpen(false)}
        >
          <BarList
            data={modalRows}
            height={340}
            leftLabel={t('analytics.rank.left')}
            noDataText={{
              desc: noDataDesc,
              title: noDataTitle,
            }}
            rightLabel={t('analytics.rank.right')}
          />
        </Modal>
      )}
    </>
  );
});

const ModelBreakdown = memo<{
  data?: CommunityUsageModelBreakdownItem[];
  isLoading?: boolean;
}>(({ data, isLoading }) => {
  const { t } = useTranslation('discover');

  const themeColorRange = useThemeColorRange();

  const items = useMemo(() => {
    if (!data) return [];

    return data.slice(0, 10).map((item) => {
      const sourceRows = SOURCES.map((source) => ({
        requests: getSourceMetric(item.sources, source).requests,
        spend: getSourceMetric(item.sources, source).spend,
        source,
        tokens: getSourceMetric(item.sources, source).totalTokens,
      })).filter((row) => row.requests > 0 || row.tokens > 0 || row.spend > 0);
      const totalRequests = sourceRows.reduce((acc, row) => acc + row.requests, 0);

      return {
        children: (
          <Flexbox gap={12}>
            <CategoryBar
              colors={themeColorRange}
              showLabels={false}
              size={2}
              values={sourceRows.map((row) => (totalRequests > 0 ? row.requests / totalRequests : 0))}
            />
            <div>
              <div style={{ marginBottom: 12 }}>
                <Flexbox horizontal wrap={'wrap'} gap={12}>
                  {SOURCES.map((source) => {
                    const metric = getSourceMetric(item.sources, source);
                    if (metric.requests === 0 && metric.totalTokens === 0 && metric.spend === 0) {
                      return null;
                    }
                    return (
                      <Tag key={source} variant={'filled'}>
                        {t(sourceLabelKey(source))}: {formatNumber(metric.requests, 0)}
                      </Tag>
                    );
                  })}
                </Flexbox>
              </div>
              <InlineTable
                dataSource={sourceRows}
                hoverToActive={false}
                rowKey={(record) => record.source}
                columns={[
                  {
                    dataIndex: 'source',
                    key: 'source',
                    render: (value: CommunityUsageSource) => {
                      const source = value ?? 'chat';
                      const SourceIcon = sourceIconMap[source];
                      return (
                        <Flexbox horizontal align={'center'} gap={8}>
                          <Icon icon={SourceIcon} size={16} />
                          {t(sourceLabelKey(source))}
                        </Flexbox>
                      );
                    },
                    title: t('analytics.rank.left'),
                    width: 180,
                  },
                  {
                    dataIndex: 'requests',
                    key: 'requests',
                    render: (value) => formatNumber(value, 0),
                    title: t('analytics.model.table.requests'),
                    width: 100,
                  },
                  {
                    dataIndex: 'tokens',
                    key: 'tokens',
                    render: (value) => formatTokenNumber(value),
                    title: t('analytics.model.table.tokens'),
                    width: 110,
                  },
                  {
                    dataIndex: 'spend',
                    key: 'spend',
                    render: (value) => `$${formatPrice(value, 2)}`,
                    title: t('analytics.model.table.spend'),
                    width: 120,
                  },
                ]}
              />
            </div>
          </Flexbox>
        ),
        extra: <Tag>{formatTokenNumber(item.totalTokens)}</Tag>,
        key: item.id,
        label: (
          <Flexbox horizontal align={'center'} gap={8}>
            <ModelIcon model={item.id} size={24} />
            <Flexbox>
              <Text weight={500}>{item.label}</Text>
              <Text fontSize={12} style={{ color: cssVar.colorTextSecondary }}>
                ${formatPrice(item.spend, 2)} · {formatNumber(item.requests, 0)} {t('analytics.model.requests')}
              </Text>
            </Flexbox>
          </Flexbox>
        ),
      };
    });
  }, [data, t, themeColorRange]);

  if (isLoading) {
    return (
      <FormGroup title={t('analytics.modelBreakdown.title')} variant={'filled'}>
        <Skeleton.Block className={styles.chartFrame} />
      </FormGroup>
    );
  }

  return (
    <FormGroup title={t('analytics.modelBreakdown.title')} variant={'filled'}>
      <Collapse
        defaultActiveKey={items.slice(0, 3).map((item) => item.key)}
        expandIconPlacement={'end'}
        gap={16}
        items={items}
        padding={{
          body: 0,
        }}
      />
    </FormGroup>
  );
});

const CommunityAnalytics = memo(() => {
  const { t } = useTranslation('discover');
  const [month, setMonth] = useState(dayjs().startOf('month'));
  const [metric, setMetric] = useState<ShowMetric>(ShowMetric.Token);
  const monthKey = month.format('YYYY-MM');

  const { data, isLoading } = useClientDataSWR(['community-analytics', monthKey], async () =>
    communityAnalyticsService.getOverview(monthKey),
  );

  const summaryTags = useMemo(() => {
    if (!data) return [];
    return [
      { label: t('analytics.meta.models'), value: data.totals.activeModels },
      { label: t('analytics.meta.providers'), value: data.totals.activeProviders },
      { label: t('analytics.meta.paths'), value: data.totals.activePaths },
      { label: t('analytics.meta.sources'), value: data.totals.activeSources },
    ];
  }, [data, t]);

  const modelRanking = data?.modelRanking ?? [];
  const providerRanking = data?.providerRanking ?? [];
  const apiKeyRanking = data?.apiKeyRanking ?? [];
  const pathRanking = data?.pathRanking ?? [];
  const subjectRanking = data?.subjectRanking ?? [];
  const userRanking = data?.userRanking ?? [];
  const nexusSourceLabel = data
    ? {
        file: t('analytics.nexus.file'),
        missing: t('analytics.nexus.missing'),
        remote: t('analytics.nexus.remote'),
      }[data.nexusSource]
    : '...';

  return (
    <Flexbox gap={16} width={'100%'}>
      <FormGroup
        extra={
          <Flexbox horizontal align={'center'} gap={8}>
            <DatePicker
              picker="month"
              value={month}
              onChange={(date) => {
                const nextDate = Array.isArray(date) ? date[0] : date;
                if (nextDate) setMonth(nextDate);
              }}
            />
            <Tag variant={'filled'}>{nexusSourceLabel}</Tag>
          </Flexbox>
        }
        title={t('analytics.title')}
        variant={'filled'}
      >
        <Grid gap={16} rows={4}>
          <OverviewCard
            count={data?.totals.requests ?? 0}
            description={t('analytics.overview.requests')}
            icon={MousePointer2}
            isLoading={isLoading}
            title={t('analytics.overview.requests')}
          />
          <OverviewCard
            count={data?.totals.totalTokens ?? 0}
            description={t('analytics.overview.tokens')}
            icon={Zap}
            isLoading={isLoading}
            title={t('analytics.overview.tokens')}
          />
          <OverviewCard
            count={data?.totals.spend ?? 0}
            description={t('analytics.overview.spend')}
            formatter={(value) => `$${formatPrice(value, 2)}`}
            icon={Coins}
            isLoading={isLoading}
            title={t('analytics.overview.spend')}
          />
          <OverviewCard
            count={data?.totals.activeSubjects ?? 0}
            description={t('analytics.overview.subjects')}
            icon={Users}
            isLoading={isLoading}
            title={t('analytics.overview.subjects')}
          />
        </Grid>

        <Divider dashed />

        <Flexbox horizontal wrap={'wrap'} gap={8}>
          {summaryTags.map((item) => (
            <Tag key={item.label} variant={'filled'}>
              {item.label}: {formatNumber(item.value, 0)}
            </Tag>
          ))}
        </Flexbox>
      </FormGroup>

      <TrendChart
        data={data?.daily ?? []}
        isLoading={isLoading}
        metric={metric}
        onMetricChange={setMetric}
      />

      <Grid gap={16} rows={2}>
        <SourceDistribution data={data} isLoading={isLoading} />
        <ModelUsageChart data={modelRanking} isLoading={isLoading} metric={metric} />
      </Grid>

      <Grid gap={16} rows={2}>
        <RankingCard
          data={subjectRanking}
          icon={(item) => <Icon icon={item.subjectType === 'user' ? UserRound : KeyRound} size={20} />}
          isLoading={isLoading}
          metric={ShowMetric.Spend}
          noDataDesc={t('analytics.empty.desc')}
          noDataTitle={t('analytics.empty.title')}
          title={t('analytics.rank.subject')}
        />
        <RankingCard
          data={userRanking}
          icon={() => <Icon icon={UserRound} size={20} />}
          isLoading={isLoading}
          metric={ShowMetric.Token}
          noDataDesc={t('analytics.empty.desc')}
          noDataTitle={t('analytics.empty.title')}
          title={t('analytics.rank.user')}
        />
        <RankingCard
          data={providerRanking}
          icon={(item) => <ProviderIcon provider={item.id} size={20} />}
          isLoading={isLoading}
          metric={ShowMetric.Spend}
          noDataDesc={t('analytics.empty.desc')}
          noDataTitle={t('analytics.empty.title')}
          title={t('analytics.rank.provider')}
        />
        <RankingCard
          data={apiKeyRanking}
          icon={() => <Icon icon={KeyRound} size={20} />}
          isLoading={isLoading}
          metric={ShowMetric.Spend}
          noDataDesc={t('analytics.empty.desc')}
          noDataTitle={t('analytics.empty.title')}
          title={t('analytics.rank.nexusKey')}
        />
        <RankingCard
          data={pathRanking}
          icon={() => <Icon icon={Route} size={20} />}
          isLoading={isLoading}
          metric={ShowMetric.Requests}
          noDataDesc={t('analytics.empty.desc')}
          noDataTitle={t('analytics.empty.title')}
          title={t('analytics.rank.path')}
        />
      </Grid>

      <ModelBreakdown data={data?.modelBreakdown ?? []} isLoading={isLoading} />
    </Flexbox>
  );
});

export default CommunityAnalytics;
