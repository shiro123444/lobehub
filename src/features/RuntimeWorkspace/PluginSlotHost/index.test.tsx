import { render, screen } from '@testing-library/react';
import React, { type FC } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { initialRuntimeState, useRuntimeStore } from '@/store/runtime';

import PluginSlotHost from './index';
import { type PluginSlotProps, pluginSlotRegistry } from './registry';

describe('PluginSlotHost Component', () => {
  beforeEach(() => {
    pluginSlotRegistry.clear();
    useRuntimeStore.setState({
      ...initialRuntimeState,
    });
  });

  it('renders real empty state when slotId is not registered', () => {
    render(<PluginSlotHost slotId="unregistered-slot" />);

    expect(screen.getByTestId('plugin-slot-host-unregistered-slot')).toBeInTheDocument();
    expect(screen.getByTestId('slot-empty-state')).toBeInTheDocument();
    expect(
      screen.getByText('No component registered for slot: unregistered-slot'),
    ).toBeInTheDocument();
    expect(screen.getByText('unregistered')).toBeInTheDocument();
  });

  it('renders custom fallback when provided for unregistered slot', () => {
    render(
      <PluginSlotHost
        fallback={<div data-testid="custom-fallback">Custom Empty Fallback</div>}
        slotId="custom-empty"
      />,
    );

    expect(screen.getByTestId('custom-fallback')).toBeInTheDocument();
    expect(screen.getByText('Custom Empty Fallback')).toBeInTheDocument();
    expect(screen.queryByTestId('slot-empty-state')).not.toBeInTheDocument();
  });

  it('renders registered React component when slotId is registered', () => {
    const TestComponent: FC<PluginSlotProps> = () => (
      <div data-testid="test-slot-widget">Hello Plugin Widget</div>
    );

    pluginSlotRegistry.register({
      component: TestComponent,
      pluginId: 'calc-plugin',
      slotId: 'calc-slot',
      title: 'Calculator Widget',
    });

    render(<PluginSlotHost slotId="calc-slot" />);

    expect(screen.getByTestId('test-slot-widget')).toBeInTheDocument();
    expect(screen.getByText('Hello Plugin Widget')).toBeInTheDocument();
    expect(screen.getByText('Slot: Calculator Widget')).toBeInTheDocument();
    expect(screen.getByText('mounted')).toBeInTheDocument();
  });

  it('passes data, props, and pluginId to the registered slot component', () => {
    const TestComponent: FC<PluginSlotProps> = ({ data, pluginId, props, slotId }) => (
      <div>
        <span data-testid="slot-data">{(data as any)?.value}</span>
        <span data-testid="slot-plugin-id">{pluginId}</span>
        <span data-testid="slot-prop">{(props as any)?.theme}</span>
        <span data-testid="slot-id-prop">{slotId}</span>
      </div>
    );

    pluginSlotRegistry.register({
      component: TestComponent,
      pluginId: 'chart-plugin',
      slotId: 'chart-slot',
    });

    render(
      <PluginSlotHost
        data={{ value: '42-points' }}
        props={{ theme: 'dark' }}
        slotId="chart-slot"
      />,
    );

    expect(screen.getByTestId('slot-data')).toHaveTextContent('42-points');
    expect(screen.getByTestId('slot-plugin-id')).toHaveTextContent('chart-plugin');
    expect(screen.getByTestId('slot-prop')).toHaveTextContent('dark');
    expect(screen.getByTestId('slot-id-prop')).toHaveTextContent('chart-slot');
  });

  it('renders real disabled state when plugin is marked disabled in store', () => {
    const TestComponent: FC<PluginSlotProps> = () => <div>Active View</div>;

    pluginSlotRegistry.register({
      component: TestComponent,
      pluginId: 'weather-plugin',
      slotId: 'weather-slot',
    });

    useRuntimeStore.setState({
      pluginStates: {
        'weather-plugin': 'disabled',
      },
    });

    render(<PluginSlotHost slotId="weather-slot" />);

    expect(screen.getByTestId('slot-disabled-state')).toBeInTheDocument();
    expect(screen.getByText('Plugin "weather-plugin" is currently disabled.')).toBeInTheDocument();
    expect(screen.queryByText('Active View')).not.toBeInTheDocument();
  });

  it('unregisters slot cleanly and re-renders empty state', () => {
    const TestComponent: FC<PluginSlotProps> = () => <div>Dynamic View</div>;

    const unregister = pluginSlotRegistry.register({
      component: TestComponent,
      slotId: 'dyn-slot',
    });

    const { rerender } = render(<PluginSlotHost slotId="dyn-slot" />);
    expect(screen.getByText('Dynamic View')).toBeInTheDocument();

    unregister();
    rerender(<PluginSlotHost slotId="dyn-slot" />);

    expect(screen.queryByText('Dynamic View')).not.toBeInTheDocument();
    expect(screen.getByTestId('slot-empty-state')).toBeInTheDocument();
  });

  it('catches slot component runtime render errors with SlotErrorBoundary', () => {
    const ErrorComponent: FC<PluginSlotProps> = () => {
      throw new Error('Component crashed while rendering');
    };

    pluginSlotRegistry.register({
      component: ErrorComponent,
      slotId: 'error-slot',
    });

    render(<PluginSlotHost slotId="error-slot" />);

    expect(screen.getByTestId('slot-error-boundary')).toBeInTheDocument();
    expect(screen.getByText('Plugin Slot Error: error-slot')).toBeInTheDocument();
    expect(screen.getByText('Component crashed while rendering')).toBeInTheDocument();
  });
});
