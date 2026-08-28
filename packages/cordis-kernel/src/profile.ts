export interface AgentProfile {
  enabledCapabilities: string[];
  id: string;
  metadata?: Record<string, unknown>;
  model?: string;
  provider?: string;
  strategyPluginId: string;
  systemPrompt?: string;
}

export type LegacyAgentRow = unknown;
export type ProfileAdapterErrorCode = 'PROFILE_INVALID';

export class ProfileAdapterError extends Error {
  constructor(
    public readonly code: ProfileAdapterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProfileAdapterError';
  }
}

type LegacyRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is LegacyRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOwn = (record: LegacyRecord, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

const invalid = (message: string): never => {
  throw new ProfileAdapterError('PROFILE_INVALID', message);
};

const capabilitiesFrom = (row: LegacyRecord): string[] => {
  const field = ['enabledCapabilities', 'enabled_capabilities', 'capabilities'].find((key) =>
    hasOwn(row, key),
  );
  if (!field) return [];

  const raw = row[field];
  if (raw === undefined) return [];
  const values: unknown[] = Array.isArray(raw)
    ? raw
    : invalid('enabledCapabilities must be an array of strings');

  const capabilities: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const capability =
      typeof value === 'string'
        ? value.trim()
        : invalid('enabledCapabilities must contain only non-empty strings');
    if (!capability) invalid('enabledCapabilities must contain only non-empty strings');
    if (!seen.has(capability)) {
      seen.add(capability);
      capabilities.push(capability);
    }
  }
  return capabilities;
};

const metadataFrom = (row: LegacyRecord): Record<string, unknown> | undefined => {
  if (!hasOwn(row, 'metadata') || row.metadata === undefined) return undefined;
  if (!isRecord(row.metadata)) invalid('metadata must be an object');
  return { ...row.metadata };
};

export const mapLegacyAgentProfile = (row: LegacyAgentRow): AgentProfile => {
  const record = isRecord(row) ? row : invalid('legacy agent row must be an object');

  const id = optionalString(record.id) ?? invalid('legacy agent row requires a non-empty id');

  return {
    id,
    strategyPluginId:
      optionalString(record.strategyPluginId) ??
      optionalString(record.strategy_plugin_id) ??
      'general-chat',
    model: optionalString(record.model),
    provider: optionalString(record.provider),
    systemPrompt: optionalString(record.systemPrompt) ?? optionalString(record.system_prompt),
    enabledCapabilities: capabilitiesFrom(record),
    metadata: metadataFrom(record),
  };
};

export class LegacyAgentProfileAdapter {
  map(row: LegacyAgentRow): AgentProfile {
    return mapLegacyAgentProfile(row);
  }

  adapt(row: LegacyAgentRow): AgentProfile {
    return this.map(row);
  }

  mapMany(rows: readonly LegacyAgentRow[]): AgentProfile[] {
    if (!Array.isArray(rows)) invalid('legacy agent rows must be an array');
    return rows.map((row) => this.map(row));
  }

  adaptMany(rows: readonly LegacyAgentRow[]): AgentProfile[] {
    return this.mapMany(rows);
  }
}

export { ProfileAdapterError as LegacyAgentProfileAdapterError };
