import { LIBRARY_HIDDEN_FILE_SOURCES } from '@lobechat/types';
import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notInArray,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import {
  agents,
  chatGroups,
  DOCUMENT_FOLDER_TYPE,
  documents,
  files,
  knowledgeBaseFiles,
  knowledgeBases,
  messages,
  sessions,
  topics,
} from '../../schemas';
import type { LobeChatDatabase } from '../../type';
import { normalizeInboxAgentMeta, normalizeInboxAgentTitle } from '../../utils/inboxAgent';
import { buildWorkspaceWhere } from '../../utils/workspace';
import { getSearchIndexAlias } from '../searchDocument';
import type {
  AgentSearchResult,
  ChatGroupSearchResult,
  FileSearchResult,
  FolderSearchResult,
  KnowledgeBaseDocumentHit,
  KnowledgeBaseSearchResult,
  MessageSearchResult,
  PageSearchResult,
  SearchBackend,
  SearchBackendCandidate,
  SearchBackendEntity,
  SearchBackendFilters,
  SearchBackendRequest,
  SearchBackendResponse,
  SearchBackendScope,
  TopicSearchResult,
} from './types';

/**
 * Candidate over-fetch keeps authorized lower-ranked hits available when an index still contains
 * a deleted or newly restricted document. PostgreSQL remains the final authorization source.
 */
const CANDIDATE_MULTIPLIER = 4;

export const ELASTICSEARCH_CONVERSATION_QUERY_FIELDS = {
  agents: ['title^5', 'slug^4', 'tags^3', 'description^2', 'system_role'],
  chatGroups: ['title^4', 'description^2', 'content'],
  messages: ['content^2', 'summary'],
  topics: ['title', 'content', 'description'],
} as const;

export type ElasticsearchConversationEntity = keyof typeof ELASTICSEARCH_CONVERSATION_QUERY_FIELDS;

export const isElasticsearchConversationEntity = (
  entity: SearchBackendEntity,
): entity is ElasticsearchConversationEntity =>
  Object.hasOwn(ELASTICSEARCH_CONVERSATION_QUERY_FIELDS, entity);

export const ELASTICSEARCH_RESOURCE_QUERY_FIELDS = {
  files: ['name'],
  knowledgeBases: ['name^4', 'description'],
} as const;

const ELASTICSEARCH_DOCUMENT_QUERY_FIELDS = {
  folder: ['title^4', 'slug^3', 'description^2'],
  knowledgeBaseDocument: ['title^4', 'slug^3', 'content'],
  page: ['title^4', 'slug^3', 'content'],
} as const;

export type ElasticsearchResourceEntity =
  keyof typeof ELASTICSEARCH_RESOURCE_QUERY_FIELDS | 'documents';

export const isElasticsearchResourceEntity = (
  entity: SearchBackendEntity,
): entity is ElasticsearchResourceEntity =>
  entity === 'documents' || Object.hasOwn(ELASTICSEARCH_RESOURCE_QUERY_FIELDS, entity);

export type ElasticsearchSearchEntity =
  ElasticsearchConversationEntity | ElasticsearchResourceEntity;

export const isElasticsearchSearchEntity = (
  entity: SearchBackendEntity,
): entity is ElasticsearchSearchEntity =>
  isElasticsearchConversationEntity(entity) || isElasticsearchResourceEntity(entity);

const messageTopicAgents = alias(agents, 'search_message_topic_agents');
const messageTopicChatGroups = alias(chatGroups, 'search_message_topic_chat_groups');
const messageTopicSessions = alias(sessions, 'search_message_topic_sessions');

export interface ElasticsearchSearchInput {
  body: Record<string, unknown>;
  index: string;
}

export interface ElasticsearchSearchResponse {
  hits: {
    hits: Array<{
      _id: string;
      _score: number | null;
    }>;
  };
}

/** Minimal transport contract so deployments own credentials and HTTP/client policy. */
export interface ElasticsearchSearchClient {
  search: (input: ElasticsearchSearchInput) => Promise<ElasticsearchSearchResponse>;
}

export interface ElasticsearchSearchBackendOptions {
  client: ElasticsearchSearchClient;
  indexNamespace: string;
}

interface CandidateHit extends SearchBackendCandidate {
  rank: number;
}

interface HydratedScore {
  relevance: number;
  score: number;
}

