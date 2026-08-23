export type CommunityUsageSource = 'agent' | 'chat' | 'image' | 'nexus' | 'video';

export interface CommunityUsageMetric {
  outputTokens: number;
  requests: number;
  spend: number;
  totalTokens: number;
  inputTokens: number;
}

export interface CommunityUsageDailyRecord extends CommunityUsageMetric {
  date: number;
  day: string;
  sources: Record<CommunityUsageSource, CommunityUsageMetric>;
}

export interface CommunityUsageRankItem extends CommunityUsageMetric {
  id: string;
  label: string;
  source?: CommunityUsageSource;
  apiKeyHash?: string | null;
  path?: string | null;
  subjectType?: 'apiKey' | 'user';
  userId?: string | null;
}

export interface CommunityUsageModelBreakdownItem extends CommunityUsageMetric {
  id: string;
  label: string;
  sources: Record<CommunityUsageSource, CommunityUsageMetric>;
}

export interface CommunityUsageOverview {
  daily: CommunityUsageDailyRecord[];
  modelBreakdown: CommunityUsageModelBreakdownItem[];
  modelRanking: CommunityUsageRankItem[];
  subjectRanking: CommunityUsageRankItem[];
  pathRanking: CommunityUsageRankItem[];
  nexusSource: 'file' | 'missing' | 'remote';
  providerRanking: CommunityUsageRankItem[];
  range: {
    endAt: string;
    month: string;
    startAt: string;
  };
  sourceSummary: CommunityUsageRankItem[];
  totals: CommunityUsageMetric & {
    activeModels: number;
    activePaths: number;
    activeProviders: number;
    activeSources: number;
    activeSubjects: number;
  };
  apiKeyRanking: CommunityUsageRankItem[];
  userRanking: CommunityUsageRankItem[];
}
