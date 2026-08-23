import { serverDB } from '@lobechat/database';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { NexusRegistryService } from '@/server/services/nexusRegistry';

const syncBodySchema = z
  .object({
    kinds: z.array(z.enum(['mcp', 'skill'])).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    locale: z.string().optional(),
    maxPages: z.number().int().min(1).max(50).optional(),
    mode: z.enum(['hydrate', 'review', 'sync']).default('sync'),
    pageSize: z.number().int().min(1).max(100).optional(),
  })
  .optional();

const isAuthorized = (request: Request) => {
  const secret = process.env.NEXUS_REGISTRY_SYNC_SECRET;
  if (!secret) return process.env.NODE_ENV === 'development';

  const auth = request.headers.get('authorization');
  return auth === `Bearer ${secret}`;
};

export const POST = async (request: Request) => {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = syncBodySchema.parse(await request.json().catch(() => undefined));
  const mode = body?.mode ?? 'sync';
  const service = new NexusRegistryService(serverDB);

  // Cron-driven UGC review pipeline. `review` runs safety scans + auto-approves/blocks;
  // `hydrate` backfills skill metadata for pending submissions so reviewers see full info.
  if (mode === 'review') {
    return NextResponse.json(await service.reviewPendingItems({ limit: body?.limit }));
  }

  if (mode === 'hydrate') {
    return NextResponse.json(
      await service.backfillSkills({ limit: body?.limit, status: 'pending' }),
    );
  }

  const result = await service.syncOfficial({
    kinds: body?.kinds,
    locale: body?.locale,
    maxPages: body?.maxPages,
    pageSize: body?.pageSize,
  });

  return NextResponse.json(result);
};