type ElasticsearchSearchResult =
  | AgentSearchResult
  | ChatGroupSearchResult
  | FileSearchResult
  | FolderSearchResult
  | KnowledgeBaseDocumentHit
  | KnowledgeBaseSearchResult
  | MessageSearchResult
  | PageSearchResult
  | TopicSearchResult;

type ElasticsearchDocumentKind = NonNullable<SearchBackendFilters['documentKind']>;
type ElasticsearchCandidateTarget =
  | { documentKind: ElasticsearchDocumentKind; entity: 'documents' }
  | { entity: Exclude<ElasticsearchSearchEntity, 'documents'> };

const DEFAULT_SNIPPET_MAX_LENGTH = 200;
const FILE_DESCRIPTION_MAX_LENGTH = 200;
const KNOWLEDGE_BASE_DOCUMENT_SNIPPET_MAX_LENGTH = 300;

const normalizeQuery = (query: string) =>
  query.trim().replaceAll('-', ' ').split(/\s+/).filter(Boolean).join(' ');

const truncate = (
  content: string | null | undefined,
  maxLength: number = DEFAULT_SNIPPET_MAX_LENGTH,
) => {
  if (!content) return null;
  if (content.length <= maxLength) return content;
  return `${content.slice(0, maxLength)}...`;
};

/** Select one extra character so truncation preserves exact ellipsis behavior without loading full content. */
const documentContentPreview = (maxLength: number) =>
  sql<string | null>`left(${documents.content}, ${maxLength + 1})`;

const visibleParent = (
  foreignKey: Parameters<typeof isNull>[0],
  id: Parameters<typeof isNotNull>[0],
) => or(isNull(foreignKey), isNotNull(id)) as SQL;

/**
 * Elasticsearch candidate provider for the product-search entities migrated in LOBE-13461/13462.
 * Every hit is reloaded through PostgreSQL with current scope and parent visibility checks.
 */
export class ElasticsearchSearchBackend implements SearchBackend {
  readonly key = 'elasticsearch';

  private readonly client: ElasticsearchSearchClient;
  private readonly indexNamespace: string;

  constructor(
    private readonly db: LobeChatDatabase,
    { client, indexNamespace }: ElasticsearchSearchBackendOptions,
  ) {
    const namespace = indexNamespace.trim();
    if (!namespace) throw new Error('Elasticsearch search index namespace is required');

    this.client = client;
    this.indexNamespace = namespace;
  }

  async search(
    request: SearchBackendRequest,
  ): Promise<SearchBackendResponse<ElasticsearchSearchResult>> {
    const entity = request.entity;
    if (!isElasticsearchSearchEntity(entity)) {
      throw new Error(`Unsupported Elasticsearch search entity: ${request.entity}`);
    }

    const query = normalizeQuery(request.query.text);
    if (!query) return { candidates: [], items: [] };
    let target: ElasticsearchCandidateTarget;
    if (entity === 'documents') {
      const documentKind = request.filters.documentKind;
      if (!documentKind) {
        throw new Error('Elasticsearch document search requires a supported document kind');
      }
      target = { documentKind, entity };
    } else {
      target = { entity };
    }
    if (
      target.entity === 'documents' &&
      target.documentKind === 'knowledgeBaseDocument' &&
      !request.filters.knowledgeBaseIds?.length
    ) {
      return { candidates: [], items: [] };
    }

    const hits = await this.searchCandidates(request, target, query);
    const candidates = hits.map(({ id, score }) => ({ id, score }));

    if (request.entity === 'agents') {
      return {
        candidates,
        items: await this.hydrateAgents(hits, request.scope, request.pagination.limit),
      };
    }
    if (request.entity === 'chatGroups') {
      return {
        candidates,
        items: await this.hydrateChatGroups(hits, request.scope, request.pagination.limit),
      };
    }
    if (entity === 'topics') {
      return {
        candidates,
        items: await this.hydrateTopics(
          hits,
          request.scope,
          request.pagination.limit,
          request.filters.agentId,
        ),
      };
    }

    if (entity === 'messages') {
      return {
        candidates,
        items: await this.hydrateMessages(
          hits,
          request.scope,
          request.pagination.limit,
          request.filters.agentId,
        ),
      };
    }
    if (entity === 'files') {
      return {
        candidates,
        items: await this.hydrateFiles(
          hits,
          request.scope,
          request.pagination.limit,
          request.filters.excludeKnowledgeBaseIds,
        ),
      };
    }
    if (entity === 'knowledgeBases') {
      return {
        candidates,
        items: await this.hydrateKnowledgeBases(
          hits,
          request.scope,
          request.pagination.limit,
          request.filters.excludeKnowledgeBaseIds,
        ),
      };
    }
    if (target.entity !== 'documents') {
      throw new Error(`Unsupported Elasticsearch search entity: ${target.entity}`);
    }
    if (target.documentKind === 'folder') {
      return {
        candidates,
        items: await this.hydrateFolders(
          hits,
          request.scope,
          request.pagination.limit,
          request.filters.excludeKnowledgeBaseIds,
        ),
      };
    }
    if (target.documentKind === 'page') {
      return {
        candidates,
        items: await this.hydratePages(
          hits,
          request.scope,
          request.pagination.limit,
          request.filters.excludeKnowledgeBaseIds,
        ),
      };
    }
    if (target.documentKind === 'knowledgeBaseDocument') {
      return {
        candidates,
        items: await this.hydrateKnowledgeBaseDocuments(
          hits,
          request.scope,
          request.pagination.limit,
          request.filters.knowledgeBaseIds ?? [],
        ),
      };
    }

    target.documentKind satisfies never;
    throw new Error(`Unsupported Elasticsearch document kind: ${String(target.documentKind)}`);
  }

