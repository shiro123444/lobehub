import { render, screen } from '@testing-library/react';
import React, { type FC } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { initialRuntimeState, useRuntimeStore } from '@/store/runtime';

import RuntimeWorkspace from './index';
import {
  type PluginSlotProps,
  pluginSlotRegistry,
  RUNTIME_SLOT_IDS,
} from './PluginSlotHost/registry';

describe('RuntimeWorkspace PluginSlotHost Layout Integration', () => {
  beforeEach(() => {
    pluginSlotRegistry.clear();
    useRuntimeStore.setState({
      ...initialRuntimeState,
    });
  });

  it('renders workspace with default empty slots without breaking existing layout', () => {
    render(<RuntimeWorkspace />);

    expect(screen.getByTestId('runtime-workspace')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-header')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('event-stream-empty')).toBeInTheDocument();
    expect(screen.getByTestId('run-composer')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-plugin-panel')).toBeInTheDocument();

    // With hideWhenEmpty=true, unregistered slot elements do not populate empty boxes
    expect(screen.queryByTestId('slot-empty-state')).not.toBeInTheDocument();
  });

  it('renders registered component into runtime.header slot', () => {
    const HeaderExtension: FC<PluginSlotProps> = () => (
      <div data-testid="header-extension">Custom Header Banner</div>
    );

    pluginSlotRegistry.register({
      component: HeaderExtension,
      slotId: RUNTIME_SLOT_IDS.header,
      title: 'Header Banner',
    });

    render(<RuntimeWorkspace />);

    expect(screen.getByTestId('header-extension')).toBeInTheDocument();
    expect(screen.getByText('Custom Header Banner')).toBeInTheDocument();
  });

  it('renders registered component into runtime.main slot', () => {
    const MainExtension: FC<PluginSlotProps> = () => (
      <div data-testid="main-extension">Live Strategy Visualizer</div>
    );

    pluginSlotRegistry.register({
      component: MainExtension,
      slotId: RUNTIME_SLOT_IDS.main,
    });

    render(<RuntimeWorkspace />);

    expect(screen.getByTestId('main-extension')).toBeInTheDocument();
    expect(screen.getByText('Live Strategy Visualizer')).toBeInTheDocument();
  });

  it('renders registered component into runtime.sidebar slot', () => {
    const SidebarExtension: FC<PluginSlotProps> = () => (
      <div data-testid="sidebar-extension">Saved Workspaces Widget</div>
    );

    pluginSlotRegistry.register({
      component: SidebarExtension,
      slotId: RUNTIME_SLOT_IDS.sidebar,
    });

    render(<RuntimeWorkspace />);

    expect(screen.getByTestId('sidebar-extension')).toBeInTheDocument();
    expect(screen.getByText('Saved Workspaces Widget')).toBeInTheDocument();
  });

  it('renders registered component into runtime.plugins slot', () => {
    const PluginsExtension: FC<PluginSlotProps> = () => (
      <div data-testid="plugins-extension">Marketplace Extension</div>
    );

    pluginSlotRegistry.register({
      component: PluginsExtension,
      slotId: RUNTIME_SLOT_IDS.plugins,
    });

    render(<RuntimeWorkspace />);

    expect(screen.getByTestId('plugins-extension')).toBeInTheDocument();
    expect(screen.getByText('Marketplace Extension')).toBeInTheDocument();
  });

  it('isolates slot render error via ErrorBoundary without crashing the workspace', () => {
    const CrashingSlot: FC<PluginSlotProps> = () => {
      throw new Error('Plugin slot critical failure');
    };

    pluginSlotRegistry.register({
      component: CrashingSlot,
      slotId: RUNTIME_SLOT_IDS.main,
    });

    render(<RuntimeWorkspace />);

    expect(screen.getByTestId('slot-error-boundary')).toBeInTheDocument();
    expect(screen.getByText('Plugin Slot Error: runtime.main')).toBeInTheDocument();
    expect(screen.getByText('Plugin slot critical failure')).toBeInTheDocument();

    // Workspace remains intact
    expect(screen.getByTestId('workspace-header')).toBeInTheDocument();
    expect(screen.getByTestId('run-composer')).toBeInTheDocument();
  });

  it('renders real disabled state when plugin assigned to slot is disabled in store', () => {
    const PluginComponent: FC<PluginSlotProps> = () => <div>Active View</div>;

    pluginSlotRegistry.register({
      component: PluginComponent,
      pluginId: 'mcp-debugger',
      slotId: RUNTIME_SLOT_IDS.main,
    });

    useRuntimeStore.setState({
      pluginStates: {
        'mcp-debugger': 'disabled',
      },
    });

    render(<RuntimeWorkspace />);

    expect(screen.getByTestId('slot-disabled-state')).toBeInTheDocument();
    expect(screen.getByText('Plugin "mcp-debugger" is currently disabled.')).toBeInTheDocument();
    expect(screen.queryByText('Active View')).not.toBeInTheDocument();
  });
});
