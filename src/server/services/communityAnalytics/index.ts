import dayjs from 'dayjs';
import debug from 'debug';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { constants as fsConstants } from 'node:fs';
import { readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';

import { AsyncTaskStatus } from '@lobechat/types';

import {
  agentOperations,
  asyncTasks,
  generationBatches,
  generationTopics,
  generations,
  messages,
  users,
} from '@/database/schemas';
import { type LobeChatDatabase } from '@/database/type';
import { genRangeWhere, genWhere } from '@/database/utils/genWhere';
import { type MessageMetadata } from '@/types/message';
import {
  type CommunityUsageDailyRecord,
  type CommunityUsageMetric,
  type CommunityUsageModelBreakdownItem,
  type CommunityUsageOverview,
  type CommunityUsageRankItem,
  type CommunityUsageSource,
} from '@/types/communityAnalytics';
import { formatDate } from '@/utils/format';

const log = debug('lobe-community:analytics');

const SOURCES: CommunityUsageSource[] = ['chat', 'agent', 'image', 'nexus', 'video'];

const EMPTY_METRIC = (): CommunityUsageMetric => ({
  inputTokens: 0,
  outputTokens: 0,
  requests: 0,
  spend: 0,
  totalTokens: 0,
});

const createSourceMap = (): Record<CommunityUsageSource, CommunityUsageMetric> =>
  Object.fromEntries(SOURCES.map((source) => [source, EMPTY_METRIC()])) as Record<
    CommunityUsageSource,
    CommunityUsageMetric
  >;

const addMetric = (target: CommunityUsageMetric, metric: CommunityUsageMetric) => {
  target.requests += metric.requests;
  target.inputTokens += metric.inputTokens;
  target.outputTokens += metric.outputTokens;
  target.totalTokens += metric.totalTokens;
  target.spend += metric.spend;
};

const clampNumber = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

const monthRange = (mo?: string) => {
  if (mo && dayjs(mo, 'YYYY-MM', true).isValid()) {
    return {
      endAt: dayjs(mo, 'YYYY-MM').endOf('month').format('YYYY-MM-DD'),
      month: mo,
      startAt: dayjs(mo, 'YYYY-MM').startOf('month').format('YYYY-MM-DD'),
    };
  }

  const now = dayjs();
  return {
    endAt: now.endOf('month').format('YYYY-MM-DD'),
    month: now.format('YYYY-MM'),
    startAt: now.startOf('month').format('YYYY-MM-DD'),
  };
};

const buildMetric = (value: Partial<CommunityUsageMetric>): CommunityUsageMetric => {
  const inputTokens = clampNumber(value.inputTokens);
  const outputTokens = clampNumber(value.outputTokens);
  const totalTokens = clampNumber(value.totalTokens || inputTokens + outputTokens);
  return {
    inputTokens,
    outputTokens,
    requests: clampNumber(value.requests),
    spend: clampNumber(value.spend),
    totalTokens,
  };
};

const stringifyDay = (date: Date) => formatDate(date);

interface BillingRecord {
  api_key_hash?: string;
  input_tokens?: number;
  meta?: {
    path?: string;
    provider?: string;
    [key: string]: unknown;
  };
  model?: string;
  output_tokens?: number;
  timestamp?: string;
  total_cost_usd?: number;
  total_tokens?: number;
}

interface UsageEvent {
  apiKeyHash?: string | null;
  createdAt: Date;
  id: string;
  inputTokens: number;
  model?: string | null;
  outputTokens: number;
  path?: string | null;
  provider?: string | null;
  source: CommunityUsageSource;
  spend: number;
  totalTokens: number;
  userId?: string | null;
}

type UserLabelMap = Map<string, string>;

const toEventMetric = (event: UsageEvent): CommunityUsageMetric => ({
  inputTokens: event.inputTokens,
  outputTokens: event.outputTokens,
  requests: 1,
  spend: event.spend,
  totalTokens: event.totalTokens,
});

export class CommunityAnalyticsService {
  private db: LobeChatDatabase;

  constructor(db: LobeChatDatabase) {
    this.db = db;
  }

  private async loadNexusBillingEvents(startAt: string, endAt: string): Promise<{
    events: UsageEvent[];
    source: CommunityUsageOverview['nexusSource'];
  }> {
    const remoteUrl = process.env.NEXUS_BILLING_GATEWAY_URL?.trim();
    const adminKey = process.env.NEXUS_BILLING_GATEWAY_ADMIN_KEY?.trim();
    const fileCandidates = [
      process.env.NEXUS_BILLING_RECORDS_FILE?.trim(),
      '/opt/billing-gateway/data/billing_records.jsonl',
      '/home/shiro/Projects/NEXUS/billing-gateway/data/billing_records.jsonl',
      resolve(process.cwd(), '../NEXUS/billing-gateway/data/billing_records.jsonl'),
      resolve(process.cwd(), '../../NEXUS/billing-gateway/data/billing_records.jsonl'),
    ].filter(Boolean) as string[];

    const parseRecords = (records: BillingRecord[]) =>
      records
        .filter((record) => record.timestamp)
        .filter((record) => {
          const timestamp = dayjs(record.timestamp);
          return (
            (timestamp.isAfter(dayjs(startAt).subtract(1, 'millisecond')) ||
              timestamp.isSame(dayjs(startAt), 'day')) &&
            (timestamp.isBefore(dayjs(endAt).add(1, 'day')) || timestamp.isSame(dayjs(endAt), 'day'))
          );
        })
        .map<UsageEvent>((record) => {
          const inputTokens = clampNumber(record.input_tokens);
          const outputTokens = clampNumber(record.output_tokens);
          const totalTokens = clampNumber(record.total_tokens || inputTokens + outputTokens);
          return {
            apiKeyHash: record.api_key_hash ?? null,
            createdAt: new Date(record.timestamp!),
            id: `${record.api_key_hash ?? 'nexus'}-${record.timestamp}`,
            inputTokens,
            model: record.model ?? null,
            outputTokens,
            path: typeof record.meta?.path === 'string' ? record.meta.path : null,
            provider: typeof record.meta?.provider === 'string' ? record.meta.provider : 'nexus',
            source: 'nexus',
            spend: clampNumber(record.total_cost_usd),
            totalTokens,
            userId: null,
          };
        });

    if (remoteUrl && adminKey) {
      try {
        const searchParams = new URLSearchParams({
          date_from: `${startAt}T00:00:00.000Z`,
          date_to: `${endAt}T23:59:59.999Z`,
          limit: '10000',
        });
        const response = await fetch(`${remoteUrl.replace(/\/$/, '')}/admin/billing?${searchParams}`, {
          headers: { 'x-admin-key': adminKey },
        });

        if (response.ok) {
          const data = (await response.json()) as { records?: BillingRecord[] };
          const records = Array.isArray(data.records) ? data.records : [];
          log('Loaded %d NEXUS billing records from remote gateway', records.length);
          return {
            events: parseRecords(records),
            source: 'remote',
          };
        }
      } catch (error) {
        log('Remote billing gateway fetch failed, falling back to local file: %O', error);
      }
    }

    for (const candidate of fileCandidates) {
      try {
        await access(candidate, fsConstants.R_OK);
        const content = await readFile(candidate, 'utf8');
        const records: BillingRecord[] = [];
        for (const line of content.split('\n')) {
          const value = line.trim();
          if (!value) continue;
          try {
            records.push(JSON.parse(value) as BillingRecord);
          } catch (error) {
            log('Skip malformed billing record in %s: %O', candidate, error);
          }
        }
        log('Loaded %d NEXUS billing records from %s', records.length, candidate);
        return {
          events: parseRecords(records),
          source: 'file',
        };
      } catch (error) {
        log('Unable to read billing record file %s: %O', candidate, error);
      }
    }

    return { events: [], source: 'missing' };
  }

  private async loadChatEvents(startAt: string, endAt: string): Promise<UsageEvent[]> {
    const rows = await this.db
      .select({
        createdAt: messages.createdAt,
        id: messages.id,
        metadata: messages.metadata,
        model: messages.model,
        provider: messages.provider,
        userId: messages.userId,
      })
      .from(messages)
      .where(
        genWhere([
          eq(messages.role, 'assistant'),
          genRangeWhere([startAt, endAt], messages.createdAt, (date) => date.toDate()),
        ]),
      )
      .orderBy(desc(messages.createdAt));

    return rows.map<UsageEvent>((row) => {
      const metadata = row.metadata as MessageMetadata | null | undefined;
      const nestedUsage = metadata?.usage;
      const inputTokens = clampNumber(
        nestedUsage?.totalInputTokens ?? metadata?.totalInputTokens ?? metadata?.inputTextTokens,
      );
      const outputTokens = clampNumber(
        nestedUsage?.totalOutputTokens ?? metadata?.totalOutputTokens ?? metadata?.outputTextTokens,
      );
      const totalTokens = clampNumber(
        nestedUsage?.totalTokens ?? metadata?.totalTokens ?? inputTokens + outputTokens,
      );

      return {
        apiKeyHash: null,
        createdAt: row.createdAt,
        id: row.id,
        inputTokens,
        model: row.model ?? null,
        outputTokens,
        path: null,
        provider: row.provider ?? null,
        source: 'chat',
        spend: clampNumber(nestedUsage?.cost ?? metadata?.cost),
        totalTokens,
        userId: row.userId,
      };
    });
  }

  private async loadAgentEvents(startAt: string, endAt: string): Promise<UsageEvent[]> {
    const rows = await this.db
      .select({
        completedAt: agentOperations.completedAt,
        createdAt: agentOperations.createdAt,
        id: agentOperations.id,
        model: agentOperations.model,
        provider: agentOperations.provider,
        status: agentOperations.status,
        totalCost: agentOperations.totalCost,
        totalInputTokens: agentOperations.totalInputTokens,
        totalOutputTokens: agentOperations.totalOutputTokens,
        totalTokens: agentOperations.totalTokens,
        userId: agentOperations.userId,
      })
      .from(agentOperations)
      .where(
        genWhere([
          genRangeWhere([startAt, endAt], agentOperations.createdAt, (date) => date.toDate()),
          inArray(agentOperations.status, ['done', 'error', 'interrupted']),
        ]),
      )
      .orderBy(desc(agentOperations.createdAt));

    return rows.map<UsageEvent>((row) => ({
      apiKeyHash: null,
      createdAt: row.completedAt ?? row.createdAt,
      id: row.id,
      inputTokens: clampNumber(row.totalInputTokens),
      model: row.model ?? null,
      outputTokens: clampNumber(row.totalOutputTokens),
      path: null,
      provider: row.provider ?? null,
      source: 'agent',
      spend: clampNumber(row.totalCost),
      totalTokens: clampNumber(row.totalTokens || clampNumber(row.totalInputTokens) + clampNumber(row.totalOutputTokens)),
      userId: row.userId,
    }));
  }

  private async loadGenerationEvents(startAt: string, endAt: string): Promise<UsageEvent[]> {
    const rows = await this.db
      .select({
        createdAt: generations.createdAt,
        id: generations.id,
        model: generationBatches.model,
        provider: generationBatches.provider,
        sourceType: generationTopics.type,
        userId: generations.userId,
      })
      .from(generations)
      .innerJoin(generationBatches, eq(generations.generationBatchId, generationBatches.id))
      .innerJoin(generationTopics, eq(generationBatches.generationTopicId, generationTopics.id))
      .leftJoin(asyncTasks, eq(generations.asyncTaskId, asyncTasks.id))
      .where(
        and(
          genRangeWhere([startAt, endAt], generations.createdAt, (date) => date.toDate()),
          eq(asyncTasks.status, AsyncTaskStatus.Success),
          isNotNull(generations.asset),
        ),
      )
      .orderBy(desc(generations.createdAt));

    return rows.map<UsageEvent>((row) => ({
      apiKeyHash: null,
      createdAt: row.createdAt,
      id: row.id,
      inputTokens: 0,
      model: row.model ?? null,
      outputTokens: 0,
      path: null,
      provider: row.provider ?? null,
      source: row.sourceType === 'video' ? 'video' : 'image',
      spend: 0,
      totalTokens: 0,
      userId: row.userId,
    }));
  }

  private aggregateEvents(
    events: UsageEvent[],
    range: { endAt: string; month: string; startAt: string },
    userLabels: UserLabelMap,
  ): Omit<CommunityUsageOverview, 'nexusSource' | 'range'> {
    const totals = EMPTY_METRIC();
    const sourceTotals = createSourceMap();
    const dailyMap = new Map<string, CommunityUsageDailyRecord>();
    const modelMap = new Map<string, CommunityUsageModelBreakdownItem>();
    const providerMap = new Map<string, CommunityUsageRankItem>();
    const apiKeyMap = new Map<string, CommunityUsageRankItem>();
    const pathMap = new Map<string, CommunityUsageRankItem>();
    const userMap = new Map<string, CommunityUsageRankItem>();
    const subjectMap = new Map<string, CommunityUsageRankItem>();
    const subjects = new Set<string>();

    const getDaily = (day: string, date: Date) => {
      const existing = dailyMap.get(day);
      if (existing) return existing;
      const value: CommunityUsageDailyRecord = {
        ...EMPTY_METRIC(),
        date: date.getTime(),
        day,
        sources: createSourceMap(),
      };
      dailyMap.set(day, value);
      return value;
    };

    const getRankItem = (
      map: Map<string, CommunityUsageRankItem>,
      key: string,
      label: string,
      extra: Partial<CommunityUsageRankItem> = {},
    ) => {
      const existing = map.get(key);
      if (existing) return existing;
      const item: CommunityUsageRankItem = {
        ...EMPTY_METRIC(),
        id: key,
        label,
        ...extra,
      };
      map.set(key, item);
      return item;
    };

    const getModelItem = (key: string, label: string) => {
      const existing = modelMap.get(key);
      if (existing) return existing;
      const item: CommunityUsageModelBreakdownItem = {
        ...EMPTY_METRIC(),
        id: key,
        label,
        sources: createSourceMap(),
      };
      modelMap.set(key, item);
      return item;
    };

    for (const event of events) {
      const metric = toEventMetric(event);
      const day = stringifyDay(event.createdAt);
      const daily = getDaily(day, event.createdAt);
      const sourceMetric = daily.sources[event.source];

      addMetric(totals, metric);
      addMetric(sourceTotals[event.source], metric);
      addMetric(daily, metric);
      addMetric(sourceMetric, metric);

      if (event.userId) {
        subjects.add(`user:${event.userId}`);
        const label = userLabels.get(event.userId) ?? event.userId;
        const user = getRankItem(userMap, event.userId, label, {
          subjectType: 'user',
          userId: event.userId,
        });
        const subject = getRankItem(subjectMap, `user:${event.userId}`, label, {
          subjectType: 'user',
          userId: event.userId,
        });
        addMetric(user, metric);
        addMetric(subject, metric);
      } else if (event.apiKeyHash) {
        subjects.add(`key:${event.apiKeyHash}`);
        const label = `${event.apiKeyHash.slice(0, 16)}...`;
        const subject = getRankItem(subjectMap, `key:${event.apiKeyHash}`, label, {
          apiKeyHash: event.apiKeyHash,
          source: 'nexus',
          subjectType: 'apiKey',
        });
        addMetric(subject, metric);
      }

      if (event.model) {
        const model = getModelItem(event.model, event.model);
        addMetric(model, metric);
        addMetric(model.sources[event.source], metric);
      }

      if (event.provider) {
        const provider = getRankItem(providerMap, event.provider, event.provider, { source: event.source });
        addMetric(provider, metric);
      }

      if (event.apiKeyHash) {
        const label = `${event.apiKeyHash.slice(0, 16)}...`;
        const apiKey = getRankItem(apiKeyMap, event.apiKeyHash, label, {
          apiKeyHash: event.apiKeyHash,
          source: 'nexus',
          subjectType: 'apiKey',
        });
        addMetric(apiKey, metric);
      }

      if (event.path) {
        const path = getRankItem(pathMap, event.path, event.path, {
          path: event.path,
          source: 'nexus',
        });
        addMetric(path, metric);
      }
    }

    const padDaily = () => {
      const start = dayjs(range.startAt);
      const end = dayjs(range.endAt);
      const result: CommunityUsageDailyRecord[] = [];
      for (let cursor = start; cursor.isBefore(end) || cursor.isSame(end, 'day'); cursor = cursor.add(1, 'day')) {
        const day = cursor.format('YYYY-MM-DD');
        result.push(
          dailyMap.get(day) ?? {
            ...EMPTY_METRIC(),
            date: cursor.toDate().getTime(),
            day,
            sources: createSourceMap(),
          },
        );
      }
      return result;
    };

    const toSortedArray = <T extends CommunityUsageRankItem | CommunityUsageModelBreakdownItem>(
      values: T[],
    ) =>
      values
        .toSorted((a, b) => b.totalTokens - a.totalTokens || b.spend - a.spend || b.requests - a.requests)
        .map((item) => ({ ...item }));

    return {
      daily: padDaily(),
      modelBreakdown: toSortedArray([...modelMap.values()]),
      modelRanking: toSortedArray([...modelMap.values()]),
      subjectRanking: toSortedArray([...subjectMap.values()]),
      pathRanking: [...pathMap.values()]
        .toSorted((a, b) => b.requests - a.requests || b.totalTokens - a.totalTokens || b.spend - a.spend)
        .map((item) => ({ ...item })),
      providerRanking: [...providerMap.values()]
        .toSorted((a, b) => b.totalTokens - a.totalTokens || b.spend - a.spend || b.requests - a.requests)
        .map((item) => ({ ...item })),
      sourceSummary: SOURCES.map((source) => ({
        ...sourceTotals[source],
        id: source,
        label: source,
        source,
      })).toSorted((a, b) => b.requests - a.requests),
      totals: {
        ...totals,
        activeModels: modelMap.size,
        activePaths: pathMap.size,
        activeProviders: providerMap.size,
        activeSources: SOURCES.filter((source) => sourceTotals[source].requests > 0).length,
        activeSubjects: subjects.size,
      },
      apiKeyRanking: [...apiKeyMap.values()]
        .toSorted((a, b) => b.spend - a.spend || b.totalTokens - a.totalTokens || b.requests - a.requests)
        .map((item) => ({ ...item })),
      userRanking: toSortedArray([...userMap.values()]),
    };
  }

  private async loadUserLabels(events: UsageEvent[]): Promise<UserLabelMap> {
    const userIds = [...new Set(events.map((event) => event.userId).filter(Boolean) as string[])];
    if (userIds.length === 0) return new Map();

    const rows = await this.db
      .select({
        displayUsername: users.displayUsername,
        email: users.email,
        fullName: users.fullName,
        id: users.id,
        username: users.username,
      })
      .from(users)
      .where(inArray(users.id, userIds));

    return new Map(
      rows.map((user) => [
        user.id,
        user.displayUsername || user.fullName || user.username || user.email || user.id,
      ]),
    );
  }

  getOverview = async (mo?: string): Promise<CommunityUsageOverview> => {
    const range = monthRange(mo);
    const [chatEvents, agentEvents, generationEvents, nexusResult] = await Promise.all([
      this.loadChatEvents(range.startAt, range.endAt),
      this.loadAgentEvents(range.startAt, range.endAt),
      this.loadGenerationEvents(range.startAt, range.endAt),
      this.loadNexusBillingEvents(range.startAt, range.endAt),
    ]);

    const events = [...chatEvents, ...agentEvents, ...generationEvents, ...nexusResult.events].toSorted(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
    const userLabels = await this.loadUserLabels(events);

    return {
      ...this.aggregateEvents(events, range, userLabels),
      nexusSource: nexusResult.source,
      range,
    };
  };
}
