import { createHash } from 'node:crypto';

import { type LobeChatDatabase } from '@lobechat/database';
import { nanoid } from '@lobechat/utils';
import {
  type NewNexusRegistryItem,
  type NexusRegistryItem,
  type NexusRegistryReviewActionItem,
  type NexusRegistrySafetyScanItem,
  nexusRegistryItems,
  nexusRegistryReviewActions,
  nexusRegistrySafetyScans,
  nexusRegistrySyncRuns,
} from '@lobechat/database/schemas';
import { and, count, desc, eq, ilike, inArray, or } from 'drizzle-orm';
import debug from 'debug';

import { GitHub } from '@/server/modules/GitHub';
import { UserModel } from '@/database/models/user';
import { DiscoverService } from '@/server/services/discover';
import { MarketService } from '@/server/services/market';
import {
  type GitHubSkillSource,
  loadGitHubSkillSource,
} from '@/server/services/nexusRegistry/skillSource';
import { analyzeNexusRegistrySkill } from '@/server/services/nexusRegistry/skillIntelligence';
import { analyzeRegistrySafety } from '@/server/services/nexusRegistry/reviewSafety';
import {
  AUTO_REVIEWER_ID,
  decideReview,
  parseThresholds,
  parseTrustedUpstreams,
  type ReviewAction,
  type ReviewActor,
  type ReviewDecision,
  type SafetyVerdict,
} from '@/server/services/nexusRegistry/decide';
import type {
  DiscoverMcpDetail,
  DiscoverMcpItem,
  DiscoverPluginDetail,
  DiscoverPluginItem,
  DiscoverSkillItem,
  DiscoverSkillDetail,
  McpListResponse,
  PluginListResponse,
  SkillCategoryItem,
  SkillListResponse,
} from '@/types/discover';
import type {
  NexusRegistryBackfillSkillsParams,
  NexusRegistryBackfillSkillsResponse,
  NexusRegistryKind,
  NexusRegistryListParams,
  NexusRegistryListResponse,
  NexusRegistryLookupParams,
  NexusRegistrySyncParams,
  NexusRegistrySyncResponse,
  NexusRegistryStatusUpdateParams,
  NexusRegistrySubmitParams,
} from '@/types/nexusRegistry';

const log = debug('nexus:registry');

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 5;
const ANALYSIS_USER_ID = 'INTERNAL_SERVICE';

const toPlainObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
};

const readString = (value: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const key of keys) {
    const item = value[key];
    if (typeof item === 'string' && item.trim()) return item.trim();
  }
};

const readNumber = (value: Record<string, unknown>, keys: string[]): number | undefined => {
  for (const key of keys) {
    const item = value[key];
    if (typeof item === 'number' && Number.isFinite(item)) return item;
  }
};

const readDate = (value: Record<string, unknown>, keys: string[]): Date | undefined => {
  for (const key of keys) {
    const item = value[key];
    if (typeof item !== 'string' || !item) continue;
    const date = new Date(item);
    if (!Number.isNaN(date.getTime())) return date;
  }
};

