import { describe, expect, it } from 'vitest';

import { LegacyAgentProfileAdapter } from './index';

const adapter = new LegacyAgentProfileAdapter();

describe('@lobechat/cordis-kernel LegacyAgentProfileAdapter', () => {
  it('maps a complete legacy agent row', () => {
    expect(
      adapter.map({
        id: 'agent-1',
        strategyPluginId: 'task-agent',
        model: 'gpt-5',
        provider: 'openai',
        systemPrompt: 'Be concise',
        enabledCapabilities: ['search', 'code'],
        metadata: { source: 'legacy', version: 1 },
      }),
    ).toEqual({
      id: 'agent-1',
      strategyPluginId: 'task-agent',
      model: 'gpt-5',
      provider: 'openai',
      systemPrompt: 'Be concise',
      enabledCapabilities: ['search', 'code'],
      metadata: { source: 'legacy', version: 1 },
    });
  });

  it('defaults a missing strategy to general-chat', () => {
    expect(adapter.map({ id: 'default-agent' })).toMatchObject({
      id: 'default-agent',
      strategyPluginId: 'general-chat',
      enabledCapabilities: [],
    });
  });

  it('deduplicates capabilities while preserving their first-seen order', () => {
    expect(
      adapter.map({
        id: 'capability-agent',
        enabledCapabilities: ['search', ' code ', 'search', 'code'],
      }).enabledCapabilities,
    ).toEqual(['search', 'code']);
  });

  it('retains metadata contents without sharing the legacy object', () => {
    const metadata = { owner: 'july', flags: ['legacy'] };
    const profile = adapter.map({ id: 'metadata-agent', metadata });

    expect(profile.metadata).toEqual(metadata);
    expect(profile.metadata).not.toBe(metadata);
  });

  it('rejects a missing or empty id with PROFILE_INVALID', () => {
    expect(() => adapter.map({ name: 'missing-id' })).toThrow(
      expect.objectContaining({ code: 'PROFILE_INVALID' }),
    );
    expect(() => adapter.map({ id: '   ' })).toThrow(
      expect.objectContaining({ code: 'PROFILE_INVALID' }),
    );
  });

  it('rejects an invalid capability field with PROFILE_INVALID', () => {
    expect(() =>
      adapter.map({ id: 'invalid-capabilities', enabledCapabilities: 'search' }),
    ).toThrow(expect.objectContaining({ code: 'PROFILE_INVALID' }));
    expect(() => adapter.map({ id: 'invalid-capabilities', capabilities: ['search', 1] })).toThrow(
      expect.objectContaining({ code: 'PROFILE_INVALID' }),
    );
  });

  it('maps a batch of legacy rows through the same adapter seam', () => {
    const profiles = adapter.mapMany([
      { id: 'first', strategyPluginId: 'general-chat' },
      { id: 'second', strategy_plugin_id: 'page-agent', enabled_capabilities: ['render'] },
    ]);

    expect(profiles).toEqual([
      { id: 'first', strategyPluginId: 'general-chat', enabledCapabilities: [] },
      { id: 'second', strategyPluginId: 'page-agent', enabledCapabilities: ['render'] },
    ]);
  });
});
