import { lambdaClient } from '@/libs/trpc/client';
import type {
  NexusRegistryBackfillSkillsParams,
  NexusRegistryKind,
  NexusRegistryListParams,
  NexusRegistrySource,
  NexusRegistrySubmitParams,
} from '@/types/nexusRegistry';

class NexusRegistryClientService {
  backfillSkills = async (params: NexusRegistryBackfillSkillsParams = {}) => {
    return lambdaClient.nexusRegistry.backfillSkills.mutate(params);
  };

  getByIdentifier = async (params: {
    identifier: string;
    kind: NexusRegistryKind;
    source?: NexusRegistrySource;
  }) => {
    return lambdaClient.nexusRegistry.getByIdentifier.query(params);
  };

  getLatestSyncRun = async (kind?: 'all' | 'mcp' | 'skill') => {
    return lambdaClient.nexusRegistry.getLatestSyncRun.query(kind ? { kind } : undefined);
  };

  installPlugin = async (params: {
    id?: string;
    identifier?: string;
    kind?: 'mcp' | 'plugin';
    type?: 'plugin' | 'customPlugin';
  }) => {
    return lambdaClient.nexusRegistry.installPlugin.mutate(params);
  };

  installSkill = async (params: { id?: string; identifier?: string }) => {
    return lambdaClient.nexusRegistry.installSkill.mutate(params);
  };

  list = async (params: NexusRegistryListParams = {}) => {
    return lambdaClient.nexusRegistry.list.query(params);
  };

  listMine = async (params: Omit<NexusRegistryListParams, 'source' | 'submittedBy'> = {}) => {
    return lambdaClient.nexusRegistry.listMine.query(params);
  };

  listReviewQueue = async (
    params: Omit<NexusRegistryListParams, 'source' | 'submittedBy'> = {},
  ) => {
    return lambdaClient.nexusRegistry.listReviewQueue.query(params);
  };

  submit = async (params: NexusRegistrySubmitParams) => {
    return lambdaClient.nexusRegistry.submit.mutate(params);
  };

  submitRepo = async (params: {
    aiMode?: 'normalize' | 'off' | 'polish';
    branch?: string;
    category?: string;
    description?: string;
    gitUrl: string;
    kind?: 'auto' | 'mcp' | 'plugin' | 'skill';
    name?: string;
    tags?: string[];
  }) => {
    return lambdaClient.nexusRegistry.submitRepo.mutate(params);
  };

  submitArtifact = async (params: {
    aiMode?: 'normalize' | 'off' | 'polish';
    artifact?: {
      dataBase64?: string;
      fileName?: string;
      mimeType?: string;
      size?: number;
    };
    category?: string;
    content?: string;
    description?: string;
    fileName?: string;
    kind?: 'auto' | 'mcp' | 'plugin' | 'skill';
    manifest?: Record<string, unknown>;
    name?: string;
    sourceType: 'manifest' | 'skill-md' | 'zip';
    tags?: string[];
  }) => {
    return lambdaClient.nexusRegistry.submitArtifact.mutate(params);
  };

  updateStatus = async (params: {
    id: string;
    metadata?: Record<string, unknown>;
    status: 'active' | 'archived' | 'hidden' | 'rejected';
  }) => {
    return lambdaClient.nexusRegistry.updateStatus.mutate(params);
  };
}

export const nexusRegistryService = new NexusRegistryClientService();
