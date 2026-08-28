import { Flexbox, Icon, Tag } from '@lobehub/ui';
import { Alert } from 'antd';
import { AlertCircle, Ban, Layers } from 'lucide-react';
import React, { Component, type ErrorInfo, memo, type ReactNode } from 'react';

import { runtimeSelectors, useRuntimeStore } from '@/store/runtime';

import { styles } from './style';
import { usePluginSlot } from './usePluginSlot';

interface ErrorBoundaryProps {
  children: ReactNode;
  slotId: string;
}

interface ErrorBoundaryState {
  error: Error | null;
  hasError: boolean;
}

class SlotErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null, hasError: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error, hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(
      `[PluginSlotHost] Render error in slot "${this.props.slotId}":`,
      error,
      errorInfo,
    );
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className={styles.errorFallback} data-testid="slot-error-boundary">
          <Alert
            showIcon
            description={this.state.error?.message || 'Unknown component failure'}
            message={`Plugin Slot Error: ${this.props.slotId}`}
            type="error"
          />
        </div>
      );
    }
    return this.props.children;
  }
}

export interface PluginSlotHostProps {
  className?: string;
  data?: unknown;
  fallback?: ReactNode;
  hideWhenEmpty?: boolean;
  pluginId?: string;
  props?: Record<string, unknown>;
  showHeader?: boolean;
  slotId: string;
}

export const PluginSlotHost = memo<PluginSlotHostProps>(
  ({
    className,
    data,
    fallback,
    hideWhenEmpty = false,
    pluginId,
    props: customProps,
    showHeader = true,
    slotId,
  }) => {
    const slot = usePluginSlot(slotId);
    const targetPluginId = pluginId || slot?.pluginId;
    const pluginState = useRuntimeStore((s) =>
      targetPluginId ? runtimeSelectors.getPluginState(targetPluginId)(s) : undefined,
    );

    const isPluginDisabled = pluginState === 'disabled' || pluginState === 'failed';

    if (hideWhenEmpty && !slot && !isPluginDisabled) {
      return fallback !== undefined ? <>{fallback}</> : null;
    }

    const renderContent = () => {
      if (isPluginDisabled) {
        return (
          <div
            aria-live="polite"
            className={styles.disabledState}
            data-testid="slot-disabled-state"
            role="status"
          >
            <Flexbox horizontal align="center" gap={6}>
              <Icon icon={Ban} size={{ fontSize: 14 }} />
              <span>
                Plugin {targetPluginId ? `"${targetPluginId}"` : ''} is currently {pluginState}.
              </span>
            </Flexbox>
          </div>
        );
      }

      if (!slot) {
        if (fallback !== undefined) {
          return fallback;
        }

        return (
          <div className={styles.emptyState} data-testid="slot-empty-state" role="status">
            <Icon
              icon={AlertCircle}
              size={{ fontSize: 20 }}
              style={{ marginBottom: 6, opacity: 0.5 }}
            />
            <div>No component registered for slot: {slotId}</div>
          </div>
        );
      }

      const SlotComponent = slot.component;

      return (
        <div className={styles.content} data-testid={`slot-content-${slotId}`}>
          <SlotErrorBoundary slotId={slotId}>
            <SlotComponent
              data={data}
              pluginId={targetPluginId}
              props={customProps}
              slotId={slotId}
            />
          </SlotErrorBoundary>
        </div>
      );
    };

    return (
      <div
        aria-label={`Plugin Slot: ${slot?.title || slotId}`}
        className={className ? `${styles.container} ${className}` : styles.container}
        data-testid={`plugin-slot-host-${slotId}`}
        role="region"
      >
        {showHeader && (
          <div className={styles.header}>
            <Flexbox horizontal align="center" gap={6}>
              <Icon icon={Layers} size={{ fontSize: 14 }} />
              <span className={styles.slotId}>Slot: {slot?.title || slotId}</span>
            </Flexbox>
            <Flexbox horizontal align="center" gap={4}>
              {targetPluginId && (
                <Tag color={isPluginDisabled ? 'error' : 'processing'} size="small">
                  {targetPluginId}
                </Tag>
              )}
              <Tag color={slot ? 'success' : 'default'} size="small">
                {slot ? 'mounted' : 'unregistered'}
              </Tag>
            </Flexbox>
          </div>
        )}
        {renderContent()}
      </div>
    );
  },
);

PluginSlotHost.displayName = 'PluginSlotHost';

export default PluginSlotHost;
export * from './registry';
export * from './usePluginSlot';