  private buildScopeClauses(
    entity: ElasticsearchSearchEntity,
    scope: SearchBackendScope,
  ): { filter: Array<Record<string, unknown>>; mustNot: Array<Record<string, unknown>> } {
    if (!scope.workspaceId) {
      return {
        filter: [{ term: { user_id: scope.userId } }],
        mustNot: [{ exists: { field: 'workspace_id' } }],
      };
    }

    const filter: Array<Record<string, unknown>> = [{ term: { workspace_id: scope.workspaceId } }];
    if (
      entity === 'agents' ||
      entity === 'chatGroups' ||
      entity === 'documents' ||
      entity === 'files' ||
      entity === 'knowledgeBases'
    ) {
      filter.push(
        scope.callerAgentVisibility === 'public'
          ? { term: { visibility: 'public' } }
          : {
              bool: {
                minimum_should_match: 1,
                should: [{ term: { visibility: 'public' } }, { term: { user_id: scope.userId } }],
              },
            },
      );
    }

    return { filter, mustNot: [] };
  }

  private async searchCandidates(
    request: SearchBackendRequest,
    target: ElasticsearchCandidateTarget,
    query: string,
  ): Promise<CandidateHit[]> {
    const { entity } = target;
    const { filter, mustNot } = this.buildScopeClauses(entity, request.scope);
    if (request.filters.agentId && (entity === 'topics' || entity === 'messages')) {
      filter.push({ term: { agent_id: request.filters.agentId } });
    }
    if (entity === 'messages') mustNot.push({ term: { role: 'tool' } });
    if (entity === 'files') {
      mustNot.push(
        { term: { file_type: 'custom/document' } },
        { terms: { source: LIBRARY_HIDDEN_FILE_SOURCES } },
      );
      if (request.filters.excludeKnowledgeBaseIds?.length) {
        mustNot.push({ terms: { knowledge_base_ids: request.filters.excludeKnowledgeBaseIds } });
      }
    }
    if (entity === 'knowledgeBases' && request.filters.excludeKnowledgeBaseIds?.length) {
      mustNot.push({ terms: { id: request.filters.excludeKnowledgeBaseIds } });
    }
    if (target.entity === 'documents') {
      const { documentKind } = target;
      if (documentKind === 'folder') {
        filter.push({ term: { file_type: DOCUMENT_FOLDER_TYPE } });
      } else if (documentKind === 'page') {
        filter.push({ term: { file_type: 'custom/document' } });
      } else if (documentKind === 'knowledgeBaseDocument') {
        filter.push({ terms: { knowledge_base_ids: request.filters.knowledgeBaseIds ?? [] } });
        mustNot.push({ term: { file_type: DOCUMENT_FOLDER_TYPE } });
      } else {
        documentKind satisfies never;
        throw new Error(`Unsupported Elasticsearch document kind: ${String(documentKind)}`);
      }
      if (
        documentKind !== 'knowledgeBaseDocument' &&
        request.filters.excludeKnowledgeBaseIds?.length
      ) {
        mustNot.push({ terms: { knowledge_base_ids: request.filters.excludeKnowledgeBaseIds } });
      }
    }

    const fields =
      target.entity === 'documents'
        ? ELASTICSEARCH_DOCUMENT_QUERY_FIELDS[target.documentKind]
        : isElasticsearchConversationEntity(target.entity)
          ? ELASTICSEARCH_CONVERSATION_QUERY_FIELDS[target.entity]
          : ELASTICSEARCH_RESOURCE_QUERY_FIELDS[target.entity];

    const response = await this.client.search({
      body: {
        _source: false,
        query: {
          bool: {
            filter,
            must: [
              {
                multi_match: {
                  fields,
                  operator: 'and',
                  query,
                  type: 'best_fields',
                },
              },
            ],
            must_not: mustNot,
          },
        },
        size: request.pagination.limit * CANDIDATE_MULTIPLIER,
        sort: [{ _score: 'desc' }, { id: 'asc' }],
      },
      index: getSearchIndexAlias(this.indexNamespace, entity),
    });

    const seen = new Set<string>();
    return response.hits.hits.flatMap((hit, rank) => {
      if (!hit._id || seen.has(hit._id)) return [];
      seen.add(hit._id);
      return [{ id: hit._id, rank, score: hit._score }];
    });
  }

