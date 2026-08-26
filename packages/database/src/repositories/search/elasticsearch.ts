import { and, eq, inArray, isNotNull, isNull, ne, or, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { agents, chatGroups, messages, sessions, topics } from '../../schemas';
import type { LobeChatDatabase } from '../../type';
import { normalizeInboxAgentMeta, normalizeInboxAgentTitle } from '../../utils/inboxAgent';
import { buildWorkspaceWhere } from '../../utils/workspace';
import { getSearchIndexAlias } from '../searchDocument';
import type {
  AgentSearchResult,
  ChatGroupSearchResult,
  MessageSearchResult,
  SearchBackend,
  SearchBackendCandidate,
  SearchBackendRequest,
  SearchBackendResponse,
  SearchBackendScope,
  TopicSearchResult,
} from './types';

const SUPPORTED_ENTITIES = new Set<SearchBackendRequest['entity']>([
  'agents',
  'chatGroups',
  'messages',
  'topics',
]);

/**
 * Candidate over-fetch keeps authorized lower-ranked hits available when an index still contains
 * a deleted or newly restricted document. PostgreSQL remains the final authorization source.
 */
const CANDIDATE_MULTIPLIER = 4;

const QUERY_FIELDS = {
  agents: ['title^5', 'slug^4', 'tags^3', 'description^2', 'system_role'],
  chatGroups: ['title^4', 'description^2', 'content'],
  messages: ['content^2', 'summary'],
  topics: ['title', 'content', 'description'],
} as const;

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

const normalizeQuery = (query: string) =>
  query.trim().replaceAll('-', ' ').split(/\s+/).filter(Boolean).join(' ');

const truncate = (content: string | null | undefined, maxLength: number = 200) => {
  if (!content) return null;
  if (content.length <= maxLength) return content;
  return `${content.slice(0, maxLength)}...`;
};

const visibleParent = (
  foreignKey: Parameters<typeof isNull>[0],
  id: Parameters<typeof isNotNull>[0],
) => or(isNull(foreignKey), isNotNull(id)) as SQL;

/**
 * Elasticsearch candidate provider for the conversation entities migrated in LOBE-13461.
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

  async search(request: SearchBackendRequest): Promise<SearchBackendResponse> {
    if (!SUPPORTED_ENTITIES.has(request.entity)) {
      throw new Error(`Unsupported Elasticsearch search entity: ${request.entity}`);
    }

    const query = normalizeQuery(request.query.text);
    if (!query) return { candidates: [], items: [] };

    const hits = await this.searchCandidates(request, query);
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
    if (request.entity === 'topics') {
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

  private buildScopeClauses(
    entity: keyof typeof QUERY_FIELDS,
    scope: SearchBackendScope,
  ): { filter: Array<Record<string, unknown>>; mustNot: Array<Record<string, unknown>> } {
    if (!scope.workspaceId) {
      return {
        filter: [{ term: { user_id: scope.userId } }],
        mustNot: [{ exists: { field: 'workspace_id' } }],
      };
    }

    const filter: Array<Record<string, unknown>> = [{ term: { workspace_id: scope.workspaceId } }];
    if (entity === 'agents' || entity === 'chatGroups') {
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
    query: string,
  ): Promise<CandidateHit[]> {
    const entity = request.entity as keyof typeof QUERY_FIELDS;
    const { filter, mustNot } = this.buildScopeClauses(entity, request.scope);
    if (request.filters.agentId && (entity === 'topics' || entity === 'messages')) {
      filter.push({ term: { agent_id: request.filters.agentId } });
    }
    if (entity === 'messages') mustNot.push({ term: { role: 'tool' } });

    const response = await this.client.search({
      body: {
        _source: false,
        query: {
          bool: {
            filter,
            must: [
              {
                multi_match: {
                  fields: QUERY_FIELDS[entity],
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
}
