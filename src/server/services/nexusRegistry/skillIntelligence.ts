import { DEFAULT_MINI_SYSTEM_AGENT_ITEM } from '@lobechat/const';
import { type LobeChatDatabase } from '@lobechat/database';
import { type GenerateObjectSchema } from '@lobechat/model-runtime';
import { RequestTrigger, SkillCategory } from '@lobechat/types';
import debug from 'debug';
import { z } from 'zod';

import { UserModel } from '@/database/models/user';
import { initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';
import type { NexusRegistryKind } from '@/types/nexusRegistry';

const log = debug('nexus:registry:skill-intelligence');

const MAX_CONTENT_CHARS = 12_000;
const ANALYSIS_USER_ID = 'INTERNAL_SERVICE';

const skillCategoryValues = Object.values(SkillCategory).filter(
  (value) => value !== SkillCategory.All,
) as string[];

const SkillIntelligenceGenerateObjectSchema = {
  name: 'nexus_skill_intelligence',
  schema: {
    additionalProperties: false,
    properties: {
      category: {
        description: 'Best matching skill category slug, or empty string if no category fits.',
        type: 'string',
      },
      installation: {
        additionalProperties: false,
        properties: {
          agent: {
            description:
              'A concise prompt for an agent to use the skill, including reading SKILL.md and resources.',
            type: 'string',
          },
          human: {
            description:
              'A short human-oriented installation note that explains where to get the skill files and how to keep SKILL.md with its resources.',
            type: 'string',
          },
        },
        required: ['agent', 'human'],
        type: 'object',
      },
      related: {
        items: {
          additionalProperties: false,
          properties: {
            identifier: {
              description: 'Best matching skill identifier, when it is obvious.',
              type: 'string',
            },
            name: {
              description: 'Display name of the related skill candidate.',
              type: 'string',
            },
            reason: {
              description: 'Short reason this skill is related.',
              type: 'string',
            },
          },
          required: ['name'],
          type: 'object',
        },
        maxItems: 6,
        type: 'array',
      },
      summary: {
        description: 'A short summary suitable for the skill overview and list card.',
        type: 'string',
      },
      tags: {
        items: {
          type: 'string',
        },
        maxItems: 8,
        type: 'array',
      },
    },
    required: ['category', 'installation', 'summary', 'tags'],
    type: 'object',
  },
  strict: true,
} satisfies GenerateObjectSchema;

const SECRET_PATTERNS = [
  /sk-[\w-]{20,}/i,
  /AKIA[0-9A-Z]{16}/,
  /xox[baprs]-[\w-]+/i,
  /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/i,
  /\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*["']?[^\s"']{8,}/i,
];

const trimText = (value?: string): string | undefined => {
  const text = value?.replaceAll(/\s+/g, ' ').trim();
  return text || undefined;
};

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

const readTags = (...groups: Array<string[] | undefined>): string[] => {
  const tags = groups
    .flatMap((group) => group ?? [])
    .map((tag) => tag.trim())
    .filter(Boolean);

  return [...new Set(tags)].slice(0, 8);
};

const redactSensitiveText = (value: string) =>
  SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, '[REDACTED]'), value);

const limitText = (value: string, max = MAX_CONTENT_CHARS) => {
  if (value.length <= max) return value;
  return `${value.slice(0, max).trim()}\n\n[TRUNCATED]`;
};

const extractMarkdownDescription = (content?: string): string | undefined => {
  if (!content) return;

  const paragraph = content
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#') && !line.startsWith('---'));

  return trimText(paragraph);
};

const normalizeCategory = (value?: string): string | undefined => {
  if (!value) return;

  const normalized = value.trim();
  return skillCategoryValues.includes(normalized) ? normalized : undefined;
};