  private attachScores<T extends { id: string }>(rows: T[], hits: CandidateHit[]) {
    const rowById = new Map(rows.map((row) => [row.id, row]));
    const hydrated = hits.flatMap((hit) => {
      const row = rowById.get(hit.id);
      return row ? [{ ...row, rank: hit.rank, score: hit.score ?? 0 }] : [];
    });
    const maxScore = Math.max(0, ...hydrated.map(({ score }) => score));

    return hydrated.map((row): T & CandidateHit & HydratedScore => ({
      ...row,
      relevance: maxScore > 0 ? 1 + 2 * (1 - row.score / maxScore) : 3,
    }));
  }

  private async hydrateAgents(
    hits: CandidateHit[],
    scope: SearchBackendScope,
    limit: number,
  ): Promise<AgentSearchResult[]> {
    if (hits.length === 0) return [];

    const rows = await this.db
      .select({
        avatar: agents.avatar,
        backgroundColor: agents.backgroundColor,
        createdAt: agents.createdAt,
        description: agents.description,
        id: agents.id,
        slug: agents.slug,
        tags: agents.tags,
        title: agents.title,
        updatedAt: agents.updatedAt,
      })
      .from(agents)
      .where(
        and(
          inArray(
            agents.id,
            hits.map(({ id }) => id),
          ),
          buildWorkspaceWhere(scope, agents),
        ),
      );

    return this.attachScores(rows, hits)
      .slice(0, limit)
      .map((row) => {
        const meta = normalizeInboxAgentMeta(
          { avatar: row.avatar, title: row.title },
          { slug: row.slug },
        );

        return {
          avatar: meta.avatar,
          backgroundColor: row.backgroundColor,
          createdAt: row.createdAt,
          description: row.description,
          id: row.id,
          relevance: row.relevance,
          slug: row.slug,
          tags: (row.tags as string[]) || [],
          title: meta.title || '',
          type: 'agent' as const,
          updatedAt: row.updatedAt,
        };
      });
  }

  private async hydrateChatGroups(
    hits: CandidateHit[],
    scope: SearchBackendScope,
    limit: number,
  ): Promise<ChatGroupSearchResult[]> {
    if (hits.length === 0) return [];

    const rows = await this.db
      .select({
        avatar: chatGroups.avatar,
        backgroundColor: chatGroups.backgroundColor,
        createdAt: chatGroups.createdAt,
        description: chatGroups.description,
        id: chatGroups.id,
        title: chatGroups.title,
        updatedAt: chatGroups.updatedAt,
      })
      .from(chatGroups)
      .where(
        and(
          inArray(
            chatGroups.id,
            hits.map(({ id }) => id),
          ),
          buildWorkspaceWhere(scope, chatGroups),
        ),
      );

    return this.attachScores(rows, hits)
      .slice(0, limit)
      .map((row) => ({
        avatar: row.avatar,
        backgroundColor: row.backgroundColor,
        createdAt: row.createdAt,
        description: row.description,
        id: row.id,
        relevance: row.relevance,
        title: row.title || '',
        type: 'chatGroup' as const,
        updatedAt: row.updatedAt,
      }));
  }

