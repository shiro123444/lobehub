import type { NexusRegistryItem, NexusRegistrySyncRun } from '@lobechat/database/schemas';

export type NexusRegistryKind = 'agent' | 'blog' | 'group_agent' | 'mcp' | 'plugin' | 'skill';
export type NexusRegistrySource = 'official' | 'user';
export type NexusRegistryStatus = 'active' | 'archived' | 'hidden' | 'pending' | 'rejected';

export interface NexusRegistryListParams {
  category?: string;
  kind?: NexusRegistryKind;
  page?: number;
  pageSize?: number;
  q?: string;
  source?: NexusRegistrySource;
  status?: NexusRegistryStatus;
  submittedBy?: string;
}

export interface NexusRegistryListResponse {
  currentPage: number;
  items: NexusRegistryItem[];
  pageSize: number;
  totalCount: number;
  totalPages: number;
}

export interface NexusRegistrySyncParams {
  kinds?: Extract<NexusRegistryKind, 'mcp' | 'skill'>[];
  locale?: string;
  maxPages?: number;
  pageSize?: number;
}

export interface NexusRegistrySyncResponse {
  insertedCount: number;
  run: NexusRegistrySyncRun;
  updatedCount: number;
}

export interface NexusRegistryBackfillSkillsParams {
  limit?: number;
  source?: NexusRegistrySource;
  status?: NexusRegistryStatus;
}

export interface NexusRegistryBackfillSkillsResponse {
  errors: Array<{
    id: string;
    identifier: string;
    message: string;
  }>;
  failedCount: number;
  processedCount: number;
  skippedCount: number;
  totalCount: number;
  updatedCount: number;
}

export interface NexusRegistrySubmitParams {
  authorAvatarUrl?: string;
  authorName?: string;
  authorUrl?: string;
  category?: string;
  content?: string;
  description?: string;
  downloadUrl?: string;
  homepageUrl?: string;
  identifier?: string;
  kind: NexusRegistryKind;
  locale?: string;
  manifest?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  name: string;
  raw?: Record<string, unknown>;
  repositoryUrl?: string;
  source?: NexusRegistrySource;
  status?: NexusRegistryStatus;
  submittedBy?: string;
  tags?: string[];
  upstreamIdentifier?: string;
  upstreamSource?: string;
  version?: string;
}

export interface NexusRegistryLookupParams {
  identifier: string;
  kind: NexusRegistryKind;
  source?: NexusRegistrySource;
  status?: NexusRegistryStatus;
}

export interface NexusRegistryStatusUpdateParams {
  id: string;
  metadata?: Record<string, unknown>;
  status: Exclude<NexusRegistryStatus, 'pending'>;
}

/**
 * Snapshot of the most recent safety scan, attached to review-queue items so the UI can
 * render verdict badges and risk flags inline. Mirrors the persisted scan shape but only
 * exposes the fields the review surface needs.
 */
export interface NexusRegistryLatestScan {
  riskScore: number;
  risks: Array<{
    detail: string;
    severity: 'critical' | 'info' | 'warning';
    type: string;
  }>;
  verdict: 'block' | 'pass' | 'review';
}