const readTags = (value: Record<string, unknown>): string[] => {
  const tags = value.tags ?? value.keywords;
  if (Array.isArray(tags)) {
    return tags.filter((tag): tag is string => typeof tag === 'string' && Boolean(tag.trim()));
  }

  if (typeof tags === 'string') {
    return tags
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  return [];
};

const normalizeIdentifierPart = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replaceAll(/[^\w-]/g, '-')
    .replaceAll(/-+/g, '-')
    .replaceAll(/^-|-$/g, '');

const buildIdentifier = (
  kind: NexusRegistryKind,
  value: {
    identifier?: string;
    name: string;
    repositoryUrl?: string;
    upstreamIdentifier?: string;
  },
): string => {
  const identifier = value.identifier?.trim();
  if (identifier) return identifier;

  const github = new GitHub({ userAgent: 'LobeHub-Nexus-Registry' });
  if (value.repositoryUrl?.trim()) {
    try {
      return github.generateIdentifier(github.parseRepoUrl(value.repositoryUrl.trim()));
    } catch {
      // fall through to a local slug
    }
  }

  const upstreamIdentifier = value.upstreamIdentifier?.trim();
  const candidate =
    upstreamIdentifier || normalizeIdentifierPart(value.name) || `${kind}-${nanoid(8)}`;
  const slug = normalizeIdentifierPart(candidate);
  return slug ? `${kind}-${slug}` : `${kind}-${nanoid(8)}`;
};

const mergeMetadata = (
  base: Record<string, unknown> | null | undefined,
  next?: Record<string, unknown>,
): Record<string, unknown> => ({
  ...(base ?? {}),
  ...(next ?? {}),
});

const readAiMetadata = (value: Record<string, unknown>): Record<string, unknown> => {
  return toPlainObject(value.ai);
};

const readSkillInstallation = (value: Record<string, unknown>) => {
  const installation = toPlainObject(value.installation);

  return {
    agent: readString(installation, ['agent']),
    human: readString(installation, ['human']),
  };
};

const readCompleteSkillAnalysis = (raw: Record<string, unknown>) => {
  const ai = readAiMetadata(raw);
  const installation = readSkillInstallation(ai);
  const summary = readString(ai, ['summary']);
  const category = readString(ai, ['category']);

  if (!summary || !category || !installation.agent || !installation.human) return;

  return {
    category,
    installation: {
      agent: installation.agent,
      human: installation.human,
    },
    related: Array.isArray(ai.related) ? ai.related : undefined,
    summary,
    tags: Array.isArray(ai.tags) ? (ai.tags as string[]) : undefined,
  };
};

const skillNeedsHydration = (item: NexusRegistryItem): boolean => {
  if (item.kind !== 'skill') return false;

  const raw = toPlainObject(item.raw);
  const analysis = readCompleteSkillAnalysis(raw);
  if (!analysis) return true;

  const rawInstallation = readSkillInstallation(raw);

  return Boolean(
    (item.repositoryUrl && !readString(raw, ['content'])) ||
      !item.description ||
      !item.category ||
      readString(raw, ['summary']) !== analysis.summary ||
      readString(raw, ['category']) !== analysis.category ||
      !rawInstallation.agent ||
      !rawInstallation.human,
  );
};

const snapshotSkillFields = (item: NexusRegistryItem) =>
  JSON.stringify({
    category: item.category,
    description: item.description,
    manifest: item.manifest,
    raw: item.raw,
    tags: item.tags,
  });

const readAuthor = (value: Record<string, unknown>) => {
  const author = toPlainObject(value.author);

  return {
    authorAvatarUrl:
      readString(author, ['avatar', 'avatarUrl', 'imageUrl']) ||
      readString(value, ['authorAvatar', 'authorAvatarUrl']),
    authorName:
      readString(author, ['name', 'displayName', 'username', 'userName']) ||
      readString(value, ['author', 'authorName']),
    authorUrl:
      readString(author, ['url', 'homepage', 'htmlUrl']) || readString(value, ['authorUrl']),
  };
};

const normalizeIdentifier = (kind: NexusRegistryKind, value: Record<string, unknown>) => {
  return (
    readString(value, ['identifier', 'id', 'name', 'slug']) ||
    `${kind}-${Buffer.from(JSON.stringify(value)).toString('base64url').slice(0, 16)}`
  );
};

const normalizeOfficialItem = (
  kind: Extract<NexusRegistryKind, 'mcp' | 'skill'>,
  rawItem: unknown,
  options: { locale?: string; runId: string },
): NewNexusRegistryItem => {
  const raw = toPlainObject(rawItem);
  const identifier = normalizeIdentifier(kind, raw);
  const manifest = toPlainObject(raw.manifest);
  const metadata = {
    downloadCount: readNumber(raw, ['downloadCount', 'downloads']),
    forkCount: readNumber(raw, ['forkCount', 'forks']),
    installCount: readNumber(raw, ['installCount', 'installs']),
    rating: readNumber(raw, ['rating', 'ratingAvg']),
    starCount: readNumber(raw, ['starCount', 'stars']),
  };
  const author = readAuthor(raw);

  return {
    ...author,
    category: readString(raw, ['category']),
    description: readString(raw, ['description', 'summary']) || '',
    downloadUrl: readString(raw, ['downloadUrl']),
    homepageUrl: readString(raw, ['homepage', 'homepageUrl', 'url']),
    identifier,
    kind,
    locale: options.locale,
    manifest,
    metadata,
    name: readString(raw, ['title', 'name', 'displayName']) || identifier,
    publishedAt: readDate(raw, ['publishedAt', 'createdAt']),
    raw,
    repositoryUrl: readString(raw, ['repository', 'repositoryUrl', 'githubUrl']),
    source: 'official',
    status: 'active',
    syncRunId: options.runId,
    tags: readTags(raw),
    upstreamIdentifier: identifier,
    upstreamSource: 'lobehub',
    version: readString(raw, ['version', 'latestVersion']),
  };
};

const toIso = (date?: Date | string | null): string => {
  if (!date) return new Date().toISOString();
  if (date instanceof Date) return date.toISOString();
  return date;
};

const toNumber = (value: unknown, fallback = 0): number => {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

const toMcpItem = (item: NexusRegistryItem): DiscoverMcpItem => {
  const raw = toPlainObject(item.raw);
  const metadata = toPlainObject(item.metadata);
  const capabilities = toPlainObject(raw.capabilities);

  return {
    ...raw,
    author: readString(raw, ['author']) || item.authorName || undefined,
    category: readString(raw, ['category']) || item.category || undefined,
    capabilities: {
      prompts: Boolean(capabilities.prompts),
      resources: Boolean(capabilities.resources),
      tools: Boolean(capabilities.tools),
    },
    createdAt: toIso(readString(raw, ['createdAt']) || item.publishedAt || item.createdAt),
    description: readString(raw, ['description']) || item.description || '',
    github: toPlainObject(raw.github) as DiscoverMcpItem['github'],
    homepage: readString(raw, ['homepage', 'homepageUrl']) || item.homepageUrl || undefined,
    icon: readString(raw, ['icon']) || item.authorAvatarUrl || undefined,
    identifier: item.identifier,
    installCount: toNumber(raw.installCount, toNumber(metadata.installCount)),
    isClaimed: item.source === 'user' || Boolean(raw.isClaimed),
    isFeatured: Boolean(raw.isFeatured),
    isOfficial: item.source === 'official' || Boolean(raw.isOfficial),
    isValidated: item.source === 'official' || Boolean(raw.isValidated),
    manifestUrl: readString(raw, ['manifestUrl']) || '',
    name: readString(raw, ['name', 'title']) || item.name,
    promptsCount: toNumber(raw.promptsCount),
    resourcesCount: toNumber(raw.resourcesCount),
    tags: Array.isArray(raw.tags) ? (raw.tags as string[]) : item.tags,
    toolsCount: toNumber(raw.toolsCount),
    updatedAt: toIso(readString(raw, ['updatedAt']) || item.updatedAt),
  } as DiscoverMcpItem;
};

const toSkillItem = (item: NexusRegistryItem): SkillListResponse['items'][number] => {
  const raw = toPlainObject(item.raw);
  const ai = readAiMetadata(raw);
  const metadata = toPlainObject(item.metadata);
  const manifest = toPlainObject(item.manifest);
  const resources = toPlainObject(raw.resources);

  return {
    ...raw,
    author: readString(raw, ['author']) || item.authorName || undefined,
    category: readString(raw, ['category']) || readString(ai, ['category']) || item.category || undefined,
    commentCount: toNumber(raw.commentCount),
    createdAt: toIso(readString(raw, ['createdAt']) || item.publishedAt || item.createdAt),
    description:
      readString(raw, ['description']) ||
      readString(raw, ['summary']) ||
      readString(ai, ['summary']) ||
      item.description ||
      readString(manifest, ['description', 'summary']) ||
      '',
    github: toPlainObject(raw.github) as SkillListResponse['items'][number]['github'],
    homepage: readString(raw, ['homepage', 'homepageUrl']) || item.homepageUrl || undefined,
    icon: readString(raw, ['icon', 'logo']) || item.authorAvatarUrl || undefined,
    identifier: item.identifier,
    installCount: toNumber(raw.installCount, toNumber(metadata.installCount)),
    isFeatured: Boolean(raw.isFeatured),
    isOfficial: item.source === 'official' || Boolean(raw.isOfficial),
    isValidated: item.source === 'official' || Boolean(raw.isValidated),
    name:
      readString(raw, ['name', 'title']) || readString(manifest, ['name', 'title']) || item.name,
    ratingAvg: toNumber(raw.ratingAvg, toNumber(metadata.rating)),
    ratingCount: toNumber(raw.ratingCount),
    resourcesCount: toNumber(raw.resourcesCount, Object.keys(resources).length),
    tags:
      Array.isArray(raw.tags)
        ? (raw.tags as string[])
        : Array.isArray(ai.tags)
          ? (ai.tags as string[])
          : item.tags,
    updatedAt: toIso(readString(raw, ['updatedAt']) || item.updatedAt),
    version: readString(raw, ['version']) || item.version || '',
  } as SkillListResponse['items'][number];
};

const toSkillDetail = (
  item: NexusRegistryItem,
  related: DiscoverSkillDetail['related'] = [],
): DiscoverSkillDetail => {
  const raw = toPlainObject(item.raw);
  const ai = readAiMetadata(raw);
  const githubRaw = toPlainObject(raw.github);
  const detail = toSkillItem(item) as unknown as DiscoverSkillDetail;
  const resources = toPlainObject(raw.resources);
  const installationRaw = Object.keys(toPlainObject(raw.installation)).length
    ? toPlainObject(raw.installation)
    : toPlainObject(ai.installation);

  return {
    ...detail,
    content: readString(raw, ['content']) || item.description || '',
    downloadUrl: item.downloadUrl || readString(raw, ['downloadUrl']) || undefined,
    github: {
      stars: toNumber(githubRaw.stars),
      url: readString(githubRaw, ['url', 'homepage', 'htmlUrl']) || item.repositoryUrl || undefined,
    },
    homepage: item.homepageUrl || readString(raw, ['homepage', 'homepageUrl']) || undefined,
    installation: {
      agent:
        readString(installationRaw, ['agent']) ||
        readString(toPlainObject(ai.installation), ['agent']),
      human: readString(installationRaw, ['human']),
    },
    manifest: toPlainObject(item.manifest),
    overview: {
      summary:
        readString(raw, ['overview']) ||
        readString(raw, ['summary']) ||
        readString(ai, ['summary']) ||
        detail.description ||
        item.description ||
        '',
    },
    ratingDistribution: undefined,
    related,
    resources,
    version: item.version || readString(raw, ['version']) || '0.0.0',
    versions: Array.isArray(raw.versions) ? raw.versions : [],
  } as unknown as DiscoverSkillDetail;
};

const toPluginItem = (item: NexusRegistryItem): DiscoverPluginItem => {
  const raw = toPlainObject(item.raw);
  const manifest = toPlainObject(item.manifest);
  const title = readString(raw, ['title', 'name']) || item.name;
  const description = readString(raw, ['description']) || item.description || '';

  return {
    author: item.authorName || readString(raw, ['author']) || 'NEXUS',
    avatar: item.authorAvatarUrl || readString(raw, ['icon', 'avatar']) || '',
    category: (item.category as DiscoverPluginItem['category']) || undefined,
    createdAt: toIso(readString(raw, ['createdAt']) || item.publishedAt || item.createdAt),
    description,
    homepage: item.homepageUrl || readString(raw, ['homepage', 'homepageUrl']) || '',
    identifier: item.identifier,
    manifest: JSON.stringify(manifest),
    meta: {
      avatar: item.authorAvatarUrl || readString(raw, ['icon', 'avatar']) || '',
      description,
      tags: item.tags,
      title,
    },
    schemaVersion: toNumber(raw.schemaVersion, 1),
    tags: item.tags,
    title,
  } as DiscoverPluginItem;
};

const toPluginDetail = (item: NexusRegistryItem): DiscoverPluginDetail => {
  return {
    ...toPluginItem(item),
    manifest: toPlainObject(item.manifest) as any,
    related: [],
    source: item.source === 'official' ? 'market' : 'market',
  };
};

const toMcpDetail = (item: NexusRegistryItem): DiscoverMcpDetail => {
  const detail = toMcpItem(item);
  return {
    ...detail,
    haveCloudEndpoint: Boolean(item.downloadUrl || item.homepageUrl || item.repositoryUrl),
    isClaimed: item.source === 'user',
    overview: item.description || '',
    related: [],
    version: item.version || '0.0.0',
    versions: [],
  } as unknown as DiscoverMcpDetail;
};

const readOrganizerFlags = (item: NexusRegistryItem): string[] => {
  const organizer = toPlainObject(toPlainObject(item.metadata).organizer);
  const flags = organizer.reviewFlags;
  return Array.isArray(flags)
    ? flags.filter((flag): flag is string => typeof flag === 'string')
    : [];
};

const extractGithubOwner = (repositoryUrl?: string | null): string | undefined => {
  const url = repositoryUrl?.trim();
  if (!url) return undefined;
  try {
    const github = new GitHub({ userAgent: 'LobeHub-Nexus-Registry' });
    return github.parseRepoUrl(url).owner;
  } catch {
    return undefined;
  }
};

const computeContentHash = (input: {
  content?: string;
  manifest?: Record<string, unknown>;
}) =>
  createHash('sha256')
    .update(JSON.stringify({ content: input.content ?? '', manifest: input.manifest ?? {} }))
    .digest('hex');

export class NexusRegistryService {
  constructor(private readonly db: LobeChatDatabase) {}

  private async resolveGitHubSkillSource(repositoryUrl?: string | null) {
    const url = repositoryUrl?.trim();
    if (!url) return;

    try {
      return await loadGitHubSkillSource(url);
    } catch (error) {
      log('Failed to load GitHub skill source from %s: %O', url, error);
      throw error;
    }
  }

  private async ensureSkillContent(item: NexusRegistryItem, userId?: string) {
    const raw = toPlainObject(item.raw);
    const ai = readAiMetadata(raw);
    const hasContent = Boolean(typeof raw.content === 'string' && raw.content.trim());
    const storedAnalysis = readCompleteSkillAnalysis(raw);
    const hasAnalysis = Boolean(storedAnalysis);
    const analysisUserId = userId?.trim() || ANALYSIS_USER_ID;

    if (hasContent && hasAnalysis && !skillNeedsHydration(item)) return item;

    if (item.kind !== 'skill') return item;

    let source: GitHubSkillSource | undefined;
    try {
      source = await this.resolveGitHubSkillSource(item.repositoryUrl);
    } catch {
      source = undefined;
    }

    const rawContent = typeof raw.content === 'string' ? raw.content : undefined;
    const nextContent = source?.content?.trim() ? source.content : rawContent;

    const shouldAnalyze = !hasAnalysis;
    if (shouldAnalyze) {
      await UserModel.makeSureUserExist(this.db, analysisUserId);
    }

    const analysis =
      shouldAnalyze
        ? await analyzeNexusRegistrySkill(this.db, {
            content: nextContent,
            description: item.description || readString(raw, ['summary']),
            identifier: item.identifier,
            kind: item.kind,
            locale: item.locale || undefined,
            manifest: mergeMetadata(toPlainObject(item.manifest), source?.manifest),
            name: item.name,
            raw,
            repositoryUrl: item.repositoryUrl,
            resources: source?.resources,
            submittedBy: analysisUserId,
            tags: item.tags,
        })
        : undefined;
    const effectiveAnalysis = analysis ?? storedAnalysis;
    const nextManifest = mergeMetadata(toPlainObject(item.manifest), source?.manifest);
    const hasSourceUpdates =
      JSON.stringify(nextManifest) !== JSON.stringify(toPlainObject(item.manifest)) ||
      JSON.stringify(source?.resources ?? {}) !== JSON.stringify(toPlainObject(raw.resources)) ||
      Boolean(nextContent && nextContent !== raw.content);

    const hasStoredFieldUpdates = Boolean(effectiveAnalysis && skillNeedsHydration(item));

    if (!effectiveAnalysis && !hasSourceUpdates && !hasStoredFieldUpdates) return item;

    const nextRaw = mergeMetadata(raw, {
      ...(nextContent
        ? {
            content: nextContent,
          }
        : {}),
      ...(source?.resources && Object.keys(source.resources).length > 0
        ? { resources: source.resources }
        : {}),
      ...(effectiveAnalysis
        ? {
            ai: mergeMetadata(ai, {
              category: effectiveAnalysis.category,
              installation: effectiveAnalysis.installation,
              related: effectiveAnalysis.related,
              summary: effectiveAnalysis.summary,
              tags: effectiveAnalysis.tags,
            }),
            category: effectiveAnalysis.category,
            installation: effectiveAnalysis.installation,
            related: effectiveAnalysis.related,
            summary: effectiveAnalysis.summary,
          }
        : {}),
    });
    const nextDescription =
      effectiveAnalysis?.summary ||
      item.description ||
      readString(nextRaw, ['summary']) ||
      readString(raw, ['description']);
    const nextCategory =
      effectiveAnalysis?.category || item.category || readString(nextRaw, ['category']);
    const nextTags = effectiveAnalysis?.tags?.length
      ? [...new Set([...(item.tags ?? []), ...effectiveAnalysis.tags])]
      : item.tags;
    const [updated] = await this.db
      .update(nexusRegistryItems)
      .set({
        category: nextCategory,
        description: nextDescription,
        manifest: nextManifest,
        raw: nextRaw,
        tags: nextTags,
        updatedAt: new Date(),
      })
      .where(eq(nexusRegistryItems.id, item.id))
      .returning();

    return updated ?? { ...item, manifest: nextManifest, raw: nextRaw };
  }

  list = async (params: NexusRegistryListParams = {}): Promise<NexusRegistryListResponse> => {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));
    const conditions = [];

    if (params.kind) conditions.push(eq(nexusRegistryItems.kind, params.kind));
    if (params.source) conditions.push(eq(nexusRegistryItems.source, params.source));
    if (params.status) conditions.push(eq(nexusRegistryItems.status, params.status));
    if (params.category) conditions.push(eq(nexusRegistryItems.category, params.category));
    if (params.submittedBy) conditions.push(eq(nexusRegistryItems.submittedBy, params.submittedBy));
    if (params.q?.trim()) {
      const q = `%${params.q.trim()}%`;
      conditions.push(
        or(ilike(nexusRegistryItems.name, q), ilike(nexusRegistryItems.description, q)),
      );
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [{ value: totalCount = 0 } = { value: 0 }] = await this.db
      .select({ value: count() })
      .from(nexusRegistryItems)
      .where(where);

    const items = await this.db
      .select()
      .from(nexusRegistryItems)
      .where(where)
      .orderBy(desc(nexusRegistryItems.updatedAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return {
      currentPage: page,
      items,
      pageSize,
      totalCount,
      totalPages: Math.ceil(totalCount / pageSize),
    };
  };

  getById = async (id: string): Promise<NexusRegistryItem | undefined> => {
    const [item] = await this.db
      .select()
      .from(nexusRegistryItems)
      .where(eq(nexusRegistryItems.id, id))
      .limit(1);
    return item;
  };

  getByIdentifier = async (
    params: NexusRegistryLookupParams,
  ): Promise<NexusRegistryItem | undefined> => {
    if (!params.source) {
      const status = params.status ?? 'active';
      return (
        (await this.getByIdentifier({ ...params, source: 'official', status })) ||
        (await this.getByIdentifier({ ...params, source: 'user', status }))
      );
    }

    const conditions = [
      eq(nexusRegistryItems.kind, params.kind),
      eq(nexusRegistryItems.identifier, params.identifier),
      eq(nexusRegistryItems.source, params.source),
    ];
    if (params.status) conditions.push(eq(nexusRegistryItems.status, params.status));

    const [item] = await this.db
      .select()
      .from(nexusRegistryItems)
      .where(and(...conditions))
      .orderBy(desc(nexusRegistryItems.updatedAt))
      .limit(1);

    return item;
  };

  submit = async (
    params: NexusRegistrySubmitParams,
  ): Promise<{ created: boolean; item: NexusRegistryItem }> => {
    const source = params.source ?? 'user';
    const status = params.status ?? (source === 'official' ? 'active' : 'pending');
    const repositoryUrl = params.repositoryUrl?.trim();
    const github = new GitHub({ userAgent: 'LobeHub-Nexus-Registry' });
    let upstreamSource = params.upstreamSource?.trim();
    let upstreamIdentifier = params.upstreamIdentifier?.trim();
    if (repositoryUrl) {
      try {
        const repoInfo = github.parseRepoUrl(repositoryUrl);
        upstreamSource = upstreamSource || 'github';
        upstreamIdentifier =
          upstreamIdentifier ||
          `${repoInfo.owner}/${repoInfo.repo}${repoInfo.path ? `/${repoInfo.path}` : ''}`;
      } catch {
        // Ignore invalid repository URLs here; they may still be valid download URLs.
      }
    }
    const identifier = buildIdentifier(params.kind, {
      identifier: params.identifier,
      name: params.name,
      repositoryUrl,
      upstreamIdentifier,
    });
    const resolvedSkillSource =
      params.kind === 'skill' && !params.content?.trim() && repositoryUrl
        ? await this.resolveGitHubSkillSource(repositoryUrl)
        : undefined;
    const content = params.content?.trim() || resolvedSkillSource?.content;
    const manifest = mergeMetadata(toPlainObject(params.manifest), resolvedSkillSource?.manifest);
    const raw = mergeMetadata(toPlainObject(params.raw), {
      ...(content ? { content } : {}),
      ...(resolvedSkillSource?.resources && Object.keys(resolvedSkillSource.resources).length > 0
        ? { resources: resolvedSkillSource.resources }
        : {}),
    });
    const metadata = toPlainObject(params.metadata);
    const now = new Date();
    const existing = await this.getByIdentifier({
      identifier,
      kind: params.kind,
      source,
      status: undefined,
    });

    const values: NewNexusRegistryItem = {
      authorAvatarUrl: params.authorAvatarUrl,
      authorName: params.authorName,
      authorUrl: params.authorUrl,
      category: params.category,
      description: params.description,
      downloadUrl: params.downloadUrl,
      homepageUrl: params.homepageUrl,
      identifier,
      kind: params.kind,
      locale: params.locale,
      manifest,
      metadata,
      name: params.name,
      raw,
      repositoryUrl,
      source,
      status,
      submittedBy: params.submittedBy,
      tags: params.tags ?? [],
      upstreamIdentifier,
      upstreamSource,
      version: params.version,
    };

    if (status === 'active') {
      values.publishedAt = now;
    }

    const [item] = await this.db
      .insert(nexusRegistryItems)
      .values(values)
      .onConflictDoUpdate({
        set: {
          authorAvatarUrl: params.authorAvatarUrl,
          authorName: params.authorName,
          authorUrl: params.authorUrl,
          category: params.category,
          description: params.description,
          downloadUrl: params.downloadUrl,
          homepageUrl: params.homepageUrl,
          locale: params.locale,
          manifest,
          metadata,
          name: params.name,
          raw,
          repositoryUrl,
          status,
          submittedBy: params.submittedBy,
          tags: params.tags ?? [],
          updatedAt: now,
          upstreamIdentifier,
          upstreamSource,
          version: params.version,
          ...(status === 'active' ? { publishedAt: now } : {}),
        },
        target: [nexusRegistryItems.kind, nexusRegistryItems.source, nexusRegistryItems.identifier],
      })
      .returning();

    const hydrated =
      item?.kind === 'skill'
        ? await this.ensureSkillContent(item, params.submittedBy)
        : item;

    return { created: !existing, item: hydrated ?? item };
  };

  updateStatus = async (
    id: string,
    params: NexusRegistryStatusUpdateParams,
    options: { userId?: string } = {},
  ): Promise<NexusRegistryItem | undefined> => {
    const existing = await this.getById(id);
    if (!existing) return;

    if (params.status === 'active') {
      await this.ensureSkillContent(existing, options.userId || existing.submittedBy || undefined);
    }

    const nextMetadata = mergeMetadata(toPlainObject(existing.metadata), params.metadata);
    const [item] = await this.db
      .update(nexusRegistryItems)
      .set({
        metadata: nextMetadata,
        publishedAt:
          params.status === 'active' ? (existing.publishedAt ?? new Date()) : existing.publishedAt,
        status: params.status,
        updatedAt: new Date(),
      })
      .where(eq(nexusRegistryItems.id, id))
      .returning();

    return item;
  };

  getScanById = async (scanId: string): Promise<NexusRegistrySafetyScanItem | undefined> => {
    const [scan] = await this.db
      .select()
      .from(nexusRegistrySafetyScans)
      .where(eq(nexusRegistrySafetyScans.id, scanId))
      .limit(1);
    return scan;
  };

  /**
   * Batch-fetch the most recent safety scan for each item id. Single query (inArray +
   * ORDER BY createdAt DESC, first row per item wins) so the review queue avoids N+1.
   * Items with no scan yet are simply absent from the Map.
   */
  getLatestScansForItems = async (
    itemIds: string[],
  ): Promise<Map<string, NexusRegistrySafetyScanItem>> => {
    if (itemIds.length === 0) return new Map();
    const scans = await this.db
      .select()
      .from(nexusRegistrySafetyScans)
      .where(inArray(nexusRegistrySafetyScans.itemId, itemIds))
      .orderBy(desc(nexusRegistrySafetyScans.createdAt));

    const latest = new Map<string, NexusRegistrySafetyScanItem>();
    for (const scan of scans) {
      if (!latest.has(scan.itemId)) latest.set(scan.itemId, scan);
    }
    return latest;
  };

  runSafetyScan = async (
    item: NexusRegistryItem,
    trigger: 'cron' | 'rescan' | 'submit' | 'update' = 'submit',
  ): Promise<{ scan: NexusRegistrySafetyScanItem; scanId: string }> => {
    const raw = toPlainObject(item.raw);
    const content = typeof raw.content === 'string' ? raw.content : undefined;
    const manifest = toPlainObject(item.manifest);
    const startedAt = Date.now();
    const result = await analyzeRegistrySafety(this.db, {
      content,
      description: item.description || undefined,
      identifier: item.identifier,
      kind: item.kind,
      manifest,
      name: item.name,
      raw,
      repositoryUrl: item.repositoryUrl,
      resources: toPlainObject(raw.resources) as Record<string, { size: number }>,
      submittedBy: item.submittedBy,
    });
    const contentHash = computeContentHash({ content, manifest });

    const [scan] = await this.db
      .insert(nexusRegistrySafetyScans)
      .values({
        contentHash,
        durationMs: Date.now() - startedAt,
        itemId: item.id,
        riskScore: result.riskScore,
        risks: result.risks,
        trigger,
        verdict: result.verdict,
      })
      .returning();

    if (!scan) throw new Error(`Failed to persist safety scan for item ${item.id}`);
    return { scan, scanId: scan.id };
  };

  recordReviewAction = async (input: {
    action: ReviewAction;
    actor: ReviewActor;
    ipAddress?: string;
    item: NexusRegistryItem;
    reason?: string;
    reviewerId: string;
    riskSnapshot?: { flags?: string[]; riskScore?: number; verdict?: string };
    scanId?: string;
    userAgent?: string;
  }): Promise<NexusRegistryReviewActionItem> => {
    const [row] = await this.db
      .insert(nexusRegistryReviewActions)
      .values({
        action: input.action,
        actor: input.actor,
        ipAddress: input.ipAddress,
        itemId: input.item.id,
        itemIdentifier: input.item.identifier,
        itemName: input.item.name,
        reason: input.reason,
        reviewerId: input.reviewerId,
        riskSnapshot: input.riskSnapshot,
        scanId: input.scanId,
        userAgent: input.userAgent,
      })
      .returning();

    if (!row) throw new Error(`Failed to record review action for item ${input.item.id}`);
    return row;
  };

  /**
   * Run (or reuse) a safety scan, apply the verdict→action decision, and — when the
   * decision is automated — persist a review_action row and flip the item status.
   * Non-automated decisions leave the item in `pending` for a human reviewer.
   */
  decideAndApply = async (
    itemId: string,
    options: { scanId?: string; trigger?: 'cron' | 'rescan' | 'submit' | 'update' } = {},
  ): Promise<{ decision: ReviewDecision; scanId?: string }> => {
    const item = await this.getById(itemId);
    if (!item) throw new Error(`Nexus registry item ${itemId} not found`);

    const staticFlags = readOrganizerFlags(item);

    // Hard rule short-circuit: a possible secret auto-rejects WITHOUT spending an LLM scan,
    // since secret detection is owned by the static organizer regex (see decide.ts).
    if (staticFlags.includes('possible-secret')) {
      const decision: ReviewDecision = {
        action: 'reject',
        actor: 'auto',
        automated: true,
        reason: 'Static scan flagged a possible secret; auto-rejected before LLM review.',
      };
      await this.recordReviewAction({
        action: 'reject',
        actor: 'auto',
        item,
        reason: decision.reason,
        reviewerId: AUTO_REVIEWER_ID,
        riskSnapshot: { flags: staticFlags },
      });
      await this.updateStatus(itemId, { id: itemId, status: 'rejected' });
      return { decision };
    }

    let scanId = options.scanId;
    let scan = scanId ? await this.getScanById(scanId) : undefined;
    if (!scan) {
      const result = await this.runSafetyScan(item, options.trigger ?? 'submit');
      scanId = result.scanId;
      scan = result.scan;
    }

    const decision = decideReview({
      isOfficialSource: item.source === 'official',
      riskScore: scan?.riskScore,
      staticFlags,
      thresholds: parseThresholds(process.env.NEXUS_REGISTRY_RISK_THRESHOLDS),
      trustedUpstreams: parseTrustedUpstreams(process.env.NEXUS_TRUSTED_UPSTREAMS),
      upstreamOwner: extractGithubOwner(item.repositoryUrl),
      verdict: scan?.verdict as SafetyVerdict | undefined,
    });

    if (decision.automated) {
      const targetStatus = decision.action === 'approve' ? 'active' : 'rejected';
      await this.recordReviewAction({
        action: decision.action,
        actor: 'auto',
        item,
        reason: decision.reason,
        reviewerId: AUTO_REVIEWER_ID,
        riskSnapshot: { flags: staticFlags, riskScore: scan?.riskScore, verdict: scan?.verdict },
        scanId,
      });
      await this.updateStatus(itemId, { id: itemId, status: targetStatus });
    }

    return { decision, scanId };
  };

  /**
   * Cron entry point: scan + auto-decide every pending user submission. Automated
   * decisions flip the item to active/rejected (with an audit row); non-automated ones
   * stay pending for a human. Bounded by `limit` to keep each cron tick's LLM cost sane.
   */
  reviewPendingItems = async (
    params: { limit?: number } = {},
  ): Promise<{
    autoApproved: number;
    autoRejected: number;
    errors: Array<{ id: string; identifier: string; message: string }>;
    needsReview: number;
    processedCount: number;
  }> => {
    const limit = Math.min(100, Math.max(1, params.limit ?? 20));
    const items = await this.db
      .select()
      .from(nexusRegistryItems)
      .where(and(eq(nexusRegistryItems.status, 'pending'), eq(nexusRegistryItems.source, 'user')))
      .orderBy(desc(nexusRegistryItems.createdAt))
      .limit(limit);

    let autoApproved = 0;
    let autoRejected = 0;
    let needsReview = 0;
    const errors: Array<{ id: string; identifier: string; message: string }> = [];

    for (const item of items) {
      try {
        const { decision } = await this.decideAndApply(item.id, { trigger: 'cron' });
        if (decision.automated) {
          if (decision.action === 'approve') autoApproved += 1;
          else autoRejected += 1;
        } else {
          needsReview += 1;
        }
      } catch (error) {
        log('reviewPendingItems failed for %s: %O', item.identifier, error);
        errors.push({
          id: item.id,
          identifier: item.identifier,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { autoApproved, autoRejected, errors, needsReview, processedCount: items.length };
  };

  backfillSkills = async (
    params: NexusRegistryBackfillSkillsParams & { userId?: string } = {},
  ): Promise<NexusRegistryBackfillSkillsResponse> => {
    const limit = Math.min(100, Math.max(1, params.limit ?? 50));
    const conditions = [eq(nexusRegistryItems.kind, 'skill')];
    if (params.source) conditions.push(eq(nexusRegistryItems.source, params.source));
    if (params.status) conditions.push(eq(nexusRegistryItems.status, params.status));

    const items = await this.db
      .select()
      .from(nexusRegistryItems)
      .where(and(...conditions))
      .orderBy(desc(nexusRegistryItems.updatedAt))
      .limit(limit);

    let processedCount = 0;
    let skippedCount = 0;
    let updatedCount = 0;
    const errors: NexusRegistryBackfillSkillsResponse['errors'] = [];

    for (const item of items) {
      if (!skillNeedsHydration(item)) {
        skippedCount += 1;
        continue;
      }

      processedCount += 1;
      const before = snapshotSkillFields(item);

      try {
        const updated = await this.ensureSkillContent(
          item,
          params.userId || item.submittedBy || undefined,
        );
        const after = snapshotSkillFields(updated ?? item);

        if (before === after) {
          skippedCount += 1;
        } else {
          updatedCount += 1;
        }
      } catch (error) {
        log('Failed to backfill skill metadata for %s: %O', item.identifier, error);
        errors.push({
          id: item.id,
          identifier: item.identifier,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      errors,
      failedCount: errors.length,
      processedCount,
      skippedCount,
      totalCount: items.length,
      updatedCount,
    };
  };

  listPlugins = async (
    params: {
      category?: string;
      page?: number;
      pageSize?: number;
      q?: string;
    } = {},
  ): Promise<PluginListResponse | undefined> => {
    if (!(await this.hasActiveItems('plugin'))) return;

    const shouldIgnoreCategory = !params.category || ['all', 'discover'].includes(params.category);
    const result = await this.list({
      category: shouldIgnoreCategory ? undefined : params.category,
      kind: 'plugin',
      page: params.page,
      pageSize: params.pageSize,
      q: params.q,
      status: 'active',
    });

    return {
      currentPage: result.currentPage,
      items: result.items.map(toPluginItem),
      pageSize: result.pageSize,
      totalCount: result.totalCount,
      totalPages: result.totalPages,
    };
  };

  getSkillDetail = async (identifier: string): Promise<DiscoverSkillDetail | undefined> => {
    // Read path stays pure: no hydration/LLM writes here. Skill content is hydrated on
    // submit/approve (write paths) and by the periodic hydrate cron. If a skill has not yet
    // been hydrated, toSkillDetail falls back to stored description/manifest fields.
    const item = await this.getByIdentifier({ identifier, kind: 'skill', status: 'active' });
    if (!item) return undefined;
    const related = await this.buildSkillRelated(item);
    return toSkillDetail(item, related);
  };

  getMcpDetail = async (identifier: string): Promise<DiscoverMcpDetail | undefined> => {
    const item = await this.getByIdentifier({ identifier, kind: 'mcp', status: 'active' });
    return item ? toMcpDetail(item) : undefined;
  };

  getPluginDetail = async (identifier: string): Promise<DiscoverPluginDetail | undefined> => {
    const item = await this.getByIdentifier({ identifier, kind: 'plugin', status: 'active' });
    return item ? toPluginDetail(item) : undefined;
  };

  hasActiveItems = async (kind: NexusRegistryKind): Promise<boolean> => {
    const [{ value = 0 } = { value: 0 }] = await this.db
      .select({ value: count() })
      .from(nexusRegistryItems)
      .where(and(eq(nexusRegistryItems.kind, kind), eq(nexusRegistryItems.status, 'active')));

    return value > 0;
  };

  listMcp = async (
    params: {
      category?: string;
      page?: number;
      pageSize?: number;
      q?: string;
    } = {},
  ): Promise<McpListResponse | undefined> => {
    if (!(await this.hasActiveItems('mcp'))) return;

    const shouldIgnoreCategory = !params.category || ['all', 'discover'].includes(params.category);
    const result = await this.list({
      category: shouldIgnoreCategory ? undefined : params.category,
      kind: 'mcp',
      page: params.page,
      pageSize: params.pageSize,
      q: params.q,
      status: 'active',
    });
    const categories = await this.listCategories('mcp', { q: params.q });

    return {
      categories: categories.map((item) => item.category),
      currentPage: result.currentPage,
      items: result.items.map(toMcpItem),
      pageSize: result.pageSize,
      totalCount: result.totalCount,
      totalPages: result.totalPages,
    };
  };

  listSkills = async (
    params: {
      category?: string;
      page?: number;
      pageSize?: number;
      q?: string;
    } = {},
  ): Promise<SkillListResponse | undefined> => {
    if (!(await this.hasActiveItems('skill'))) return;

    const shouldIgnoreCategory = !params.category || params.category === 'all';
    const result = await this.list({
      category: shouldIgnoreCategory ? undefined : params.category,
      kind: 'skill',
      page: params.page,
      pageSize: params.pageSize,
      q: params.q,
      status: 'active',
    });

    return {
      categories: await this.listCategories('skill', { q: params.q }),
      currentPage: result.currentPage,
      items: result.items.map(toSkillItem),
      pageSize: result.pageSize,
      totalCount: result.totalCount,
      totalPages: result.totalPages,
    };
  };

  listCategories = async (
    kind: Extract<NexusRegistryKind, 'mcp' | 'skill' | 'plugin'>,
    params: { q?: string } = {},
  ): Promise<SkillCategoryItem[]> => {
    if (!(await this.hasActiveItems(kind))) return [];

    const conditions = [eq(nexusRegistryItems.kind, kind), eq(nexusRegistryItems.status, 'active')];
    if (params.q?.trim()) {
      const q = `%${params.q.trim()}%`;
      conditions.push(
        or(ilike(nexusRegistryItems.name, q), ilike(nexusRegistryItems.description, q))!,
      );
    }

    const rows = await this.db
      .select({
        category: nexusRegistryItems.category,
        count: count(),
      })
      .from(nexusRegistryItems)
      .where(and(...conditions))
      .groupBy(nexusRegistryItems.category);

    return rows
      .filter((item): item is { category: string; count: number } => Boolean(item.category))
      .map((item) => ({ category: item.category, count: item.count }));
  };

  getLatestSyncRun = async (kind?: 'all' | 'mcp' | 'skill') => {
    const [run] = await this.db
      .select()
      .from(nexusRegistrySyncRuns)
      .where(kind ? eq(nexusRegistrySyncRuns.kind, kind) : undefined)
      .orderBy(desc(nexusRegistrySyncRuns.startedAt))
      .limit(1);

    return run;
  };

  syncOfficial = async (
    params: NexusRegistrySyncParams = {},
  ): Promise<NexusRegistrySyncResponse> => {
    const kinds: Extract<NexusRegistryKind, 'mcp' | 'skill'>[] = params.kinds?.length
      ? params.kinds
      : ['mcp', 'skill'];
    const runKind: 'all' | 'mcp' | 'skill' = kinds.length === 1 ? kinds[0] : 'all';
    const [run] = await this.db
      .insert(nexusRegistrySyncRuns)
      .values({
        kind: runKind,
        metadata: {
          kinds,
          locale: params.locale,
          maxPages: params.maxPages ?? DEFAULT_MAX_PAGES,
          pageSize: params.pageSize ?? DEFAULT_PAGE_SIZE,
        },
        source: 'lobehub',
        status: 'running',
      })
      .returning();

    try {
      let insertedCount = 0;
      let updatedCount = 0;

      for (const kind of kinds) {
        const result =
          kind === 'mcp'
            ? await this.syncOfficialMcp(run.id, params)
            : await this.syncOfficialSkills(run.id, params);

        insertedCount += result.insertedCount;
        updatedCount += result.updatedCount;
      }

      const [completedRun] = await this.db
        .update(nexusRegistrySyncRuns)
        .set({
          completedAt: new Date(),
          insertedCount,
          status: 'success',
          updatedAt: new Date(),
          updatedCount,
        })
        .where(eq(nexusRegistrySyncRuns.id, run.id))
        .returning();

      return { insertedCount, run: completedRun, updatedCount };
    } catch (error) {
      log('syncOfficial failed: %O', error);

      const [failedRun] = await this.db
        .update(nexusRegistrySyncRuns)
        .set({
          completedAt: new Date(),
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
          status: 'failed',
          updatedAt: new Date(),
        })
        .where(eq(nexusRegistrySyncRuns.id, run.id))
        .returning();

      return { insertedCount: 0, run: failedRun, updatedCount: 0 };
    }
  };

  private syncOfficialMcp = async (
    runId: string,
    params: NexusRegistrySyncParams,
  ): Promise<{ insertedCount: number; updatedCount: number }> => {
    const discoverService = new DiscoverService();

    return this.syncPagedOfficialItems({
      fetchPage: (page, pageSize) =>
        discoverService.getMcpList({
          locale: params.locale,
          page,
          pageSize,
        }),
      kind: 'mcp',
      locale: params.locale,
      maxPages: params.maxPages,
      pageSize: params.pageSize,
      runId,
    });
  };

  private syncOfficialSkills = async (
    runId: string,
    params: NexusRegistrySyncParams,
  ): Promise<{ insertedCount: number; updatedCount: number }> => {
    const marketService = new MarketService();

    return this.syncPagedOfficialItems({
      fetchPage: (page, pageSize) =>
        marketService.searchSkill({
          locale: params.locale,
          page,
          pageSize,
        }),
      kind: 'skill',
      locale: params.locale,
      maxPages: params.maxPages,
      pageSize: params.pageSize,
      runId,
    });
  };

  private syncPagedOfficialItems = async ({
    fetchPage,
    kind,
    locale,
    maxPages = DEFAULT_MAX_PAGES,
    pageSize = DEFAULT_PAGE_SIZE,
    runId,
  }: {
    fetchPage: (
      page: number,
      pageSize: number,
    ) => Promise<{ items?: unknown[]; totalPages?: number }>;
    kind: Extract<NexusRegistryKind, 'mcp' | 'skill'>;
    locale?: string;
    maxPages?: number;
    pageSize?: number;
    runId: string;
  }): Promise<{ insertedCount: number; updatedCount: number }> => {
    let insertedCount = 0;
    let updatedCount = 0;

    for (let page = 1; page <= maxPages; page += 1) {
      const response = await fetchPage(page, pageSize);
      const rawItems = response.items ?? [];
      if (rawItems.length === 0) break;

      const items = rawItems.map((item) => normalizeOfficialItem(kind, item, { locale, runId }));
      const identifiers = items.map((item) => item.identifier);
      const existing = await this.db
        .select({ identifier: nexusRegistryItems.identifier })
        .from(nexusRegistryItems)
        .where(
          and(
            eq(nexusRegistryItems.kind, kind),
            eq(nexusRegistryItems.source, 'official'),
            inArray(nexusRegistryItems.identifier, identifiers),
          ),
        );
      const existingIdentifiers = new Set(existing.map((item) => item.identifier));

      insertedCount += identifiers.filter(
        (identifier) => !existingIdentifiers.has(identifier),
      ).length;
      updatedCount += identifiers.filter((identifier) =>
        existingIdentifiers.has(identifier),
      ).length;

      for (const item of items) {
        await this.db
          .insert(nexusRegistryItems)
          .values(item)
          .onConflictDoUpdate({
            set: {
              authorAvatarUrl: item.authorAvatarUrl,
              authorName: item.authorName,
              authorUrl: item.authorUrl,
              category: item.category,
              description: item.description,
              downloadUrl: item.downloadUrl,
              homepageUrl: item.homepageUrl,
              locale: item.locale,
              manifest: item.manifest,
              metadata: item.metadata,
              name: item.name,
              publishedAt: item.publishedAt,
              raw: item.raw,
              repositoryUrl: item.repositoryUrl,
              status: 'active',
              syncRunId: runId,
              tags: item.tags,
              upstreamIdentifier: item.upstreamIdentifier,
              upstreamSource: item.upstreamSource,
              updatedAt: new Date(),
              version: item.version,
            },
            target: [
              nexusRegistryItems.kind,
              nexusRegistryItems.source,
              nexusRegistryItems.identifier,
            ],
          });
      }

      if (response.totalPages && page >= response.totalPages) break;
    }

    return { insertedCount, updatedCount };
  };

  private async buildSkillRelated(item: NexusRegistryItem): Promise<DiscoverSkillItem[]> {
    const raw = toPlainObject(item.raw);
    const ai = readAiMetadata(raw);
    const relatedSeeds = Array.isArray(ai.related) ? ai.related : [];
    const relatedIdentifiers = new Set(
      relatedSeeds
        .map((seed) => readString(toPlainObject(seed), ['identifier']))
        .filter((value): value is string => Boolean(value)),
    );
    const relatedNames = new Set(
      relatedSeeds
        .map((seed) => readString(toPlainObject(seed), ['name']))
        .filter((value): value is string => Boolean(value)),
    );
    const tagSet = new Set(item.tags ?? []);
    const category = readString(raw, ['category']) || readString(ai, ['category']) || item.category;

    const candidates = await this.db
      .select()
      .from(nexusRegistryItems)
      .where(and(eq(nexusRegistryItems.kind, 'skill'), eq(nexusRegistryItems.status, 'active')))
      .limit(200);

    const scored = candidates
      .filter((candidate) => candidate.id !== item.id)
      .map((candidate) => {
        const candidateRaw = toPlainObject(candidate.raw);
        const candidateAi = readAiMetadata(candidateRaw);
        const candidateTags = new Set(candidate.tags ?? []);
        let score = 0;

        if (relatedIdentifiers.has(candidate.identifier)) score += 100;
        if (relatedNames.has(candidate.name)) score += 60;
        if (category && (candidate.category || readString(candidateAi, ['category'])) === category) {
          score += 20;
        }

        const sharedTags = [...tagSet].filter((tag) => candidateTags.has(tag)).length;
        score += sharedTags * 8;

        const content = [
          candidate.name,
          candidate.description,
          readString(candidateRaw, ['summary']),
          readString(candidateAi, ['summary']),
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();

        for (const seed of relatedNames) {
          if (seed && content.includes(seed.toLowerCase())) score += 12;
        }

        return { candidate, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map(({ candidate }) => toSkillItem(candidate) as DiscoverSkillItem);

    return scored;
  }
}