  private async hydrateTopics(
    hits: CandidateHit[],
    scope: SearchBackendScope,
    limit: number,
    agentId?: string,
  ): Promise<TopicSearchResult[]> {
    if (hits.length === 0) return [];

    const rows = await this.db
      .select({
        agentAvatar: agents.avatar,
        agentBackgroundColor: agents.backgroundColor,
        agentId: topics.agentId,
        agentMatchedId: agents.id,
        agentSlug: agents.slug,
        agentTitle: agents.title,
        content: topics.content,
        createdAt: topics.createdAt,
        favorite: topics.favorite,
        groupId: topics.groupId,
        groupMatchedId: chatGroups.id,
        id: topics.id,
        sessionId: topics.sessionId,
        sessionMatchedId: sessions.id,
        title: topics.title,
        updatedAt: topics.updatedAt,
      })
      .from(topics)
      .leftJoin(agents, and(eq(topics.agentId, agents.id), buildWorkspaceWhere(scope, agents)))
      .leftJoin(
        chatGroups,
        and(eq(topics.groupId, chatGroups.id), buildWorkspaceWhere(scope, chatGroups)),
      )
      .leftJoin(
        sessions,
        and(eq(topics.sessionId, sessions.id), buildWorkspaceWhere(scope, sessions)),
      )
      .where(
        and(
          inArray(
            topics.id,
            hits.map(({ id }) => id),
          ),
          buildWorkspaceWhere(scope, topics),
          agentId ? eq(topics.agentId, agentId) : undefined,
          visibleParent(topics.agentId, agents.id),
          visibleParent(topics.groupId, chatGroups.id),
          visibleParent(topics.sessionId, sessions.id),
        ),
      );

    return this.attachScores(rows, hits)
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
      .slice(0, limit)
      .map((row) => ({
        agent: row.agentMatchedId
          ? {
              avatar: normalizeInboxAgentMeta(
                { avatar: row.agentAvatar, title: row.agentTitle },
                { slug: row.agentSlug },
              ).avatar,
              backgroundColor: row.agentBackgroundColor,
              title: normalizeInboxAgentTitle(row.agentTitle, { slug: row.agentSlug }),
            }
          : null,
        agentId: row.agentId,
        createdAt: row.createdAt,
        description: truncate(row.content),
        favorite: row.favorite,
        groupId: row.groupId,
        id: row.id,
        relevance: row.relevance,
        sessionId: row.sessionId,
        title: row.title || '',
        type: 'topic' as const,
        updatedAt: row.updatedAt,
      }));
  }

