// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '../../../core/getTestDB';
import {
  agents,
  chatGroups,
  messages,
  sessions,
  topics,
  users,
  workspaces,
} from '../../../schemas';
import type { LobeChatDatabase } from '../../../type';
import { ElasticsearchSearchBackend, type ElasticsearchSearchClient } from '../elasticsearch';
import type { SearchBackendRequest, SearchBackendScope } from '../types';

const db: LobeChatDatabase = await getTestDB();

const userId = 'es-search-user';
const otherUserId = 'es-search-other-user';
const workspaceId = 'es-search-workspace';
const otherWorkspaceId = 'es-search-other-workspace';
const indexNamespace = 'lobehub-dev';

const request = (
  entity: SearchBackendRequest['entity'],
  options: {
    agentId?: string;
    limit?: number;
    query?: string;
    scope?: Partial<SearchBackendScope>;
  } = {},
): SearchBackendRequest => ({
  entity,
  filters: { agentId: options.agentId },
  pagination: { limit: options.limit ?? 5 },
  query: { text: options.query ?? 'search phrase' },
  scope: {
    userId,
    workspaceId,
    ...options.scope,
  },
});

const createClient = (
  hits: Array<{ _id: string; _score: number | null }>,
): ElasticsearchSearchClient => ({
  search: vi.fn().mockResolvedValue({ hits: { hits } }),
});

beforeEach(async () => {
  await db.delete(users);
  await db.insert(users).values([{ id: userId }, { id: otherUserId }]);
  await db.insert(workspaces).values([
    {
      id: workspaceId,
      name: 'Search Workspace',
      primaryOwnerId: userId,
      slug: workspaceId,
    },
    {
      id: otherWorkspaceId,
      name: 'Other Search Workspace',
      primaryOwnerId: otherUserId,
      slug: otherWorkspaceId,
    },
  ]);
});

afterEach(async () => {
  await db.delete(users);
});

