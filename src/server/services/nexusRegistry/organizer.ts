type AiMode = 'normalize' | 'off' | 'polish';
type RegistryKind = 'mcp' | 'plugin' | 'skill';
type SourceType = 'github' | 'manifest' | 'skill-md' | 'zip';

interface SubmissionArtifact {
  dataBase64?: string;
  fileName?: string;
  mimeType?: string;
  size?: number;
}

interface OrganizeSubmissionInput {
  aiMode?: AiMode;
  artifact?: SubmissionArtifact;
  category?: string;
  content?: string;
  description?: string;
  fileName?: string;
  gitUrl?: string;
  kind: RegistryKind;
  manifest?: Record<string, unknown>;
  name?: string;
  sourceType: SourceType;
  tags?: string[];
}

interface OrganizeSubmissionResult {
  category?: string;
  description?: string;
  manifest?: Record<string, unknown>;
  metadata: Record<string, unknown>;
  name: string;
  raw: Record<string, unknown>;
  tags?: string[];
}

const MAX_DESCRIPTION_LENGTH = 180;

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

const readString = (value: Record<string, unknown> | undefined, keys: string[]) => {
  if (!value) return;

  for (const key of keys) {
    const item = value[key];
    if (typeof item === 'string' && item.trim()) return item.trim();
  }
};

const readTags = (manifest?: Record<string, unknown>): string[] => {
  const tags = manifest?.tags ?? manifest?.keywords;
  if (Array.isArray(tags)) {
    return tags.filter((tag): tag is string => typeof tag === 'string' && Boolean(tag.trim()));
  }

  if (typeof tags === 'string') {
    return tags
      .split(/[,，\s]+/)
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  return [];
};

const uniqueTags = (...groups: (string[] | undefined)[]): string[] | undefined => {
  const tags = groups
    .flatMap((group) => group ?? [])
    .map((tag) => tag.trim())
    .filter(Boolean);

  const result = [...new Set(tags)].slice(0, 8);
  return result.length > 0 ? result : undefined;
};

const extractMarkdownTitle = (content?: string): string | undefined => {
  if (!content) return;
  const title = content.match(/^#\s+(.+)$/m)?.[1];
  return trimText(title);
};

const extractMarkdownDescription = (content?: string): string | undefined => {
  if (!content) return;

  const paragraph = content
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#') && !line.startsWith('---'));

  return trimText(paragraph);
};

const normalizeDescription = (value?: string, mode: AiMode = 'normalize') => {
  const text = trimText(value);
  if (!text) return;
  if (mode === 'off') return text;

  return text.length > MAX_DESCRIPTION_LENGTH
    ? `${text.slice(0, MAX_DESCRIPTION_LENGTH).trim()}...`
    : text;
};

const scanReviewFlags = (input: OrganizeSubmissionInput): string[] => {
  const flags: string[] = [];
  const content = [input.content, JSON.stringify(input.manifest ?? {})].filter(Boolean).join('\n');

  if (content && SECRET_PATTERNS.some((pattern) => pattern.test(content))) {
    flags.push('possible-secret');
  }

  if (input.artifact?.size && input.artifact.size > 5 * 1024 * 1024) {
    flags.push('large-archive');
  }

  if (input.sourceType === 'zip' && !input.artifact?.dataBase64) {
    flags.push('archive-not-inlined');
  }

  return flags;
};

const fallbackName = (input: OrganizeSubmissionInput) => {
  if (input.gitUrl) {
    try {
      const url = new URL(input.gitUrl);
      return url.pathname
        .split('/')
        .filter(Boolean)
        .at(1)
        ?.replace(/\.git$/, '');
    } catch {
      // Ignore invalid URL here; caller validates GitHub URLs before organizing.
    }
  }

  return input.fileName?.replace(/\.(?:zip|md|json)$/i, '') || `${input.kind}-submission`;
};

export const organizeNexusSubmission = (
  input: OrganizeSubmissionInput,
): OrganizeSubmissionResult => {
  const aiMode = input.aiMode ?? 'normalize';
  const manifest = input.manifest ?? {};
  const name =
    trimText(input.name) ||
    readString(manifest, ['title', 'name', 'displayName']) ||
    extractMarkdownTitle(input.content) ||
    fallbackName(input) ||
    `${input.kind}-submission`;
  const description = normalizeDescription(
    input.description ||
      readString(manifest, ['description', 'summary']) ||
      extractMarkdownDescription(input.content),
    aiMode,
  );
  const tags = uniqueTags(input.tags, readTags(manifest), [input.kind, input.sourceType]);
  const reviewFlags = scanReviewFlags(input);
  const raw: Record<string, unknown> = {
    sourceType: input.sourceType,
  };

  if (input.content?.trim()) raw.content = input.content;
  if (Object.keys(manifest).length > 0) raw.manifest = manifest;
  if (input.gitUrl) raw.repositoryUrl = input.gitUrl;
  if (input.artifact) raw.artifact = input.artifact;

  return {
    category: input.category,
    description,
    manifest,
    metadata: {
      organizer: {
        confidence: reviewFlags.length > 0 ? 'needs-review' : 'normal',
        engine: 'nexus-organizer-v1',
        mode: aiMode,
        policy: 'preserve-original-source',
        reviewFlags,
      },
      preview: {
        description,
        kind: input.kind,
        name,
        sourceType: input.sourceType,
        tags,
      },
    },
    name,
    raw,
    tags,
  };
};
