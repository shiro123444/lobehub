import type { ComponentType } from 'react';

export const RUNTIME_SLOT_IDS = {
  header: 'runtime.header',
  main: 'runtime.main',
  plugins: 'runtime.plugins',
  presentation: 'runtime.presentation',
  sidebar: 'runtime.sidebar',
} as const;

export type RuntimeSlotId = (typeof RUNTIME_SLOT_IDS)[keyof typeof RUNTIME_SLOT_IDS];

export interface PluginSlotProps {
  data?: unknown;
  pluginId?: string;
  props?: Record<string, unknown>;
  slotId: string;
}

export type PluginSlotComponent = ComponentType<PluginSlotProps>;

export interface SlotRegistration {
  component: PluginSlotComponent;
  metadata?: Record<string, unknown>;
  pluginId?: string;
  slotId: string;
  title?: string;
}

export class PluginSlotRegistry {
  private slots = new Map<string, SlotRegistration>();
  private listeners = new Set<() => void>();

  register(registration: SlotRegistration): () => void {
    this.slots.set(registration.slotId, registration);
    this.notify();
    return () => this.unregister(registration.slotId);
  }

  unregister(slotId: string): void {
    if (this.slots.delete(slotId)) {
      this.notify();
    }
  }

  get(slotId: string): SlotRegistration | undefined {
    return this.slots.get(slotId);
  }

  list(): SlotRegistration[] {
    return Array.from(this.slots.values());
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.slots.clear();
    this.notify();
  }

  private notify() {
    this.listeners.forEach((listener) => listener());
  }
}

export const pluginSlotRegistry = new PluginSlotRegistry();
