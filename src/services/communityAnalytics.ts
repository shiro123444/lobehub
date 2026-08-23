import { lambdaClient } from '@/libs/trpc/client';

class CommunityAnalyticsService {
  getOverview = async (mo?: string) => {
    return lambdaClient.communityAnalytics.getOverview.query({ mo });
  };
}

export const communityAnalyticsService = new CommunityAnalyticsService();
