import { z } from 'zod';

import { publicProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import { CommunityAnalyticsService } from '@/server/services/communityAnalytics';

const communityAnalyticsProcedure = publicProcedure.use(serverDatabase).use(async (opts) => {
  const { ctx } = opts;

  return opts.next({
    ctx: {
      communityAnalyticsService: new CommunityAnalyticsService(ctx.serverDB),
    },
  });
});

export const communityAnalyticsRouter = router({
  getOverview: communityAnalyticsProcedure
    .input(
      z.object({
        mo: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      return await ctx.communityAnalyticsService.getOverview(input.mo);
    }),
});

export type CommunityAnalyticsRouter = typeof communityAnalyticsRouter;