const buildFallbackInstallationPrompt = (input: {
  description?: string;
  identifier: string;
  name: string;
  resourceCount: number;
}) => {
  const parts = [
    `You are an agent using the ${input.name} skill.`,
    `Skill identifier: ${input.identifier}.`,
    input.description ? `Summary: ${input.description}` : undefined,
    `Read SKILL.md first, then inspect the ${input.resourceCount} attached resource file(s) before answering.`,
    'Follow the skill instructions exactly and stay within the skill scope.',
  ].filter(Boolean);

  return parts.join('\n\n');
};

const buildFallbackHumanInstallationNote = (input: {
  identifier: string;
  name: string;
  repositoryUrl?: string | null;
}) =>
  [
    input.repositoryUrl
      ? `Open ${input.repositoryUrl} and install or copy the ${input.name} skill files into your agent skill directory.`
      : `Install ${input.name} from the Qingzhou skill page or import the ${input.identifier} skill package manually.`,
    'Keep SKILL.md together with any resource files shipped with the skill.',
  ].join('\n\n');

export interface NexusRegistrySkillIntelligenceInput {
  content?: string;
  description?: string;
  identifier: string;
  kind: NexusRegistryKind;
  locale?: string;
  manifest?: Record<string, unknown>;
  name: string;
  raw?: Record<string, unknown>;
  repositoryUrl?: string | null;
  resources?: Record<string, { size: number }>;
  submittedBy?: string | null;
  tags?: string[];
}

export interface NexusRegistrySkillIntelligenceResult {
  category?: string;
  installation?: {
    agent: string;
    human?: string;
  };
  related?: Array<{
    identifier?: string;
    name: string;
    reason?: string;
  }>;
  summary?: string;
  tags?: string[];
}

const resolveTaskModelConfig = async (db: LobeChatDatabase, userId: string) => {
  const userModel = new UserModel(db, userId);
  const settings = await userModel.getUserSettings();
  const systemAgent = settings?.systemAgent as
    | Partial<Record<'topic', { model?: string; provider?: string }>>
    | undefined;
  const taskConfig = systemAgent?.topic;

  return {
    model: taskConfig?.model || DEFAULT_MINI_SYSTEM_AGENT_ITEM.model,
    provider: taskConfig?.provider || DEFAULT_MINI_SYSTEM_AGENT_ITEM.provider,
  };
};

const getUserLocale = async (db: LobeChatDatabase, userId: string) => {
  const userInfo = await UserModel.getInfoForAIGeneration(db, userId);
  return userInfo.responseLanguage || 'en-US';
};

const buildPrompt = (input: NexusRegistrySkillIntelligenceInput) => {
  const raw = toPlainObject(input.raw);
  const manifest = toPlainObject(input.manifest);
  const content = redactSensitiveText(
    limitText(
      trimText(input.content) ||
        readString(raw, ['content']) ||
        trimText(input.description) ||
        readString(manifest, ['description', 'summary']) ||
        '',
    ),
  );
  const resourcePaths = Object.keys(toPlainObject(raw.resources)).sort().slice(0, 80);

  return [
    `Skill name: ${input.name}`,
    `Skill identifier: ${input.identifier}`,
    `Skill kind: ${input.kind}`,
    input.repositoryUrl ? `Repository: ${input.repositoryUrl}` : undefined,
    input.locale ? `Target language: ${input.locale}` : undefined,
    content ? `Skill content:\n${content}` : undefined,
    Object.keys(manifest).length > 0
      ? `Manifest:\n${JSON.stringify(manifest, null, 2)}`
      : undefined,
    resourcePaths.length > 0 ? `Resource files:\n${resourcePaths.join('\n')}` : undefined,
    input.tags?.length ? `Current tags: ${input.tags.join(', ')}` : undefined,
  ]
    .filter(Boolean)
    .join('\n\n');
};

const normalizeRelated = (related?: NexusRegistrySkillIntelligenceResult['related']) => {
  const normalized: NonNullable<NexusRegistrySkillIntelligenceResult['related']> = [];

  for (const item of related ?? []) {
    const identifier = trimText(item.identifier);
    const name = trimText(item.name) || identifier || '';
    const reason = trimText(item.reason);

    if (!name) continue;

    normalized.push({
      ...(identifier ? { identifier } : {}),
      name,
      ...(reason ? { reason } : {}),
    });
  }

  return normalized;
};

