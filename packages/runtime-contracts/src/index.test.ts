import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  AgentProfile,
  ArtifactSnapshot,
  CommandEnvelope,
  Disposable,
  Disposer,
  Effect,
  Fiber,
  FiberState,
  PermissionManifest,
  PluginDescriptor,
  PluginRuntimeState,
  PresentationPort,
  RunSnapshot,
  RunState,
  RuntimeEvent,
  RuntimePluginManifest,
  StartRunInput,
} from './index';
import { PLUGIN_KINDS, PLUGIN_RUNTIME_STATES, RUN_STATES, RUNTIME_PROTOCOL_VERSION } from './index';

describe('@lobechat/runtime-contracts', () => {
  it('exports the runtime protocol and state constants', () => {
    expect(RUNTIME_PROTOCOL_VERSION).toBe('runtime.v1');
    expect(PLUGIN_KINDS).toContain('agent-strategy');
    expect(PLUGIN_RUNTIME_STATES).toContain('active');
    expect(RUN_STATES).toContain('waiting_human');
    expect(RUN_STATES).toContain('cancelled');
  });

  it('exports the Fiber lifecycle contracts', () => {
    const disposer: Disposer = () => {};
    const disposable: Disposable = disposer;
    const effect: Effect = disposable;
    const fiber: Fiber = {
      name: 'test-fiber',
      state: 'active',
      collect: (candidate) => candidate,
      dispose: async () => {},
    };

    expect(effect).toBe(disposable);
    expect(fiber.collect(disposable)).toBe(disposable);
    expect(fiber.state satisfies FiberState).toBe('active');
  });

  it('resolves the public runtime contract type exports', () => {
    type ContractExports = {
      agentProfile: AgentProfile;
      artifactSnapshot: ArtifactSnapshot;
      commandEnvelope: CommandEnvelope;
      permissionManifest: PermissionManifest;
      pluginDescriptor: PluginDescriptor;
      pluginRuntimeState: PluginRuntimeState;
      presentationPort: PresentationPort;
      runSnapshot: RunSnapshot;
      runState: RunState;
      runtimeEvent: RuntimeEvent;
      runtimePluginManifest: RuntimePluginManifest;
      startRunInput: StartRunInput;
    };

    expectTypeOf<ContractExports>().toBeObject();
  });
});
