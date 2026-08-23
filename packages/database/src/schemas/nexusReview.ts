import { index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';

import { createNanoId } from '../utils/idGenerator';
import { timestamps } from './_helpers';
import { nexusRegistryItems } from './nexus';

/**
 * A single risk finding produced by the reviewSafety agent (or static scan).
 * `severity` drives the color of the warning tag rendered in the review UI.
 */
export interface NexusSafetyRisk {
  detail: string;
  severity: 'critical' | 'info' | 'warning';
  type:
    | 'dangerous-network'
    | 'license-issue'
    | 'malicious-command'
    | 'other'
    | 'pii'
    | 'prompt-injection'
    | 'secret-leak';
}

/**
 * One run of the reviewSafety agent against a registry item. Technical, high-frequency,
 * reproducible data — therefore cascades on item deletion. An item may have many scans
 * over time (on submit, on update, on manual rescan, on periodic cron).
 */
export const nexusRegistrySafetyScans = pgTable(
  'nexus_registry_safety_scans',
  {
    id: text('id')
      .$defaultFn(() => createNanoId(18)())
      .notNull()
      .primaryKey(),
    itemId: text('item_id')
      .references(() => nexusRegistryItems.id, { onDelete: 'cascade' })
      .notNull(),
    verdict: text('verdict', { enum: ['block', 'pass', 'review'] }).notNull(),
    riskScore: integer('risk_score').notNull(),
    risks: jsonb('risks').$type<NexusSafetyRisk[]>().default([]).notNull(),
    trigger: text('trigger', { enum: ['cron', 'rescan', 'submit', 'update'] }).notNull(),
    /** Content fingerprint; when unchanged, cron rescans can skip the LLM call. */
    contentHash: text('content_hash'),
    model: text('model'),
    provider: text('provider'),
    durationMs: integer('duration_ms'),
    error: jsonb('error').$type<{ message: string; type?: string }>(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),

    ...timestamps,
  },
  (t) => [
    index('nexus_registry_safety_scans_item_id_created_at_idx').on(t.itemId, t.createdAt),
    index('nexus_registry_safety_scans_verdict_idx').on(t.verdict),
  ],
);

/**
 * Immutable audit trail of every review decision (human or auto). Mirrors the
 * `agentOperations.userId` convention: `reviewerId` is intentionally NOT a foreign key so
 * that audit history survives user deletion. `itemIdentifier`/`itemName` snapshots keep
 * the row readable even if the referenced item is later hard-deleted.
 */
export const nexusRegistryReviewActions = pgTable(
  'nexus_registry_review_actions',
  {
    id: text('id')
      .$defaultFn(() => createNanoId(18)())
      .notNull()
      .primaryKey(),
    itemId: text('item_id')
      .references(() => nexusRegistryItems.id, { onDelete: 'cascade' })
      .notNull(),
    /**
     * Preserved across user deletion — review actions are audit data, so this column is
     * intentionally not a foreign key. For `actor === 'auto'` this is a stable sentinel
     * (e.g. `AUTO_REVIEWER`); for humans it is the acting user id.
     */
    reviewerId: text('reviewer_id').notNull(),
    actor: text('actor', { enum: ['auto', 'human'] }).notNull(),
    action: text('action', { enum: ['approve', 'reject', 'request_changes'] }).notNull(),
    reason: text('reason'),
    /** The scan that informed this decision. Optional: early-stage items may predate scans. */
    scanId: text('scan_id').references(() => nexusRegistrySafetyScans.id, {
      onDelete: 'set null',
    }),
    /** Risk context frozen at decision time so audit does not depend on the scan row surviving. */
    riskSnapshot: jsonb('risk_snapshot').$type<{
      flags?: string[];
      riskScore?: number;
      verdict?: string;
    }>(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    itemIdentifier: text('item_identifier'),
    itemName: text('item_name'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),

    ...timestamps,
  },
  (t) => [
    index('nexus_registry_review_actions_item_id_created_at_idx').on(t.itemId, t.createdAt),
    index('nexus_registry_review_actions_reviewer_id_idx').on(t.reviewerId),
    index('nexus_registry_review_actions_action_idx').on(t.action),
    index('nexus_registry_review_actions_scan_id_idx').on(t.scanId),
  ],
);

export type NewNexusRegistrySafetyScan = typeof nexusRegistrySafetyScans.$inferInsert;
export type NexusRegistrySafetyScanItem = typeof nexusRegistrySafetyScans.$inferSelect;
export type NewNexusRegistryReviewAction = typeof nexusRegistryReviewActions.$inferInsert;
export type NexusRegistryReviewActionItem = typeof nexusRegistryReviewActions.$inferSelect;