export const analyzeNexusRegistrySkill = async (
  db: LobeChatDatabase,
  input: NexusRegistrySkillIntelligenceInput,
): Promise<NexusRegistrySkillIntelligenceResult> => {
  const analysisUserId = input.submittedBy?.trim() || ANALYSIS_USER_ID;

  await UserModel.makeSureUserExist(db, analysisUserId);

  try {
    const [{ model, provider }, locale] = await Promise.all([
      resolveTaskModelConfig(db, analysisUserId),
      getUserLocale(db, analysisUserId),
    ]);

    const modelRuntime = await initModelRuntimeFromDB(db, analysisUserId, provider);
    const result = await modelRuntime.generateObject(
      {
        messages: [
          {
            content:
              'You normalize Qingzhou skill metadata. Return only structured data. Keep summaries concise, useful, and in the user locale.',
            role: 'system',
          },
          {
            content: [
              `Locale: ${locale}`,
              `Allowed categories: ${skillCategoryValues.join(', ')}`,
              `Never invent files or capabilities that are not present in the input.`,
              `Prefer exact skill identifiers for related items when obvious.`,
              `Always choose the closest allowed category slug. Use productivity-tasks only when the skill is genuinely generic.`,
              `Generate an agent installation prompt that tells an agent to read SKILL.md and any resources before acting.`,
              `Generate a human installation note for the same skill files without leaving it blank.`,
              buildPrompt({ ...input, locale }),
            ].join('\n\n'),
            role: 'user',
          },
        ],
        model,
        schema: SkillIntelligenceGenerateObjectSchema,
      },
      { metadata: { trigger: RequestTrigger.AgentSignal } },
    );

    const parsed = z
      .object({
        category: z.string().optional(),
        installation: z.object({
          agent: z.string().min(1),
          human: z.string().min(1),
        }),
        related: z
          .array(
            z.object({
              identifier: z.string().optional(),
              name: z.string().min(1),
              reason: z.string().optional(),
            }),
          )
          .optional(),
        summary: z.string().min(1),
        tags: z.array(z.string()).optional(),
      })
      .parse(result);

    const summary = trimText(parsed.summary) || input.description || input.name;
    const category =
      normalizeCategory(parsed.category) ||
      normalizeCategory(readString(toPlainObject(input.raw), ['category'])) ||
      normalizeCategory(readString(toPlainObject(input.manifest), ['category']));
    const tags = readTags(parsed.tags, input.tags, [input.kind]);
    const installationAgent =
      trimText(parsed.installation.agent) ||
      buildFallbackInstallationPrompt({
        description: summary,
        identifier: input.identifier,
        name: input.name,
        resourceCount: Object.keys(input.resources ?? {}).length,
      });

    return {
      category,
      installation: {
        agent: installationAgent,
        human:
          trimText(parsed.installation.human) ||
          buildFallbackHumanInstallationNote({
            identifier: input.identifier,
            name: input.name,
            repositoryUrl: input.repositoryUrl,
          }),
      },
      related: normalizeRelated(parsed.related),
      summary,
      tags,
    };
  } catch (error) {
    log('Failed to analyze skill metadata for %s: %O', input.identifier, error);
    return {
      installation: {
        agent: buildFallbackInstallationPrompt({
          description: input.description,
          identifier: input.identifier,
          name: input.name,
          resourceCount: Object.keys(input.resources ?? {}).length,
        }),
        human: buildFallbackHumanInstallationNote({
          identifier: input.identifier,
          name: input.name,
          repositoryUrl: input.repositoryUrl,
        }),
      },
      summary:
        trimText(input.description) ||
        trimText(readString(toPlainObject(input.manifest), ['description', 'summary'])) ||
        extractMarkdownDescription(input.content) ||
        input.name,
      tags: readTags(input.tags, input.kind === 'skill' ? ['skill'] : undefined),
    };
  }
};