  private async hydrateMessages(
    hits: CandidateHit[],
    scope: SearchBackendScope,
    limit: number,
    agentId?: string,
  ): Promise<MessageSearchResult[]> {
    if (hits.length === 0) return [];

    const rows = await this.db
      .select({
        agentId: messages.agentId,
        agentMatchedId: agents.id,
        agentSlug: agents.slug,
        agentTitle: agents.title,
        content: messages.content,
        createdAt: messages.createdAt,
        groupId: messages.groupId,
        groupMatchedId: chatGroups.id,
        id: messages.id,
        model: messages.model,
        role: messages.role,
        sessionId: messages.sessionId,
        sessionMatchedId: sessions.id,
        topicId: messages.topicId,
        topicMatchedId: topics.id,
        updatedAt: messages.updatedAt,
      })
      .from(messages)
      .leftJoin(agents, and(eq(messages.agentId, agents.id), buildWorkspaceWhere(scope, agents)))
      .leftJoin(
        chatGroups,
        and(eq(messages.groupId, chatGroups.id), buildWorkspaceWhere(scope, chatGroups)),
      )
      .leftJoin(
        sessions,
        and(eq(messages.sessionId, sessions.id), buildWorkspaceWhere(scope, sessions)),
      )
      .leftJoin(topics, and(eq(messages.topicId, topics.id), buildWorkspaceWhere(scope, topics)))
      .leftJoin(
        messageTopicAgents,
        and(
          eq(topics.agentId, messageTopicAgents.id),
          buildWorkspaceWhere(scope, messageTopicAgents),
        ),
      )
      .leftJoin(
        messageTopicChatGroups,
        and(
          eq(topics.groupId, messageTopicChatGroups.id),
          buildWorkspaceWhere(scope, messageTopicChatGroups),
        ),
      )
      .leftJoin(
        messageTopicSessions,
        and(
          eq(topics.sessionId, messageTopicSessions.id),
          buildWorkspaceWhere(scope, messageTopicSessions),
        ),
      )
      .where(
        and(
          inArray(
            messages.id,
            hits.map(({ id }) => id),
          ),
          buildWorkspaceWhere(scope, messages),
          ne(messages.role, 'tool'),
          agentId ? eq(messages.agentId, agentId) : undefined,
          visibleParent(messages.agentId, agents.id),
          visibleParent(messages.groupId, chatGroups.id),
          visibleParent(messages.sessionId, sessions.id),
          visibleParent(messages.topicId, topics.id),
          /** A topic is itself a permission container; validate its parents even when the message omits direct foreign keys. */
          visibleParent(topics.agentId, messageTopicAgents.id),
          visibleParent(topics.groupId, messageTopicChatGroups.id),
          visibleParent(topics.sessionId, messageTopicSessions.id),
        ),
      );

    return this.attachScores(rows, hits)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, limit)
      .map((row) => ({
        agentId: row.agentId,
        content: row.content || '',
        createdAt: row.createdAt,
        description:
          normalizeInboxAgentTitle(row.agentTitle, { slug: row.agentSlug }) || 'General Chat',
        groupId: row.groupId,
        id: row.id,
        model: row.model,
        relevance: row.relevance,
        role: row.role,
        title: truncate(row.content) || '',
        topicId: row.topicId,
        type: 'message' as const,
        updatedAt: row.updatedAt,
      }));
  }

  /**
   * Omitting scope is intentionally conservative for exclusion checks: any restricted membership
   * hides the result. Authorization checks must pass scope so unrelated memberships cannot grant access.
   */
  private async getKnowledgeBaseIdsByFile(
    fileIds: string[],
    scope?: SearchBackendScope,
  ): Promise<Map<string, string[]>> {
    if (fileIds.length === 0) return new Map();

    const rows = await this.db
      .select({
        fileId: knowledgeBaseFiles.fileId,
        knowledgeBaseId: knowledgeBaseFiles.knowledgeBaseId,
      })
      .from(knowledgeBaseFiles)
      .where(
        and(
          inArray(knowledgeBaseFiles.fileId, fileIds),
          scope ? buildWorkspaceWhere(scope, knowledgeBaseFiles) : undefined,
        ),
      );
    const idsByFile = new Map<string, Set<string>>();
    for (const { fileId, knowledgeBaseId } of rows) {
      const ids = idsByFile.get(fileId) ?? new Set<string>();
      ids.add(knowledgeBaseId);
      idsByFile.set(fileId, ids);
    }

    return new Map(
      [...idsByFile.entries()].map(([fileId, ids]) => [fileId, [...ids].sort()] as const),
    );
  }

  private async hydrateFiles(
    hits: CandidateHit[],
    scope: SearchBackendScope,
    limit: number,
    excludeKnowledgeBaseIds: string[] = [],
  ): Promise<FileSearchResult[]> {
    if (hits.length === 0) return [];

    const rows = await this.db
      .select({
        createdAt: files.createdAt,
        fileType: files.fileType,
        id: files.id,
        name: files.name,
        size: files.size,
        updatedAt: files.updatedAt,
        url: files.url,
      })
      .from(files)
      .where(
        and(
          inArray(
            files.id,
            hits.map(({ id }) => id),
          ),
          buildWorkspaceWhere(scope, files),
          ne(files.fileType, 'custom/document'),
          or(isNull(files.source), notInArray(files.source, LIBRARY_HIDDEN_FILE_SOURCES)),
        ),
      );
    const fileIds = rows.map(({ id }) => id);
    const knowledgeBaseIdsByFile = await this.getKnowledgeBaseIdsByFile(fileIds);
    const excluded = new Set(excludeKnowledgeBaseIds);
    const authorizedRows = rows.filter(({ id }) =>
      (knowledgeBaseIdsByFile.get(id) ?? []).every(
        (knowledgeBaseId) => !excluded.has(knowledgeBaseId),
      ),
    );
    const scoredRows = this.attachScores(authorizedRows, hits).slice(0, limit);
    const selectedFileIds = scoredRows.map(({ id }) => id);
    const documentRows =
      selectedFileIds.length === 0
        ? []
        : await this.db
            .select({
              content: documentContentPreview(FILE_DESCRIPTION_MAX_LENGTH),
              fileId: documents.fileId,
              id: documents.id,
            })
            .from(documents)
            .where(
              and(
                inArray(documents.fileId, selectedFileIds),
                buildWorkspaceWhere(scope, documents),
              ),
            );
    const contentByFile = new Map<string, string | null>();
    for (const row of documentRows.toSorted((left, right) => left.id.localeCompare(right.id))) {
      if (row.fileId && !contentByFile.has(row.fileId)) contentByFile.set(row.fileId, row.content);
    }

    return scoredRows.map((row) => ({
      createdAt: row.createdAt,
      description: truncate(contentByFile.get(row.id), FILE_DESCRIPTION_MAX_LENGTH),
      fileType: row.fileType,
      id: row.id,
      knowledgeBaseId: knowledgeBaseIdsByFile.get(row.id)?.[0] ?? null,
      name: row.name,
      relevance: row.relevance,
      size: row.size,
      title: row.name,
      type: 'file' as const,
      updatedAt: row.updatedAt,
      url: row.url,
    }));
  }

  private async hydrateFolders(
    hits: CandidateHit[],
    scope: SearchBackendScope,
    limit: number,
    excludeKnowledgeBaseIds: string[] = [],
  ): Promise<FolderSearchResult[]> {
    if (hits.length === 0) return [];

    const rows = await this.db
      .select({
        createdAt: documents.createdAt,
        description: documents.description,
        fileId: documents.fileId,
        filename: documents.filename,
        id: documents.id,
        knowledgeBaseId: documents.knowledgeBaseId,
        slug: documents.slug,
        title: documents.title,
        updatedAt: documents.updatedAt,
      })
      .from(documents)
      .where(
        and(
          inArray(
            documents.id,
            hits.map(({ id }) => id),
          ),
          buildWorkspaceWhere(scope, documents),
          eq(documents.fileType, DOCUMENT_FOLDER_TYPE),
        ),
      );
    const knowledgeBaseIdsByFile = await this.getKnowledgeBaseIdsByFile(
      rows.flatMap(({ fileId }) => (fileId ? [fileId] : [])),
    );
    const excluded = new Set(excludeKnowledgeBaseIds);
    const authorizedRows = rows.filter((row) => {
      const knowledgeBaseIds = [
        ...(row.knowledgeBaseId ? [row.knowledgeBaseId] : []),
        ...(row.fileId ? (knowledgeBaseIdsByFile.get(row.fileId) ?? []) : []),
      ];
      return knowledgeBaseIds.every((knowledgeBaseId) => !excluded.has(knowledgeBaseId));
    });

    return this.attachScores(authorizedRows, hits)
      .slice(0, limit)
      .map((row) => ({
        createdAt: row.createdAt,
        description: row.description,
        id: row.id,
        knowledgeBaseId: row.knowledgeBaseId,
        relevance: row.relevance,
        slug: row.slug,
        title: row.title || row.filename || 'Untitled',
        type: 'folder' as const,
        updatedAt: row.updatedAt,
      }));
  }

  private async hydratePages(
    hits: CandidateHit[],
    scope: SearchBackendScope,
    limit: number,
    excludeKnowledgeBaseIds: string[] = [],
  ): Promise<PageSearchResult[]> {
    if (hits.length === 0) return [];

    const rows = await this.db
      .select({
        createdAt: documents.createdAt,
        fileId: documents.fileId,
        filename: documents.filename,
        id: documents.id,
        knowledgeBaseId: documents.knowledgeBaseId,
        title: documents.title,
        updatedAt: documents.updatedAt,
      })
      .from(documents)
      .where(
        and(
          inArray(
            documents.id,
            hits.map(({ id }) => id),
          ),
          buildWorkspaceWhere(scope, documents),
          eq(documents.fileType, 'custom/document'),
        ),
      );
    const knowledgeBaseIdsByFile = await this.getKnowledgeBaseIdsByFile(
      rows.flatMap(({ fileId }) => (fileId ? [fileId] : [])),
    );
    const excluded = new Set(excludeKnowledgeBaseIds);
    const authorizedRows = rows.filter((row) => {
      const knowledgeBaseIds = [
        ...(row.knowledgeBaseId ? [row.knowledgeBaseId] : []),
        ...(row.fileId ? (knowledgeBaseIdsByFile.get(row.fileId) ?? []) : []),
      ];
      return knowledgeBaseIds.every((knowledgeBaseId) => !excluded.has(knowledgeBaseId));
    });

    return this.attachScores(authorizedRows, hits)
      .slice(0, limit)
      .map((row) => ({
        createdAt: row.createdAt,
        description: null,
        id: row.id,
        relevance: row.relevance,
        title: row.title || row.filename || 'Untitled',
        type: 'page' as const,
        updatedAt: row.updatedAt,
      }));
  }

  private async hydrateKnowledgeBaseDocuments(
    hits: CandidateHit[],
    scope: SearchBackendScope,
    limit: number,
    knowledgeBaseIds: string[],
  ): Promise<KnowledgeBaseDocumentHit[]> {
    if (hits.length === 0 || knowledgeBaseIds.length === 0) return [];

    const rows = await this.db
      .select({
        fileId: documents.fileId,
        filename: documents.filename,
        id: documents.id,
        knowledgeBaseId: documents.knowledgeBaseId,
        title: documents.title,
        updatedAt: documents.updatedAt,
      })
      .from(documents)
      .where(
        and(
          inArray(
            documents.id,
            hits.map(({ id }) => id),
          ),
          buildWorkspaceWhere(scope, documents),
          ne(documents.fileType, DOCUMENT_FOLDER_TYPE),
        ),
      );
    const knowledgeBaseIdsByFile = await this.getKnowledgeBaseIdsByFile(
      rows.flatMap(({ fileId }) => (fileId ? [fileId] : [])),
      scope,
    );
    const requested = new Set(knowledgeBaseIds);
    const authorizedRows = rows.flatMap((row) => {
      const matchingKnowledgeBaseId =
        row.knowledgeBaseId && requested.has(row.knowledgeBaseId)
          ? row.knowledgeBaseId
          : row.fileId
            ? knowledgeBaseIdsByFile
                .get(row.fileId)
                ?.find((knowledgeBaseId) => requested.has(knowledgeBaseId))
            : undefined;
      return matchingKnowledgeBaseId ? [{ ...row, matchingKnowledgeBaseId }] : [];
    });
    const scoredRows = this.attachScores(authorizedRows, hits).slice(0, limit);
    const selectedDocumentIds = scoredRows.map(({ id }) => id);
    const contentRows =
      selectedDocumentIds.length === 0
        ? []
        : await this.db
            .select({
              content: documentContentPreview(KNOWLEDGE_BASE_DOCUMENT_SNIPPET_MAX_LENGTH),
              id: documents.id,
            })
            .from(documents)
            .where(
              and(
                inArray(documents.id, selectedDocumentIds),
                buildWorkspaceWhere(scope, documents),
              ),
            );
    const contentById = new Map(contentRows.map(({ content, id }) => [id, content] as const));

    return scoredRows.map((row) => ({
      documentId: row.id,
      fileId: row.fileId ?? undefined,
      knowledgeBaseId: row.matchingKnowledgeBaseId,
      relevance: row.relevance,
      snippet: truncate(contentById.get(row.id), KNOWLEDGE_BASE_DOCUMENT_SNIPPET_MAX_LENGTH) ?? '',
      title: row.title || row.filename || 'Untitled',
      updatedAt: row.updatedAt,
    }));
  }

  private async hydrateKnowledgeBases(
    hits: CandidateHit[],
    scope: SearchBackendScope,
    limit: number,
    excludeKnowledgeBaseIds: string[] = [],
  ): Promise<KnowledgeBaseSearchResult[]> {
    if (hits.length === 0) return [];

    const rows = await this.db
      .select({
        avatar: knowledgeBases.avatar,
        createdAt: knowledgeBases.createdAt,
        description: knowledgeBases.description,
        id: knowledgeBases.id,
        name: knowledgeBases.name,
        updatedAt: knowledgeBases.updatedAt,
      })
      .from(knowledgeBases)
      .where(
        and(
          inArray(
            knowledgeBases.id,
            hits.map(({ id }) => id),
          ),
          buildWorkspaceWhere(scope, knowledgeBases),
          excludeKnowledgeBaseIds.length > 0
            ? notInArray(knowledgeBases.id, excludeKnowledgeBaseIds)
            : undefined,
        ),
      );

    return this.attachScores(rows, hits)
      .slice(0, limit)
      .map((row) => ({
        avatar: row.avatar,
        createdAt: row.createdAt,
        description: row.description,
        id: row.id,
        relevance: row.relevance,
        title: row.name,
        type: 'knowledgeBase' as const,
        updatedAt: row.updatedAt,
      }));
  }
}