describe('ElasticsearchSearchBackend', () => {
  it('queries weighted agent fields and rechecks workspace visibility during hydration', async () => {
    await db.insert(agents).values([
      {
        id: 'agent-public',
        title: 'Public workspace agent',
        userId: otherUserId,
        visibility: 'public',
        workspaceId,
      },
      {
        id: 'agent-private-own',
        title: 'Own private workspace agent',
        userId,
        visibility: 'private',
        workspaceId,
      },
      {
        id: 'agent-private-other',
        title: 'Other private workspace agent',
        userId: otherUserId,
        visibility: 'private',
        workspaceId,
      },
    ]);
    const client = createClient([
      { _id: 'agent-private-other', _score: 12 },
      { _id: 'agent-public', _score: 10 },
      { _id: 'agent-private-own', _score: 8 },
      { _id: 'agent-deleted', _score: 7 },
    ]);
    const backend = new ElasticsearchSearchBackend(db, {
      client,
      indexNamespace,
    });

    const response = await backend.search(request('agents'));

    expect(response.candidates).toEqual([
      { id: 'agent-private-other', score: 12 },
      { id: 'agent-public', score: 10 },
      { id: 'agent-private-own', score: 8 },
      { id: 'agent-deleted', score: 7 },
    ]);
    expect(response.items.map(({ id }) => id)).toEqual(['agent-public', 'agent-private-own']);
    expect(client.search).toHaveBeenCalledWith({
      body: {
        _source: false,
        query: {
          bool: {
            filter: [
              { term: { workspace_id: workspaceId } },
              {
                bool: {
                  minimum_should_match: 1,
                  should: [{ term: { visibility: 'public' } }, { term: { user_id: userId } }],
                },
              },
            ],
            must: [
              {
                multi_match: {
                  fields: ['title^5', 'slug^4', 'tags^3', 'description^2', 'system_role'],
                  operator: 'and',
                  query: 'search phrase',
                  type: 'best_fields',
                },
              },
            ],
            must_not: [],
          },
        },
        size: 20,
        sort: [{ _score: 'desc' }, { id: 'asc' }],
      },
      index: 'lobehub-dev-agents',
    });

    const publicCaller = await backend.search(
      request('agents', { scope: { callerAgentVisibility: 'public' } }),
    );
    expect(publicCaller.items.map(({ id }) => id)).toEqual(['agent-public']);
  });

  it('searches chat-group content while personal hydration blocks workspace and stale hits', async () => {
    await db.insert(chatGroups).values([
      {
        content: 'Deep planning notes',
        id: 'group-personal',
        title: 'Personal group',
        userId,
      },
      {
        content: 'Deep workspace notes',
        id: 'group-workspace',
        title: 'Workspace group',
        userId,
        workspaceId,
      },
    ]);
    const client = createClient([
      { _id: 'group-workspace', _score: 9 },
      { _id: 'group-personal', _score: 7 },
      { _id: 'group-deleted', _score: 6 },
    ]);
    const backend = new ElasticsearchSearchBackend(db, { client, indexNamespace });

    const response = await backend.search(
      request('chatGroups', { scope: { workspaceId: undefined } }),
    );

    expect(response.items.map(({ id }) => id)).toEqual(['group-personal']);
    expect(client.search).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          query: {
            bool: expect.objectContaining({
              filter: [{ term: { user_id: userId } }],
              must: [
                {
                  multi_match: {
                    fields: ['title^4', 'description^2', 'content'],
                    operator: 'and',
                    query: 'search phrase',
                    type: 'best_fields',
                  },
                },
              ],
              must_not: [{ exists: { field: 'workspace_id' } }],
            }),
          },
        }),
        index: 'lobehub-dev-chat-groups',
      }),
    );
  });

  it('reranks topic candidates by recency and blocks invisible parent containers', async () => {
    await db.insert(agents).values([
      {
        id: 'topic-agent-public',
        title: 'Public topic agent',
        userId: otherUserId,
        visibility: 'public',
        workspaceId,
      },
      {
        id: 'topic-agent-private',
        title: 'Private topic agent',
        userId: otherUserId,
        visibility: 'private',
        workspaceId,
      },
    ]);
    await db.insert(chatGroups).values([
      {
        id: 'topic-group-public',
        title: 'Public topic group',
        userId: otherUserId,
        visibility: 'public',
        workspaceId,
      },
      {
        id: 'topic-group-private',
        title: 'Private topic group',
        userId: otherUserId,
        visibility: 'private',
        workspaceId,
      },
    ]);
    await db.insert(sessions).values({
      id: 'topic-session',
      title: 'Topic session',
      userId: otherUserId,
      workspaceId,
    });
    await db.insert(topics).values([
      {
        agentId: 'topic-agent-public',
        groupId: 'topic-group-public',
        id: 'topic-old',
        sessionId: 'topic-session',
        title: 'Older relevant topic',
        updatedAt: new Date('2026-08-20T00:00:00.000Z'),
        userId,
        workspaceId,
      },
      {
        agentId: 'topic-agent-public',
        groupId: 'topic-group-public',
        id: 'topic-recent',
        sessionId: 'topic-session',
        title: 'Recent relevant topic',
        updatedAt: new Date('2026-08-25T00:00:00.000Z'),
        userId,
        workspaceId,
      },
      {
        agentId: 'topic-agent-private',
        id: 'topic-private-agent',
        title: 'Private parent agent topic',
        userId,
        workspaceId,
      },
      {
        groupId: 'topic-group-private',
        id: 'topic-private-group',
        title: 'Private parent group topic',
        userId,
        workspaceId,
      },
    ]);
    const client = createClient([
      { _id: 'topic-old', _score: 12 },
      { _id: 'topic-private-agent', _score: 11 },
      { _id: 'topic-private-group', _score: 10 },
      { _id: 'topic-recent', _score: 8 },
    ]);
    const backend = new ElasticsearchSearchBackend(db, { client, indexNamespace });

    const response = await backend.search(request('topics', { limit: 2 }));

    expect(response.items.map(({ id }) => id)).toEqual(['topic-recent', 'topic-old']);
    expect(response.items[0]).toMatchObject({
      agentId: 'topic-agent-public',
      groupId: 'topic-group-public',
      sessionId: 'topic-session',
    });

    await backend.search(request('topics', { agentId: 'topic-agent-public', limit: 2 }));
    expect(client.search).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          query: {
            bool: expect.objectContaining({
              filter: expect.arrayContaining([{ term: { agent_id: 'topic-agent-public' } }]),
            }),
          },
        }),
      }),
    );
  });

  it('searches message summaries but excludes tool, foreign, deleted, and private-parent hits in PG', async () => {
    await db.insert(agents).values([
      {
        id: 'message-agent-public',
        title: 'Public message agent',
        userId: otherUserId,
        visibility: 'public',
        workspaceId,
      },
      {
        id: 'message-agent-private',
        title: 'Private message agent',
        userId: otherUserId,
        visibility: 'private',
        workspaceId,
      },
    ]);
    await db.insert(chatGroups).values({
      id: 'message-group',
      title: 'Message group',
      userId: otherUserId,
      workspaceId,
    });
    await db.insert(sessions).values({
      id: 'message-session',
      title: 'Message session',
      userId: otherUserId,
      workspaceId,
    });
    await db.insert(topics).values({
      agentId: 'message-agent-public',
      groupId: 'message-group',
      id: 'message-topic',
      sessionId: 'message-session',
      title: 'Message topic',
      userId,
      workspaceId,
    });
    await db.insert(topics).values({
      agentId: 'message-agent-private',
      id: 'message-private-topic',
      title: 'Private parent agent topic',
      userId,
      workspaceId,
    });
    await db.insert(messages).values([
      {
        agentId: 'message-agent-public',
        content: 'Older hydrated message',
        createdAt: new Date('2026-08-20T00:00:00.000Z'),
        groupId: 'message-group',
        id: 'message-old',
        role: 'assistant',
        sessionId: 'message-session',
        summary: 'Search phrase only appears in this summary',
        topicId: 'message-topic',
        userId,
        workspaceId,
      },
      {
        agentId: 'message-agent-public',
        content: 'Recent hydrated message',
        createdAt: new Date('2026-08-25T00:00:00.000Z'),
        groupId: 'message-group',
        id: 'message-recent',
        role: 'user',
        sessionId: 'message-session',
        topicId: 'message-topic',
        userId,
        workspaceId,
      },
      {
        content: 'Tool payload',
        id: 'message-tool',
        role: 'tool',
        userId,
        workspaceId,
      },
      {
        agentId: 'message-agent-private',
        content: 'Private parent payload',
        id: 'message-private-agent',
        role: 'assistant',
        userId,
        workspaceId,
      },
      {
        content: 'Private topic parent payload',
        id: 'message-private-topic-parent',
        role: 'assistant',
        topicId: 'message-private-topic',
        userId,
        workspaceId,
      },
      {
        content: 'Foreign workspace payload',
        id: 'message-foreign-workspace',
        role: 'user',
        userId: otherUserId,
        workspaceId: otherWorkspaceId,
      },
    ]);
    const client = createClient([
      { _id: 'message-old', _score: 12 },
      { _id: 'message-tool', _score: 11 },
      { _id: 'message-private-agent', _score: 10 },
      { _id: 'message-private-topic-parent', _score: 9.5 },
      { _id: 'message-foreign-workspace', _score: 9 },
      { _id: 'message-deleted', _score: 8 },
      { _id: 'message-recent', _score: 7 },
    ]);
    const backend = new ElasticsearchSearchBackend(db, { client, indexNamespace });

    const response = await backend.search(request('messages', { limit: 2 }));

    expect(response.items.map(({ id }) => id)).toEqual(['message-recent', 'message-old']);
    expect(response.items[0]).toMatchObject({
      agentId: 'message-agent-public',
      groupId: 'message-group',
      topicId: 'message-topic',
    });
    expect(client.search).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          query: {
            bool: expect.objectContaining({
              must: [
                {
                  multi_match: {
                    fields: ['content^2', 'summary'],
                    operator: 'and',
                    query: 'search phrase',
                    type: 'best_fields',
                  },
                },
              ],
              must_not: [{ term: { role: 'tool' } }],
            }),
          },
        }),
        index: 'lobehub-dev-messages',
      }),
    );
  });

  it('rejects entities that have not migrated to Elasticsearch yet', async () => {
    const backend = new ElasticsearchSearchBackend(db, {
      client: createClient([]),
      indexNamespace,
    });

    await expect(backend.search(request('files'))).rejects.toThrow(
      'Unsupported Elasticsearch search entity: files',
    );
  });
});
