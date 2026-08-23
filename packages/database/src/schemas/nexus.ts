import { index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

import { createNanoId } from '../utils/idGenerator';
import { timestamps, timestamptz } from './_helpers';
import { users } from './user';

export const nexusLegacyUserMappings = pgTable(
  'nexus_legacy_user_mappings',
  {
    id: text('id')
      .$defaultFn(() => createNanoId(16)())
      .notNull()
      .primaryKey(),
    importBatchId: text('import_batch_id'),
    legacyCreatedAt: timestamptz('legacy_created_at'),
    legacyStudentId: text('legacy_student_id').notNull(),
    legacyUserId: integer('legacy_user_id').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
    source: text('source').default('kiro-kroxy').notNull(),
    userId: text('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),

    ...timestamps,
  },
  (table) => [
    uniqueIndex('nexus_legacy_user_mappings_source_legacy_user_id_idx').on(
      table.source,
      table.legacyUserId,
    ),
    uniqueIndex('nexus_legacy_user_mappings_source_legacy_student_id_idx').on(
      table.source,
      table.legacyStudentId,
    ),
    index('nexus_legacy_user_mappings_user_id_idx').on(table.userId),
    index('nexus_legacy_user_mappings_import_batch_id_idx').on(table.importBatchId),
  ],
);

export type NewNexusLegacyUserMapping = typeof nexusLegacyUserMappings.$inferInsert;
export type NexusLegacyUserMappingItem = typeof nexusLegacyUserMappings.$inferSelect;

export const nexusImIdentities = pgTable(
  'nexus_im_identities',
  {
    id: text('id')
      .$defaultFn(() => createNanoId(16)())
      .notNull()
      .primaryKey(),
    avatar: text('avatar'),
    displayName: text('display_name'),
    externalId: text('external_id').notNull(),
    groupId: text('group_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
    provider: text('provider').default('qq').notNull(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),

    ...timestamps,
  },
  (table) => [
    uniqueIndex('nexus_im_identities_provider_external_id_idx').on(
      table.provider,
      table.externalId,
    ),
    index('nexus_im_identities_user_id_idx').on(table.userId),
    index('nexus_im_identities_provider_group_id_idx').on(table.provider, table.groupId),
  ],
);

export type NewNexusImIdentity = typeof nexusImIdentities.$inferInsert;
export type NexusImIdentityItem = typeof nexusImIdentities.$inferSelect;

export const nexusImLoginCodes = pgTable(
  'nexus_im_login_codes',
  {
    id: text('id')
      .$defaultFn(() => createNanoId(18)())
      .notNull()
      .primaryKey(),
    codeHash: text('code_hash').notNull(),
    confirmedAt: timestamptz('confirmed_at'),
    consumedAt: timestamptz('consumed_at'),
    expiresAt: timestamptz('expires_at').notNull(),
    groupId: text('group_id'),
    identityId: text('identity_id').references(() => nexusImIdentities.id, { onDelete: 'set null' }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
    provider: text('provider').default('qq').notNull(),
    status: text('status').default('pending').notNull(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),

    ...timestamps,
  },
  (table) => [
    index('nexus_im_login_codes_code_hash_idx').on(table.codeHash),
    index('nexus_im_login_codes_status_expires_at_idx').on(table.status, table.expiresAt),
    index('nexus_im_login_codes_user_id_idx').on(table.userId),
    index('nexus_im_login_codes_identity_id_idx').on(table.identityId),
  ],
);

export type NewNexusImLoginCode = typeof nexusImLoginCodes.$inferInsert;
export type NexusImLoginCodeItem = typeof nexusImLoginCodes.$inferSelect;

export const nexusRegistryItems = pgTable(
  'nexus_registry_items',
  {
    id: text('id')
      .$defaultFn(() => createNanoId(18)())
      .notNull()
      .primaryKey(),
    authorAvatarUrl: text('author_avatar_url'),
    authorName: text('author_name'),
    authorUrl: text('author_url'),
    category: text('category'),
    description: text('description'),
    downloadUrl: text('download_url'),
    homepageUrl: text('homepage_url'),
    identifier: text('identifier').notNull(),
    kind: text('kind', {
      enum: ['agent', 'blog', 'group_agent', 'mcp', 'plugin', 'skill'],
    }).notNull(),
    locale: text('locale'),
    manifest: jsonb('manifest').$type<Record<string, unknown>>().default({}).notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
    name: text('name').notNull(),
    publishedAt: timestamptz('published_at'),
    raw: jsonb('raw').$type<Record<string, unknown>>().default({}).notNull(),
    repositoryUrl: text('repository_url'),
    source: text('source', { enum: ['official', 'user'] }).default('official').notNull(),
    status: text('status', {
      enum: ['active', 'archived', 'hidden', 'pending', 'rejected'],
    })
      .default('active')
      .notNull(),
    submittedBy: text('submitted_by').references(() => users.id, { onDelete: 'set null' }),
    syncRunId: text('sync_run_id'),
    tags: text('tags').array().default([]).notNull(),
    upstreamIdentifier: text('upstream_identifier'),
    upstreamSource: text('upstream_source'),
    version: text('version'),

    ...timestamps,
  },
  (table) => [
    uniqueIndex('nexus_registry_items_kind_source_identifier_idx').on(
      table.kind,
      table.source,
      table.identifier,
    ),
    uniqueIndex('nexus_registry_items_upstream_idx').on(
      table.kind,
      table.upstreamSource,
      table.upstreamIdentifier,
    ),
    index('nexus_registry_items_kind_status_idx').on(table.kind, table.status),
    index('nexus_registry_items_source_idx').on(table.source),
    index('nexus_registry_items_category_idx').on(table.category),
    index('nexus_registry_items_submitted_by_idx').on(table.submittedBy),
    index('nexus_registry_items_sync_run_id_idx').on(table.syncRunId),
  ],
);

export type NewNexusRegistryItem = typeof nexusRegistryItems.$inferInsert;
export type NexusRegistryItem = typeof nexusRegistryItems.$inferSelect;

export const nexusRegistrySyncRuns = pgTable(
  'nexus_registry_sync_runs',
  {
    id: text('id')
      .$defaultFn(() => createNanoId(18)())
      .notNull()
      .primaryKey(),
    completedAt: timestamptz('completed_at'),
    error: jsonb('error').$type<Record<string, unknown>>(),
    insertedCount: integer('inserted_count').default(0).notNull(),
    kind: text('kind', { enum: ['all', 'mcp', 'skill'] }).notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
    source: text('source').default('lobehub').notNull(),
    startedAt: timestamptz('started_at').defaultNow().notNull(),
    status: text('status', { enum: ['failed', 'running', 'success'] })
      .default('running')
      .notNull(),
    updatedCount: integer('updated_count').default(0).notNull(),

    ...timestamps,
  },
  (table) => [
    index('nexus_registry_sync_runs_kind_started_at_idx').on(table.kind, table.startedAt),
    index('nexus_registry_sync_runs_source_status_idx').on(table.source, table.status),
  ],
);

export type NewNexusRegistrySyncRun = typeof nexusRegistrySyncRuns.$inferInsert;
export type NexusRegistrySyncRun = typeof nexusRegistrySyncRuns.$inferSelect;
