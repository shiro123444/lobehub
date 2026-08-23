import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { PluginModel } from '@/database/models/plugin';
import { authedProcedure, publicProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import { SkillImporter } from '@/server/services/skill';
import { NexusRegistryService } from '@/server/services/nexusRegistry';
import { organizeNexusSubmission } from '@/server/services/nexusRegistry/organizer';
import { loadGitHubSkillSource } from '@/server/services/nexusRegistry/skillSource';

const registryProcedure = publicProcedure.use(serverDatabase).use(async ({ ctx, next }) => {
  return next({
    ctx: {
      nexusRegistryService: new NexusRegistryService(ctx.serverDB),
    },
  });
});

const registryAuthedProcedure = authedProcedure.use(serverDatabase).use(async ({ ctx, next }) => {
  return next({
    ctx: {
      nexusRegistryService: new NexusRegistryService(ctx.serverDB),
      pluginModel: new PluginModel(ctx.serverDB, ctx.userId),
      skillImporter: new SkillImporter(ctx.serverDB, ctx.userId),
    },
  });
});

const registryKindSchema = z.enum(['agent', 'blog', 'group_agent', 'mcp', 'plugin', 'skill']);
const registrySourceSchema = z.enum(['official', 'user']);
const registryStatusSchema = z.enum(['active', 'archived', 'hidden', 'pending', 'rejected']);
const registryReviewStatusSchema = z.enum(['active', 'archived', 'hidden', 'rejected']);

const metadataSchema = z.record(z.any());

const registrySubmitSchema = z.object({
  authorAvatarUrl: z.string().url().optional(),
  authorName: z.string().min(1).optional(),
  authorUrl: z.string().url().optional(),
  category: z.string().min(1).optional(),
  content: z.string().optional(),
  description: z.string().optional(),
  downloadUrl: z.string().url().optional(),
  homepageUrl: z.string().url().optional(),
  identifier: z.string().min(1).optional(),
  kind: registryKindSchema,
  locale: z.string().optional(),
  manifest: metadataSchema.optional(),
  metadata: metadataSchema.optional(),
  name: z.string().min(1),
  raw: metadataSchema.optional(),
  repositoryUrl: z.string().url().optional(),
  tags: z.array(z.string()).optional(),
  version: z.string().optional(),
});

const registrySubmitRepoSchema = z.object({
  aiMode: z.enum(['off', 'polish', 'normalize']).default('normalize').optional(),
  branch: z.string().optional(),
  category: z.string().optional(),
  description: z.string().optional(),
  gitUrl: z.string().url(),
  kind: z.enum(['auto', 'mcp', 'plugin', 'skill']).default('auto'),
  name: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const registrySubmitArtifactSchema = z.object({
  aiMode: z.enum(['off', 'polish', 'normalize']).default('normalize').optional(),
  artifact: z
    .object({
      dataBase64: z.string().optional(),
      fileName: z.string().optional(),
      mimeType: z.string().optional(),
      size: z.number().optional(),
    })
    .optional(),
  category: z.string().optional(),
  content: z.string().min(1).optional(),
  description: z.string().optional(),
  fileName: z.string().optional(),
  kind: z.enum(['auto', 'mcp', 'plugin', 'skill']).default('auto'),
  manifest: metadataSchema.optional(),
  name: z.string().optional(),
  sourceType: z.enum(['manifest', 'skill-md', 'zip']),
  tags: z.array(z.string()).optional(),
});

const registryBackfillSkillsSchema = z
  .object({
    limit: z.number().int().min(1).max(100).optional(),
    source: registrySourceSchema.optional(),
    status: registryStatusSchema.optional(),
  })
  .optional();

const inferKindFromArtifact = (input: {
  content?: string;
  fileName?: string;
  kind: 'auto' | 'mcp' | 'plugin' | 'skill';
  manifest?: Record<string, unknown>;
  sourceType: 'manifest' | 'skill-md' | 'zip';
}): 'mcp' | 'plugin' | 'skill' => {
  if (input.kind !== 'auto') return input.kind;
  if (input.sourceType === 'skill-md') return 'skill';

  const fileName = input.fileName?.toLowerCase() ?? '';
  const content = input.content?.toLowerCase() ?? '';
  const manifest = input.manifest ?? {};

  if (fileName.endsWith('.zip')) return 'skill';
  if (Array.isArray(manifest.tools) || Array.isArray(manifest.prompts)) return 'mcp';
  if (manifest.type === 'mcp' || content.includes('"tools"') || content.includes('mcp')) {
    return 'mcp';
  }
  if (Array.isArray(manifest.api) || manifest.type === 'plugin' || content.includes('"api"')) {
    return 'plugin';
  }

  return 'skill';
};

const inferKindFromGitHub = (input: {
  gitUrl: string;
  kind: 'auto' | 'mcp' | 'plugin' | 'skill';
}): 'mcp' | 'plugin' | 'skill' => {
  if (input.kind !== 'auto') return input.kind;

  const url = input.gitUrl.toLowerCase();
  if (url.includes('mcp')) return 'mcp';
  if (url.includes('plugin')) return 'plugin';
  if (url.includes('skill')) return 'skill';

  return 'skill';
};

const requireRegistryAdmin = (userId: string) => {
  const adminIds = [
    ...(process.env.NEXUS_REGISTRY_ADMIN_USER_IDS ?? '').split(','),
    ...(process.env.NEXUS_ADMIN_USER_IDS ?? '').split(','),
  ]
    .map((id) => id.trim())
    .filter(Boolean);

  if (adminIds.includes(userId)) return;
  if (process.env.NODE_ENV === 'development' && adminIds.length === 0) return;

  throw new TRPCError({ code: 'FORBIDDEN', message: 'NEXUS registry admin required' });
};

const resolveRegistryItem = async ({
  ctx,
  id,
  identifier,
  kind,
}: {
  ctx: { nexusRegistryService: NexusRegistryService };
  id?: string;
  identifier?: string;
  kind: 'mcp' | 'plugin' | 'skill';
}) => {
  const item = id
    ? await ctx.nexusRegistryService.getById(id)
    : identifier
      ? await ctx.nexusRegistryService.getByIdentifier({ identifier, kind, status: 'active' })
      : undefined;

  if (!item || item.kind !== kind || item.status !== 'active') {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'NEXUS registry item not found' });
  }

  return item;
};

export const nexusRegistryRouter = router({
  getByIdentifier: registryProcedure
    .input(
      z.object({
        identifier: z.string(),
        kind: registryKindSchema,
        source: registrySourceSchema.optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      return ctx.nexusRegistryService.getByIdentifier({ ...input, status: 'active' });
    }),

  getLatestSyncRun: registryProcedure
    .input(z.object({ kind: z.enum(['all', 'mcp', 'skill']).optional() }).optional())
    .query(async ({ ctx, input }) => {
      return ctx.nexusRegistryService.getLatestSyncRun(input?.kind);
    }),

  installPlugin: registryAuthedProcedure
    .input(
      z.object({
        id: z.string().optional(),
        identifier: z.string().optional(),
        kind: z.enum(['mcp', 'plugin']).default('plugin'),
        type: z.enum(['plugin', 'customPlugin']).default('customPlugin'),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const item = await resolveRegistryItem({
        ctx,
        id: input.id,
        identifier: input.identifier,
        kind: input.kind,
      });
      const manifest = item.manifest as any;

      if (!manifest || Object.keys(manifest).length === 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'NEXUS registry plugin has no installable manifest',
        });
      }

      const metadata = (item.metadata ?? {}) as Record<string, any>;
      const data = await ctx.pluginModel.create({
        customParams: metadata.customParams,
        identifier: item.identifier,
        manifest,
        settings: metadata.settings,
        source: 'nexus',
        type: input.type,
      });

      return data.identifier;
    }),

  installSkill: registryAuthedProcedure
    .input(
      z.object({
        id: z.string().optional(),
        identifier: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const item = await resolveRegistryItem({
        ctx,
        id: input.id,
        identifier: input.identifier,
        kind: 'skill',
      });
      const raw = (item.raw ?? {}) as Record<string, unknown>;

      if (item.downloadUrl) {
        return ctx.skillImporter.importFromUrl(
          { url: item.downloadUrl },
          { identifier: item.identifier, source: 'market' },
        );
      }

      if (item.repositoryUrl) {
        return ctx.skillImporter.importFromGitHub({ gitUrl: item.repositoryUrl });
      }

      if (typeof raw.content === 'string' && raw.content.trim()) {
        return {
          skill: await ctx.skillImporter.createUserSkill({
            content: raw.content,
            description: item.description || item.name,
            identifier: item.identifier,
            name: item.name,
          }),
          status: 'created' as const,
        };
      }

      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'NEXUS registry skill has no downloadUrl, repositoryUrl, or inline content',
      });
    }),

  list: registryProcedure
    .input(
      z
        .object({
          category: z.string().optional(),
          kind: registryKindSchema.optional(),
          page: z.number().int().min(1).optional(),
          pageSize: z.number().int().min(1).max(100).optional(),
          q: z.string().optional(),
          source: registrySourceSchema.optional(),
          status: registryStatusSchema.optional(),
          submittedBy: z.string().optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      return ctx.nexusRegistryService.list({ ...(input ?? {}), status: 'active' });
    }),

  listReviewQueue: registryAuthedProcedure
    .input(
      z
        .object({
          category: z.string().optional(),
          kind: registryKindSchema.optional(),
          page: z.number().int().min(1).optional(),
          pageSize: z.number().int().min(1).max(100).optional(),
          q: z.string().optional(),
          status: registryStatusSchema.optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      requireRegistryAdmin(ctx.userId);
      const result = await ctx.nexusRegistryService.list({
        ...(input ?? {}),
        source: 'user',
        status: input?.status ?? 'pending',
      });
      // Attach the latest safety scan so the review UI can render verdict/risk flags
      // without a second round-trip per row.
      const latestScans = await ctx.nexusRegistryService.getLatestScansForItems(
        result.items.map((item) => item.id),
      );
      return {
        ...result,
        items: result.items.map((item) => {
          const scan = latestScans.get(item.id);
          return {
            ...item,
            latestScan: scan
              ? { verdict: scan.verdict, riskScore: scan.riskScore, risks: scan.risks }
              : undefined,
          };
        }),
      };
    }),

  listMine: registryAuthedProcedure
    .input(
      z
        .object({
          category: z.string().optional(),
          kind: registryKindSchema.optional(),
          page: z.number().int().min(1).optional(),
          pageSize: z.number().int().min(1).max(100).optional(),
          q: z.string().optional(),
          status: registryStatusSchema.optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      return ctx.nexusRegistryService.list({
        ...(input ?? {}),
        source: 'user',
        submittedBy: ctx.userId,
      });
    }),

  backfillSkills: registryAuthedProcedure
    .input(registryBackfillSkillsSchema)
    .mutation(async ({ ctx, input }) => {
      requireRegistryAdmin(ctx.userId);
      return ctx.nexusRegistryService.backfillSkills({
        ...(input ?? {}),
        userId: ctx.userId,
      });
    }),

  submit: registryAuthedProcedure.input(registrySubmitSchema).mutation(async ({ ctx, input }) => {
    return ctx.nexusRegistryService.submit({
      ...input,
      source: 'user',
      status: 'pending',
      submittedBy: ctx.userId,
    });
  }),

  submitRepo: registryAuthedProcedure
    .input(registrySubmitRepoSchema)
    .mutation(async ({ ctx, input }) => {
      const url = new URL(input.gitUrl);
      const [, owner, repo] = url.pathname.split('/');
      if (url.hostname !== 'github.com' || !owner || !repo) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid GitHub repository URL' });
      }

      const repoName = repo.replace(/\.git$/, '') || 'repository';
      const kind = inferKindFromGitHub(input);
      const repositoryUrl = input.branch
        ? `${input.gitUrl.replace(/\/$/, '')}/tree/${input.branch}`
        : input.gitUrl;
      const skillSource =
        kind === 'skill' ? await loadGitHubSkillSource(repositoryUrl) : undefined;
      const organized = organizeNexusSubmission({
        aiMode: input.aiMode,
        category: input.category,
        content: skillSource?.content,
        description: input.description,
        gitUrl: repositoryUrl,
        kind,
        manifest: skillSource?.manifest,
        name: input.name,
        sourceType: 'github',
        tags: input.tags,
      });

      return ctx.nexusRegistryService.submit({
        category: organized.category,
        content: kind === 'skill' ? skillSource?.content : undefined,
        description: organized.description,
        homepageUrl: input.gitUrl,
        kind,
        manifest: organized.manifest,
        metadata: {
          ...organized.metadata,
          aiMode: input.aiMode ?? 'normalize',
          branch: input.branch,
          owner,
          requestedKind: input.kind,
          repo: repoName,
          submissionType: 'github',
        },
        name: organized.name,
        raw: organized.raw,
        repositoryUrl,
        source: 'user',
        status: 'pending',
        submittedBy: ctx.userId,
        tags: organized.tags,
      });
    }),

  submitArtifact: registryAuthedProcedure
    .input(registrySubmitArtifactSchema)
    .mutation(async ({ ctx, input }) => {
      const kind = inferKindFromArtifact(input);
      const organized = organizeNexusSubmission({
        aiMode: input.aiMode,
        artifact: input.artifact,
        category: input.category,
        content: input.content,
        description: input.description,
        fileName: input.fileName,
        kind,
        manifest: input.manifest,
        name: input.name,
        sourceType: input.sourceType,
        tags: input.tags,
      });

      return ctx.nexusRegistryService.submit({
        category: organized.category,
        content: kind === 'skill' ? input.content : undefined,
        description: organized.description,
        kind,
        manifest: organized.manifest,
        metadata: {
          ...organized.metadata,
          aiMode: input.aiMode ?? 'normalize',
          fileName: input.fileName,
          requestedKind: input.kind,
          sourceType: input.sourceType,
          submissionType: input.sourceType,
        },
        name: organized.name,
        raw: organized.raw,
        source: 'user',
        status: 'pending',
        submittedBy: ctx.userId,
        tags: organized.tags,
      });
    }),

  updateStatus: registryAuthedProcedure
    .input(
      z.object({
        id: z.string(),
        metadata: metadataSchema.optional(),
        status: registryReviewStatusSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRegistryAdmin(ctx.userId);
      const item = await ctx.nexusRegistryService.updateStatus(input.id, input, {
        userId: ctx.userId,
      });
      if (!item)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'NEXUS registry item not found' });

      // Audit human approve/reject decisions (lifecycle ops like archived/hidden are not
      // review decisions and are intentionally not recorded as review actions here).
      if (input.status === 'active' || input.status === 'rejected') {
        await ctx.nexusRegistryService.recordReviewAction({
          action: input.status === 'active' ? 'approve' : 'reject',
          actor: 'human',
          ipAddress: ctx.clientIp ?? undefined,
          item,
          reason: (input.metadata?.reason as string | undefined) ?? undefined,
          reviewerId: ctx.userId,
          userAgent: ctx.userAgent ?? undefined,
        });
      }

      return item;
    }),

  rescan: registryAuthedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      requireRegistryAdmin(ctx.userId);
      return ctx.nexusRegistryService.decideAndApply(input.id, { trigger: 'rescan' });
    }),
});

export type NexusRegistryRouter = typeof nexusRegistryRouter;
